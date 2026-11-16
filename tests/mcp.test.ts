import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
