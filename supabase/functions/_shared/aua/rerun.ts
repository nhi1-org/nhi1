// Wind-tunnel re-runs (S4 A + B; George 11/13 一): the board's first calls of other agents' public tools.
// Bounds (S4 Q8 (a), George 11/13 agreed): only effect 0; never a tool the canary flags; no key or credential
// is sent (the MCP client below sends none); the tool's answer is never stored and never shown to any model —
// it is read once, here, to decide code / err, then dropped. Every re-run becomes a replay_result record signed
// by the wind key that points straight at the use (Q3 (b)). Runtime-agnostic (fetch, rpc, clock injected).
//   how 0 — stub re-run (no tokens): a stub blob with no $s / $h; $n -> 1, $b -> false, other leaves as they are (Q5 (b)).
//   how 1 — cross-family re-run (rpf.ts): another model family writes the values.
// pass (Q6 (a)) = code 0: the call answered with no protocol error and no isError; a tool that declares an
// outputSchema must answer with structuredContent that fits it, else code 1 (partial). A weak pass: the call
// can be made, not that the answer is right. Apache-2.0.
import { canon, hashOf, ident, recordId, toHex } from "./canon.ts";
import { type Fetch, mcpCallTool, mcpListTools } from "./mcp.ts";
import type { Rpc } from "./handlers.ts";
import { ERR } from "./schema.ts";

export type Signer = { pub: string; jwk: JsonWebKey };
export type RerunDeps = { rpc: Rpc; fetch: Fetch; now: () => Date; signer?: Signer; aua?: string };
export type Outcome = { code: number; err: number };
const E = Object.fromEntries(ERR.map((n, i) => [n, i])) as Record<(typeof ERR)[number], number>;

export const knob = async (rpc: Rpc, name: string) => Number(await rpc("aua_knob", { p: name }));

// ── the stub fill (Q5 (b)) ──
const PH = /^\$([snbh])[0-9]?$/;
/** true when the blob has a placeholder only a model can fill ($s string, $h hash) */
export function needsModel(blob: unknown): boolean {
  if (blob === null || typeof blob !== "object") return typeof blob === "string" && /^\$[sh][0-9]?$/.test(blob);
  return Object.values(blob as Record<string, unknown>).some(needsModel);
}
/** the arguments of a stub re-run: $n -> 1, $b -> false; numbers, bools, null and hash strings as they are */
export function fillStub(blob: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(blob)) {
    const m = typeof v === "string" ? PH.exec(v) : null;
    if (m) {
      if (m[1] === "n") out[k] = 1;
      else if (m[1] === "b") out[k] = false;
      else throw new Error("stub: $" + m[1] + " needs a model (cross-family re-run)");
    } else if (v !== null && typeof v === "object") out[k] = fillStub(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
/** a model's arguments laid over a stub: the stub's fixed leaves win; every placeholder must be filled */
export function overStub(blob: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(blob)) {
    const a = args?.[k];
    if (typeof v === "string" && PH.test(v)) {
      if (a === undefined) return null;
      out[k] = a;
    } else if (v !== null && typeof v === "object") {
      const sub = overStub(v as Record<string, unknown>, (a && typeof a === "object" && !Array.isArray(a) ? a : {}) as Record<string, unknown>);
      if (!sub) return null;
      out[k] = sub;
    } else out[k] = v;
  }
  return out;
}

// ── the pass definition (Q6 (a)) ──
/** a small JSON-Schema check (type, required, properties, items, enum): enough for "fits its outputSchema" */
export function fits(schema: unknown, v: unknown, depth = 0): boolean {
  if (!schema || typeof schema !== "object" || depth > 8) return true;
  const s = schema as Record<string, any>;
  if (Array.isArray(s.enum) && !s.enum.some((x: unknown) => canon(x) === canon(v))) return false;
  const types = s.type === undefined ? null : Array.isArray(s.type) ? s.type : [s.type];
  if (types) {
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
    if (!types.some((x: string) => x === t || (x === "number" && t === "integer"))) return false;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Array.isArray(s.required) && s.required.some((k: string) => !(k in o))) return false;
    if (s.properties && typeof s.properties === "object") {
      for (const [k, sub] of Object.entries(s.properties)) if (k in o && !fits(sub, o[k], depth + 1)) return false;
    }
  }
  if (Array.isArray(v) && s.items) return v.every((x) => fits(s.items, x, depth + 1));
  return true;
}
/** code / err of one tools/call answer; the answer itself goes no further than this function */
export function judgeAnswer(tool: Record<string, unknown>, res: { isError?: boolean; structuredContent?: unknown }): Outcome {
  if (res.isError === true) return { code: 2, err: E.upstream_error };
  if (tool.outputSchema && !(res.structuredContent !== undefined && fits(tool.outputSchema, res.structuredContent))) return { code: 1, err: E.other };
  return { code: 0, err: E.none };
}
/** a failed MCP exchange → err (timeout 1, auth 2, rate 5, the tool's own error 6, network 7) */
export function errOf(e: unknown): number {
  const name = (e as { name?: string })?.name ?? "";
  const msg = String((e as { message?: string })?.message ?? e);
  if (name === "TimeoutError" || name === "AbortError") return E.timeout;
  const http = /mcp http (\d+)/.exec(msg);
  if (http) {
    const c = Number(http[1]);
    return c === 401 || c === 403 ? E.auth_required : c === 429 ? E.rate_limited : c === 404 ? E.not_found : E.upstream_error;
  }
  if (/no result/.test(msg)) return E.upstream_error;
  return E.network;
}

/** the tool as it is served now, matched by the use's interface hash; null = gone or changed */
export async function findTool(d: RerunDeps, addr: string, iface: string, op: string, ms: number) {
  const list = await mcpListTools(addr, d.fetch, ms);
  for (const t of list) if ((await hashOf(t)) === iface && (await ident(String(t.name))) === op) return t;
  return null;
}
/** call it once; the answer is judged and dropped */
export async function callOnce(d: RerunDeps, addr: string, tool: Record<string, unknown>, args: Record<string, unknown>, ms: number): Promise<Outcome> {
  try {
    return judgeAnswer(tool, await mcpCallTool(addr, d.fetch, String(tool.name), args, ms));
  } catch (e) {
    return { code: 2, err: errOf(e) };
  }
}

/** sign a replay_result with the wind key and store it; returns its id */
export async function putResult(
  d: RerunDeps,
  f: { use: string; req: string | null; how: 0 | 1; out: Outcome; fam?: string | null; model?: string | null },
): Promise<string | null> {
  if (!d.signer || !d.aua) return null;
  const rec: Record<string, unknown> = {
    aua: d.aua, use: f.use, req: f.req, how: f.how, code: f.out.code, err: f.out.err,
    fam: f.how === 1 ? f.fam ?? null : null, model: f.how === 1 ? f.model ?? null : null,
    by: { key: d.signer.pub }, t: Math.floor(d.now().getTime() / 1000),
  };
  const pk = await crypto.subtle.importKey("jwk", d.signer.jwk, { name: "Ed25519" }, false, ["sign"]);
  rec.sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pk, new TextEncoder().encode(canon(rec))));
  const id = await recordId(rec);
  await d.rpc("aua_put_replay_result", { p_id: id, p_rec: rec });
  return id;
}

/** one stub re-run without signing (the digest's sandbox uses it before its use exists) */
export async function stubTry(d: RerunDeps, t: { addr: string; iface: string; op: string; stub: Record<string, unknown> }, ms: number): Promise<Outcome> {
  let tool: Record<string, unknown> | null;
  try {
    tool = await findTool(d, t.addr, t.iface, t.op, ms);
  } catch (e) {
    return { code: 2, err: errOf(e) };
  }
  if (!tool) return { code: 2, err: E.iface_mismatch }; // the interface changed: no call
  return callOnce(d, t.addr, tool, fillStub(t.stub), ms);
}

type Todo = { use: string; req: string | null; thing: string; addr: string; iface: string; op: string; stub: Record<string, unknown> };
export type StubOut = { status: "off" | "nokey" | "ran"; ran: number; pass: number; fail: number };

/** B: the day's stub re-runs (requests first, then the least recently re-run digest stubs); knob replay_on gates it */
export async function runStubReplay(d: RerunDeps, batch?: number): Promise<StubOut> {
  const out: StubOut = { status: "off", ran: 0, pass: 0, fail: 0 };
  if ((await knob(d.rpc, "replay_on")) !== 1) return out;
  if (!d.signer || !d.aua) return { ...out, status: "nokey" };
  out.status = "ran";
  const ms = (await knob(d.rpc, "replay_call_ms")) || 15000;
  const todo = (await d.rpc("aua_replay_todo", { p_lim: batch ?? (await knob(d.rpc, "replay_batch")) })) as Todo[];
  for (const u of todo) {
    if (needsModel(u.stub)) continue; // the SQL already leaves these to rpf; belt and braces
    const o = await stubTry(d, u, ms);
    await putResult(d, { use: u.use, req: u.req, how: 0, out: o });
    out.ran++;
    if (o.code === 0) out.pass++;
    else out.fail++;
  }
  return out;
}
