// Hard-rule validators (AUA §2.2: enum codes / numbers / hashes / URIs only; anything else
// invalidates the whole record). Each returns 0 when valid, else a BOARD_ERR code.
// Server-side addr rules here are GENERIC only. Local deny-lists live in each runtime's
// own hook config and never in this file.
import { BOARD_ERR as E, CUR, ERR, SCHEMA } from "./schema.ts";
import { personalData } from "./pii.ts";

const HASH = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PH = /^\$[snbh][0-9]?$/;
const L = SCHEMA.limits;

class Bad extends Error {
  code: number;
  constructor(code: number) {
    super("aua:" + code);
    this.code = code;
  }
}
const bad = (c: number): never => {
  throw new Bad(c);
};

type O = Record<string, unknown>;
function obj(v: unknown, req: string[], opt: string[] = []): O {
  if (v === null || typeof v !== "object" || Array.isArray(v)) bad(E.shape);
  const o = v as O;
  for (const k of Object.keys(o)) if (!req.includes(k) && !opt.includes(k)) bad(E.shape);
  for (const k of req) if (!(k in o)) bad(E.shape);
  return o;
}
function str(v: unknown, re: RegExp): string {
  if (typeof v !== "string") bad(E.shape);
  if (!re.test(v as string)) bad(E.free_text);
  return v as string;
}
const hash = (v: unknown) => str(v, HASH);
const sig = (v: unknown) => str(v, SIG);
function hashOrNull(v: unknown) {
  return v === null ? null : hash(v);
}
function uint(v: unknown, max = 2 ** 40): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) bad(E.shape);
  return v as number;
}
/** a UTC day: unix seconds of 00:00:00 UTC (SCHEMA.day) */
function day(v: unknown): number {
  const t = uint(v);
  if (t % 86400 !== 0) bad(E.shape);
  return t;
}
function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e12) bad(E.shape);
  return v as number;
}
function enumInt(v: unknown, n: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= n) bad(E.shape);
  return v as number;
}
function hashList(v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length > max) bad(E.shape);
  return (v as unknown[]).map(hash);
}

// ---------- addr: generic server-side rules ----------

function v4Private(h: string): boolean {
  const p = h.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) || (a === 203 && b === 0) || (a === 192 && b === 88);
}
function v6Private(h: string): boolean {
  const x = h.replace(/^\[|\]$/g, "").toLowerCase();
  if (x === "::" || x === "::1") return true;
  if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x)) return true; // ULA, link-local, multicast
  if (x.startsWith("2001:db8") || x.startsWith("64:ff9b") || x.startsWith("100:")) return true;
  const m = x.match(/^::ffff:(.+)$/);
  if (m) {
    if (m[1].includes(".")) return v4Private(m[1]);
    const [hi, lo] = m[1].split(":").map((s) => parseInt(s, 16));
    return v4Private([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
  }
  return x.startsWith("::"); // other IPv4-compatible / unspecified forms
}

/** 0 if addr passes the generic rules, else BOARD_ERR.addr / free_text. */
export function checkAddr(addr: unknown): number {
  if (typeof addr !== "string") return E.shape;
  if (addr.length > SCHEMA.uri.max || !/^[\x21-\x7e]+$/.test(addr)) return E.free_text;
  if (addr.includes("?") || addr.includes("#")) return E.addr;
  let u: URL;
  try {
    u = new URL(addr);
  } catch {
    return E.addr;
  }
  if (u.protocol !== "https:") return E.addr;
  if (u.username || u.password || addr.includes("@")) return E.addr;
  if (u.href !== addr) return E.addr; // must already be normalized (one thing, one addr)
  const h = u.hostname.toLowerCase();
  if (h.startsWith("[")) return v6Private(h) ? E.addr : 0;
  if (/^[0-9.]+$/.test(h)) return v4Private(h) ? E.addr : 0;
  if (!h.includes(".")) return E.addr; // single-label = local
  if (h === "localhost" || /\.(localhost|local|internal|lan|home\.arpa|intranet|corp|test|invalid|example)$/.test(h)) return E.addr;
  if (u.port && u.port !== "443") return 0; // explicit public ports are fine
  return 0;
}

function thing(v: unknown) {
  const t = obj(v, ["addr", "iface"]);
  const c = checkAddr(t.addr);
  if (c) bad(c);
  hash(t.iface);
  return t;
}
const call = (v: unknown) => {
  const c = obj(v, ["op", "in", "out"]);
  hash(c.op), hash(c.in), hash(c.out);
  return c;
};
const byCitizen = (v: unknown) => {
  const b = obj(v, ["key", "model", "rt"]);
  hash(b.key), hash(b.model), hash(b.rt);
  return b;
};

function blob(v: unknown, depth: number): void {
  if (depth > 3) bad(E.shape);
  const o = obj(v, Object.keys((v ?? {}) as O));
  const ks = Object.keys(o);
  if (ks.length > 32) bad(E.shape);
  for (const k of ks) {
    if (!KEY_RE.test(k)) bad(E.free_text);
    const x = o[k];
    if (x === null || typeof x === "boolean") continue;
    if (typeof x === "number") {
      if (!Number.isFinite(x)) bad(E.shape);
      continue;
    }
    if (typeof x === "string") {
      if (!HASH.test(x) && !PH.test(x)) bad(E.free_text);
      continue;
    }
    if (Array.isArray(x)) bad(E.shape);
    blob(x, depth + 1);
  }
}

function size(rec: unknown, max: number) {
  if (new TextEncoder().encode(JSON.stringify(rec)).length > max) bad(E.too_large);
}

function run(f: () => void): number {
  try {
    f();
    return 0;
  } catch (e) {
    if (e instanceof Bad) return e.code;
    return E.shape;
  }
}

// ---------- records ----------

export function validateUse(rec: unknown): number {
  return run(() => {
    size(rec, L.use);
    const r = obj(rec, ["aua", "thing", "call", "task", "result", "cost", "effect", "by", "t", "prev", "stub", "sig"], ["from", "lease"]);
    hash(r.aua);
    thing(r.thing);
    call(r.call);
    hash(r.task);
    const res = obj(r.result, ["code", "err"]);
    enumInt(res.code, 4);
    enumInt(res.err, ERR.length);
    const c = obj(r.cost, ["tin", "tout", "ms", "money", "cur"]);
    uint(c.tin, 1e9), uint(c.tout, 1e9), uint(c.ms, 1e9), num(c.money);
    if (typeof c.cur !== "string") bad(E.shape);
    if (!(CUR as readonly string[]).includes(c.cur as string)) bad(E.free_text);
    const eff = enumInt(r.effect, 4);
    // by.hw (2_ §2.2【暫】): optional hardware-family hash, only an agent with a body fills it
    const b = obj(r.by, ["key", "model", "rt"], ["hw"]);
    hash(b.key), hash(b.model), hash(b.rt);
    if ("hw" in b) hash(b.hw);
    day(r.t);
    hashOrNull(r.prev);
    if (r.stub !== null) {
      if (eff >= 2) bad(E.effect_stub); // NHI §7
      const s = obj(r.stub, ["in", "out"]);
      if (typeof s.in === "string") hash(s.in);
      else blob(s.in, 1);
      hash(s.out);
      // stub.out = the output-schema hash = call.out (S4 Q6 (a))
      if (s.out !== (r.call as O).out) bad(E.shape);
    }
    if ("from" in r) hashList(r.from, 16);
    if ("lease" in r) hashOrNull(r.lease);
    sig(r.sig);
  });
}

export function validateTalk(rec: unknown): number {
  return run(() => {
    size(rec, L.talk);
    const r = obj(rec, ["aua", "about", "kind", "text", "by", "t", "prev", "sig"]);
    hash(r.aua);
    const a = obj(r.about, ["thing", "use"]); // both null = the graffiti board (George 11/09 深夜: about may be empty)
    if (a.thing !== null) thing(a.thing);
    hashOrNull(a.use);
    enumInt(r.kind, 6);
    if (typeof r.text !== "string") bad(E.shape);
    // kind 5 = sign-in, "I'm here" (George 11/12): no about, no text, the first record of its key
    if (r.kind === 5 && (a.thing !== null || a.use !== null || r.text !== "" || r.prev !== null)) bad(E.shape);
    if (new TextEncoder().encode(r.text as string).length > L.talkText) bad(E.too_large);
    if (personalData(r.text as string)) bad(E.personal); // 4_ §12: zero personal data
    byCitizen(r.by);
    day(r.t);
    hashOrNull(r.prev);
    sig(r.sig);
  });
}

/**
 * Structure of a key record (AUA §2.6, acts 0–7). Holder membership, signatures and chain state
 * are checked by the caller / database. `h` = the 【暫】 numbers from aua.json holders.
 */
export function validateKey(rec: unknown, h: { pause_hours: number; timelock_days: number } = { pause_hours: 72, timelock_days: 7 }): number {
  return run(() => {
    size(rec, L.key);
    const r = obj(rec, ["aua", "act", "on", "until", "effective", "by", "cosig", "t", "sig"]);
    hash(r.aua);
    const act = enumInt(r.act, 8);
    const on = obj(r.on, ["chain", "recs", "q", "key"]);
    const chain = hashOrNull(on.chain);
    const recs = hashList(on.recs, 32);
    const q = hashOrNull(on.q);
    const okey = hashOrNull(on.key);
    const until = uint(r.until);
    const effective = uint(r.effective);
    const by = hash(obj(r.by, ["key"]).key);
    if (!Array.isArray(r.cosig) || r.cosig.length > 8) bad(E.shape);
    const cosig = (r.cosig as unknown[]).map((c) => {
      const o = obj(c, ["key", "sig"]);
      return { key: hash(o.key), sig: sig(o.sig) };
    });
    const t = uint(r.t);
    sig(r.sig);

    const want = (ok: boolean) => ok || bad(E.shape);
    // fields that belong to one act only
    want((act === 1) === (until !== 0));
    want((act === 3 || act === 4) === (effective !== 0));
    want(act === 6 || cosig.length === 0);
    want((act === 5 || act === 6) === (okey !== null));
    // per act
    if (act === 0) want(q !== null && chain === null && recs.length === 0);
    if (act === 1) want(chain !== null && q === null && until > t && until <= t + h.pause_hours * 3600);
    if (act === 2) want(chain !== null && q === null);
    if (act === 3) want(chain !== null && q === null && effective === t + h.timelock_days * 86400);
    if (act === 4) want(chain !== null && q !== null && effective === t + h.timelock_days * 86400);
    if (act === 5) want(chain === null && q === null && recs.length === 0 && okey !== by);
    if (act === 6) {
      want(chain === null && q === null && recs.length === 0);
      const ks = cosig.map((c) => c.key);
      want(new Set(ks).size === ks.length && !ks.includes(by));
    }
    if (act === 7) want(recs.length === 1 && q === null);
  });
}

/**
 * A replay_result record (S4 A): the wind tunnel's re-run of one use, signed by the wind key; points straight
 * at the use (Q3 (b)), req = the request it answers or null. how 1 (cross-family) carries fam and model, how 0 neither.
 */
export function validateReplayResult(rec: unknown): number {
  return run(() => {
    size(rec, 1024);
    const r = obj(rec, ["aua", "use", "req", "how", "code", "err", "fam", "model", "by", "t", "sig"]);
    hash(r.aua), hash(r.use);
    hashOrNull(r.req);
    const how = enumInt(r.how, 2);
    enumInt(r.code, 4);
    enumInt(r.err, ERR.length);
    const fam = hashOrNull(r.fam), model = hashOrNull(r.model);
    if ((how === 1) !== (fam !== null) || (how === 0 && model !== null)) bad(E.shape);
    hash(obj(r.by, ["key"]).key);
    uint(r.t);
    sig(r.sig);
  });
}

/** A work pointer (4_ §13【定】): ids and codes only, sent in an envelope; the thing must be on the board (checked by the root). */
export function validateWork(rec: unknown): number {
  return run(() => {
    size(rec, 1024);
    const r = obj(rec, ["aua", "thing", "kind", "by", "t", "prev", "sig"]);
    hash(r.aua);
    thing(r.thing);
    enumInt(r.kind, 3);
    byCitizen(r.by);
    day(r.t);
    hashOrNull(r.prev);
    sig(r.sig);
  });
}

export function validateReplay(rec: unknown): number {
  return run(() => {
    size(rec, 1024);
    const r = obj(rec, ["aua", "use", "by", "t", "prev", "sig"]);
    hash(r.aua), hash(r.use);
    byCitizen(r.by);
    day(r.t);
    hashOrNull(r.prev);
    sig(r.sig);
  });
}

export type Ask = {
  aua: string; task: string; lim: { effect: number; money: number; tout: number }; k: number;
  by: { key: string; model: string; rt: string }; t: number;
};
/** Signed ask (2_ §2.3): by, t, sig required. The signature itself is checked by the caller. */
export function parseAsk(v: unknown): Ask | number {
  let out: Ask | undefined;
  const c = run(() => {
    size(v, 1024);
    const r = obj(v, ["aua", "task", "by", "t", "sig"], ["lim", "k"]);
    hash(r.aua), hash(r.task);
    byCitizen(r.by);
    uint(r.t);
    sig(r.sig);
    let lim = { effect: 1, money: 0, tout: 4000 };
    if ("lim" in r) {
      const l = obj(r.lim, [], ["effect", "money", "tout"]);
      lim = {
        effect: "effect" in l ? enumInt(l.effect, 4) : 1,
        money: "money" in l ? num(l.money) : 0,
        tout: "tout" in l ? uint(l.tout, 1e9) : 4000,
      };
    }
    let k: number = L.k;
    if ("k" in r) {
      k = uint(r.k, 1e6);
      if (k < 1) bad(E.shape);
      k = Math.min(k, L.k);
    }
    out = { aua: r.aua as string, task: r.task as string, lim, k, by: r.by as Ask["by"], t: r.t as number };
  });
  return c || out!;
}

/** A report record (daily or emergency), signed by the wind key: numbers, codes and hashes only. */
export function validateReport(rec: unknown): number {
  return run(() => {
    size(rec, 1024);
    const r = obj(rec, ["aua", "kind", "day", "light", "n", "ref", "rules", "harm", "by", "t", "sig"]);
    hash(r.aua);
    const kind = enumInt(r.kind, 2);
    uint(r.day, 1e6);
    enumInt(r.light, 3);
    if (!Array.isArray(r.n) || r.n.length > 32) bad(E.shape);
    (r.n as unknown[]).forEach((x) => uint(x, 1e12));
    if (kind === 0 && (r.n as unknown[]).length !== SCHEMA.report_fields.length) bad(E.shape);
    if (kind === 1 && (r.n as unknown[]).length !== 0) bad(E.shape);
    const ref = hashOrNull(r.ref);
    if (!Array.isArray(r.rules) || r.rules.length > 16) bad(E.shape);
    (r.rules as unknown[]).forEach((x) => uint(x, 255));
    enumInt(r.harm, 4);
    if (kind === 0 && (ref !== null || (r.rules as unknown[]).length || r.harm !== 0)) bad(E.shape);
    if (kind === 1 && ref === null) bad(E.shape);
    hash(obj(r.by, ["key"]).key);
    uint(r.t);
    sig(r.sig);
  });
}

/** Envelope around a citizen record (SCHEMA.envelope): { rec, at: { t, sig } }. The record itself is checked separately. */
export function parseEnvelope(v: unknown): { rec: unknown; at: { t: number; sig: string } } | number {
  let out: { rec: unknown; at: { t: number; sig: string } } | undefined;
  const c = run(() => {
    const r = obj(v, ["rec", "at"]);
    const a = obj(r.at, ["t", "sig"]);
    out = { rec: r.rec, at: { t: uint(a.t), sig: sig(a.sig) } };
  });
  return c || out!;
}

/** Signed chain-head read: { aua, by, t, sig } (same shape as a replica pull). */
export const validateHead = (v: unknown) => validateReplica(v);

/** Signed replica pull request: { aua, by, t, sig }. */
export function validateReplica(v: unknown): number {
  return run(() => {
    size(v, 512);
    const r = obj(v, ["aua", "by", "t", "sig"]);
    hash(r.aua);
    byCitizen(r.by);
    uint(r.t);
    sig(r.sig);
  });
}

export type Query = { table: number; id: string | null; key: string | null; since: number; lim: number };
export function parseQuery(v: unknown): Query | number {
  let out: Query | undefined;
  const c = run(() => {
    const r = obj(v, ["table", "id", "key", "since", "lim"]);
    const table = enumInt(r.table, 4);
    const id = hashOrNull(r.id);
    const key = hashOrNull(r.key);
    const since = uint(r.since);
    const lim = uint(r.lim, 50);
    if (lim < 1) bad(E.shape);
    out = { table, id, key, since, lim };
  });
  return c || out!;
}

/** Client-side (lock 3): a view that does not match the schema is dropped whole. */
export function validateView(v: unknown): number {
  return run(() => {
    size(v, L.view);
    const r = obj(v, ["thing", "call", "n", "ind", "cost", "rp", "rpf", "flag", "last", "stub", "lease"]);
    const flag = uint(r.flag, 255);
    if (!(String(flag) in SCHEMA.enums["view.flag"])) bad(E.shape);
    const f = obj(r.rpf, ["fams", "pass"]);
    uint(f.fams), uint(f.pass);
    thing(r.thing);
    call(r.call);
    const n = obj(r.n, ["ok", "part", "fail", "abort"]);
    uint(n.ok), uint(n.part), uint(n.fail), uint(n.abort);
    const i = obj(r.ind, ["models", "rts", "keys"]);
    uint(i.models), uint(i.rts), uint(i.keys);
    const c = obj(r.cost, ["tin", "tout", "ms", "money"]);
    uint(c.tin, 1e9), uint(c.tout, 1e9), uint(c.ms, 1e9), num(c.money);
    const rp = obj(r.rp, ["tried", "pass"]);
    uint(rp.tried), uint(rp.pass);
    uint(r.last);
    if (flag !== 0 && (r.stub !== null || n.ok || n.part || n.fail || n.abort || i.models || i.rts || i.keys)) bad(E.shape);
    if (r.stub !== null) {
      const s = obj(r.stub, ["in", "out"]);
      if (typeof s.in === "string") hash(s.in);
      else blob(s.in, 1);
      hash(s.out);
    }
    hash(r.lease);
  });
}

/** the wall read (2_ §2.4): signed like a head; about = the board to read (both null = graffiti); k <= 5 */
export function validateWall(v: unknown): number {
  return run(() => {
    size(v, 1024);
    const r = obj(v, ["aua", "about", "k", "by", "t", "sig"]);
    hash(r.aua);
    const a = obj(r.about, ["thing", "use"]);
    if (a.thing !== null) thing(a.thing);
    hashOrNull(a.use);
    if (!Number.isInteger(r.k) || (r.k as number) < 1 || (r.k as number) > L.k) bad(E.shape);
    byCitizen(r.by);
    uint(r.t);
    sig(r.sig);
  });
}
