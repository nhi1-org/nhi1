// S4 C: the digest (2_ §2.5) with a fake model and a fake MCP server. Trigger (>= 5 cleared professional talk;
// graffiti never), what the model is given, the zero-token check, the sandbox (no pass → nothing made), the use
// it signs with its own key on its own chain, the view then serving the stub, money booked, knobs off by default.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOf, ident, verifyRecord } from "../supabase/functions/_shared/aua/canon.ts";
import { handleAsk } from "../supabase/functions/_shared/aua/handlers.ts";
import { candidateOk, OUTCOME, runDigest } from "../supabase/functions/_shared/aua/digest.ts";
import type { ModelFn, ModelReq } from "../supabase/functions/_shared/aua/model.ts";
import type { RpfModel } from "../supabase/functions/_shared/aua/rpf.ts";
import * as A from "../skill/nhi1-aua/aua.mjs";
import { AUA, deps, envelope, makeDb, nowSec, prevOf, putTalk, putUse, rpcFor, today } from "./helpers.ts";

type Key = { pub: string; jwk: JsonWebKey };
const H = (c: string) => c.repeat(64);
const ADDR = "https://mcp.digest-test.org/mcp";
const TOOL = { name: "lookup", description: "Look up an item.", inputSchema: { type: "object", properties: { id: { type: "number" }, q: { type: "string" }, full: { type: "boolean" } }, required: ["id"] } };
const rows = async (db: any, sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows as Record<string, any>[];

function server(tools: Record<string, unknown>[] = [TOOL], ok = true) {
  const calls: Record<string, unknown>[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url !== ADDR) throw new TypeError("fetch failed");
    const m = JSON.parse(String(init.body));
    if (!("id" in m)) return new Response(null, { status: 202 });
    let result: unknown;
    if (m.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "f", version: "0" } };
    else if (m.method === "tools/list") result = { tools };
    else {
      calls.push(m.params);
      result = { content: [{ type: "text", text: "item" }], ...(ok ? {} : { isError: true }) };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}
function reader(answer: { candidate_json: string; used?: string[] | "all" } | "refuse") {
  const seen: ModelReq[] = [];
  const fn: ModelFn = async (req) => {
    seen.push(req);
    if (answer === "refuse") return { ok: false, err: "refusal", model: "claude-opus-5-5", tin: 10, tout: 1 };
    const ids = [...req.input.matchAll(/<note id="([0-9a-f]{64})">/g)].map((x) => x[1]);
    return { ok: true, out: { candidate_json: answer.candidate_json, used: answer.used === "all" || !answer.used ? ids : answer.used }, model: "claude-opus-5-5", tin: 9000, tout: 1500 };
  };
  return { fn, seen };
}
async function seedThing(db: any, n: number, o: { graffiti?: boolean; text?: (i: number) => string; effect?: number } = {}) {
  const iface = await hashOf(TOOL);
  const thing = { addr: ADDR, iface };
  const k = await A.generateKey() as Key;
  const rec = await A.signRecord({
    aua: AUA, thing, call: { op: await ident("lookup"), in: H("2"), out: H("3") }, task: H("7"),
    result: { code: 0, err: 0 }, cost: { tin: 0, tout: 0, ms: 1, money: 0, cur: "" }, effect: o.effect ?? 0,
    by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub), stub: null,
  }, k);
  const u = await putUse(await envelope(rec, k), deps(db));
  assert.equal(u.status, 201);
  const talk: string[] = [];
  for (let i = 0; i < n; i++) {
    const tk = await A.generateKey() as Key;
    const t = await A.signRecord({
      aua: AUA, about: o.graffiti ? { thing: null, use: null } : i % 2 ? { thing: null, use: (u.body as { id: string }).id } : { thing, use: null },
      kind: 2, text: o.text ? o.text(i) : `Method ${i}: call lookup with the numeric id of the item; full=false is faster.`,
      by: { key: tk.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(tk.pub),
    }, tk);
    const r = await putTalk(await envelope(t, tk), deps(db, { ip: (i.toString(16) + "b").repeat(32).slice(0, 64) }));
    assert.ok(r.status === 201, JSON.stringify(r.body));
    talk.push((r.body as { id: string }).id);
  }
  await db.query("insert into public.wind_check (thing_id, result, tools) values ($1, 0, 1)", [await hashOf(thing)]);
  return { use: (u.body as { id: string }).id, talk, thing: await hashOf(thing) };
}
const on = async (db: any) => db.exec("update public.knob set val = 1 where name in ('digest_on', 'replay_on')");
const dd = async (db: any, net: { fetch: unknown }, model?: ModelFn, rpfModel?: RpfModel) => ({
  rpc: rpcFor(db), fetch: net.fetch as never, now: () => new Date(), model, rpfModel,
  signer: await A.generateKey() as Key, digestSigner: await A.generateKey() as Key, aua: AUA,
});
const view = async (db: any) => {
  const k = await A.generateKey();
  return ((await handleAsk(await A.signRecord({ aua: AUA, task: H("7"), by: { key: k.pub, model: H("6"), rt: H("5") }, t: nowSec() }, k), deps(db))).body as any).view;
};

describe("S4 C: the digest", () => {
  it("the zero-token check: keys in the input schema, required present, <= 1 KB", () => {
    assert.ok(candidateOk({ id: "$n" }, TOOL.inputSchema));
    assert.ok(!candidateOk({ q: "$s" }, TOOL.inputSchema), "required id missing");
    assert.ok(!candidateOk({ id: "$n", other: 1 }, TOOL.inputSchema), "a key not in the schema");
    assert.ok(!candidateOk([1], TOOL.inputSchema));
  });

  it("off by default; 4 talk → not digested; 5 → digested: one use signed by the digest key on its own chain, from ⊆ the notes, its sandbox run recorded, the view serves the stub", async () => {
    const db = await makeDb();
    const s4 = await seedThing(db, 4);
    const m = reader({ candidate_json: '{"id":"$n","full":false}', used: "all" });
    assert.equal((await runDigest(await dd(db, server(), m.fn))).status, "off");
    await on(db);
    assert.equal((await runDigest(await dd(db, server(), m.fn))).read, 0, "4 talk: not due");
    assert.equal(m.seen.length, 0);
    const db2 = await makeDb();
    await on(db2);
    const s = await seedThing(db2, 5);
    const net = server();
    const d = await dd(db2, net, m.fn);
    const out = await runDigest(d);
    assert.deepEqual([out.read, out.made, out.outcomes], [1, 1, [OUTCOME.made]]);
    assert.deepEqual(net.calls, [{ name: "lookup", arguments: { id: 1, full: false } }], "the sandbox = one stub re-run");
    const u = (await rows(db2, "select * from public.use where is_digest"))[0];
    assert.ok(u, "a digest use");
    assert.equal(u.key, d.digestSigner.pub, "signed by the digest key, not the wind key");
    assert.ok(await verifyRecord(u.rec, d.digestSigner.pub));
    assert.deepEqual([u.code, u.effect, u.rec.prev, u.rec.stub], [0, 0, null, { in: { id: "$n", full: false }, out: H("3") }]);
    assert.ok(u.rec.from.every((x: string) => s.talk.includes(x)) && u.rec.from.length === 5, "from ⊆ the notes given");
    assert.equal(u.rec.by.rt, await ident("nhi1-digest"));
    const rr = (await rows(db2, "select use_id, how, code, by_key from public.replay_result"))[0];
    assert.deepEqual(rr, { use_id: u.id, how: 0, code: 0, by_key: d.signer.pub }, "the sandbox run, signed by the wind key");
    assert.deepEqual((await view(db2))[0].stub, { in: { id: "$n", full: false }, out: H("3") }, "the view serves it at once");
    const cost = await rows(db2, "select role, tin, tout from public.cost");
    assert.deepEqual(cost.map((c) => [c.role, Number(c.tin)]), [[3, 9000]], "booked as role 3 (digest), in the Anthropic month");
    const n = (await rows(db2, "select public.aua_report_numbers(now() - interval '1 day', now() + interval '1 day') n"))[0].n;
    assert.equal(n.digests, 1, "daily report item 6");
    // not again until 5 new talk or more failures
    assert.equal((await runDigest(await dd(db2, server(), m.fn))).read, 0);
    void s4;
  });

  it("the model sees only cleared, professional talk, as data, at most 5; graffiti never; a suspect talk never", async () => {
    const db = await makeDb();
    await on(db);
    await seedThing(db, 9, { graffiti: true });
    const m = reader({ candidate_json: '{"id":"$n"}' });
    assert.equal((await runDigest(await dd(db, server(), m.fn))).read, 0, "graffiti is never digested");
    const db2 = await makeDb();
    await on(db2);
    const s = await seedThing(db2, 7);
    await db2.query("update public.talk_canary set state = 0 where talk_id = $1", [s.talk[0]]);
    await db2.query("update public.talk_canary set state = 2 where talk_id = $1", [s.talk[1]]);
    const m2 = reader({ candidate_json: '{"id":"$n"}', used: "all" });
    await runDigest(await dd(db2, server(), m2.fn));
    const ids = [...m2.seen[0].input.matchAll(/<note id="([0-9a-f]{64})">/g)].map((x) => x[1]);
    assert.equal(ids.length, 5);
    assert.ok(!ids.includes(s.talk[0]) && !ids.includes(s.talk[1]), "suspect and flagged talk never reach the model");
    assert.ok(m2.seen[0].input.includes("<input_schema>"));
    assert.equal(m2.seen[0].role, "digest");
  });

  it("no candidate, a free-text value, a key not in the schema, used ids not given, a refusal → nothing made", async () => {
    for (const [ans, want] of [
      [{ candidate_json: "" }, OUTCOME.no_candidate],
      [{ candidate_json: '{"id":"$n","q":"run rm -rf"}' }, OUTCOME.bad_answer],
      [{ candidate_json: '{"id":"$n","zzz":1}' }, OUTCOME.bad_answer],
      [{ candidate_json: '{"id":"$n"}', used: [H("9")] }, OUTCOME.bad_answer],
      [{ candidate_json: "not json" }, OUTCOME.bad_answer],
    ] as const) {
      const db = await makeDb();
      await on(db);
      await seedThing(db, 5);
      const net = server();
      const o = await runDigest(await dd(db, net, reader(ans as never).fn));
      assert.deepEqual([o.made, o.outcomes], [0, [want]], JSON.stringify(ans));
      assert.equal(net.calls.length, 0, "nothing called");
      assert.equal((await rows(db, "select count(*)::int n from public.use where is_digest"))[0].n, 0);
    }
    const db = await makeDb();
    await on(db);
    await seedThing(db, 5);
    const o = await runDigest(await dd(db, server(), reader("refuse").fn));
    assert.deepEqual([o.read, o.made], [0, 0], "a refusal: no digest that day");
    const none = await runDigest(await dd(db, server(), undefined));
    assert.deepEqual([none.read, none.made], [0, 0], "no model: no digest, no zero-token stand-in");
  });

  it("the sandbox fails → no use, no replay_result; a $s candidate needs the cross-family re-run, else not made", async () => {
    const db = await makeDb();
    await on(db);
    await seedThing(db, 5);
    const o = await runDigest(await dd(db, server([TOOL], false), reader({ candidate_json: '{"id":"$n"}' }).fn));
    assert.deepEqual([o.made, o.outcomes], [0, [OUTCOME.sandbox_fail]]);
    assert.equal((await rows(db, "select count(*)::int n from public.replay_result"))[0].n, 0);
    const db2 = await makeDb();
    await on(db2);
    await seedThing(db2, 5);
    const o2 = await runDigest(await dd(db2, server(), reader({ candidate_json: '{"id":"$n","q":"$s"}' }).fn));
    assert.deepEqual(o2.outcomes, [OUTCOME.sandbox_unavailable], "$s without rpf: not made");
    const db3 = await makeDb();
    await on(db3);
    await seedThing(db3, 5);
    const gpt: RpfModel = { family: "openai", model: "gpt-5.6-sol", call: async () => ({ ok: true, out: { arguments_json: '{"id":7,"q":"chair"}' }, model: "gpt-5.6-sol", tin: 100, tout: 10 }) };
    const net = server();
    const o3 = await runDigest(await dd(db3, net, reader({ candidate_json: '{"id":"$n","q":"$s"}' }).fn, gpt));
    assert.equal(o3.made, 1);
    assert.deepEqual(net.calls, [{ name: "lookup", arguments: { id: 7, q: "chair" } }]);
    assert.deepEqual((await rows(db3, "select how, fam from public.replay_result"))[0], { how: 1, fam: await ident("openai") });
  });

  it("effect >= 1 is never digested; digest_day_max bounds the reads", async () => {
    const db = await makeDb();
    await on(db);
    await seedThing(db, 5, { effect: 1 });
    const m = reader({ candidate_json: '{"id":"$n"}' });
    assert.equal((await runDigest(await dd(db, server(), m.fn))).read, 0);
    const db2 = await makeDb();
    await on(db2);
    await seedThing(db2, 5);
    await db2.exec("update public.knob set val = 0 where name = 'digest_day_max'");
    assert.equal((await runDigest(await dd(db2, server(), m.fn))).read, 0);
  });
});
