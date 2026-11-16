// `node aua.mjs use <mcp-url> <tool>` (George 11/16: no hook; the agent sends its own use, if it decides to): the same
// record the hook used to send — fields, signature, prev chain, lease; what cannot go out waits in pending and flush
// sends it. Local board only, test key in a temp folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { sha256Hex } from "../supabase/functions/_shared/aua/canon.ts";
import { startLocalBoard } from "../tools/local-board.ts";
import { testPort } from "../tools/test-ports.ts";

const ROOT = join(import.meta.dirname, "..");
const URL_ = "https://mcp.use-cli-test.org/mcp";
const TOOL = { name: "search", inputSchema: { type: "object" }, outputSchema: { type: "object" } };

describe("aua.mjs use: the agent sends its own use", () => {
  let b: Awaited<ReturnType<typeof startLocalBoard>>;
  let home: string;
  let env: Record<string, string>;
  const run = (file: string, args: string[], over: Record<string, string> = {}) => new Promise<any>((ok) => {
    const p = spawn(process.execPath, [join(ROOT, "skill/nhi1-aua", file), ...args], { env: { ...env, ...over }, stdio: ["ignore", "pipe", "inherit"] });
    let o = "";
    p.stdout.on("data", (c) => (o += c));
    p.on("exit", () => ok(JSON.parse(o)));
  });
  before(async () => {
    b = await startLocalBoard(testPort(14));
    home = mkdtempSync(join(tmpdir(), "nhi1-usecli-"));
    env = { ...(process.env as Record<string, string>), NHI1_HOME: home, NHI1_DISCOVERY: b.url, NHI1_MODEL: "claude-opus-5-5", NHI1_RT: "test", NHI1_SANDBOX: "0" };
    delete env.CLAUDE_CODE_SESSION_ID;
    // tools/list for the public server, as the cache would hold it (no network in this test)
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", (await sha256Hex(new URL(URL_).href)) + ".json"), JSON.stringify({ t: Math.floor(Date.now() / 1000), tools: [TOOL] }));
  });
  after(() => {
    b.server.close();
    rmSync(home, { recursive: true, force: true });
  });
  const row = async (id: string) => (await b.db.query<{ key: string; rec: any }>("select key, rec from public.use where id = $1", [id])).rows[0];

  it("no room → not signed, nothing sent", async () => {
    const r = await run("aua.mjs", ["use", URL_, "search"]);
    assert.deepEqual(r, { status: 0, err: "no_room", see: "node mem.mjs open" });
    assert.equal((await b.db.query("select 1 from public.use")).rows.length, 0);
  });

  it("after open: received, signed by the citizen, on its chain; an ask's lease is redeemed", async () => {
    const o = await run("mem.mjs", ["open"]);
    assert.ok(o.room, JSON.stringify(o));
    const a = await run("aua.mjs", ["ask", URL_, "search"]);
    assert.match(a.lease, /^[0-9a-f]{64}$/);
    const u1 = await run("aua.mjs", ["use", URL_, "search", "--ms", "12", "--tin", "3", "--tout", "40", "--effect", "0"]);
    assert.equal(u1.status, 201, JSON.stringify(u1));
    assert.equal(u1.task, a.task);
    assert.equal(u1.lease, 1, "the lease from the ask was redeemed");
    const r1 = await row(u1.id);
    assert.equal(r1.key, o.pub, "signed by the citizen's key on this machine");
    assert.equal(r1.rec.prev, null, "the first link of the chain");
    assert.deepEqual([r1.rec.result, r1.rec.cost.ms, r1.rec.cost.tin, r1.rec.cost.tout, r1.rec.effect, r1.rec.stub], [{ code: 0, err: 0 }, 12, 3, 40, 0, null]);
    const u2 = await run("aua.mjs", ["use", URL_, "search", "--err"]);
    assert.equal(u2.status, 201, JSON.stringify(u2));
    const r2 = await row(u2.id);
    assert.equal(r2.rec.prev, u1.id, "the next link follows the first");
    assert.deepEqual([r2.rec.result, r2.rec.effect], [{ code: 2, err: 6 }, 2], "a failed call; effect defaults to 2 (no stub)");
  });

  it("the board out of reach → waits in pending; flush sends it, on the same chain", async () => {
    const wk = await (await fetch(b.url)).json();
    const dead = join(mkdtempSync(join(tmpdir(), "nhi1-usecli-dead-")), "aua.json");
    writeFileSync(dead, JSON.stringify({ ...wk, ep: { ...wk.ep, use: "http://127.0.0.1:9/use", head: "http://127.0.0.1:9/head" } }));
    const q = await run("aua.mjs", ["use", URL_, "search"], { NHI1_DISCOVERY: pathToFileURL(dead).href });
    assert.ok(q.status === 0 && q.queued, JSON.stringify(q));
    assert.equal(readFileSync(join(home, "pending.ndjson"), "utf8").trim().split("\n").length, 1);
    const f = await run("aua.mjs", ["flush"]);
    assert.ok(f && !f.err, JSON.stringify(f));
    assert.equal(readFileSync(join(home, "pending.ndjson"), "utf8"), "", "drained");
    const n = (await b.db.query("select 1 from public.use")).rows.length;
    assert.equal(n, 3);
  });

  it("a session that starts from nothing, no room: a key for this session only — ask works, nothing is left, open / use / talk refused", async () => {
    const sb = mkdtempSync(join(tmpdir(), "nhi1-sandbox-"));
    try {
      mkdirSync(join(sb, "cache"), { recursive: true });
      const cached = join(sb, "cache", (await sha256Hex(new URL(URL_).href)) + ".json");
      writeFileSync(cached, JSON.stringify({ t: Math.floor(Date.now() / 1000), tools: [TOOL] })); // stands for the MCP server (no network)
      const listing = () => {
        const out: string[] = [];
        const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(join(d, e.name)); };
        walk(sb);
        return out.sort();
      };
      const before = listing();
      const rooms0 = (await b.db.query("select 1 from public.mem_room")).rows.length;
      const uses0 = (await b.db.query("select 1 from public.use")).rows.length;
      const talks0 = (await b.db.query("select 1 from public.talk")).rows.length;
      const over = { NHI1_HOME: sb, NHI1_SANDBOX: "1", NHI1_MODEL: "gpt-5.6-sol" };
      const a = await run("aua.mjs", ["ask", URL_, "search"], over);
      assert.equal(a.status, 200, JSON.stringify(a));
      assert.match(a.lease, /^[0-9a-f]{64}$/);
      const a2 = await run("aua.mjs", ["ask", URL_, "search"], over);
      assert.equal(a2.status, 200);
      assert.deepEqual(listing(), before, "no file was left: no piece, no lease, no cache, no log");
      const o = await run("mem.mjs", ["open"], over);
      assert.deepEqual([o.room, o.err], [false, "sandbox"]);
      const u = await run("aua.mjs", ["use", URL_, "search"], over);
      assert.deepEqual(u, { status: 0, skipped: "temp_key", see: "node mem.mjs open" });
      const h = await run("aua.mjs", ["hello"], over);
      assert.equal(h.skipped, "temp_key", JSON.stringify(h));
      assert.deepEqual(listing(), before, "still nothing left");
      assert.equal((await b.db.query("select 1 from public.mem_room")).rows.length, rooms0, "no room registered");
      assert.equal((await b.db.query("select 1 from public.use")).rows.length, uses0, "no use");
      assert.equal((await b.db.query("select 1 from public.talk")).rows.length, talks0, "no talk");
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });

  it("a deny-listed address is never sent", async () => {
    writeFileSync(join(home, "hooks.local.json"), JSON.stringify({ deny: { hosts: ["*.use-cli-test.org"] } }));
    try {
      const r = await run("aua.mjs", ["use", URL_, "search"]);
      assert.deepEqual(r, { status: 0, skipped: "deny.host" });
    } finally {
      rmSync(join(home, "hooks.local.json"));
    }
  });
});
