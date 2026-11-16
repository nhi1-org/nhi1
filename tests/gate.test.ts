// The local deny list (~/.nhi1/hooks.local.json) is checked in sendUse(), the one function every use
// leaves through. Two paths — MCP `use` tool, library (there is no hook since 2026-11-16) — each try to send
// a denied addr; a counting stand-in board proves nothing reached it (and that an allowed addr does).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { AUA, generateKey, McpHttp, sendUse, signRecord } from "../skill/nhi1-aua/aua.mjs";
import { testPort } from "../tools/test-ports.ts";

const ROOT = join(import.meta.dirname, "..");
const H = (c: string) => c.repeat(64);
const CFG = {
  send: true,
  deny: {
    rules: ["localhost", "private-ip", "query", "userinfo"],
    servers: ["*corp*"],
    hosts: ["*.supabase.co", "corp-secret.*", "*.corp-secret.*"],
    hostExceptions: [],
  },
  servers: { corp: { url: "https://api.corp-secret.ai/mcp" }, pub: { url: "https://mcp.public-tools.org/mcp" } },
};

let lastKey: Awaited<ReturnType<typeof generateKey>>;
async function useRec(addr: string) {
  const k = (lastKey = await generateKey());
  return signRecord({
    aua: H("9"), thing: { addr, iface: H("1") }, call: { op: H("2"), in: H("3"), out: H("4") }, task: H("5"),
    result: { code: 0, err: 0 }, cost: { tin: 1, tout: 1, ms: 1, money: 0, cur: "" }, effect: 0,
    by: { key: k.pub, model: H("6"), rt: H("7") }, t: Math.floor(Date.now() / 1000), stub: null,
  }, k);
}

describe("local deny-list gate in sendUse (MCP use · library)", () => {
  let board: Server;
  let posts = 0;
  let mcp: ReturnType<typeof spawn>;
  const home = mkdtempSync(join(tmpdir(), "nhi1-gate-"));
  const cfgPath = join(home, "hooks.local.json");
  const MCP_PORT = testPort(0);

  before(async () => {
    board = createServer((req, res) => {
      if (req.method === "POST") posts++;
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: H("a"), lease: 0, dup: 0 }));
    });
    await new Promise<void>((ok) => board.listen(0, "127.0.0.1", ok));
    const port = (board.address() as { port: number }).port;
    const disc = join(home, "aua.json");
    writeFileSync(disc, JSON.stringify({ aua: AUA, ep: { ask: `http://127.0.0.1:${port}/ask`, use: `http://127.0.0.1:${port}/use` } }));
    writeFileSync(cfgPath, JSON.stringify(CFG));
    process.env.NHI1_DISCOVERY = pathToFileURL(disc).href;
    process.env.NHI1_HOME = home;
    process.env.NHI1_HOOK_CONFIG = cfgPath;
    mcp = spawn(process.execPath, [join(ROOT, "mcp/server.ts"), "--http", String(MCP_PORT)], { env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((ok) => mcp.stderr!.on("data", (d) => String(d).includes("MCP on") && ok()));
  });
  after(() => {
    mcp.kill();
    board.close();
  });

  it("library: sendUse() refuses a denied addr, sends an allowed one", async () => {
    const before = posts;
    const r = await sendUse(await useRec("https://abc.supabase.co/functions/v1/mcp"));
    assert.equal(r.status, 0);
    assert.equal(r.skipped, "deny.host");
    assert.equal(posts, before, "nothing reached the board");
    const ok = await sendUse(await useRec("https://mcp.public-tools.org/mcp"), { key: lastKey });
    assert.equal(ok.status, 201, "control: an allowed addr is sent");
    assert.equal(posts, before + 1);
  });

  it("MCP `use` tool: a signed record with a denied addr is refused before it leaves", async () => {
    const before = posts;
    const m = new McpHttp(`http://127.0.0.1:${MCP_PORT}/mcp`);
    await m.init();
    for (const [addr, why] of [["https://api.corp-secret.ai/mcp", "deny.server"], ["https://x.supabase.co/mcp", "deny.host"], ["https://mcp.public-tools.org/mcp?key=1", "deny.rule.query"]]) {
      const r = await m.call("use", { record: await useRec(addr) });
      assert.deepEqual(JSON.parse(r.content[0].text), { status: 0, skipped: why }, addr);
    }
    assert.equal(posts, before, "nothing reached the board");
  });

  it("blocked sends are logged locally, never sent", () => {
    const lines = readFileSync(join(home, "send.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.via === "lib" && l.skip === "deny.host"));
    assert.ok(lines.some((l) => l.via === "mcp" && l.skip === "deny.server"));
    assert.ok(lines.every((l) => !("addr" in l)), "send.log keeps no addr");
    assert.equal(existsSync(join(home, "key.jwk")), false, "nothing was signed with a local key");
  });
});
