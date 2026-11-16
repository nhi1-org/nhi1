// S4 A + the rest of the one NHI-1 schema release (George 11/13 一 3): replay_result as a record, the work pointer
// (作品指標), by.hw, stub.out = call.out, the new daily-report fields, the new aua hash.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOf, ident, verifyRecord } from "../supabase/functions/_shared/aua/canon.ts";
import { buildExport, handleUse, handleWork } from "../supabase/functions/_shared/aua/handlers.ts";
import { putResult } from "../supabase/functions/_shared/aua/rerun.ts";
import { reportNumbers } from "../supabase/functions/_shared/aua/report.ts";
import { SCHEMA } from "../supabase/functions/_shared/aua/schema.ts";
import { validateReplayResult, validateUse, validateWork } from "../supabase/functions/_shared/aua/validate.ts";
import * as A from "../skill/nhi1-aua/aua.mjs";
import { AUA, deps, envelope, HEADS, makeDb, prevOf, putUse, rpcFor, today } from "./helpers.ts";

const H = (c: string) => c.repeat(64);
const THING = { addr: "https://mcp.work-test.org/mcp", iface: H("1") };
const rows = async (db: any, sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, any>[];
const useRec = (k: { pub: string }, o: Record<string, unknown> = {}) => ({
  aua: AUA, thing: THING, call: { op: H("9"), in: H("2"), out: H("3") }, task: H("7"),
  result: { code: 0, err: 0 }, cost: { tin: 0, tout: 0, ms: 1, money: 0, cur: "" }, effect: 0,
  by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub), stub: null, ...o,
});
async function aUse(db: any) {
  const k = await A.generateKey();
  const r = await putUse(await envelope(await A.signRecord(useRec(k), k), k), deps(db));
  assert.equal(r.status, 201);
  return { use: (r.body as { id: string }).id, k };
}

describe("S4 A: replay_result is a wind-signed record", () => {
  it("schema hash = aua.mjs AUA; SCHEMA carries records.replay_result, replay.how, work, by.hw", async () => {
    assert.equal(await hashOf(SCHEMA), A.AUA);
    assert.ok("replay_result" in SCHEMA.records && "work" in SCHEMA.records);
    assert.deepEqual(SCHEMA.enums["replay.how"], { "0": "stub", "1": "cross_family" });
    assert.ok("hw?" in SCHEMA.records.use.by);
  });

  it("shape: no free text, fam only for how 1, model never for how 0", () => {
    const ok = { aua: H("a"), use: H("b"), req: null, how: 1, code: 0, err: 0, fam: H("c"), model: H("d"), by: { key: H("e") }, t: 1, sig: "f".repeat(128) };
    assert.equal(validateReplayResult(ok), 0);
    assert.notEqual(validateReplayResult({ ...ok, how: 0 }), 0, "how 0 with a family");
    assert.notEqual(validateReplayResult({ ...ok, fam: null }), 0, "how 1 without a family");
    assert.notEqual(validateReplayResult({ ...ok, how: 0, fam: null }), 0, "how 0 with a model");
    assert.equal(validateReplayResult({ ...ok, how: 0, fam: null, model: null }), 0);
    assert.equal(validateReplayResult({ ...ok, err: "timeout" }), 3);
    assert.equal(validateReplayResult({ ...ok, note: "hi" }), 3, "an extra field");
    assert.equal(validateReplayResult({ ...ok, model: "gpt-5.6-sol" }), 4, "a name instead of its hash: free text");
  });

  it("append-only, service_role only, exported; the wind key's signature verifies", async () => {
    const db = await makeDb();
    const u = await aUse(db);
    const signer = await A.generateKey() as never as { pub: string; jwk: JsonWebKey };
    const id = await putResult({ rpc: rpcFor(db), fetch: (() => {}) as never, now: () => new Date(), signer, aua: AUA }, { use: u.use, req: null, how: 0, out: { code: 0, err: 0 } });
    assert.ok(id);
    await assert.rejects(db.query("update public.replay_result set code = 2"), /append-only/);
    await assert.rejects(db.query("delete from public.replay_result"), /append-only/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from public.replay_result"), /permission denied/);
      await assert.rejects(rpcFor(db, role)("aua_put_replay_result", { p_id: H("0"), p_rec: {} }), /permission denied/);
      await db.exec("reset role");
    }
    const { text, counts } = await buildExport(rpcFor(db));
    assert.equal(counts.replay_result, 1);
    const line = text.split("\n").find((l) => l.includes('"table":"replay_result"'))!;
    const rec = JSON.parse(line).rec;
    assert.ok(await verifyRecord(rec, signer.pub), "verifies with the wind key");
    assert.equal(validateReplayResult(rec), 0);
  });
});

describe("work pointer (作品指標, 4_ §13【定】) and by.hw", () => {
  it("a work pointer on a thing on the board: 201, rides the chain, exported; a thing not on the board: err 12", async () => {
    const db = await makeDb();
    const u = await aUse(db);
    const k = u.k;
    const w = await A.signRecord({ aua: AUA, thing: THING, kind: 0, by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub) }, k);
    assert.equal(validateWork(w), 0);
    const r = await handleWork(await envelope(w, k), deps(db));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    HEADS.set(k.pub, (r.body as { id: string }).id);
    assert.equal((await rows(db, "select id from public.chain_head where key = $1", [k.pub]))[0].id, (r.body as { id: string }).id, "the chain head moved");
    const w2 = await A.signRecord({ aua: AUA, thing: { ...THING, iface: H("8") }, kind: 1, by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub) }, k);
    assert.deepEqual((await handleWork(await envelope(w2, k), deps(db))).body, { err: 12 }, "only a thing already on the board");
    const stale = await A.signRecord({ aua: AUA, thing: THING, kind: 2, by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: null }, k);
    assert.equal((await handleWork(await envelope(stale, k), deps(db))).status, 409, "prev must be the head (err 21)");
    assert.equal(validateWork({ ...w, kind: 3 }), 3);
    assert.equal(validateWork({ ...w, note: "my best work" }), 3, "ids and codes only");
    const { counts } = await buildExport(rpcFor(db));
    assert.equal(counts.work, 1);
    const n = (await rows(db, "select public.aua_report_numbers(now() - interval '1 day', now() + interval '1 day') n"))[0].n;
    assert.equal(n.works, 1);
  });

  it("by.hw: an optional hash; a name is free text; stub.out must be call.out", async () => {
    const k = await A.generateKey();
    const base = { ...useRec(k), sig: "f".repeat(128) };
    assert.equal(validateUse({ ...base, by: { ...base.by, hw: H("4") } }), 0);
    assert.equal(validateUse({ ...base, by: { ...base.by, hw: "unitree-g1" } }), 4);
    assert.equal(validateUse({ ...base, by: { ...base.by, body: H("4") } }), 3);
    assert.equal(validateUse({ ...base, stub: { in: { id: "$n" }, out: H("3") } }), 0);
    assert.equal(validateUse({ ...base, stub: { in: { id: "$n" }, out: H("5") } }), 3, "stub.out = call.out (S4 Q6 (a))");
    const db = await makeDb();
    const rec = await A.signRecord({ ...useRec(k), by: { key: k.pub, model: H("6"), rt: H("5"), hw: await ident("some-arm") } }, k);
    assert.equal((await handleUse(await envelope(rec, k), deps(db))).status, 201);
  });

  it("report_fields gains the S4 numbers; reportNumbers fills them in cents and states", () => {
    const f = SCHEMA.report_fields as readonly string[];
    for (const k of ["stub_runs", "stub_pass", "rpf_runs", "rpf_pass", "rpf_cents_day", "rpf_cents_cap", "rpf_state", "works"]) assert.ok(f.includes(k), k);
    const n = reportNumbers({ asks: 0, ask_bytes: 0, usd_day: 0, usd_month: 0, twd_day: 0, twd_month: 0, rpf_usd_day: 0.0123, rpf_usd_cap: 1, rpf_state: 0, stub_runs: 3 } as never);
    assert.equal(n.length, f.length);
    assert.deepEqual([n[f.indexOf("rpf_cents_day")], n[f.indexOf("rpf_cents_cap")], n[f.indexOf("stub_runs")]], [1, 100, 3]);
  });
});
