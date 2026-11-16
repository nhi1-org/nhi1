// The wind tunnel, zero-token part (task card 1.1a + 1.2a): for each thing on the board, list its tools
// again and compare the interface the records were made with; scan the tool's published text with the
// canary rules. Rule-uncertain text goes to the strong model (no tools, enum answer) if allowed; with
// no model the thing is flagged anyway (kept safe, counted as "not judged"). A new flag raises an
// emergency (which has its own harm judgement). The board never CALLS a thing here.
// Flags clear themselves (7_ 裁（五）3): every run rescans the tool text; a changed text or rules version
// is judged afresh; a model verdict is reused for the same text only for canary_rejudge_days. Apache-2.0.
import { canon, hashOf, ident, recordId, toHex } from "./canon.ts";
import { RULES_V, scanTalk, scanText, TALK_RULES_V, toolText } from "./canary.ts";
import { mcpListTools } from "./mcp.ts";
import { CANARY_JUDGE, TALK_JUDGE, useModel } from "./model.ts";
import { raiseEmergency, type ReportDeps } from "./report.ts";

export const RESULT = { same: 0, changed: 1, gone: 2, unreachable: 3 } as const;
type Thing = { id: string; addr: string; iface: string; ops: string[]; recs: string[] };

export async function checkThing(d: ReportDeps, th: Thing) {
  let result: number = RESULT.unreachable;
  let tools = 0;
  let tool: Record<string, unknown> | null = null;
  try {
    const list = await mcpListTools(th.addr, d.fetch);
    tools = list.length;
    for (const t of list) if ((await hashOf(t)) === th.iface) tool = t;
    if (tool) result = RESULT.same;
    else {
      for (const t of list) if (th.ops.includes(await ident(String(t.name)))) tool = t;
      result = tool ? RESULT.changed : RESULT.gone;
    }
  } catch {
    result = RESULT.unreachable;
  }

  // rules: null = no judgement possible (gone / unreachable) → flags stay as they are.
  // Otherwise the canary judges again and the live flags become exactly `rules` (it clears its own flags).
  let rules: number[] | null = null;
  let how = 0;
  let text = "";
  let th_: string | null = null;
  let verdict: number | null = null;
  if (tool) {
    text = toolText(tool);
    th_ = await hashOf(text);
    const s = scanText(text);
    rules = [];
    if (s.certain.length) rules = s.certain;
    else if (s.suspect.length) {
      // same text, same rules version, judged recently → no new model call
      const memo = (await d.rpc("aua_canary_memo", { p_thing: th.id, p_th: th_, p_rv: RULES_V })) as number | null;
      if (memo === 1) (rules = s.suspect), (how = 1);
      else if (memo === 0) rules = [];
      else {
        const m = await useModel(d.rpc, d.model, {
          role: "judge", system: CANARY_JUDGE.system, schema: CANARY_JUDGE.schema, maxTokens: 16000, input: CANARY_JUDGE.input(text),
        });
        const v = m.ok ? String(m.out.verdict) : "";
        if (v === "instruction") (rules = s.suspect), (how = 1), (verdict = 1);
        else if (v === "documentation") (rules = []), (verdict = 0);
        else (rules = s.suspect), (how = 2); // unsure, or no model: keep it safe; asked again next run
      }
    }
  }
  const fresh = (await d.rpc("aua_wind_put", {
    p_thing: th.id, p_result: result, p_tools: tools, p_rules: rules, p_how: how, p_th: th_, p_rv: RULES_V, p_verdict: verdict,
  })) as number[];
  let emergency: Awaited<ReturnType<typeof raiseEmergency>> | null = null;
  if (fresh && fresh.length) emergency = await raiseEmergency(d, { thing: th.id, recs: th.recs, rules: fresh, how, text });
  return { thing: th.id, result, tools, rules: rules ?? [], how, emergency };
}

export async function runWind(d: ReportDeps, batch?: number) {
  const lim = batch ?? Number(await d.rpc("aua_knob", { p: "wind_batch" })) ?? 200;
  const things = (await d.rpc("aua_wind_things", { p_lim: lim, p_rv: RULES_V })) as Thing[];
  const out = [];
  for (const th of things) out.push(await checkThing(d, th));
  return out;
}

/**
 * The canary on talk (2_ §2.4): talk whose text the rules could not call (suspects, stored at write) goes to
 * the judge model, with its server-side fallback, booked in the same ledger and under the same monthly cap
 * as every model call. instruction → flagged ('model'); documentation → clear; unsure → flagged ('unsure');
 * no model or over the cap → flagged to be safe ('unjudged'), asked again on the next run with a model.
 * What a flag then does (not served, chain weight) waits for George (talk batch part 2, question C).
 */
type Canary = { state: number; how: string | null };
const HOW: Record<string, number> = { rules: 0, model: 1, unsure: 2, unjudged: 3 };

/** a talk_flag record (hole 4): the canary's flag, signed by the wind key, in the replica */
async function putTalkFlag(d: ReportDeps, talk: string, state: 1 | 2, how: string, rules: number[]) {
  if (!d.signer || !d.aua) return false;
  const rec: Record<string, unknown> = {
    aua: d.aua, talk, state, how: HOW[how], rules, rv: TALK_RULES_V, by: { key: d.signer.pub }, t: Math.floor(d.now().getTime() / 1000),
  };
  const pk = await crypto.subtle.importKey("jwk", d.signer.jwk, { name: "Ed25519" }, false, ["sign"]);
  rec.sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pk, new TextEncoder().encode(canon(rec))));
  await d.rpc("aua_put_talk_flag", { p_id: await recordId(rec), p_rec: rec });
  return true;
}
/** a record is signed when a talk becomes flagged (or its reason changes), and when a flag is cleared */
const signs = (old: Canary, now: Canary) =>
  (now.state === 2 && (old.state !== 2 || old.how !== now.how)) || (old.state === 2 && now.state === 1);

/**
 * The canary on talk, each wind run (George 11/12, the five holes):
 *  1. rescan: every talk scanned under an older talk rules version (all talk, not only suspects);
 *  2. judge: suspects, and flags no model could judge yet, go to the judge model (server-side fallback kept;
 *     same ledger, same monthly cap). The answer is about instructions to the reader, not about speaking to an AI.
 * A flag hides that one talk and sets its signer's talk ordering to 0 while it lasts (computed live by the
 * root); its uses are untouched. Every change of a flag is signed by the wind key as a talk_flag record.
 */
export async function runTalkCanary(d: ReportDeps, lim = 50) {
  const out = { rescanned: 0, judged: 0, flagged: 0, cleared: 0, unjudged: 0, records: 0 };
  const rs = (await d.rpc("aua_talk_to_rescan", { p_rv: TALK_RULES_V, p_lim: lim })) as ({ id: string; text: string } & Canary)[];
  for (const r of rs) {
    const s = scanTalk(r.text);
    const keepModel = r.state === 2 && r.how === "model"; // a model's "instruction" stands until the model clears it
    const now: Canary = s.certain.length ? { state: 2, how: "rules" }
      : keepModel ? { state: 2, how: "model" }
      : s.suspect.length ? (r.state === 2 ? { state: 2, how: "unjudged" } : { state: 0, how: null })
      : { state: 1, how: "rules" };
    await d.rpc("aua_talk_rescanned", { p_id: r.id, p_state: now.state, p_how: now.how, p_rules: s.certain.length ? s.certain : s.suspect, p_rv: TALK_RULES_V });
    out.rescanned++;
    if (now.state === 2 && now.how === "rules" && r.state !== 2) out.flagged++;
    if (now.state === 1 && r.state === 2) out.cleared++;
    if (signs(r, now) && (await putTalkFlag(d, r.id, now.state as 1 | 2, now.how!, s.certain.length ? s.certain : s.suspect))) out.records++;
  }
  const todo = (await d.rpc("aua_talk_to_judge", { p_lim: lim })) as ({ id: string; text: string; suspect: number[] } & Canary)[];
  for (const t of todo) {
    const m = await useModel(d.rpc, d.model, {
      role: "judge", system: TALK_JUDGE.system, schema: TALK_JUDGE.schema, maxTokens: 16000, input: TALK_JUDGE.input(t.text),
    });
    const v = m.ok ? String(m.out.verdict) : "";
    const now: Canary = v === "instruction" ? { state: 2, how: "model" } : v === "not_instruction" ? { state: 1, how: "model" }
      : m.ok ? { state: 2, how: "unsure" } : { state: 2, how: "unjudged" };
    await d.rpc("aua_talk_judged", { p_id: t.id, p_state: now.state, p_how: now.how });
    if (m.ok) out.judged++;
    if (now.state === 1) out.cleared++;
    else if (now.how === "unjudged") out.unjudged++;
    else out.flagged++;
    if (signs(t, now) && (await putTalkFlag(d, t.id, now.state as 1 | 2, now.how!, t.suspect ?? []))) out.records++;
  }
  return out;
}
