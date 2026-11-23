// BOARD-FIX-1123 (Opus card after the 11/23 audit): the door count, the daily report's new lines, yellow only when
// an interface's state changes, judged gone after 7 days, a report that cannot silently not happen, and the rpf price
// warning. Local only: PGlite with the real migrations, fake network and model; nothing here leaves the machine.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countDoor, memOp, withDoor } from "../supabase/functions/_shared/aua/door.ts";
import { handleHttp } from "../supabase/functions/_shared/aua/http.ts";
import { handleAsk, handleHead } from "../supabase/functions/_shared/aua/handlers.ts";
import { handleMem } from "../supabase/functions/_shared/aua/mem.ts";
import type { ModelFn } from "../supabase/functions/_shared/aua/model.ts";
import { errSummary, lightOf, runDaily, runReportJob, templateSentence } from "../supabase/functions/_shared/aua/report.ts";
import { runWind } from "../supabase/functions/_shared/aua/wind.ts";
import { generateKey, signRecord } from "../skill/nhi1-aua/aua.mjs";
import { AUA, deps, envelope, makeDb, prevOf, putUse, rpcFor, today } from "./helpers.ts";
import { hashOf, ident } from "../supabase/functions/_shared/aua/canon.ts";
import { applyMem } from "./mem-helpers.ts";

type Db = Awaited<ReturnType<typeof makeDb>>;
const H = (c: string) => c.repeat(64);
const rows = async (db: Db, sql: string, p: unknown[] = []) => (await db.query<Record<string, any>>(sql, p)).rows;
const nowS = () => Math.floor(Date.now() / 1000);
const mails: { subject: string; text: string }[] = [];
const fetchFake = async (url: string, init?: RequestInit): Promise<Response> => {
  if (url === "https://api.resend.com/emails") {
    const b = JSON.parse(String(init?.body));
    mails.push({ subject: b.subject, text: b.text });
    return new Response("{}", { status: 200 });
  }
  throw new TypeError("fetch failed (unreachable)");
};
const rdeps = (db: Db, now: () => Date, model?: ModelFn) =>
  ({ rpc: rpcFor(db), fetch: fetchFake, model, now, mail: { key: "re_test", to: "holder@example.org", from: "NHI-1 <report@mail.nhi1.org>" } });
/** a report run as cron would make it the morning after `day` (UTC, YYYY-MM-DD) */
const morningAfter = (day: string) => () => new Date(Date.parse(day + "T00:05:00Z") + 86400e3);
const lastText = () => mails[mails.length - 1].text;

/** a thing straight in the table, and wind checks at given UTC instants (result 3 = unreachable) */
async function thingWithChecks(db: Db, c: string, checks: [string, number][]) {
  const id = H(c);
  await db.query("insert into public.thing (id, addr, iface) values ($1, $2, $3)", [id, `https://mcp.${c}.test/mcp`, H("1")]);
  for (const [at, result] of checks) await db.query("insert into public.wind_check (thing_id, result, at) values ($1, $2, $3)", [id, result, at]);
  return id;
}
const days = (first: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(first + "T23:30:00Z") + i * 86400e3).toISOString());

describe("1 door count", () => {
  const req = (fn: string, method: string, body?: string) => new Request(`https://board.test/functions/v1/${fn}`, { method, body });

  it("every answer is counted by day × function × method × status; failures too; no IP, UA or key in the table", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const d = deps(db);
    const ask = withDoor("ask", rpc, (r, m) => handleHttp(r, "ask", handleAsk, 1024, async () => d, m));
    const head = withDoor("head", rpc, (r, m) => handleHttp(r, "head", handleHead, 1024, async () => d, m));
    assert.equal((await ask(req("ask", "GET"))).status, 405);
    assert.equal((await ask(req("ask", "POST", "{not json"))).status, 400);
    assert.equal((await ask(req("ask", "POST", "x".repeat(2000)))).status, 413);
    const k = await generateKey();
    const signed = await signRecord({ aua: AUA, task: H("7"), by: { key: k.pub, model: H("6"), rt: H("5") }, t: nowS() }, k);
    assert.equal((await ask(req("ask", "POST", JSON.stringify(signed)))).status, 200);
    const bad = (await ask(req("ask", "POST", JSON.stringify({ ...signed, sig: "0".repeat(128) })))).status;
    assert.ok(bad >= 400, "a bad signature is refused");
    assert.equal((await head(req("head", "OPTIONS"))).status, 204);
    const got = await rows(db, "select fn, method, status, inside, op, n::int n from public.door order by fn, method, status");
    assert.deepEqual(got.map((r) => [r.fn, r.method, r.status, r.inside, r.op, r.n]), [
      ["ask", "GET", 405, false, "", 1], ["ask", "POST", 200, false, "", 1], ["ask", "POST", 400, false, "", 1],
      ...[["ask", "POST", bad, false, "", 1], ["ask", "POST", 413, false, "", 1]].sort((a, b) => Number(a[2]) - Number(b[2])), ["head", "OPTIONS", 204, false, "", 1],
    ]);
    const cols = (await rows(db, "select column_name c from information_schema.columns where table_name = 'door' order by ordinal_position")).map((r) => r.c);
    assert.deepEqual(cols, ["day", "fn", "method", "status", "inside", "op", "n"], "nothing that tells who came");
  });

  it("mem counts its op (reads vs writes); a GET with no body is '?' and counts as a read attempt", async () => {
    const db = await makeDb();
    await applyMem(db);
    const rpc = rpcFor(db);
    const mem = withDoor("mem", rpc, (r, m) => handleHttp(r, "mem", handleMem, 96 * 1024, async () => deps(db), m));
    assert.equal((await mem(req("mem", "GET"))).status, 405, "the 11/22 outside GET /mem");
    await mem(req("mem", "POST", JSON.stringify({ op: "boot", aua: "x", key: H("a"), n: 1, t: nowS(), sig: "0" })));
    await mem(req("mem", "POST", JSON.stringify({ op: "put", rec: {} })));
    await mem(req("mem", "POST", JSON.stringify({ op: "drop tables" })));
    const got = await rows(db, "select method, op, status from public.door where fn = 'mem' order by op, method");
    assert.deepEqual(got.map((r) => [r.method, r.op]), [["GET", "?"], ["POST", "?"], ["POST", "boot"], ["POST", "put"]]);
    assert.equal(memOp({ op: "box_get" }), "box_get");
    assert.equal(memOp({ op: "x; drop" }), "?", "only the fixed list is stored");
    const to = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
    const n = (await rpc("aua_report_numbers", { p_from: new Date(to.getTime() - 86400e3).toISOString(), p_to: to.toISOString() })) as Record<string, any>;
    assert.equal(n.reads, 3, "GET ?, POST ?, boot: reads; put: a write");
    assert.deepEqual(n.door, { mem: { ok: 0, fail: 4 } });
  });

  it("internal jobs that prove the secret are counted as inside, not mixed with outside; a failing counter changes nothing", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const job = withDoor("wind", rpc, async (r, m) => {
      if (r.headers.get("x-aua-export") !== "ok") return new Response(null, { status: 401 });
      m.inside = true;
      return new Response("{}", { status: 200 });
    });
    await job(new Request("https://board.test/wind", { method: "POST", headers: { "x-aua-export": "ok" } }));
    await job(new Request("https://board.test/wind", { method: "POST", headers: { "x-aua-export": "guess" } }));
    const got = await rows(db, "select status, inside from public.door where fn = 'wind' order by status");
    assert.deepEqual(got.map((r) => [r.status, r.inside]), [[200, true], [401, false]], "a guess from outside is outside");
    const to = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
    const n = (await rpc("aua_report_numbers", { p_from: new Date(to.getTime() - 86400e3).toISOString(), p_to: to.toISOString() })) as Record<string, any>;
    assert.equal(n.door_in, 1);
    assert.equal(n.door_out, 1);
    assert.deepEqual(n.door, { wind: { ok: 0, fail: 1 } });

    const broken = withDoor("ask", async () => { throw new Error("db down"); }, async () => new Response("{}", { status: 200 }));
    assert.equal((await broken(new Request("https://board.test/ask", { method: "POST" }))).status, 200, "the answer is untouched");
    const slow = withDoor("ask", () => new Promise(() => {}), async () => new Response("{}", { status: 201 }), () => {});
    assert.equal((await slow(new Request("https://board.test/ask", { method: "POST" }))).status, 201, "handed to waitUntil, not awaited");
    await countDoor(rpc, "nope" as never, "GET", 200, false); // a value the table refuses: swallowed
  });

  it("the report has a door line every day, green days too, and two query numbers", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) await rpc("aua_door", { p_fn: "ask", p_method: "POST", p_status: 200, p_inside: false, p_op: "" });
    await rpc("aua_door", { p_fn: "wall", p_method: "POST", p_status: 429, p_inside: false, p_op: "" });
    await rpc("aua_door", { p_fn: "use", p_method: "POST", p_status: 201, p_inside: false, p_op: "" });
    await rpc("aua_door", { p_fn: "report", p_method: "POST", p_status: 200, p_inside: true, p_op: "" });
    const r = await runDaily(rdeps(db, morningAfter(day)));
    assert.equal(r.light, 0, "people coming is not a problem");
    assert.match(r.text, /10\. 門口：昨天外面來的請求 5 次——ask 成功 3／失敗 0、use 成功 1／失敗 0、wall 成功 0／失敗 1；讀取請求共 4 次（ask、head、wall、replica、mem 讀，含失敗），其中 ask 成功 0 次（內部排程 1 次另計）。/);
    const quiet = await runDaily(rdeps(await makeDb(), morningAfter(day)));
    assert.match(quiet.text, /10\. 門口：昨天沒有外面來的請求/);
  });
});

describe("2 new keys: the first time a key is written down anywhere", () => {
  it("a key that only registered a room is new that day; a key seen before is not", async () => {
    const db = await makeDb();
    await applyMem(db);
    const rpc = rpcFor(db);
    const today = Math.floor(Date.now() / 86400e3) * 86400;
    await db.query("insert into public.mem_room (pub, day) values ($1, $2), ($3, $4)", [H("a"), today, H("b"), today - 3 * 86400]);
    const to = new Date((today + 86400) * 1000);
    const n = (await rpc("aua_report_numbers", { p_from: new Date(today * 1000).toISOString(), p_to: to.toISOString() })) as Record<string, number>;
    assert.equal(n.new_keys, 1, "only the room registered today");
  });
});

describe("3 yellow only when an interface's state changes", () => {
  it("first unreachable day: yellow; the next days: green with 持續連不上 N 天", async () => {
    const db = await makeDb();
    await thingWithChecks(db, "a", [["2026-10-01T23:30:00Z", 0], ...days("2026-10-02", 3).map((t) => [t, 3] as [string, number])]);
    const r1 = await runDaily(rdeps(db, morningAfter("2026-10-02")));
    assert.equal(r1.light, 1);
    assert.equal(r1.nums.unreachable_new, 1);
    assert.match(r1.text, /今天有狀況，不用人處理：1 個工具介面第一次連不上/);
    const r2 = await runDaily(rdeps(db, morningAfter("2026-10-03")));
    assert.equal(r2.light, 0, "still unreachable: no new state, no light");
    assert.match(r2.text, /11\. 介面狀況：持續連不上 1 個介面（最長已 2 天，不再亮燈）/);
    const r3 = await runDaily(rdeps(db, morningAfter("2026-10-04")));
    assert.match(r3.text, /最長已 3 天/);
  });

  it("7 days running: one 'judged gone' state row, said once (green), then never again; old checks untouched", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const id = await thingWithChecks(db, "b", days("2026-10-10", 6).map((t) => [t, 3] as [string, number]));
    assert.equal(await rpc("aua_wind_gone", {}), 0, "6 days: not yet");
    await db.query("insert into public.wind_check (thing_id, result, at) values ($1, 3, '2026-10-16T23:30:00Z')", [id]);
    // the state row is made right after the 7th check (as runWind does); its time is that night
    await db.query("insert into public.thing_state (thing_id, state, days, at) select $1, 1, public.aua_unreach_days($1, 'infinity'), '2026-10-16T23:31:00Z' where public.aua_unreach_days($1, 'infinity') >= 7", [id]);
    assert.equal(await rpc("aua_wind_gone", {}), 0, "already judged: no second row");
    const st = await rows(db, "select state, days from public.thing_state");
    assert.deepEqual(st.map((r) => [r.state, r.days]), [[1, 7]]);
    const before = (await rows(db, "select count(*)::int n from public.wind_check"))[0].n;
    const r = await runDaily(rdeps(db, morningAfter("2026-10-16")));
    assert.equal(r.light, 0, "judged gone is said, not lit");
    assert.equal(r.nums.checked, 0, "a thing judged gone is no longer counted in the checks");
    assert.match(r.text, /判為不見 1 個（連續 7 天連不上；只提這一次，紀錄照留）/);
    await db.query("insert into public.wind_check (thing_id, result, at) values ($1, 3, '2026-10-17T23:30:00Z')", [id]);
    const next = await runDaily(rdeps(db, morningAfter("2026-10-17")));
    assert.equal(next.light, 0);
    assert.doesNotMatch(next.text, /判為不見|持續連不上|11\. /, "not mentioned again");
    assert.equal((await rows(db, "select count(*)::int n from public.wind_check"))[0].n, before + 1, "checks only ever added");
    await assert.rejects(db.query("update public.thing_state set state = 0"), /append-only/);
    await assert.rejects(db.query("delete from public.thing_state"), /append-only/);
    // it answers again: a new state row, and a later streak can be judged again
    await db.query("insert into public.wind_check (thing_id, result, at) values ($1, 0, '2026-10-18T23:30:00Z')", [id]);
    await rpc("aua_wind_gone", {});
    assert.deepEqual((await rows(db, "select state from public.thing_state order by id")).map((r) => r.state), [1, 0]);
  });

  it("runWind writes the state row itself (the live board's cc24ef97 case: unreachable 7 days → judged gone)", async () => {
    const db = await makeDb();
    const now = Date.now();
    const past = Array.from({ length: 6 }, (_, i) => [new Date(now - (6 - i) * 86400e3).toISOString(), 3] as [string, number]);
    await thingWithChecks(db, "c", past);
    await runWind({ ...rdeps(db, () => new Date()) }, 10); // today's check: unreachable (the fake network has nothing)
    const st = await rows(db, "select state, days from public.thing_state");
    assert.deepEqual(st.map((r) => [r.state, r.days]), [[1, 7]]);
  });

  it("the words are what happened: 'AI 已自己處理' only when something was handled", () => {
    const z = { records: 0, canary: 0, zeroed: 0, held: 0, changed: 0, unreachable: 0, unreachable_new: 0, usd_month: 0, usd_cap: 100, twd_month: 0, twd_cap: 2000, emergencies: 0, rpf_state: 2 };
    assert.equal(lightOf(z), 0);
    assert.equal(templateSentence({ ...z, canary: 1 }, 1), "今天 AI 已自己處理：金絲雀擋下 1 個工具的說明，不需要你動手。");
    assert.equal(templateSentence({ ...z, unreachable_new: 1 }, 1), "今天有狀況，不用人處理：1 個工具介面第一次連不上。");
    assert.equal(templateSentence({ ...z, unreachable_new: 1, zeroed: 2 }, 1), "今天有狀況，不用人處理：1 個工具介面第一次連不上；AI 已自己處理：2 條鏈被歸零。");
  });

  it("the writer may not say the AI handled something when nothing was; then the fixed sentence is used", async () => {
    const db = await makeDb();
    await thingWithChecks(db, "d", [["2026-10-20T23:30:00Z", 3]]);
    const liar: ModelFn = async () => ({ ok: true, out: { sentence: "有一個介面連不上，AI 已自己處理。" }, model: "claude-haiku-5-5", tin: 10, tout: 10 });
    const r = await runDaily(rdeps(db, morningAfter("2026-10-20"), liar));
    assert.equal(r.wrote, false);
    assert.match(r.text, /2\. 一句話：今天有狀況，不用人處理/);
  });
});

describe("4 a report cannot silently not happen", () => {
  it("run rows: started then finished; the 00:40 retry does nothing when the day is finished", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const now = morningAfter("2026-10-22");
    const j = await runReportJob(rpc, now, async () => rdeps(db, now));
    assert.ok(j.r);
    assert.deepEqual((await rows(db, "select kind from public.report_log where kind >= 2 order by created_at, kind")).map((r) => r.kind), [2, 3]);
    const sent = mails.length;
    const again = await runReportJob(rpc, now, async () => rdeps(db, now), { retry: true });
    assert.equal(again.r, null, "already finished: skipped");
    assert.equal(mails.length, sent, "no second mail");
  });

  it("a run that fails leaves started + failed (short error, nothing secret); the retry runs it again", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const now = morningAfter("2026-10-24");
    await assert.rejects(runReportJob(rpc, now, async () => { throw new Error("rpc aua_wind_key 500 https://x.example/rest key " + H("f")); }));
    const log = await rows(db, "select kind, err, day::text as d from public.report_log order by created_at, kind");
    assert.deepEqual(log.map((r) => r.kind), [2, 4]);
    assert.equal(log[1].err, "rpc aua_wind_key 500 … key …", "no address, no hex");
    assert.equal(log[1].d, "2026-10-25");
    const j = await runReportJob(rpc, now, async () => rdeps(db, now), { retry: true });
    assert.ok(j.r, "not finished yet: the retry runs");
    assert.deepEqual((await rows(db, "select kind from public.report_log where kind >= 2 order by created_at, kind")).map((r) => r.kind), [2, 4, 2, 3]);
    assert.equal(errSummary(new Error("to holder@example.org")), "to …");
  });

  it("the day before has no finished report → the first line says so and the light is at least yellow", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    // 10-27 ran fine; 10-28 started and never finished (the 11/17 shape: killed mid-way)
    await runReportJob(rpc, morningAfter("2026-10-26"), async () => rdeps(db, morningAfter("2026-10-26")));
    await rpc("aua_report_run", { p_day: "2026-10-28", p_state: 0, p_err: null });
    const r = await runDaily(rdeps(db, morningAfter("2026-10-28")));
    assert.equal(r.day, "2026-10-29");
    assert.equal(r.light, 1);
    assert.equal(r.text.split("\n")[0], "前一天（2026-10-28）的日報沒有產出：那天的報告沒有跑完，也沒有補跑成功。今天的燈號至少是黃。");
    assert.match(r.text, /今天有狀況，不用人處理：前一天的日報沒有產出/);
    // a day with no run rows and no report at all, after reports began, is missing too
    const r2 = await runDaily(rdeps(db, morningAfter("2026-10-30")));
    assert.equal(r2.nums.prev_missing, 1);
    // the first report ever has no day before it: not missing
    assert.equal((await runDaily(rdeps(await makeDb(), morningAfter("2026-10-30")))).nums.prev_missing, 0);
  });

  it("a writer that hangs is cut off (the likely 11/17 cause: the model call outliving the function): the report still goes", async () => {
    const db = await makeDb();
    const hang: ModelFn = () => new Promise(() => {});
    const r = await runDaily(rdeps(db, morningAfter("2026-11-01"), hang), { writerMs: 50 });
    assert.equal(r.wrote, false);
    assert.equal((await rows(db, "select count(*)::int n from public.report_log where kind = 0"))[0].n, 1);
  });
});

describe("5 the rpf price", () => {
  it("price knobs at 0: item 8 says the cost is not exact; replay_on 1 with no price turns the light yellow (warning, not filled in)", async () => {
    const db = await makeDb();
    const r = await runDaily(rdeps(db, morningAfter("2026-11-02")));
    assert.match(r.text, /價目未設，費用不準/);
    assert.equal(r.light, 0, "replay_on 0: a note, no light");
    await db.exec("update public.knob set val = 1 where name = 'replay_on'"); // allowed, with a database warning
    const on = await runDaily(rdeps(db, morningAfter("2026-11-03")));
    assert.equal(on.light, 1);
    assert.match(on.text, /replay_on 已開但跨家族重跑的價目未設，費用不準/);
    const k = await rows(db, "select name, val::int val from public.knob where name in ('rpf_price_in', 'rpf_price_out') order by name");
    assert.deepEqual(k.map((x) => x.val), [0, 0], "the prices are never filled in by the board");
    await db.exec("update public.knob set val = 5 where name in ('rpf_price_in', 'rpf_price_out')");
    const set = await runDaily(rdeps(db, morningAfter("2026-11-04")));
    assert.doesNotMatch(set.text, /價目未設/);
  });

  it("setting replay_on = 1 with no price raises a database warning", async () => {
    const db = await makeDb();
    const notices: string[] = [];
    await db.query("update public.knob set val = 1 where name = 'replay_on'", [], { onNotice: (n: { message?: string }) => notices.push(String(n.message)) } as never);
    assert.ok(notices.some((m) => /replay_on = 1 while rpf_price_in \/ rpf_price_out are 0/.test(m)), "warned");
  });
});

describe("3b a thing judged gone that gets a new use is usable again (Opus 11/23 follow-up)", () => {
  const t = { name: "search", description: "Search.", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
  async function use(db: Db, addr: string) {
    const k = await generateKey();
    const rec = await signRecord({
      aua: AUA, thing: { addr, iface: await hashOf(t) }, call: { op: await ident(t.name), in: H("2"), out: H("3") }, task: H("7"),
      result: { code: 0, err: 0 }, cost: { tin: 1, tout: 1, ms: 1, money: 0, cur: "" }, effect: 0,
      by: { key: k.pub, model: await ident("claude-opus-5-5"), rt: await ident("claude-code") }, t: today(), prev: prevOf(k.pub), stub: null,
    }, k);
    const r = await putUse(await envelope(rec, k), deps(db));
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  }

  it("a new use adds one 「重新可用」 row (state 2); the thing is back in the checks, said once; old rows untouched", async () => {
    const db = await makeDb();
    const rpc = rpcFor(db);
    const addr = "https://mcp.again.org/mcp";
    await use(db, addr);
    const id = (await rows(db, "select id from public.thing"))[0].id;
    const now = Date.now();
    for (let i = 7; i >= 1; i--) await db.query("insert into public.wind_check (thing_id, result, at) values ($1, 3, $2)", [id, new Date(now - i * 86400e3).toISOString()]);
    assert.equal(await rpc("aua_wind_gone", {}), 1, "7 days: judged gone");
    await use(db, addr);
    assert.deepEqual((await rows(db, "select state from public.thing_state order by id")).map((r) => r.state), [1, 2]);
    await use(db, addr);
    assert.equal((await rows(db, "select count(*)::int n from public.thing_state"))[0].n, 2, "no longer gone: a further use adds nothing");
    assert.equal(await rpc("aua_wind_gone", {}), 0, "the 7-day count starts again after the state row: not judged gone again that night");
    await db.query("insert into public.wind_check (thing_id, result, at) values ($1, 3, now() + interval '1 second')", [id]);
    const d = new Date();
    const r = await runDaily(rdeps(db, () => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5))));
    assert.equal(r.nums.checked, 1, "back in the checks");
    assert.equal(r.nums.unreachable_new, 1, "unreachable after being used again is a new state: yellow once");
    assert.equal(r.light, 1);
    assert.match(r.text, /判為不見後有新的 use 紀錄、重新可用 1 個（回到抽查）/);
    assert.equal((await rows(db, "select count(*)::int n from public.wind_check where result = 3"))[0].n, 8, "checks only added");
    await assert.rejects(db.query("update public.thing_state set state = 1 where state = 2"), /append-only/);
  });

  it("a use for a thing that is not judged gone adds no state row", async () => {
    const db = await makeDb();
    await use(db, "https://mcp.fine.org/mcp");
    await use(db, "https://mcp.fine.org/mcp");
    assert.equal((await rows(db, "select count(*)::int n from public.thing_state"))[0].n, 0);
  });
});
