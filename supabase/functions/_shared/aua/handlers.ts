// Board handlers, runtime-agnostic. Deno entrypoints (supabase/functions/*/index.ts) and the
// local Node board (tools/local-board.ts) both call these. The handlers never execute a stub and
// never call a thing (only the wind tunnel does, S4 Q8 (a)), and never return free text: errors are {"err": <BOARD_ERR code>}.
import { bytes, canon, cosigningBytes, hashOf, recordId, verifyEd25519, verifyRecord } from "./canon.ts";
import type { Holders } from "./holders.ts";
import { BOARD_ERR as E, SCHEMA } from "./schema.ts";
import { scanTalk, TALK_RULES_V } from "./canary.ts";
import { parseAsk, parseEnvelope, parseQuery, validateHead, validateKey, validateReplay, validateReplica, validateTalk, validateUse, validateWall, validateWork } from "./validate.ts";

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;
export type Deps = {
  rpc: Rpc;
  now: () => number; // unix seconds
  ip: string; // hashed client IP (never stored raw)
  aua: string; // current schema hash
  holders: Holders;
  randomHex: (bytes: number) => string;
  store?: { get(path: string): Promise<Uint8Array | null> }; // private export bucket (replica only)
};
export type Res = { status: number; body: unknown };

const err = (status: number, code: number): Res => ({ status, body: { err: code } });
const STATUS: Record<number, number> = {
  [E.sig]: 401, [E.not_holder]: 403, [E.rate]: 429, [E.too_large]: 413, [E.not_found]: 404,
  [E.key_state]: 409, [E.chain_stopped]: 423, [E.replica_closed]: 503, [E.chain_head]: 409,
};
/** write gate result: 0 ok, 7 rate, 19 chain paused / cut */
const gate = async (d: Deps, key: string) => (await d.rpc("aua_gate_write", { p_key: key, p_ip: d.ip })) as number;
const fail = (code: number): Res => err(STATUS[code] ?? 400, code);

const bytesLen = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

function clockOk(t: number, now: number) {
  return Math.abs(t - now) <= SCHEMA.limits.clockSkew;
}

const DAY = 86400;
export const dayOf = (t: number) => t - (((t % DAY) + DAY) % DAY);

/**
 * The envelope's time rules (SCHEMA.envelope): at.t within clockSkew of the board; rec.t = the UTC day of
 * at.t; that day is today (board UTC) or, within clockSkew after 00:00 UTC, yesterday.
 */
export function stampOk(recT: number, atT: number, now: number): boolean {
  if (!clockOk(atT, now)) return false;
  if (recT !== dayOf(atT)) return false;
  const today = dayOf(now);
  return recT === today || (recT === today - DAY && now - today <= SCHEMA.limits.clockSkew);
}

/** at.sig: by.key signs canon({ id, t: at.t }) */
export const atBytes = (id: string, t: number) => bytes(canon({ id, t }));

type Sealed = { rec: Record<string, any>; at: { t: number; sig: string }; id: string };
/**
 * Open an envelope around a citizen record: shape, aua, time, both signatures. Returns the record and its
 * id, or a board error. A bare record (no envelope) is an old client: err 8, upgrade.
 */
async function openEnvelope(body: unknown, validate: (r: unknown) => number, d: Deps): Promise<Sealed | number> {
  if (body && typeof body === "object" && !Array.isArray(body) && "aua" in body && !("rec" in body)) return E.unknown_aua;
  const env = parseEnvelope(body);
  if (typeof env === "number") return env;
  const c = validate(env.rec);
  if (c) return c;
  const rec = env.rec as Record<string, any>;
  if (rec.aua !== d.aua) return E.unknown_aua;
  if (!stampOk(rec.t, env.at.t, d.now())) return E.clock;
  if (!(await verifyRecord(rec, rec.by.key))) return E.sig;
  const id = await recordId(rec);
  if (!(await verifyEd25519(rec.by.key, env.at.sig, atBytes(id, env.at.t)))) return E.sig;
  return { rec, at: env.at, id };
}

/** Signed ask (2_ §2.3): no signature, a bad one, or a stale t is refused; the lease is bound to by.key. */
export async function handleAsk(body: unknown, d: Deps): Promise<Res> {
  const a = parseAsk(body);
  if (typeof a === "number") return fail(a);
  if (a.aua !== d.aua) return fail(E.unknown_aua);
  if (!clockOk(a.t, d.now())) return fail(E.clock);
  if (!(await verifyRecord(body as Record<string, unknown>, a.by.key))) return fail(E.sig);
  if ((await d.rpc("aua_gate_ask", { p_ip: d.ip, p_key: a.by.key })) !== 0) return fail(E.rate);
  const lease = d.randomHex(32);
  const r = (await d.rpc("aua_ask", {
    p_task: a.task, p_effect: a.lim.effect, p_money: a.lim.money, p_tout: a.lim.tout, p_k: a.k, p_lease: lease, p_key: a.by.key,
  })) as { view: Record<string, unknown>[]; lease: string };
  // each view <= 1 KB: drop the stub first, then the view
  const view = r.view
    .map((v) => (bytesLen(v) > SCHEMA.limits.view ? { ...v, stub: null } : v))
    .filter((v) => bytesLen(v) <= SCHEMA.limits.view);
  const out = { aua: d.aua, view, lease: r.lease };
  try {
    await d.rpc("aua_note_ask", { p_bytes: bytesLen(out) }); // daily report item 3 (count + size only)
  } catch { /* never fail an ask over a counter */ }
  return { status: 200, body: out };
}

/** A collision on the chain: 409 + the key's current head, so the writer can re-stamp at once. */
const chainErr = (head: unknown): Res => ({ status: 409, body: { err: E.chain_head, head: head ?? null } });

export async function handleUse(body: unknown, d: Deps): Promise<Res> {
  const o = await openEnvelope(body, validateUse, d);
  if (typeof o === "number") return fail(o);
  const { rec, at, id } = o;
  const g = await gate(d, rec.by.key);
  if (g) return fail(g);
  const thingId = await hashOf({ addr: rec.thing.addr, iface: rec.thing.iface });
  const r = (await d.rpc("aua_put_use", { p_id: id, p_rec: rec, p_thing_id: thingId, p_at: at.t })) as
    { dup: boolean; lease: boolean; err?: number; head?: string | null };
  if (r.err === E.chain_head) return chainErr(r.head);
  return { status: r.dup ? 200 : 201, body: { id, lease: r.lease ? 1 : 0, dup: r.dup ? 1 : 0 } };
}

export async function handleReplay(body: unknown, d: Deps): Promise<Res> {
  const o = await openEnvelope(body, validateReplay, d);
  if (typeof o === "number") return fail(o);
  const { rec, at, id } = o;
  const g = await gate(d, rec.by.key);
  if (g) return fail(g);
  const r = (await d.rpc("aua_put_replay", { p_id: id, p_rec: rec, p_at: at.t })) as { err?: number; id: string; rp: unknown; head?: string | null };
  if (r.err === E.chain_head) return chainErr(r.head);
  if (r.err) return fail(r.err);
  return { status: 202, body: { id, rp: r.rp } };
}

/**
 * A talk (2_ §2.4): the same envelope, day t and prev chain as a use; its own quota (aua_gate_talk).
 * Refused before anything is stored: a personal-data shape (23, in validateTalk), or text the canary is
 * certain addresses an AI reader (22). Rule suspects are stored and wait for the model (talk_canary).
 * about.thing / about.use may both be null: the graffiti board.
 */
export async function handleTalk(body: unknown, d: Deps): Promise<Res> {
  const o = await openEnvelope(body, validateTalk, d);
  if (typeof o === "number") return fail(o);
  const { rec, at, id } = o;
  const scan = scanTalk(rec.text); // instructions to the reader, not the act of speaking to an AI (George 11/12)
  if (scan.certain.length) return fail(E.canary_hit);
  const g = (await d.rpc("aua_gate_talk", { p_key: rec.by.key, p_ip: d.ip })) as number;
  if (g) return fail(g);
  const th = rec.about.thing;
  const thingId = th ? await hashOf({ addr: th.addr, iface: th.iface }) : null;
  const r = (await d.rpc("aua_put_talk", {
    p_id: id, p_rec: rec, p_thing_id: thingId, p_at: at.t, p_suspect: scan.suspect, p_rv: TALK_RULES_V,
  })) as { dup?: boolean; err?: number; head?: string | null };
  if (r.err === E.chain_head) return chainErr(r.head);
  if (r.err) return fail(r.err);
  return { status: r.dup ? 200 : 201, body: { id, dup: r.dup ? 1 : 0 } };
}

/**
 * A work pointer (作品指標, 4_ §13【定】): the same envelope, day t and prev chain as a use; the write quota.
 * It points only at a thing already on the board (err 12 otherwise).
 */
export async function handleWork(body: unknown, d: Deps): Promise<Res> {
  const o = await openEnvelope(body, validateWork, d);
  if (typeof o === "number") return fail(o);
  const { rec, at, id } = o;
  const g = await gate(d, rec.by.key);
  if (g) return fail(g);
  const thingId = await hashOf({ addr: rec.thing.addr, iface: rec.thing.iface });
  const r = (await d.rpc("aua_put_work", { p_id: id, p_rec: rec, p_thing_id: thingId, p_at: at.t })) as
    { dup?: boolean; err?: number; head?: string | null };
  if (r.err === E.chain_head) return chainErr(r.head);
  if (r.err) return fail(r.err);
  return { status: r.dup ? 200 : 201, body: { id, dup: r.dup ? 1 : 0 } };
}

/**
 * The wall read (2_ §2.4): signed, <= 5 talks of one board (about both null = graffiti), only talk the canary
 * has cleared, ordered by the signer's talk ordering. The root hands out records, never a reading of them:
 * the reference skill gives the text only to a call with no tools and no MCP (讀牆; no 板子代讀).
 */
export async function handleWall(body: unknown, d: Deps): Promise<Res> {
  const c = validateWall(body);
  if (c) return fail(c);
  const rec = body as Record<string, any>;
  if (rec.aua !== d.aua) return fail(E.unknown_aua);
  if (!clockOk(rec.t, d.now())) return fail(E.clock);
  if (!(await verifyRecord(rec, rec.by.key))) return fail(E.sig);
  if ((await d.rpc("aua_gate_wall", { p_ip: d.ip, p_key: rec.by.key })) !== 0) return fail(E.rate);
  const th = rec.about.thing;
  const thingId = th ? await hashOf({ addr: th.addr, iface: th.iface }) : null;
  const talk = await d.rpc("aua_wall", { p_thing: thingId, p_use: rec.about.use, p_lim: rec.k });
  return { status: 200, body: { talk: talk ?? [] } };
}
/** The chain head of the asking key only (signed like an ask): { head: <id> | null }. */
export async function handleHead(body: unknown, d: Deps): Promise<Res> {
  const c = validateHead(body);
  if (c) return fail(c);
  const rec = body as Record<string, any>;
  if (rec.aua !== d.aua) return fail(E.unknown_aua);
  if (!clockOk(rec.t, d.now())) return fail(E.clock);
  if (!(await verifyRecord(rec, rec.by.key))) return fail(E.sig);
  if ((await d.rpc("aua_gate_head", { p_ip: d.ip, p_key: rec.by.key })) !== 0) return fail(E.rate);
  return { status: 200, body: { head: ((await d.rpc("aua_chain_head", { p_key: rec.by.key })) as string | null) ?? null } };
}

/** body = { rec: <key record, act 0>, query: { table, id, key, since, lim } }, rec.on.q = hash(query). */
export async function handleKeyView(body: unknown, d: Deps): Promise<Res> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fail(E.shape);
  const { rec, query, ...extra } = body as Record<string, any>;
  if (Object.keys(extra).length) return fail(E.shape);
  const c = validateKey(rec, d.holders);
  if (c) return fail(c);
  if (rec.act !== 0) return fail(E.act_endpoint);
  if (rec.aua !== d.aua) return fail(E.unknown_aua);
  if (!clockOk(rec.t, d.now())) return fail(E.clock);
  if (rec.by.key !== (await activeKey(d))) return fail(E.not_holder);
  if (!(await verifyRecord(rec, rec.by.key))) return fail(E.sig);
  const q = parseQuery(query);
  if (typeof q === "number") return fail(q);
  if ((await hashOf(query)) !== rec.on.q) return fail(E.q_mismatch);
  const g = await gate(d, rec.by.key);
  if (g) return fail(g);
  const id = await recordId(rec);
  const r = await d.rpc("aua_key_view", {
    p_id: id, p_rec: rec, p_table: q.table, p_qid: q.id, p_qkey: q.key, p_since: q.since, p_lim: q.lim,
  });
  return { status: 200, body: r };
}

/** The key in use now: aua.json `holders.active`, unless a later handover / wake moved it. */
async function activeKey(d: Deps): Promise<string> {
  return (await d.rpc("aua_key_active", { p_active: d.holders.active[0] ?? "" })) as string;
}

/**
 * Key acts 1–7 (AUA §2.6). body = the key record. Membership + signatures here; chain state
 * (one pause per chain, pending cut, revoke window, 180-day silence) in the database.
 */
export async function handleKey(body: unknown, d: Deps): Promise<Res> {
  const c = validateKey(body, d.holders);
  if (c) return fail(c);
  const rec = body as Record<string, any>;
  if (rec.act === 0) return fail(E.act_endpoint); // looks go through key-view, which answers them
  if (rec.aua !== d.aua) return fail(E.unknown_aua);
  if (!clockOk(rec.t, d.now())) return fail(E.clock);
  const active = await activeKey(d);
  if (rec.act === 6) {
    // wake: by + cosig must be exactly every dormant key (the active one excluded); on.key one of them
    const dormant = d.holders.dormant.filter((k) => k !== active);
    const signers = [rec.by.key, ...rec.cosig.map((x: { key: string }) => x.key)];
    if (!dormant.includes(rec.by.key) || !dormant.includes(rec.on.key)) return fail(E.not_holder);
    if (signers.length !== dormant.length || !dormant.every((k) => signers.includes(k))) return fail(E.not_holder);
    const msg = cosigningBytes(rec);
    for (const x of rec.cosig as { key: string; sig: string }[]) {
      if (!(await verifyEd25519(x.key, x.sig, msg))) return fail(E.sig);
    }
  } else if (rec.by.key !== active) {
    return fail(E.not_holder);
  }
  if (!(await verifyRecord(rec, rec.by.key))) return fail(E.sig);
  const g = await gate(d, rec.by.key);
  if (g) return fail(g);
  const id = await recordId(rec);
  const r = (await d.rpc("aua_put_key", {
    p_id: id, p_rec: rec, p_active: d.holders.active[0] ?? "", p_wake_sec: d.holders.wake_after_days * 86400,
  })) as { err?: number; dup?: boolean };
  if (r.err) return fail(r.err);
  return { status: r.dup ? 200 : 201, body: { id, dup: r.dup ? 1 : 0 } };
}

/**
 * Replica pull (3_ §5, 4_ §13): any signed key gets the latest full export; rate-limited, never
 * refused for lack of seniority. Closed (err 20) while the knob replica_open = 0.
 * Returns { manifest, gz_b64 } — the gzip NDJSON the daily export job wrote to the private bucket.
 */
export async function handleReplica(body: unknown, d: Deps): Promise<Res> {
  const c = validateReplica(body);
  if (c) return fail(c);
  const rec = body as Record<string, any>;
  if (rec.aua !== d.aua) return fail(E.unknown_aua);
  if (!clockOk(rec.t, d.now())) return fail(E.clock);
  if (!(await verifyRecord(rec, rec.by.key))) return fail(E.sig);
  const g = (await d.rpc("aua_gate_replica", { p_ip: d.ip, p_key: rec.by.key })) as number;
  if (g) return fail(g);
  if (!d.store) return fail(E.not_found);
  const manifest = await d.store.get("latest.json");
  const gz = await d.store.get("latest.ndjson.gz");
  if (!manifest || !gz) return fail(E.not_found);
  let b64 = "";
  for (let i = 0; i < gz.length; i += 0x8000) b64 += String.fromCharCode(...gz.subarray(i, i + 0x8000));
  return { status: 200, body: { manifest: JSON.parse(new TextDecoder().decode(manifest)), gz_b64: btoa(b64) } };
}

const TABLES = ["thing", "use", "talk", "key", "replay", "report", "talk_flag", "replay_result", "work"] as const;

/** Full export as NDJSON lines {"table","id","rec"} (records only). Returns the text and counts. */
export async function buildExport(rpc: Rpc): Promise<{ text: string; counts: Record<string, number> }> {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (let t = 0; t < TABLES.length; t++) {
    let after = "";
    counts[TABLES[t]] = 0;
    for (;;) {
      const page = (await rpc("aua_export_page", { p_table: t, p_after: after, p_lim: 1000 })) as { id: string; rec: unknown }[];
      for (const row of page) lines.push(canon({ table: TABLES[t], id: row.id, rec: row.rec }));
      counts[TABLES[t]] += page.length;
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
  }
  return { text: lines.join("\n") + (lines.length ? "\n" : ""), counts };
}
