// Reports to the key holders (4_ §11): a daily one (every day, also when nothing happened) and an
// emergency one (only for 憲章三: loss of life or major property, caused or about to be). Numbers come
// straight from the trail by SQL; no single record, no key, no talk text ever goes into a mail. No links
// in any mail: the holder checks the report id in the key interface. Runtime-agnostic. Apache-2.0.
import { canon, recordId, sha256Hex, toHex } from "./canon.ts";
import type { Rpc } from "./handlers.ts";
import type { Fetch } from "./mcp.ts";
import { DAILY_WRITER, HARM_JUDGE, type ModelFn, useModel } from "./model.ts";
import { SCHEMA } from "./schema.ts";

export type MailEnv = { key?: string; to?: string; from: string };
/** signer = the wind key (schema batch): every report also becomes a signed `report` record in the trail */
export type ReportDeps = {
  rpc: Rpc; fetch: Fetch; model?: ModelFn; mail: MailEnv; now: () => Date;
  signer?: { pub: string; jwk: JsonWebKey }; aua?: string;
};

const daysOf = (taipeiDate: string) => Math.floor(Date.parse(taipeiDate + "T00:00:00Z") / 86400e3);

/** sign and store a report record; returns its id (the id every mail carries), or null without a signer */
async function putReport(d: ReportDeps, f: { kind: number; day: string; light: number; n: number[]; ref: string | null; rules: number[]; harm: number }) {
  if (!d.signer || !d.aua) return null;
  const rec: Record<string, unknown> = {
    aua: d.aua, kind: f.kind, day: daysOf(f.day), light: f.light, n: f.n, ref: f.ref, rules: f.rules, harm: f.harm,
    by: { key: d.signer.pub }, t: Math.floor(d.now().getTime() / 1000),
  };
  const pk = await crypto.subtle.importKey("jwk", d.signer.jwk, { name: "Ed25519" }, false, ["sign"]);
  rec.sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pk, new TextEncoder().encode(canon(rec))));
  const id = await recordId(rec);
  await d.rpc("aua_put_report", { p_id: id, p_rec: rec });
  return id;
}

/** the daily numbers as the record's fixed-order uint list (report_fields) */
export function reportNumbers(n: N): number[] {
  const v: N = {
    ...n, ask_tok: n.asks ? Math.round(n.ask_bytes / n.asks / 4) : 0,
    usd_cents_day: Math.round(n.usd_day * 100), usd_cents_month: Math.round(n.usd_month * 100),
    rpf_cents_day: Math.round((n.rpf_usd_day ?? 0) * 100), rpf_cents_cap: Math.round((n.rpf_usd_cap ?? 0) * 100),
    rpf_state: n.rpf_state ?? 5,
    twd_day: Math.round(n.twd_day), twd_month: Math.round(n.twd_month),
  };
  return (SCHEMA.report_fields as readonly string[]).map((k) => Math.max(0, Math.round(Number(v[k] ?? 0))));
}

/** Resend. 0 sent · 1 not configured · 2 refused · 3 network */
export async function sendMail(fetchFn: Fetch, env: MailEnv, msg: { subject: string; text: string }): Promise<number> {
  if (!env.key || !env.to) return 1;
  try {
    const r = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.from, to: [env.to], subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(20000),
    });
    return r.ok ? 0 : 2;
  } catch {
    return 3;
  }
}

type N = Record<string, number>;
const fmt = (x: number) => Math.round(Number(x) || 0).toLocaleString("en-US");
const usd = (x: number) => "US$" + x.toFixed(2);
const LIGHT_SHORT = ["綠燈", "黃燈", "紅燈"];

// What the light says is what happened (BOARD-FIX-1123, 3): "AI 已自己處理" only when something was actually done
// by the board on its own; everything else is a situation that needs no person, named as it is.
/** things the board really did by itself */
export function handledOf(n: N): string[] {
  const h: string[] = [];
  if (n.canary > 0) h.push(`金絲雀擋下 ${fmt(n.canary)} 個工具的說明`);
  if (n.zeroed > 0) h.push(`${fmt(n.zeroed)} 條鏈被歸零`);
  if (n.held > 0) h.push(`${fmt(n.held)} 件事經模型判定不會傷人、沒寄緊急信`);
  if (n.usd_month >= n.usd_cap) h.push("模型費用到上限，要用模型的部分已自動停掉");
  return h;
}
/** situations that need no person and that nobody handled */
export function situationsOf(n: N): string[] {
  const s: string[] = [];
  if (n.prev_missing > 0) s.push("前一天的日報沒有產出");
  const firstDown = n.unreachable_new ?? n.unreachable; // older number sets have no "new"
  if (firstDown > 0) s.push(`${fmt(firstDown)} 個工具介面第一次連不上`);
  if (n.changed > 0) s.push(`${fmt(n.changed)} 個工具介面變了或不見`);
  if (n.twd_month >= n.twd_cap) s.push("現金花費到每月上限");
  if (n.rpf_state === 4) s.push("跨家族重跑的模型叫不動"); // George 11/13 一 1
  if (n.replay_on === 1 && n.rpf_price_set === 0) s.push("replay_on 已開但跨家族重跑的價目未設，費用不準");
  return s;
}

export function lightOf(n: N): number {
  if (n.emergencies > 0) return 2;
  if (handledOf(n).length || situationsOf(n).length) return 1;
  return 0;
}

function lightLabel(n: N, light: number): string {
  if (light === 2) return "紅（有緊急回報）";
  if (light === 0) return "綠（一切正常）";
  return situationsOf(n).length ? "黃（有狀況，不用人處理）" : "黃（有問題，AI 已自己處理）";
}

export function templateSentence(n: N, light: number): string {
  if (light === 2) return `今天發出 ${n.emergencies} 份緊急回報，請看緊急信裡的報告編號。`;
  if (light === 1) {
    const s = situationsOf(n), h = handledOf(n);
    if (s.length) return `今天有狀況，不用人處理：${s.join("、")}${h.length ? `；AI 已自己處理：${h.join("、")}` : ""}。`;
    return `今天 AI 已自己處理：${h.join("、")}，不需要你動手。`;
  }
  return `今天一切照常：新紀錄 ${n.records} 筆，沒有需要你處理的事。`;
}

/** the writer's sentence: short, no link, no hash; and it may not say the AI handled something when nothing was */
const okSentence = (s: unknown, n?: N) =>
  typeof s === "string" && s.length > 0 && s.length <= 80 && !/[\r\n]|https?:|www\.|[0-9a-f]{32}/i.test(s) &&
  !(n && handledOf(n).length === 0 && /(AI|已經?|自己|自動).{0,4}(處理|解決|擋)/.test(s));

/** Taipei calendar date of an instant */
const taipeiDay = (d: Date) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
const dayBefore = (day: string) => new Date(Date.parse(day + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10);

/** the door line: yesterday's requests from outside, per function, answered / refused (no who, ever) */
function doorLine(n: N): string {
  const door = (n as unknown as { door?: Record<string, { ok: number; fail: number }> }).door ?? {};
  const fns = Object.keys(door).sort();
  const per = fns.map((f) => `${f} 成功 ${fmt(door[f].ok)}／失敗 ${fmt(door[f].fail)}`).join("、");
  const inner = `（內部排程 ${fmt(n.door_in ?? 0)} 次另計）`;
  const reads = `讀取請求共 ${fmt(n.reads ?? 0)} 次（ask、head、wall、replica、mem 讀，含失敗），其中 ask 成功 ${fmt(n.asks)} 次`;
  return fns.length ? `10. 門口：昨天外面來的請求 ${fmt(n.door_out ?? 0)} 次——${per}；${reads}${inner}。`
    : `10. 門口：昨天沒有外面來的請求；${reads}${inner}。`;
}

/** item 11, only when there is something: interfaces that keep not answering, judged gone, or answering again */
function reachLine(n: N): string | null {
  const parts: string[] = [];
  if (n.unreachable_cont > 0) parts.push(`持續連不上 ${fmt(n.unreachable_cont)} 個介面（最長已 ${fmt(n.unreachable_days)} 天，不再亮燈）`);
  if (n.gone_new > 0) parts.push(`判為不見 ${fmt(n.gone_new)} 個（連續 ${fmt(n.gone_days ?? 7)} 天連不上；只提這一次，紀錄照留）`);
  if (n.back_new > 0) parts.push(`判為不見後又連上 ${fmt(n.back_new)} 個`);
  return parts.length ? `11. 介面狀況：${parts.join("；")}。` : null;
}

export function dailyText(n: N, sentence: string, light: number, week?: N, day?: string): string {
  const L: string[] = [];
  const tok = n.asks ? Math.round(n.ask_bytes / n.asks / 4) : 0;
  if (n.prev_missing > 0) {
    L.push(`前一天${day ? `（${dayBefore(day)}）` : ""}的日報沒有產出：那天的報告沒有跑完，也沒有補跑成功。今天的燈號至少是黃。`);
  }
  L.push(`1. 今天的燈號：${lightLabel(n, light)}`);
  L.push(`2. 一句話：${sentence}`);
  if (light > 0) {
    L.push(`3. 新紀錄 ${fmt(n.records)} 筆——AI 用過工具之後留下的證據。查詢：ask 成功 ${fmt(n.asks)} 次，每次平均回約 ${fmt(tok)} token——要一直比自己試一次便宜，這是門檻；所有讀取請求 ${fmt(n.reads ?? 0)} 次（ask、head、wall、replica、mem 讀，含失敗）。`);
    L.push(`4. 重跑驗證：抽查 ${fmt(n.checked)} 個工具介面，過了 ${fmt(n.passed)} 個；介面變了或不見 ${fmt(n.changed)} 個、連不上 ${fmt(n.unreachable)} 個（其中第一次連不上 ${fmt(n.unreachable_new ?? n.unreachable)} 個）——介面一變，舊紀錄就不再適用。照 stub 真的叫一次（不花 token）${fmt(n.stub_runs ?? 0)} 筆、過 ${fmt(n.stub_pass ?? 0)} 筆；跨家族重跑（別家模型寫參數）${fmt(n.rpf_runs ?? 0)} 筆、過 ${fmt(n.rpf_pass ?? 0)} 筆。`);
    L.push(`5. 新來的公民：新金鑰 ${fmt(n.new_keys)} 把（金鑰第一次出現在任何記下它的地方：紀錄、留言、作品、房間、私艙），用了 ${fmt(n.new_models)} 種模型——種類越多，紀錄越不是同一家說了算。`);
    L.push(`6. 討論：新留言 ${fmt(n.talks)} 則，整理成可照抄的呼叫 ${fmt(n.digests)} 個；新掛上的作品 ${fmt(n.works ?? 0)} 件。`);
    const ruleOnly = n.canary - n.canary_judged - n.canary_unjudged;
    L.push(`7. AI 自己處理掉的問題：金絲雀抓到 ${fmt(n.canary)} 個工具的說明藏了寫給 AI 的指令（規則確定 ${fmt(ruleOnly)}、模型判定 ${fmt(n.canary_judged)}、沒經判斷先擋 ${fmt(n.canary_unjudged)}），這些工具不再出現在查詢結果裡，紀錄不刪；金絲雀自己重判後清掉的旗子 ${fmt(n.canary_cleared ?? 0)} 個；被歸零的鏈 ${fmt(n.zeroed)} 條；模型判定不會傷到人、沒寄緊急信的事件 ${fmt(n.held)} 件。`);
  }
  const usdLeft = Math.max(0, n.usd_cap - n.usd_month);
  const capNote = n.usd_month >= n.usd_cap ? "已到上限：要用模型的部分已自動停掉，改用不花錢的做法。" : `離上限還有 ${usd(usdLeft)}。`;
  L.push(`8. 費用：模型今天 ${usd(n.usd_day)}（輸入 ${fmt(n.tok_in_day)} token、輸出 ${fmt(n.tok_out_day)} token），本月 ${usd(n.usd_month)}／上限 ${usd(n.usd_cap)}，${capNote}現金今天 NT$${fmt(n.twd_day)}，本月 NT$${fmt(n.twd_month)}／上限 NT$${fmt(n.twd_cap)}。`);
  if (n.rpf_usd_cap !== undefined) {
    // rpf (OpenAI) is its own money with its own day cap. The amount is an estimate (tokens × price table);
    // OpenAI's own dashboard is the authority. A model that cannot be called is said in words, never a quiet 0.
    const st = Number(n.rpf_state ?? 5);
    const rm = (n as Record<string, unknown>).rpf_model;
    const model = typeof rm === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(rm) ? `：${rm}` : "";
    const state = st === 4 ? `叫不動：模型被下架、或這把金鑰叫不到它，今天的 0 筆不是沒事做，是停了。`
      : st === 3 ? "已到每日上限，今天停了，明天再跑。"
      : st === 1 ? "沒有 OpenAI 金鑰，沒跑。"
      : st === 2 ? "開關關著（replay_on = 0），沒跑。"
      : st === 5 ? "今天沒有跑到這一段。" : "";
    // the price knobs are the authority; at 0 the amount comes from the built-in table only (BOARD-FIX-1123, 5)
    const price = n.rpf_price_set === 0 ? "價目未設，費用不準（rpf_price_in／rpf_price_out 是 0，只能用程式內建的價目表估）。" : "";
    L.push(`   跨家族重跑（OpenAI${model}）：今天跑 ${fmt(n.rpf_runs)} 筆、過 ${fmt(n.rpf_pass)} 筆，費用約 ${usd(n.rpf_usd_day)}／每日上限 ${usd(n.rpf_usd_cap)}（估算：token 數 × 價目表；實際以 OpenAI 後台為準）。${price}${state}`);
  }
  L.push(`9. 人類介入次數 ${fmt(n.interventions)}（應該永遠是 0）；鑰匙持有人查看 ${fmt(n.holder_looks)} 次。昨天寄出緊急信 ${fmt(n.emergencies)} 封，其中 ${fmt(n.unjudged)} 封沒經模型判斷（可能是誤發）。`);
  L.push(doorLine(n));
  const reach = reachLine(n);
  if (reach) L.push(reach);
  if (week) {
    L.push("");
    L.push(`本週總結：新紀錄 ${fmt(week.records)} 筆、查詢 ${fmt(week.asks)} 次、介面抽查 ${fmt(week.checked)} 個（過 ${fmt(week.passed)}）、新金鑰 ${fmt(week.new_keys)} 把、金絲雀 ${fmt(week.canary)} 件、緊急信 ${fmt(week.emergencies)} 封、模型費用 ${usd(week.usd_day)}。`);
  }
  return L.join("\n");
}

/** the UTC day a report run covers, and its name (the Taipei date the report is sent on) */
export function reportWindow(now: Date) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: new Date(to.getTime() - 86400e3), to, day: taipeiDay(to) };
}

/** the writer gets this long; past it, the fixed sentence (an Anthropic call that hangs must not outlive the function) */
export const WRITER_MS = 30_000;
async function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((ok) => (timer = setTimeout(() => ok(late), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** the daily report for the UTC day that just ended (cron 00:00 UTC = 08:00 台北) */
export async function runDaily(d: ReportDeps, o: { writerMs?: number } = {}) {
  const now = d.now();
  const { from, to, day } = reportWindow(now);
  const n = (await d.rpc("aua_report_numbers", { p_from: from.toISOString(), p_to: to.toISOString() })) as N;
  n.canary_cleared = Number(await d.rpc("aua_canary_cleared", { p_from: from.toISOString(), p_to: to.toISOString() }));
  // the day before has no finished report → said on the first line, and at least yellow (BOARD-FIX-1123, 4)
  n.prev_missing = (await d.rpc("aua_report_prev_ok", { p_day: day })) ? 0 : 1;
  const sunday = new Date(to.getTime() + 8 * 3600e3).getUTCDay() === 0;
  const week = sunday
    ? ((await d.rpc("aua_report_numbers", { p_from: new Date(to.getTime() - 7 * 86400e3).toISOString(), p_to: to.toISOString() })) as N)
    : undefined;
  const light = lightOf(n);

  // item 2: the cheap model writes one sentence from the numbers; anything off → the fixed sentence
  let sentence = templateSentence(n, light);
  let wrote = false;
  const m = await within(useModel(d.rpc, d.model, {
    role: "writer", system: DAILY_WRITER.system, schema: DAILY_WRITER.schema, maxTokens: 2000,
    input: JSON.stringify({ light: ["green", "yellow", "red"][light], situations: situationsOf(n), handled: handledOf(n), ...n, door: undefined, rpf_model: undefined }),
  }), o.writerMs ?? WRITER_MS, { ok: false, err: "network" } as Awaited<ReturnType<typeof useModel>>);
  if (m.ok && okSentence(m.out.sentence, n)) {
    sentence = String(m.out.sentence);
    wrote = true;
  }
  // re-read the numbers after the writer call, so today's own model spend is in item 8
  const n2 = wrote ? ((await d.rpc("aua_report_numbers", { p_from: from.toISOString(), p_to: new Date(now.getTime() + 1).toISOString() })) as N) : n;
  const shown: N = { ...n, usd_month: n2.usd_month, twd_month: n2.twd_month };

  const id = (await putReport(d, { kind: 0, day, light, n: reportNumbers(shown), ref: null, rules: [], harm: 0 })) ??
    (await sha256Hex(canon({ kind: 0, day, from: from.toISOString(), light, nums: shown })));
  const text = dailyText(shown, sentence, light, week, day) + `\n\n報告編號：${id}`;
  const subject = `NHI-1 每日回報 ${day}（台北）— ${LIGHT_SHORT[light]}`;
  await d.rpc("aua_report_put", { p_id: id, p_kind: 0, p_day: day, p_light: light, p_nums: shown, p_judged: wrote, p_held: false });
  const err = await sendMail(d.fetch, d.mail, { subject, text });
  await d.rpc("aua_report_sent", { p_id: id, p_ok: err === 0, p_err: err });
  return { id, day, light, sentence, wrote, subject, text, err, nums: shown };
}

/** an error, short and without anything that could be a key, an id, an address or a mailbox */
export const errSummary = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .replace(/[0-9a-f]{32,}/gi, "…").replace(/https?:\/\/\S+/g, "…").replace(/\S+@\S+/g, "…").replace(/\s+/g, " ").slice(0, 200);

/**
 * One run of the daily report with its run rows (BOARD-FIX-1123, 4): "started" first, then "finished" or
 * "failed" with a short error. The 00:40 retry ({retry}) runs only when the day has no finished run yet.
 * `prepare` builds the rest of the deps (the wind signer…) after the started row, so its failure is recorded too.
 */
export async function runReportJob(rpc: Rpc, now: () => Date, prepare: () => Promise<ReportDeps>, o: { retry?: boolean; writerMs?: number } = {}) {
  const { day } = reportWindow(now());
  if (o.retry && (await rpc("aua_report_done", { p_day: day }))) return { day, r: null };
  await rpc("aua_report_run", { p_day: day, p_state: 0, p_err: null });
  try {
    const r = await runDaily(await prepare(), { writerMs: o.writerMs });
    await rpc("aua_report_run", { p_day: day, p_state: 1, p_err: null });
    return { day, r };
  } catch (e) {
    try {
      await rpc("aua_report_run", { p_day: day, p_state: 2, p_err: errSummary(e) });
    } catch { /* the started row stays: the retry and tomorrow's first line still see it */ }
    throw e;
  }
}

// ── emergency ──

export const RULE_ZH: Record<number, string> = {
  1: "叫 AI 忽略原本的規則", 2: "叫 AI 瞞著它的使用者", 3: "叫 AI 送出金鑰或資料", 4: "叫 AI 換成別的角色",
  5: "叫 AI 執行指令", 6: "叫 AI 轉錢", 7: "要 AI 改用或先用別的工具", 8: "指向機密檔案",
  21: "用命令的語氣對 AI 說話", 22: "藏了看不見的字元", 23: "藏了編碼過的長字串", 24: "藏了註解", 25: "叫 AI 去開某個網址",
};

export type EmergencyEvent = { thing: string; recs: string[]; rules: number[]; how: number; text: string };

/**
 * A trigger happened. The strong model judges "could this hurt people (憲章三)?". likely / unsure → mail;
 * unlikely → no mail, counted in tomorrow's daily report; no model (off, cap, error) → mail anyway
 * (寧可誤發，不可漏發), marked as not judged.
 */
export async function raiseEmergency(d: ReportDeps, ev: EmergencyEvent) {
  const now = d.now();
  const kinds = ev.rules.map((r) => RULE_ZH[r] || `規則 ${r}`).join("、");
  const m = await useModel(d.rpc, d.model, {
    role: "judge", system: HARM_JUDGE.system, schema: HARM_JUDGE.schema, maxTokens: 16000,
    input: HARM_JUDGE.input(ev.rules.join(","), ev.text),
    fallback: false, // Opus refuses → no other model decides: mail it, marked possible misfire (George 11/10)
  });
  const harm = m.ok ? String(m.out.harm) : "";
  const judged = m.ok && ["likely", "unlikely", "unsure"].includes(harm);
  const held = judged && harm === "unlikely";
  const day = taipeiDay(now);
  const nums = { rules: ev.rules, how: ev.how, recs: ev.recs.length };
  const harmCode = !judged ? 0 : ({ likely: 1, unsure: 2, unlikely: 3 } as Record<string, number>)[harm];
  const id = (await putReport(d, { kind: 1, day, light: 2, n: [], ref: ev.thing, rules: ev.rules, harm: harmCode })) ??
    (await sha256Hex(canon({ kind: 1, at: now.toISOString(), thing: ev.thing, rules: ev.rules, harm })));
  await d.rpc("aua_report_put", { p_id: id, p_kind: 1, p_day: day, p_light: 2, p_nums: nums, p_judged: judged, p_held: held });
  if (held) return { id, held, judged, err: -1, subject: "", text: "" };

  const urgency = !judged
    ? "沒有經過模型判斷（模型不可用或沒回應），依規則先發出，可能是誤發。"
    : harm === "likely" ? "模型判定：可能已經或即將傷到人。" : "模型無法排除會傷到人，所以發出。";
  const text = [
    `1. 發生了什麼：一個工具公開的說明裡${kinds}。會受影響的是使用這個工具的 AI，以及它們背後的使用者。`,
    `2. 哪個工具、哪幾筆紀錄：工具 id ${ev.thing}；相關紀錄 ${ev.recs.length ? ev.recs.join("、") : "（還沒有）"}。`,
    "3. AI 已經自己做了：這個工具不再提供可照抄的呼叫（stub）；紀錄一筆都沒刪。",
    "4. 你能做的：用鑰匙暫停相關的鏈（一把鑰匙、最多 72 小時）；永久切掉或分叉（一把鑰匙簽，7 天後生效，期間可撤；等生效時暫停自動延續）；或不動，也是合法的選擇。要動就在你自己的終端機用持鑰人工具簽，不要按信裡的任何東西（這封信本來就沒有連結）。",
    `5. 多急：${urgency}`,
    "",
    `報告編號：${id}`,
  ].join("\n");
  const subject = `【NHI-1 緊急】報告編號 ${id.slice(0, 12)}`;
  const err = await sendMail(d.fetch, d.mail, { subject, text });
  await d.rpc("aua_report_sent", { p_id: id, p_ok: err === 0, p_err: err });
  return { id, held, judged, err, subject, text };
}
