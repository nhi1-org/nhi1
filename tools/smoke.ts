// Smoke test: the agent opens its room (its key made on this machine, three pieces) → signed ask about a public MCP tool
// (0 views, lease bound to the key) → call it as `call` says (no stub yet) → the agent sends its own use (no hook since
// 2026-11-16) → ask again: n.ok=1, ind.keys=1.
//   node tools/smoke.ts          always against an in-process board (PGlite). S2: tests never write the
//                                live board — its first record belongs to the first citizen.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const local = true; // never the live board
const MCP = "https://mcp.deepwiki.com/mcp";
const TOOL = "read_wiki_structure";
const ARGS = { repoName: "modelcontextprotocol/typescript-sdk" };

const say = (n: number, s: string) => console.log(`[${n}] ${s}`);
const homeDir = mkdtempSync(join(tmpdir(), "nhi1-smoke-"));
process.env.NHI1_HOME = homeDir;
const pieceDirs = ["a", "b", "c"].map((x) => join(homeDir, "pieces-" + x)); // never the real ones: made here, removed at the end
process.env.NHI1_KEY_DIRS = pieceDirs.join(delimiter);
process.env.NHI1_SANDBOX = "0";
process.env.NHI1_MODEL = "claude-opus-5-5"; // the model this run stands for (not this session's transcript)
delete process.env.CLAUDE_CODE_SESSION_ID;
let stop: (() => void) | undefined;
if (local) {
  const { startLocalBoard } = await import("./local-board.ts");
  const { testPort } = await import("./test-ports.ts");
  const b = await startLocalBoard(testPort(9));
  process.env.NHI1_DISCOVERY = b.url;
  stop = () => b.server.close();
}
const A = await import("../skill/nhi1-aua/aua.mjs");
const disc = await A.discover();
say(0, `board ${process.env.NHI1_DISCOVERY || A.DEFAULT_DISCOVERY} · aua ${disc.aua.slice(0, 12)}…`);

// 1. key: no room → nothing is signed; the agent opens its room itself (the key is made here, in three pieces)
assert.equal(await A.citizenKeyOrNull(), null, "no room yet: no key, and none is made by asking");
const M = await import("../skill/nhi1-aua/mem.mjs");
const opened = await M.openRoom();
assert.ok(opened.room && opened.new && opened.pieces === 3 && opened.reg === "new", JSON.stringify(opened));
const key = await A.ensureKey();
assert.equal(key.citizen, "opus");
assert.equal(key.pub, opened.pub);
assert.deepEqual(pieceDirs.map((d) => readdirSync(d).length), [1, 1, 1], "one piece in each of the three places");
assert.equal(existsSync(join(homeDir, "key.jwk")), false, "no local key file");
say(1, `citizen ${key.citizen} key ${key.pub.slice(0, 16)}… (three pieces on this machine; the root has the public half)`);

// 2. ask (expect 0 views + lease)
const tools = await A.toolsCached(MCP);
const tool = tools.find((t: { name: string }) => t.name === TOOL);
assert.ok(tool, "tool exists on the public MCP server");
const h = await A.toolHashes(tool);
const task = await A.taskOf(h.in, h.out);
const a1 = await A.ask({ task });
assert.equal(a1.status, 200, "ask 200");
assert.match(a1.lease, /^[0-9a-f]{64}$/, "lease returned");
const mine1 = a1.views.filter((v: any) => v.call.op === h.op && v.thing.addr === MCP);
say(2, `ask → ${a1.views.length} views (${mine1.length} for this tool), lease ${a1.lease.slice(0, 12)}…, stub ${mine1[0]?.stub ? "yes" : "none"}`);

// 3. call it ourselves, as `call` says (op/in/out); the board never calls anything
const m = new A.McpHttp(MCP, 60000);
await m.init();
const t0 = Date.now();
const out = await m.call(TOOL, ARGS);
const ms = Date.now() - t0;
say(3, `called ${TOOL} → ${out?.isError ? "error" : "ok"} in ${ms} ms`);

// 4. the agent sends its own use (signed here; there is no hook)
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
const rec = await A.makeUse({
  addr: MCP, iface: h.iface, op: h.op, in: h.in, out: h.out, task, code: out?.isError ? 2 : 0, err: out?.isError ? 6 : 0,
  tin: Math.ceil(bytes(ARGS) / 4), tout: Math.ceil(bytes(out) / 4), ms, money: 0, cur: "", effect: 0,
  model: await A.ident("claude-opus-5-5"), rt: await A.ident("smoke"), stub: null, lease: A.takeLease(task),
}, key);
const sent = await A.sendUse(rec, { cfg: { deny: { hosts: ["*.supabase.co"] } }, via: "smoke", key, budgetMs: 8000 });
assert.ok(sent.status === 201 || sent.status === 200, "use accepted: " + JSON.stringify(sent));
say(4, `use → ${sent.body?.id?.slice(0, 12)}… status ${sent.status}, lease redeemed ${sent.body?.lease}`);

// 5. ask again — the view shows our record
const a2 = await A.ask({ task });
const v = a2.views.find((x: any) => x.call.op === h.op && x.thing.addr === MCP);
assert.ok(v, "view for this tool present");
assert.match(a2.lease, /^[0-9a-f]{64}$/);
say(5, `ask → n.ok=${v.n.ok} ind.keys=${v.ind.keys} lease ${v.lease.slice(0, 12)}… cost.ms=${v.cost.ms}`);
if (local) {
  assert.equal(v.n.ok, 1);
  assert.equal(v.ind.keys, 1);
}
console.log("SMOKE OK");
stop?.();
rmSync(homeDir, { recursive: true, force: true }); // the test key's pieces go with it
process.exit(0);
