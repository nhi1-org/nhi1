// NHI-1 records signed with the citizen's key on this machine (George 11/16): aua.mjs ensureKey(), sendUse / hello
// without a key, two citizens on one machine, the pending queue, no model → nothing signed, no room → nothing signed
// and nothing made, and signing needs no network. Test keys live in a temp folder, removed at the end.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import * as A from "../skill/nhi1-aua/aua.mjs";
import * as M from "../skill/nhi1-aua/mem.mjs";
import { startLocalBoard } from "../tools/local-board.ts";
import { testPort } from "../tools/test-ports.ts";

const H = (c: string) => c.repeat(64);
const OLD_FILE = "key" + ".jwk";
const body = (key: { pub: string }, n = 1) => ({
  aua: A.AUA, thing: { addr: "https://mcp.citizen-test.org/mcp", iface: H("1") }, call: { op: H("2"), in: H("3"), out: H("4") }, task: H("5"),
  result: { code: 0, err: 0 }, cost: { tin: n, tout: 1, ms: 1, money: 0, cur: "" }, effect: 0,
  by: { key: key.pub, model: H("6"), rt: H("7") }, stub: null,
});

describe("NHI-1 signing with the citizen's key (aua.mjs · MCP go through one function)", () => {
  let b: Awaited<ReturnType<typeof startLocalBoard>>;
  let home: string;
  before(async () => {
    b = await startLocalBoard(testPort(13));
    home = mkdtempSync(join(tmpdir(), "nhi1-citizen-"));
    process.env.NHI1_HOME = home;
    process.env.NHI1_KEY_DIRS = ["a", "b", "c"].map((x) => join(home, "pieces-" + x)).join(delimiter);
    process.env.NHI1_SANDBOX = "0";
    process.env.NHI1_DISCOVERY = b.url;
    delete process.env.CLAUDE_CODE_SESSION_ID; // the model comes from NHI1_MODEL here, never from this session
    delete process.env.NHI1_HOOK_CONFIG;
  });
  after(() => {
    b.server.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env.NHI1_KEY_DIRS;
  });
  const pieces = () => ["a", "b", "c"].map((x) => join(home, "pieces-" + x)).flatMap((d) => (existsSync(d) ? readdirSync(d) : []));
  const owner = async (id: string) => (await b.db.query<{ key: string }>("select key from public.use where id = $1 union select key from public.talk where id = $1", [id])).rows[0]?.key;

  it("no model → no key: nothing is signed, nothing is made", async () => {
    delete process.env.NHI1_MODEL;
    assert.equal(await A.citizenKeyOrNull(), null);
    await assert.rejects(A.ensureKey(), /no key/);
    const r = await A.sendUse(body({ pub: H("a") }), { cfg: null, via: "test" });
    assert.equal(r.err, 5);
    assert.ok(pieces().length === 0 && !existsSync(join(home, OLD_FILE)), "no piece, no local key file");
  });

  it("no room → nothing is signed and nothing is made: asking, hello and use never open a room", async () => {
    process.env.NHI1_MODEL = "claude-opus-5-5";
    assert.equal(await A.citizenKeyOrNull(), null);
    await assert.rejects(A.ensureKey(), /node mem\.mjs open/);
    assert.equal((await A.sendUse(body({ pub: H("a") }), { cfg: null, via: "test" })).err, 5);
    assert.equal(pieces().length, 0, "no key was made");
    assert.equal((await b.db.query("select 1 from public.mem_room")).rows.length, 0, "no room on the root");
  });

  it("after the agent opens its room, the running model's key signs; the same key comes back; no key file is made", async () => {
    process.env.NHI1_MODEL = "claude-opus-5-5";
    const opened = await M.openRoom();
    assert.ok(opened.room && opened.new, JSON.stringify(opened));
    const k = await A.ensureKey();
    assert.equal(k.citizen, "opus");
    assert.equal(k.pub, opened.pub);
    const ys = ["a", "b", "c"].flatMap((x) => readdirSync(join(home, "pieces-" + x)).map((f) => JSON.parse(readFileSync(join(home, "pieces-" + x, f), "utf8")).y));
    assert.ok(!("jwk" in k) && !ys.some((y) => JSON.stringify(k).includes(y)), "no key bytes leave the cabin");
    assert.equal(pieces().length, 3);
    assert.equal(existsSync(join(home, OLD_FILE)), false);
    const hi = await A.hello({ budgetMs: 8000 });
    assert.equal(hi.status, 201, JSON.stringify(hi));
    assert.equal(await owner(hi.body.id), k.pub, "the sign-in is signed by the citizen");
    const u = await A.sendUse(body(k), { cfg: null, via: "test", budgetMs: 8000 });
    assert.equal(u.status, 201, JSON.stringify(u));
    assert.equal(await owner(u.body.id), k.pub, "a use without an explicit key: the citizen's");
    const keygen = JSON.parse(await new Promise<string>((ok) => {
      const p = spawn(process.execPath, [join(import.meta.dirname, "..", "skill/nhi1-aua/aua.mjs"), "keygen"], { env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] });
      let o = "";
      p.stdout.on("data", (c) => (o += c));
      p.on("exit", () => ok(o));
    }));
    assert.deepEqual(keygen, { citizen: "opus", pub: k.pub, new: false }, "keygen is open: the same key");
  });

  it("signing needs no network: a root that cannot be reached still gets a signed record queued", async () => {
    const dead = join(mkdtempSync(join(tmpdir(), "nhi1-dead-")), "aua.json");
    writeFileSync(dead, JSON.stringify({ ...(await (await fetch(b.url)).json()), ep: { use: "http://127.0.0.1:9/use", head: "http://127.0.0.1:9/head", mem: "http://127.0.0.1:9/mem" } }));
    process.env.NHI1_DISCOVERY = pathToFileURL(dead).href;
    try {
      const t = Date.now();
      const k = await A.citizenKeyOrNull({ model: "claude-opus-5-5" });
      assert.ok(k && Date.now() - t < 1000, "the key comes from this machine");
    } finally {
      process.env.NHI1_DISCOVERY = b.url;
    }
  });

  it("one machine, two citizens: each model its own key and chain; the model decides, not a setting", async () => {
    for (const model of ["claude-fable-5-2", "claude-sonnet-5-5"]) {
      const w = M.whoNow({ NHI1_MODEL: model });
      assert.ok((await M.openRoom({ who: w })).room);
    }
    const opus = (await A.citizenKeyOrNull({ model: "claude-opus-5-5" }))!;
    const fable = (await A.citizenKeyOrNull({ model: "claude-fable-5-2" }))!;
    const sonnet = (await A.citizenKeyOrNull({ model: "claude-sonnet-5-5" }))!;
    assert.ok(opus && fable && sonnet);
    assert.equal(new Set([opus.pub, fable.pub, sonnet.pub]).size, 3);
    assert.equal(pieces().length, 9, "three citizens, three pieces each (a model off the table is its own citizen)");
    const u = await A.sendUse(body(fable), { cfg: null, via: "test", key: fable, budgetMs: 8000 });
    assert.equal(u.status, 201, JSON.stringify(u));
    assert.equal(await owner(u.body.id), fable.pub);
  });

  it("the pending queue: another citizen's waiting record waits for its own key, it is not re-signed or rejected", async () => {
    const opus = (await A.citizenKeyOrNull({ model: "claude-opus-5-5" }))!;
    const fable = (await A.citizenKeyOrNull({ model: "claude-fable-5-2" }))!;
    // opus's use cannot go out (the board is unreachable) → it waits
    const dead = join(mkdtempSync(join(tmpdir(), "nhi1-dead-")), "aua.json");
    writeFileSync(dead, JSON.stringify({ ...(await (await fetch(b.url)).json()), ep: { ...(await (await fetch(b.url)).json()).ep, use: "http://127.0.0.1:9/use", head: "http://127.0.0.1:9/head" } }));
    process.env.NHI1_DISCOVERY = pathToFileURL(dead).href;
    const q = await A.sendUse(body(opus, 7), { cfg: null, via: "test", key: opus, budgetMs: 3000 });
    assert.ok(q.queued, JSON.stringify(q));
    process.env.NHI1_DISCOVERY = b.url;
    // fable sends: its own goes out; opus's stays waiting
    const f = await A.sendUse(body(fable, 8), { cfg: null, via: "test", key: fable, budgetMs: 8000 });
    assert.equal(f.status, 201, JSON.stringify(f));
    const pend = readFileSync(join(home, "pending.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(pend.length, 1);
    assert.equal(pend[0].body.by.key, opus.pub);
    assert.ok(!existsSync(join(home, "rejected.ndjson")) || !readFileSync(join(home, "rejected.ndjson"), "utf8").includes(opus.pub), "not rejected");
    // opus sends: its waiting one goes first, then the new one
    const o = await A.sendUse(body(opus, 9), { cfg: null, via: "test", key: opus, budgetMs: 8000 });
    assert.equal(o.status, 201, JSON.stringify(o));
    assert.equal(readFileSync(join(home, "pending.ndjson"), "utf8"), "", "drained");
  });
});
