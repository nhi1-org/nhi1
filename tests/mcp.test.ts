import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpHttp } from "../skill/nhi1-aua/aua.mjs";
import { startLocalBoard } from "../tools/local-board.ts";
import { testPort } from "../tools/test-ports.ts";

// NHI-2: a citizen's key is on this machine (made when the agent opens its room), chosen by the running model.
// These tests stand for one model, whatever session runs them; the key lives in a temp folder.
process.env.NHI1_MODEL = "claude-opus-5-5";
delete process.env.CLAUDE_CODE_SESSION_ID;

const ROOT = join(import.meta.dirname, "..");
const TASK = "7".repeat(64);

describe("MCP server exposes ask / use / replay", () => {
  let board: Awaited<ReturnType<typeof startLocalBoard>>;
  let proc: ReturnType<typeof spawn>;
  const home = mkdtempSync(join(tmpdir(), "nhi1-mcp-"));
  const env = () => ({ ...process.env, NHI1_DISCOVERY: board.url, NHI1_HOME: home, NHI1_SANDBOX: "0" });
  before(async () => {
    board = await startLocalBoard(testPort(2));
    // no room → the server cannot sign an ask; the agent opens its room itself first
    const o = spawn(process.execPath, [join(ROOT, "skill/nhi1-aua/mem.mjs"), "open"], { env: env(), stdio: ["ignore", "ignore", "ignore"] });
    await new Promise((ok) => o.on("exit", ok));
    proc = spawn(process.execPath, [join(ROOT, "mcp/server.ts"), "--http", String(testPort(3))], { env: env(), stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((ok) => proc.stderr!.on("data", (d) => String(d).includes("MCP on") && ok()));
  });
  after(() => {
    proc.kill();
    board.server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("HTTP: tools/list has exactly ask, use, replay, wall; ask returns a lease", async () => {
    const m = new McpHttp(`http://127.0.0.1:${testPort(3)}/mcp`);
    await m.init();
    const names = (await m.tools()).map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ["ask", "replay", "use", "wall"]);
    const r = await m.call("ask", { task: TASK });
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.status, 200);
    assert.match(body.lease, /^[0-9a-f]{64}$/);
  });

  it("stdio: same four tools", async () => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp/server.ts")], env: env() as Record<string, string> }));
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ask", "replay", "use", "wall"]);
    const r = await c.callTool({ name: "use", arguments: { record: { note: "free text" } } });
    const body = JSON.parse((r.content as { text: string }[])[0].text);
    assert.ok(body.err === 5 || body.status === 400, "unsigned record without a key / free text is refused");
    await c.close();
  });
});

// MCP 0.1.1 (Opus 11/17): a client that installed only the MCP server — no room on this machine, no NHI1_MODEL,
// no Claude Code transcript — still reads: ask is signed with a key that lives only in that process. A use is
// skipped (nothing sent), and no key piece is written anywhere.
describe("MCP with no room and no model: reads with a process-only key, never writes", () => {
  let board: Awaited<ReturnType<typeof startLocalBoard>>;
  const home = mkdtempSync(join(tmpdir(), "nhi1-mcp-bare-"));
  const pieces = ["a", "b", "c"].map((x) => join(home, "pieces-" + x));
  const env = () => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|NHI1_)/.test(k)) e[k] = v;
    return { ...e, NHI1_DISCOVERY: board.url, NHI1_HOME: home, NHI1_SANDBOX: "0", NHI1_KEY_DIRS: pieces.join(delimiter) };
  };
  before(async () => { board = await startLocalBoard(testPort(16)); });
  after(() => { board.server.close(); rmSync(home, { recursive: true, force: true }); });

  it("ask → 200 with a lease (signed); use → skipped; no record, no room, no piece", async () => {
    const n = async () => (await board.db.query<{ u: number; t: number; r: number }>(
      "select (select count(*)::int from public.use) u, (select count(*)::int from public.talk) t, (select count(*)::int from public.mem_room) r")).rows[0];
    const before0 = await n();
    const c = new Client({ name: "bare", version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp/server.ts")], env: env() }));
    try {
      const a = JSON.parse((await c.callTool({ name: "ask", arguments: { task: TASK } }) as { content: { text: string }[] }).content[0].text);
      assert.equal(a.status, 200, JSON.stringify(a));
      assert.match(a.lease, /^[0-9a-f]{64}$/);
      const lease = (await board.db.query<{ key: string }>("select key from public.lease where id = $1", [a.lease])).rows[0];
      assert.match(lease.key, /^[0-9a-f]{64}$/, "the ask was signed: the lease is bound to a key");
      const rec = { aua: "x", thing: { addr: "https://example.com/mcp", iface: TASK }, task: TASK, op: TASK, res: 0, effect: 2 };
      const u = JSON.parse((await c.callTool({ name: "use", arguments: { record: rec } }) as { content: { text: string }[] }).content[0].text);
      assert.equal(u.skipped, "no_room", JSON.stringify(u));
    } finally {
      await c.close();
    }
    assert.deepEqual(await n(), before0, "no use, no talk, no room on the board");
    for (const d of pieces) assert.equal(existsSync(d) ? readdirSync(d).length : 0, 0, "no key piece in " + d);
    assert.ok(!existsSync(join(home, "citizen")) || readdirSync(join(home, "citizen")).length === 0, "no piece under HOME");
  });
});
