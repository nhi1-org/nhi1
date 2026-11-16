// SCHEMA BATCH part 2 (branch s2-schema-batch): t = UTC day, prev chain, the envelope, the chain head,
// many sessions on one key, the local pending queue, "要升級", the replica. Local board only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { hashOf, recordId } from "../supabase/functions/_shared/aua/canon.ts";
import { buildExport, handleHead, handleReplica, stampOk } from "../supabase/functions/_shared/aua/handlers.ts";
import { SCHEMA } from "../supabase/functions/_shared/aua/schema.ts";
import * as client from "../skill/nhi1-aua/aua.mjs";
import { AUA, deps, envelope, makeDb, nowSec, putUse, rpcFor, today } from "./helpers.ts";
import { startLocalBoard } from "../tools/local-board.ts";
import { testPort } from "../tools/test-ports.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const H = (c: string) => c.repeat(64);
const D = 86400;

async function rawUse(k: { pub: string; jwk: unknown }, prev: string | null, tin = 1, t = today()) {
  return client.signRecord({
    aua: AUA, thing: { addr: "https://mcp.chain-test.org/mcp", iface: H("1") }, call: { op: H("2"), in: H("3"), out: H("4") }, task: H("5"),
    result: { code: 0, err: 0 }, cost: { tin, tout: 1, ms: 1, money: 0, cur: "" }, effect: 0,
    by: { key: k.pub, model: H("6"), rt: H("7") }, t, prev, stub: null,
  }, k);
}

describe("the client and the board agree on the schema", () => {
  it("aua.mjs AUA == sha256(canon(SCHEMA))", async () => {
    assert.equal(client.AUA, await hashOf(SCHEMA));
    assert.equal(client.AUA, AUA);
  });
});

describe("time lives in the record: t = UTC day, the exact second only on the envelope", () => {
  const T = 1794268800; // a 00:00:00 UTC
  it("today; yesterday only within 900 s after midnight; never tomorrow; rec.t must be the day of at.t", () => {
    assert.equal(T % D, 0);
    assert.ok(stampOk(T, T + 5000, T + 5000), "today");
    assert.ok(stampOk(T - D, T - 3, T + 600), "sent 23:59:57, arrived 00:10: yesterday within the grace");
    assert.ok(!stampOk(T - D, T - 600, T + 1000), "yesterday, 1000 s after midnight: refused");
    assert.ok(!stampOk(T + D, T + D + 5, T + D - 5), "a client 10 s ahead at midnight: tomorrow is refused (resent later, re-stamped)");
    assert.ok(!stampOk(T, T - 5, T + 10), "rec.t must be the UTC day of at.t");
    assert.ok(!stampOk(T, T + 10, T + 10 + 901), "at.t outside the 900 s window");
  });

  it("the board keeps at.t inside; export and the replica carry the record only (day + prev)", async () => {
    const db = await makeDb();
    const k = await client.generateKey();
    const r1 = await putUse(await envelope(await rawUse(k, null), k), deps(db));
    assert.equal(r1.status, 201);
    const at = (await db.query<{ at_t: string; t: string }>("select at_t, t from public.use")).rows[0];
    assert.ok(Math.abs(Number(at.at_t) - nowSec()) < 5, "exact time kept at the root");
    assert.equal(Number(at.t) % D, 0, "the record says only the day");
    const { text } = await buildExport(rpcFor(db));
    assert.doesNotMatch(text, new RegExp(String(at.at_t)), "the exact second is in no exported line");
    for (const line of text.trim().split("\n")) {
      const o = JSON.parse(line);
      assert.equal(await recordId(o.rec), o.id, "every exported record still re-hashes to its id");
      if (o.table === "use") assert.deepEqual(Object.keys(o.rec).sort(), Object.keys(await rawUse(k, null)).sort());
    }
  });
});

describe("the chain: prev must be the key's head", () => {
  it("first record prev = null; a fork attempt gets 409 + the head; a resend is a dup, not a collision", async () => {
    const db = await makeDb();
    const k = await client.generateKey();
    const a = await rawUse(k, null, 1);
    const ra = await putUse(await envelope(a, k), deps(db));
    assert.equal(ra.status, 201);
    const idA = await recordId(a);
    const b = await rawUse(k, idA, 2);
    const fork = await rawUse(k, idA, 3); // a second session that also read head = A
    assert.equal((await putUse(await envelope(b, k), deps(db))).status, 201);
    const rf = await putUse(await envelope(fork, k), deps(db));
    assert.equal(rf.status, 409);
    assert.deepEqual(rf.body, { err: 21, head: await recordId(b) }, "told where the head is");
    assert.equal((await putUse(await envelope(await rawUse(k, null, 4), k), deps(db))).status, 409, "a second 'first' record");
    const again = await putUse(await envelope(b, k, nowSec() + 1), deps(db));
    assert.equal(again.status, 200, "resend of a stored record (new envelope) = dup");
    const fixed = await rawUse(k, await recordId(b), 3); // re-stamped on the head
    assert.equal((await putUse(await envelope(fixed, k), deps(db))).status, 201);
    const n = (await db.query<{ n: string }>("select n from public.chain_head")).rows[0].n;
    assert.equal(Number(n), 3, "one chain, three links");
    const other = await client.generateKey();
    assert.equal((await putUse(await envelope(await rawUse(other, null), other), deps(db))).status, 201, "every key has its own chain");
  });

  it("ep.head answers only for the signing key", async () => {
    const db = await makeDb();
    const k = await client.generateKey();
    const ask = async (key: typeof k, over: Record<string, unknown> = {}) =>
      handleHead(await client.signRecord({ aua: AUA, by: { key: key.pub, model: H("6"), rt: H("7") }, t: nowSec(), ...over }, key), deps(db));
    assert.deepEqual((await ask(k)).body, { head: null });
    const a = await rawUse(k, null);
    await putUse(await envelope(a, k), deps(db));
    assert.deepEqual((await ask(k)).body, { head: await recordId(a) });
    const signed = await client.signRecord({ aua: AUA, by: { key: k.pub, model: H("6"), rt: H("7") }, t: nowSec() }, k);
    assert.equal((await handleHead({ ...signed, by: { ...signed.by, key: (await client.generateKey()).pub } }, deps(db))).status, 401);
    assert.equal((await ask(k, { t: nowSec() - 2000 })).status, 400, "stale");
  });
});

describe("one key, many sessions (a 7 s send budget)", () => {
  let board: Awaited<ReturnType<typeof startLocalBoard>>;
  const PORT = testPort(1);
  before(async () => {
    board = await startLocalBoard(PORT);
  });
  after(() => board.server.close());

  const homeWith = (key: unknown, disc = board.url) => {
    const home = mkdtempSync(join(tmpdir(), "nhi1-chain-"));
    writeFileSync(join(home, "key.jwk"), JSON.stringify(key));
    return { home, env: { ...process.env, NHI1_HOME: home, NHI1_DISCOVERY: disc } };
  };
  const session = async (env: NodeJS.ProcessEnv, n: number, tag: string) =>
    JSON.parse((await run(process.execPath, [join(ROOT, "tests/fixtures/send-n.mjs"), String(n), tag], { env })).stdout) as
      { status: number; id: string; queued?: string; ms: number }[];
  /** walk the chain back from the board's head: every record exactly once, no fork */
  const walk = async (pub: string) => {
    const head = (await board.db.query<{ id: string }>("select id from public.chain_head where key = $1", [pub])).rows[0]?.id;
    const recs = new Map((await board.db.query<{ id: string; rec: { prev: string | null } }>("select id, rec from public.use where key = $1", [pub])).rows.map((r) => [r.id, r.rec.prev]));
    const seen: string[] = [];
    for (let id: string | null | undefined = head; id; id = recs.get(id)) seen.push(id);
    return { seen, total: recs.size };
  };

  it("two sessions on this machine send at the same moment (3 each): six links, one chain, all inside 7 s", async () => {
    const k = await client.generateKey();
    const { env } = homeWith(k);
    const [a, b] = await Promise.all([session(env, 3, "a"), session(env, 3, "b")]);
    for (const r of [...a, ...b]) {
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.ok(r.ms < 7000, "inside the send budget: " + r.ms);
    }
    const w = await walk(k.pub);
    assert.equal(w.total, 6);
    assert.equal(w.seen.length, 6, "the chain from the head reaches every record: no fork, nothing lost");
    console.log(`two sessions, one machine: 6/6 on the board, slowest send ${Math.max(...[...a, ...b].map((r) => r.ms))} ms`);
  });

  it("two machines with one key (two homes: no shared lock): the board's 409 sends them back to re-sign; one chain", async () => {
    const k = await client.generateKey();
    const m1 = homeWith(k), m2 = homeWith(k);
    const [a, b] = await Promise.all([session(m1.env, 3, "c"), session(m2.env, 3, "d")]);
    const sent = [...a, ...b].filter((r) => r.status === 201).length;
    const queued = [...a, ...b].filter((r) => r.queued).length;
    console.log(`two machines, one key: ${sent} sent at once, ${queued} waited locally, slowest ${Math.max(...[...a, ...b].map((r) => r.ms))} ms`);
    assert.equal(sent + queued, 6, "every record is either on the board or waiting locally — none dropped");
    const w = await walk(k.pub);
    assert.equal(w.seen.length, w.total, "no fork");
    // whatever waited goes out on the next send
    for (const m of [m1, m2]) await run(process.execPath, [join(ROOT, "tests/fixtures/flush-with.mjs")], { env: m.env });
    const w2 = await walk(k.pub);
    assert.equal(w2.total, 6);
    assert.equal(w2.seen.length, 6);
  });

  it("board unreachable → kept in pending.ndjson; next send goes out oldest first, same chain", async () => {
    const k = await client.generateKey();
    const dead = join(mkdtempSync(join(tmpdir(), "nhi1-dead-")), "aua.json");
    writeFileSync(dead, JSON.stringify({ ...(await (await fetch(board.url)).json()), ep: { use: "http://127.0.0.1:9/use", head: "http://127.0.0.1:9/head", ask: "http://127.0.0.1:9/ask" } }));
    const m = homeWith(k, pathToFileURL(dead).href);
    const r = await session(m.env, 2, "e");
    assert.ok(r.every((x) => x.status === 0 && x.queued), JSON.stringify(r));
    const pend = readFileSync(join(m.home, "pending.ndjson"), "utf8").trim().split("\n");
    assert.equal(pend.length, 2, "both kept, not dropped");
    const back = await session({ ...m.env, NHI1_DISCOVERY: board.url }, 1, "f");
    assert.equal(back[0].status, 201);
    assert.equal(readFileSync(join(m.home, "pending.ndjson"), "utf8"), "", "queue drained");
    const w = await walk(k.pub);
    assert.equal(w.total, 3);
    assert.equal(w.seen.length, 3);
    assert.equal(w.seen[0], back[0].id, "the new one is the head: the waiting ones went first");
  });

  it("a record the board rejects for good goes to rejected.ndjson (logged, not silent) and does not block the rest", async () => {
    const k = await client.generateKey();
    const m = homeWith(k);
    writeFileSync(join(m.home, "pending.ndjson"), JSON.stringify({ kind: "use", body: { aua: AUA, junk: 1 }, n: 0 }) + "\n");
    const r = await session(m.env, 1, "g");
    assert.equal(r[0].status, 201);
    assert.match(readFileSync(join(m.home, "rejected.ndjson"), "utf8"), /"why":"err\.3"/);
  });

  it("board on a newer schema → 要升級: nothing sent, the record waits; after the upgrade it goes out", async () => {
    const k = await client.generateKey();
    const doc = await (await fetch(board.url)).json();
    const newer = join(mkdtempSync(join(tmpdir(), "nhi1-new-")), "aua.json");
    writeFileSync(newer, JSON.stringify({ ...doc, aua: H("9") }));
    const m = homeWith(k, pathToFileURL(newer).href);
    const r = await session(m.env, 1, "h");
    assert.equal(r[0].status, 0);
    assert.match(readFileSync(join(m.home, "send.log"), "utf8"), /要升級/);
    assert.equal(readFileSync(join(m.home, "pending.ndjson"), "utf8").trim().split("\n").length, 1);
    // "upgraded": client and board agree again → the waiting record is sent first
    const back = await session({ ...m.env, NHI1_DISCOVERY: board.url }, 1, "i");
    assert.equal(back[0].status, 201);
    assert.equal((await walk(k.pub)).seen.length, 2);
    // the board itself answers a bare (pre-envelope) record with err 8
    const bare = await rawUse(k, null);
    const res = await fetch(doc.ep.use, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bare) });
    assert.equal((await res.json()).err, 8);
  });
});

describe("replica (3_ §5): ready to open now that time lives in the record", () => {
  it("closed while replica_open = 0; open → the full set for any signed key; no exact time in it", async () => {
    const db = await makeDb();
    const k = await client.generateKey();
    await putUse(await envelope(await rawUse(k, null), k), deps(db));
    const { text } = await buildExport(rpcFor(db));
    const { gzipSync, gunzipSync } = await import("node:zlib");
    const files: Record<string, Uint8Array> = { "latest.json": new TextEncoder().encode(JSON.stringify({ n: 1 })), "latest.ndjson.gz": gzipSync(text) };
    const store = { get: async (p: string) => files[p] ?? null };
    const reader = await client.generateKey();
    const req = async () => handleReplica(await client.signRecord({ aua: AUA, by: { key: reader.pub, model: H("6"), rt: H("7") }, t: nowSec() }, reader), deps(db, { store }));
    assert.equal(((await req()).body as { err: number }).err, 20, "closed until George says so");
    await db.exec("update public.knob set val = 1 where name = 'replica_open'");
    const r = await req();
    assert.equal(r.status, 200);
    const lines = gunzipSync(Buffer.from((r.body as { gz_b64: string }).gz_b64, "base64")).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    const use = lines.find((l) => l.table === "use");
    assert.equal(use.rec.t % D, 0);
    assert.ok(!("at" in use) && !("at_t" in use.rec), "no exact time");
    assert.equal(await recordId(use.rec), use.id);
    assert.ok(existsSync(join(ROOT, "supabase/functions/head/index.ts")), "head endpoint has its edge function");
  });
});
