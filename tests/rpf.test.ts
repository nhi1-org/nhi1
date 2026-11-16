// Cross-family re-runs (rpf, replay_result how 1) with a fake OpenAI and a fake MCP server (George 11/13; S4):
// the family and the model are filled in by the wind tunnel, Claude never fills rpf, its own day cap, read-only
// tools only, the result is a wind-signed record pointing straight at the use (Q3 (b)), the view and the talk
// ordering count it, the daily report shows the spend as an estimate and says when the model cannot be called.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOf, ident, verifyRecord } from "../supabase/functions/_shared/aua/canon.ts";
import { handleAsk } from "../supabase/functions/_shared/aua/handlers.ts";
import { dailyText, lightOf, reportNumbers } from "../supabase/functions/_shared/aua/report.ts";
import { rpfUsd, runRpf, type RpfModel, type RpfReq } from "../supabase/functions/_shared/aua/rpf.ts";
import { SCHEMA } from "../supabase/functions/_shared/aua/schema.ts";
import { validateReplayResult } from "../supabase/functions/_shared/aua/validate.ts";
import * as A from "../skill/nhi1-aua/aua.mjs";
import { AUA, deps, envelope, makeDb, nowSec, prevOf, putReplay, putUse, rpcFor, today } from "./helpers.ts";

const H = (c: string) => c.repeat(64);
const ADDR = "https://mcp.rpf-test.org/mcp";
const TOOL = { name: "search", description: "Search the docs. Returns matching titles.", inputSchema: { type: "object", properties: { q: { type: "string" }, n: { type: "number" } }, required: ["q"] } };
const rows = async (db: any, sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, any>[];
const on = (db: any) => db.exec("update public.knob set val = 1 where name = 'replay_on'");

/** a fake MCP server: tools/list → TOOL; tools/call → ok, or isError when `q` is missing */
export function fakeMcp(tools: Record<string, unknown>[] = [TOOL], addr = ADDR, answer = "Doc A") {
  const calls: Record<string, unknown>[] = [];
  const auth: (string | null)[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== addr) throw new TypeError("fetch failed (unreachable)");
    auth.push(new Headers(init.headers).get("authorization"));
    const m = JSON.parse(String(init.body));
    if (!("id" in m)) return new Response(null, { status: 202 });
    let result: unknown;
    if (m.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } };
    else if (m.method === "tools/list") result = { tools };
    else {
      calls.push(m.params);
      result = typeof m.params.arguments?.q === "string" ? { content: [{ type: "text", text: answer }] } : { content: [{ type: "text", text: "q required" }], isError: true };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls, auth };
}
function fakeGpt(args: string | "fail" | "gone", family = "openai", tin = 1000, tout = 100) {
  const seen: RpfReq[] = [];
  const m: RpfModel = {
    family, model: "gpt-5.6-sol",
    call: async (req) => {
      seen.push(req);
      if (args === "fail") return { ok: false, err: "network" };
      if (args === "gone") return { ok: false, err: "model_gone", model: "gpt-5.6-sol" };
      return { ok: true, out: { arguments_json: args }, model: "gpt-5.6-sol", tin, tout };
    },
  };
  return { m, seen };
}
async function seed(db: any, effect = 0, stub: Record<string, unknown> | null = null) {
  const iface = await hashOf(TOOL);
  const k = await A.generateKey();
  const rec = await A.signRecord({
    aua: AUA, thing: { addr: ADDR, iface }, call: { op: await ident("search"), in: H("2"), out: H("3") }, task: H("7"),
    result: { code: 0, err: 0 }, cost: { tin: 1, tout: 1, ms: 1, money: 0, cur: "" }, effect,
    by: { key: k.pub, model: await ident("claude-opus-5-5"), rt: await ident("claude-code") }, t: today(), prev: prevOf(k.pub),
    stub: stub ? { in: stub, out: H("3") } : null, ...(stub ? { from: [H("a")] } : {}),
  }, k);
  const r = await putUse(await envelope(rec, k), deps(db));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const thing = await hashOf({ addr: ADDR, iface });
  await db.query("insert into public.wind_check (thing_id, result, tools) values ($1, 0, 1)", [thing]);
  return { use: (r.body as { id: string }).id, key: k, thing };
}
const wind = async () => ({ signer: await A.generateKey() as { pub: string; jwk: JsonWebKey } });
const rd = (db: any, net: ReturnType<typeof fakeMcp>, m: RpfModel | undefined, signer: { pub: string; jwk: JsonWebKey }) =>
  ({ rpc: rpcFor(db), fetch: net.fetch as never, now: () => new Date(), rpfModel: m, signer, aua: AUA });

describe("rpf: cross-family re-runs in the wind tunnel (George 11/13: OpenAI gpt-5.6-sol)", () => {
  it("GPT writes the call; the wind tunnel calls the read-only tool with no key, signs a replay_result that points at the use; family and model filled in", async () => {
    const db = await makeDb();
    await on(db);
    const s = await seed(db);
    const net = fakeMcp(), gpt = fakeGpt('{"q":"install"}'), { signer } = await wind();
    const out = await runRpf(rd(db, net, gpt.m, signer));
    assert.deepEqual({ ...out, usd: undefined }, { status: "ran", state: 0, ran: 1, pass: 1, fail: 0, skipped: 0, usd: undefined });
    assert.ok(gpt.seen[0].input.includes("Search the docs"), "GPT sees the tool's interface");
    assert.ok(!gpt.seen.some((x) => x.input.includes("Doc A")), "the tool's answer never reaches a model");
    assert.deepEqual(net.calls, [{ name: "search", arguments: { q: "install" } }], "the board calls the tool with GPT's arguments");
    assert.ok(net.auth.every((a) => a === null), "no key or credential is sent to the tool");
    const rr = await rows(db, "select * from public.replay_result");
    assert.equal(rr.length, 1);
    assert.equal(rr[0].req_id, null, "the wind tunnel signs no replay request (S4 Q3 (b))");
    assert.equal((await rows(db, "select count(*)::int n from public.replay"))[0].n, 0);
    assert.deepEqual([rr[0].use_id, rr[0].how, rr[0].code, rr[0].pass], [s.use, 1, 0, true]);
    assert.equal(rr[0].fam, await ident("openai"), "family = the adapter's, filled in by the wind tunnel");
    assert.equal(rr[0].model, await ident("gpt-5.6-sol"));
    assert.equal(rr[0].by_key, signer.pub, "signed by the wind key");
    assert.ok(await verifyRecord(rr[0].rec, signer.pub), "the record verifies with the wind key");
    assert.equal(validateReplayResult(rr[0].rec), 0, "the record fits SCHEMA records.replay_result");
    assert.equal(JSON.stringify(rr[0].rec).includes("Doc A"), false, "the answer is not stored");
    // counted: view rpf (not rp) and the signer's talk ordering
    const ask = await handleAsk(await A.signRecord({ aua: AUA, task: H("7"), by: { key: s.key.pub, model: H("6"), rt: H("7") }, t: nowSec() }, s.key), deps(db));
    assert.deepEqual([(ask.body as any).view[0].rpf, (ask.body as any).view[0].rp], [{ fams: 1, pass: 1 }, { tried: 0, pass: 0 }]);
    assert.equal(Number((await rows(db, "select public.aua_talk_w($1) w", [s.key.pub]))[0].w), 1);
    // once per use and family
    assert.equal((await runRpf(rd(db, net, gpt.m, signer))).ran, 0, "not re-run by the same family");
    const cost = await rows(db, "select role, tin, tout, usd from public.cost");
    assert.deepEqual(cost.map((c) => [c.role, Number(c.tin), Number(c.tout)]), [[2, 1000, 100]], "booked as role 2");
    assert.equal(Number(cost[0].usd), (1000 * 4 + 100 * 20) / 1e6, "gpt-5.6-sol at OpenAI's official 4 / 20 per M");
  });

  it("a failed call is a failed run (code 2); no answer is no run; Claude never fills rpf; no key / switched off are their own states", async () => {
    const db = await makeDb();
    await on(db);
    await seed(db);
    const { signer } = await wind();
    const bad = await runRpf(rd(db, fakeMcp(), fakeGpt('{"n":1}').m, signer));
    assert.equal(bad.fail, 1, "the tool answers isError → fail, recorded");
    assert.deepEqual((await rows(db, "select code, err, pass from public.replay_result"))[0], { code: 2, err: 6, pass: false });
    const db2 = await makeDb();
    await on(db2);
    await seed(db2);
    await assert.rejects(runRpf(rd(db2, fakeMcp(), fakeGpt('{"q":"x"}', "anthropic").m, signer)), /never fills rpf/);
    assert.deepEqual([(await runRpf(rd(db2, fakeMcp(), undefined, signer))).state], [1], "no OPENAI_API_KEY → state 1 no_key");
    await db2.exec("update public.knob set val = 0 where name = 'replay_on'");
    const off = fakeGpt('{"q":"x"}');
    assert.equal((await runRpf(rd(db2, fakeMcp(), off.m, signer))).state, 2, "replay_on = 0 → state 2, nothing called");
    assert.equal(off.seen.length, 0);
  });

  it("a withdrawn model, or one that never answers, is state 4 in the daily report — never a quiet 0", async () => {
    const db = await makeDb();
    await on(db);
    await seed(db);
    await seed(db);
    const { signer } = await wind();
    const gone = await runRpf(rd(db, fakeMcp(), fakeGpt("gone").m, signer));
    assert.deepEqual([gone.status, gone.state, gone.ran, gone.err], ["down", 4, 0, "model_gone"]);
    const flaky = await runRpf(rd(db, fakeMcp(), fakeGpt("fail").m, signer));
    assert.deepEqual([flaky.state, flaky.skipped], [4, 2], "every call got no answer → cannot be called");
    const n = (await rows(db, "select public.aua_report_numbers(now() - interval '1 day', now() + interval '1 day') n"))[0].n;
    assert.deepEqual([n.rpf_state, n.rpf_runs, n.rpf_model], [4, 0, "gpt-5.6-sol"]);
    assert.equal(lightOf(n), 1, "yellow");
    const text = dailyText({ ...n, asks: 0, ask_bytes: 0 }, "x", 1);
    assert.match(text, /叫不動/);
    assert.match(text, /實際以 OpenAI 後台為準/, "the spend is said to be an estimate");
    const fields = reportNumbers(n);
    assert.equal(fields[(SCHEMA.report_fields as readonly string[]).indexOf("rpf_state")], 4, "report record field rpf_state = 4");
  });

  it("only read-only, unflagged tools whose interface is the same; a changed interface is skipped", async () => {
    const db = await makeDb();
    await on(db);
    await seed(db, 1);
    const { signer } = await wind();
    const net = fakeMcp();
    assert.equal((await runRpf(rd(db, net, fakeGpt('{"q":"x"}').m, signer))).ran, 0, "effect 1 is never called");
    const db2 = await makeDb();
    await on(db2);
    const s = await seed(db2);
    await db2.query("insert into public.wind_flag (thing_id, rule) values ($1, 1)", [s.thing]);
    assert.equal((await runRpf(rd(db2, net, fakeGpt('{"q":"x"}').m, signer))).ran, 0, "flagged → not called");
    const db3 = await makeDb();
    await on(db3);
    await seed(db3);
    const changed = fakeMcp([{ ...TOOL, description: "Search, now different." }]);
    const o = await runRpf(rd(db3, changed, fakeGpt('{"q":"x"}').m, signer));
    assert.deepEqual([o.ran, o.skipped, changed.calls.length], [0, 1, 0], "interface changed → skipped, never called");
    assert.equal(net.calls.length, 0);
  });

  it("a stub with $s: GPT fills only the placeholders, the stub's fixed leaves win; a citizen's request for it is answered (req set)", async () => {
    const db = await makeDb();
    await on(db);
    const s = await seed(db, 0, { q: "$s", n: 3 });
    const k = await A.generateKey();
    const rq = await A.signRecord({ aua: AUA, use: s.use, by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub) }, k);
    const r = await putReplay(await envelope(rq, k), deps(db));
    assert.equal(r.status, 202);
    const net = fakeMcp(), gpt = fakeGpt('{"q":"install","n":99}'), { signer } = await wind();
    await runRpf(rd(db, net, gpt.m, signer));
    assert.ok(gpt.seen[0].input.includes("call_template"));
    assert.deepEqual(net.calls, [{ name: "search", arguments: { q: "install", n: 3 } }], "n stays 3 from the stub");
    const rr = await rows(db, "select req_id from public.replay_result");
    assert.deepEqual(rr.map((x) => x.req_id), [(r.body as { id: string }).id], "the request is answered by this run");
  });

  it("its own day cap: over rpf_cents_day it stops until tomorrow; the Anthropic monthly cap does not count it; the report shows it", async () => {
    const db = await makeDb();
    await on(db);
    await seed(db);
    await seed(db);
    await db.exec("update public.knob set val = 1 where name = 'rpf_cents_day'");
    const { signer } = await wind();
    const o = await runRpf(rd(db, fakeMcp(), fakeGpt('{"q":"x"}', "openai", 100000, 10000).m, signer));
    assert.deepEqual([o.status, o.state, o.ran], ["cap", 3, 1], "the first run spends past the cap; the second waits for the next day");
    assert.equal(Number((await rows(db, "select (public.aua_cost_month()->>'usd')::numeric u"))[0].u), 0, "not in the Anthropic month");
    const n = (await rows(db, "select public.aua_report_numbers(now() - interval '1 day', now() + interval '1 day') n"))[0].n;
    assert.deepEqual([n.rpf_runs, n.rpf_pass, n.rpf_usd_cap, n.rpf_state], [1, 1, 0.01, 3]);
    assert.ok(Number(n.rpf_usd_day) > 0);
    assert.equal(Number(n.usd_day), 0, "item 8's Anthropic line leaves the OpenAI money out");
  });

  it("price table: gpt-5.6-sol 4 / 20 until the promotion ends 2026-11-30, then booked at 8 / 40 until re-checked; unknown high", () => {
    assert.equal(rpfUsd("gpt-5.6-sol", 1e6, 0, new Date("2026-11-30T23:00:00Z")), 4);
    assert.equal(rpfUsd("gpt-5.6-sol", 1e6, 0, new Date("2026-12-01T00:00:00Z")), 8);
    assert.equal(rpfUsd("gpt-5.6-sol", 0, 1e6, new Date("2026-11-13T00:00:00Z")), 20);
    assert.equal(rpfUsd("gpt-9-unknown", 1e6, 0), 15);
    assert.equal(rpfUsd("gpt-5.6-sol", 1e6, 1e6, new Date("2026-12-05T00:00:00Z"), [5, 25]), 30, "the knobs win once both are set");
    assert.equal(rpfUsd("gpt-5.6-sol", 1e6, 0, new Date("2026-12-05T00:00:00Z"), [5, 0]), 8, "one knob alone is ignored");
  });

  it("price knobs rpf_price_in / rpf_price_out start at 0; once set, every rpf call is booked at them", async () => {
    const db = await makeDb();
    const k = await rows(db, "select name, val from public.knob where name in ('rpf_price_in', 'rpf_price_out') order by name");
    assert.deepEqual(k.map((r) => [r.name, Number(r.val)]), [["rpf_price_in", 0], ["rpf_price_out", 0]]);
    await seed(db);
    await on(db);
    await db.exec("update public.knob set val = 1000 where name in ('rpf_price_in', 'rpf_price_out')");
    const { signer } = await wind();
    await runRpf(rd(db, fakeMcp(), fakeGpt('{"q":"x"}', "openai", 1000, 1000).m, signer));
    const c = await rows(db, "select sum(usd)::numeric u from public.cost where role = 2");
    assert.equal(Number(c[0].u), 0.02, "1 000 in + 1 000 out at US$10 per million each");
  });
});
