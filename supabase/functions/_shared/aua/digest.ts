// The digest (整理, 2_ §2.5; S4 C): where agents' talk about a tool adds up to a copyable call, the root, acting
// as one agent with its own key (Q9 (c), Q12 (a)), reads <= 5 cleared notes with a no-tool model, checks the
// candidate with no tokens, re-runs it in the wind tunnel's sandbox (Q8 (a): rerun.ts), and only if it passes,
// signs one use (code 0, effect 0, stub, from = the notes used) on its own chain, plus the replay_result of the
// sandbox run, so the view serves the stub at once (Q11 (c)). Nothing passes → nothing is made (2_ §2.5).
//   * Graffiti (about empty) never enters; only talk the canary cleared; never kind 5 (SQL, 0015).
//   * No model, over the monthly cap, a refusal or an answer off the schema → no digest that day; there is no
//     zero-token stand-in for reading.
//   * A candidate with $s / $h can only be sandboxed by the cross-family re-run (another family fills the values;
//     costs OpenAI tokens, its own day cap); without one it is not made that day 【暫，CODE 建議】. Apache-2.0.
import { canon, hashOf, ident, recordId, toHex } from "./canon.ts";
import type { Fetch } from "./mcp.ts";
import type { Rpc } from "./handlers.ts";
import { DIGEST_READER, type ModelFn, useModel } from "./model.ts";
import { findTool, knob, needsModel, type Outcome, putResult, type Signer, stubTry } from "./rerun.ts";
import { type RpfModel, rpfOnce } from "./rpf.ts";
import { validateUse } from "./validate.ts";

export type DigestDeps = {
  rpc: Rpc; fetch: Fetch; now: () => Date; model?: ModelFn; rpfModel?: RpfModel;
  signer?: Signer; // the wind key: signs the sandbox run's replay_result
  digestSigner?: Signer; // the digest key: signs the use
  aua?: string;
};
type Todo = {
  thing: string; addr: string; iface: string; fail: number; talk_n: number;
  task: string; op: string; cin: string; cout: string; talk: { id: string; text: string }[];
};
export type DigestOut = { status: "off" | "nokey" | "ran"; read: number; made: number; outcomes: number[] };
export const OUTCOME = { made: 0, no_candidate: 1, bad_answer: 2, sandbox_fail: 3, sandbox_unavailable: 4, interface_gone: 5 } as const;
const DAY = 86400;
export const RT = "nhi1-digest"; // by.rt of the uses the digest signs 【暫，CODE 建議】

/**
 * the zero-token check of a candidate (task card §1 C): a blob by the hard rule (validated as the stub of the use
 * it would become), <= 1 KB, top-level keys all in the input schema, every required key present
 */
export function candidateOk(c: unknown, inputSchema: unknown): c is Record<string, unknown> {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  if (new TextEncoder().encode(JSON.stringify(c)).length > 1024) return false;
  const s = (inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const props = s.properties && typeof s.properties === "object" ? Object.keys(s.properties) : [];
  if (!Object.keys(c).every((k) => props.includes(k))) return false;
  if (Array.isArray(s.required) && !s.required.every((k) => k in c)) return false;
  return true;
}

async function sign(rec: Record<string, unknown>, jwk: JsonWebKey) {
  const pk = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  rec.sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pk, new TextEncoder().encode(canon(rec))));
  return rec;
}

export async function runDigest(d: DigestDeps): Promise<DigestOut> {
  const out: DigestOut = { status: "off", read: 0, made: 0, outcomes: [] };
  if ((await knob(d.rpc, "digest_on")) !== 1) return out;
  if (!d.digestSigner || !d.signer || !d.aua) return { ...out, status: "nokey" };
  out.status = "ran";
  const left = (await knob(d.rpc, "digest_day_max")) - Number(await d.rpc("aua_digest_today", {}));
  if (left <= 0) return out;
  const ms = (await knob(d.rpc, "replay_call_ms")) || 15000;
  const todo = (await d.rpc("aua_digest_todo", { p_lim: left })) as Todo[];
  for (const th of todo) {
    const log = async (o: number, use: string | null = null) => {
      out.outcomes.push(o);
      await d.rpc("aua_digest_log", { p_thing: th.thing, p_outcome: o, p_use: use, p_fail: th.fail, p_talk_n: th.talk_n });
    };
    let tool: Record<string, unknown> | null = null;
    try {
      tool = await findTool(d, th.addr, th.iface, th.op, ms);
    } catch { /* unreachable today: not read, tried again next run */ continue; }
    if (!tool) {
      await log(OUTCOME.interface_gone);
      continue;
    }
    const given = th.talk.slice(0, 5);
    const m = await useModel(d.rpc, d.model, {
      role: "digest", system: DIGEST_READER.system, schema: DIGEST_READER.schema, maxTokens: 16000,
      input: DIGEST_READER.input(tool.inputSchema, given),
    });
    if (!m.ok) {
      if (m.err === "off" || m.err === "cap") break; // no model today: nothing else to try
      continue; // refusal / network / off-schema: no digest of this thing today, nothing logged (asked again next run)
    }
    out.read++;
    const raw = String(m.out.candidate_json ?? "");
    if (!raw.trim()) {
      await log(OUTCOME.no_candidate);
      continue;
    }
    let cand: unknown;
    try {
      cand = JSON.parse(raw);
    } catch {
      cand = null;
    }
    const ids = new Set(given.map((t) => t.id));
    const used = Array.isArray(m.out.used) ? [...new Set((m.out.used as unknown[]).map(String))] : [];
    if (!candidateOk(cand, tool.inputSchema) || used.length < 1 || used.length > 16 || !used.every((u) => ids.has(u))) {
      await log(OUTCOME.bad_answer);
      continue;
    }
    // the use it would become, checked by the board's own validator before anything is run
    const day = Math.floor(d.now().getTime() / 1000 / DAY) * DAY;
    const head = (await d.rpc("aua_chain_head", { p_key: d.digestSigner.pub })) as string | null;
    const rec: Record<string, unknown> = {
      aua: d.aua, thing: { addr: th.addr, iface: th.iface }, call: { op: th.op, in: th.cin, out: th.cout }, task: th.task,
      result: { code: 0, err: 0 }, cost: { tin: 0, tout: 0, ms: 0, money: 0, cur: "" }, effect: 0,
      by: { key: d.digestSigner.pub, model: await ident(m.model), rt: await ident(RT) }, t: day, prev: head ?? null,
      stub: { in: cand, out: th.cout }, from: used.sort(), sig: "0".repeat(128),
    };
    if (validateUse(rec) !== 0) {
      await log(OUTCOME.bad_answer);
      continue;
    }
    // the sandbox: the wind tunnel's re-run (no tokens), or the cross-family re-run for $s / $h
    let o: Outcome | undefined;
    let how: 0 | 1 = 0;
    let fam: string | null = null, model: string | null = null;
    const t0 = Date.now();
    if (!needsModel(cand)) o = await stubTry(d, { addr: th.addr, iface: th.iface, op: th.op, stub: cand }, ms);
    else if (d.rpfModel && d.rpfModel.family.toLowerCase() !== "anthropic" && (await knob(d.rpc, "replay_on")) === 1 && (await d.rpc("aua_rpf_ok", {}))) {
      const r = await rpfOnce(d, d.rpfModel, th.addr, tool, cand, ms);
      o = r.out;
      how = 1;
      fam = await ident(d.rpfModel.family);
      model = await ident(r.model ?? d.rpfModel.model ?? "unknown");
    }
    if (!o) {
      await log(OUTCOME.sandbox_unavailable);
      continue;
    }
    if (o.code !== 0) {
      await log(OUTCOME.sandbox_fail); // 2_ §2.5: what does not pass the sandbox is not made
      continue;
    }
    delete rec.sig;
    (rec.cost as Record<string, number>).ms = Math.min(Date.now() - t0, 1e9);
    await sign(rec, d.digestSigner.jwk);
    const id = await recordId(rec);
    const thingId = await hashOf({ addr: th.addr, iface: th.iface });
    const put = (await d.rpc("aua_put_use", { p_id: id, p_rec: rec, p_thing_id: thingId, p_at: Math.floor(d.now().getTime() / 1000) })) as { err?: number };
    if (put.err) continue; // the chain moved under it (another run): tried again next run
    await putResult(d, { use: id, req: null, how, out: o, fam, model });
    await log(OUTCOME.made, id);
    out.made++;
  }
  return out;
}
