// S4 B: stub re-runs (no tokens) against a fake MCP server. Bounds (Q8 (a), George 11/13): effect 0 only, never
// a flagged tool, no key sent, the answer never stored; fill rule $n → 1, $b → false, $s / $h left to rpf (Q5 (b));
// pass = no error, + fits the outputSchema when there is one (Q6 (a)); the view gives only verified stubs (Q11 (c)).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOf, ident } from "../supabase/functions/_shared/aua/canon.ts";
import { buildExport, handleAsk } from "../supabase/functions/_shared/aua/handlers.ts";
import { fillStub, fits, needsModel, overStub, runStubReplay } from "../supabase/functions/_shared/aua/rerun.ts";
import * as A from "../skill/nhi1-aua/aua.mjs";
import { AUA, deps, envelope, makeDb, nowSec, prevOf, putReplay, putUse, rpcFor, today } from "./helpers.ts";

const H = (c: string) => c.repeat(64);
const ADDR = "https://mcp.stub-test.org/mcp";
const MARK = "SECRET-ANSWER-MARK-7f3a";
const TOOL = { name: "lookup", description: "Look up an item by number.", inputSchema: { type: "object", properties: { id: { type: "number" }, full: { type: "boolean" } } } };
const rows = async (db: any, sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, any>[];

type Mode = "ok" | "isError" | "slow" | "401" | "bad-out";
function server(tools: Record<string, unknown>[] = [TOOL], mode: Mode = "ok", structured?: unknown) {
  const calls: Record<string, unknown>[] = [];
  const auth: (string | null)[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== ADDR) throw new TypeError("fetch failed");
    auth.push(new Headers(init.headers).get("authorization"));
    const m = JSON.parse(String(init.body));
    if (!("id" in m)) return new Response(null, { status: 202 });
    let result: unknown;
    if (m.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "f", version: "0" } };
    else if (m.method === "tools/list") result = { tools };
    else {
      calls.push(m.params);
      if (mode === "401") return new Response("no", { status: 401 });
      if (mode === "slow") {
        const e = new Error("timed out");
        e.name = "TimeoutError";
        throw e;
      }
      result = { content: [{ type: "text", text: MARK }], ...(structured !== undefined ? { structuredContent: structured } : {}), ...(mode === "isError" ? { isError: true } : {}) };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls, auth };
}
async function seed(db: any, o: { effect?: number; stub?: unknown; tool?: Record<string, unknown>; digest?: boolean } = {}) {
  const tool = o.tool ?? TOOL;
  const iface = await hashOf(tool);
  const k = await A.generateKey();
  const out = await hashOf((tool as { outputSchema?: unknown }).outputSchema ?? null);
  const rec = await A.signRecord({
    aua: AUA, thing: { addr: ADDR, iface }, call: { op: await ident(String(tool.name)), in: H("2"), out }, task: H("7"),
    result: { code: 0, err: 0 }, cost: { tin: 0, tout: 0, ms: 1, money: 0, cur: "" }, effect: o.effect ?? 0,
    by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub),
    stub: o.stub === null ? null : { in: o.stub ?? { id: "$n", full: "$b" }, out }, ...(o.digest === false ? {} : { from: [H("a")] }),
  }, k);
  const r = await putUse(await envelope(rec, k), deps(db));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { use: (r.body as { id: string }).id, thing: await hashOf({ addr: ADDR, iface }), key: k };
}
const sd = async (db: any, net: { fetch: unknown }) =>
  ({ rpc: rpcFor(db), fetch: net.fetch as never, now: () => new Date(), signer: await A.generateKey() as never, aua: AUA });
const on = (db: any) => db.exec("update public.knob set val = 1 where name = 'replay_on'");
const view = async (db: any) => {
  const k = await A.generateKey();
  return ((await handleAsk(await A.signRecord({ aua: AUA, task: H("7"), by: { key: k.pub, model: H("6"), rt: H("5") }, t: nowSec() }, k), deps(db))).body as any).view;
};

describe("S4 B: the fill rule and the pass definition", () => {
  it("$n → 1, $b → false, fixed leaves kept; $s / $h need a model; a model's values only fill placeholders", () => {
    assert.deepEqual(fillStub({ id: "$n", full: "$b1", k: H("a"), deep: { x: 2, y: null } }), { id: 1, full: false, k: H("a"), deep: { x: 2, y: null } });
    assert.throws(() => fillStub({ q: "$s" }), /needs a model/);
    assert.deepEqual([needsModel({ q: "$s" }), needsModel({ a: { h: "$h2" } }), needsModel({ id: "$n" })], [true, true, false]);
    assert.deepEqual(overStub({ q: "$s", n: 3 }, { q: "x", n: 9, extra: 1 }), { q: "x", n: 3 });
    assert.equal(overStub({ q: "$s" }, {}), null, "an unfilled placeholder: no call");
  });
  it("fits: type, required, properties, items, enum", () => {
    const s = { type: "object", required: ["a"], properties: { a: { type: "integer" }, b: { type: "array", items: { enum: ["x"] } } } };
    assert.equal(fits(s, { a: 1, b: ["x"] }), true);
    assert.equal(fits(s, { a: 1.5 }), false);
    assert.equal(fits(s, { b: [] }), false);
    assert.equal(fits(s, { a: 1, b: ["y"] }), false);
  });
});

describe("S4 B: stub re-runs in the wind tunnel", () => {
  it("off by default (replay_on 0): nothing is called", async () => {
    const db = await makeDb();
    await seed(db);
    const net = server();
    assert.equal((await runStubReplay(await sd(db, net))).status, "off");
    assert.equal(net.calls.length, 0);
  });

  it("an effect-0 digest stub is called once with the filled values and no key; a code-0 replay_result; the answer is stored nowhere; the view now gives the stub", async () => {
    const db = await makeDb();
    await on(db);
    const s = await seed(db);
    assert.equal((await view(db))[0].stub, null, "not served before the wind tunnel re-ran it (Q11 (c))");
    const net = server();
    const o = await runStubReplay(await sd(db, net));
    assert.deepEqual(o, { status: "ran", ran: 1, pass: 1, fail: 0 });
    assert.deepEqual(net.calls, [{ name: "lookup", arguments: { id: 1, full: false } }]);
    assert.ok(net.auth.every((a) => a === null), "no key or credential sent");
    const rr = await rows(db, "select use_id, how, code, req_id, fam from public.replay_result");
    assert.deepEqual(rr, [{ use_id: s.use, how: 0, code: 0, req_id: null, fam: null }]);
    const v = (await view(db))[0];
    assert.notEqual(v.stub, null, "verified → served");
    assert.deepEqual(v.rp, { tried: 1, pass: 1 });
    const { text } = await buildExport(rpcFor(db));
    assert.ok(text.includes('"table":"replay_result"'), "the record is in the export / replica");
    assert.ok(!text.includes(MARK), "the tool's answer is in no record");
    const dump = JSON.stringify((await db.query("select * from public.replay_result")).rows) + JSON.stringify((await db.query("select * from public.rpf_log")).rows);
    assert.ok(!dump.includes(MARK));
    // not again within replay_gap_days
    assert.equal((await runStubReplay(await sd(db, net))).ran, 0);
  });

  it("isError → code 2 and the stub stops being served; outputSchema not met → code 1; auth / timeout → their err codes", async () => {
    const db = await makeDb();
    await on(db);
    await seed(db);
    await runStubReplay(await sd(db, server()));
    await db.exec("update public.knob set val = 0 where name = 'replay_gap_days'");
    await runStubReplay(await sd(db, server([TOOL], "isError")));
    assert.deepEqual((await rows(db, "select code, err from public.replay_result order by created_at desc limit 1"))[0], { code: 2, err: 6 });
    assert.equal((await view(db))[0].stub, null, "the latest re-run failed → no stub");
    for (const [mode, err] of [["401", 2], ["slow", 1]] as const) {
      const d2 = await makeDb();
      await on(d2);
      await seed(d2);
      await runStubReplay(await sd(d2, server([TOOL], mode)));
      assert.deepEqual((await rows(d2, "select code, err from public.replay_result"))[0], { code: 2, err }, mode);
    }
    const OUT = { ...TOOL, name: "typed", outputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } } };
    const d3 = await makeDb();
    await on(d3);
    await seed(d3, { tool: OUT });
    await runStubReplay(await sd(d3, server([OUT], "ok", { nope: 1 })));
    assert.deepEqual((await rows(d3, "select code, pass from public.replay_result"))[0], { code: 1, pass: false }, "answered, not to its outputSchema: partial");
    const d4 = await makeDb();
    await on(d4);
    await seed(d4, { tool: OUT });
    await runStubReplay(await sd(d4, server([OUT], "ok", { title: "x" })));
    assert.equal((await rows(d4, "select code from public.replay_result"))[0].code, 0);
  });

  it("interface changed → 0 tools/call, code 2 err 8; effect 1, a flagged tool, a $s stub → never called", async () => {
    const db = await makeDb();
    await on(db);
    await seed(db);
    const net = server([{ ...TOOL, description: "Look up, now different." }]);
    await runStubReplay(await sd(db, net));
    assert.equal(net.calls.length, 0, "no call");
    assert.deepEqual((await rows(db, "select code, err from public.replay_result"))[0], { code: 2, err: 8 });

    const d2 = await makeDb();
    await on(d2);
    await seed(d2, { effect: 1 });
    const s = await seed(d2, { stub: { q: "$s" } });
    const f = await seed(d2);
    await d2.query("insert into public.wind_flag (thing_id, rule) values ($1, 1)", [f.thing]);
    const n2 = server();
    const o = await runStubReplay(await sd(d2, n2));
    assert.equal(o.ran, 0);
    assert.equal(n2.calls.length, 0, "effect 1, $s and flagged: nothing called");
    void s;
  });

  it("a citizen's replay request is run first and answered (req set); replay_batch 0 runs nothing", async () => {
    const db = await makeDb();
    await on(db);
    const a = await seed(db);
    const b = await seed(db, { digest: false }); // a stub that is not from the digest: only re-run when asked
    const k = await A.generateKey();
    const rq = await A.signRecord({ aua: AUA, use: b.use, by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub) }, k);
    const r = await putReplay(await envelope(rq, k), deps(db));
    await db.exec("update public.knob set val = 0 where name = 'replay_batch'");
    assert.equal((await runStubReplay(await sd(db, server()))).ran, 0);
    await db.exec("update public.knob set val = 1 where name = 'replay_batch'");
    await runStubReplay(await sd(db, server()));
    const rr = await rows(db, "select use_id, req_id from public.replay_result");
    assert.deepEqual(rr, [{ use_id: b.use, req_id: (r.body as { id: string }).id }], "the request first, answered");
    void a;
  });
});
