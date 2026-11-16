// NHI-2 private cabin: the root side. One endpoint (aua.json ep.mem, 9_ §8 第 5 題), ops put / head / boot /
// all / del / reg / check (and the old key box, box_get / box_put, closed by knob box_on since 11/16). The root checks the shell (codes, numbers, hashes, ciphertext — never free text), the signature,
// the mem chain and the quotas; it never sees plaintext, keys or passwords (9_ §3.2【定】). Runtime-agnostic:
// supabase/functions/mem/index.ts and tools/local-board.ts both call handleMem.
import { bytes, canon, hashOf, recordId, verifyEd25519, verifyRecord } from "./canon.ts";
import type { Deps, Res } from "./handlers.ts";
import { MEM_ERR as E, MEM_SCHEMA } from "./mem-schema.ts";

export const MEM_AUA = hashOf(MEM_SCHEMA);

const H = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const DAY = 86400;
const L = MEM_SCHEMA.limits;
const KINDS = new Set([0, 1, 2, 4, 6]);
const STATUS: Record<number, number> = {
  [E.sig]: 401, [E.rate]: 429, [E.too_large]: 413, [E.mem_head]: 409, [E.day_full]: 507, [E.total_full]: 507,
  [E.root_full]: 507, [E.writes_off]: 503, [E.not_found]: 404, [E.box_none]: 404, [E.box_ver]: 409, [E.box_taken]: 409,
  [E.box_closed]: 410,
};
const fail = (code: number): Res => ({ status: STATUS[code] ?? 400, body: { err: code } });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (o: Record<string, unknown>, req: string[], opt: string[] = []) =>
  req.every((k) => k in o) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k));
const uint = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
const hashList = (x: unknown, max: number) =>
  Array.isArray(x) && x.length <= max && x.every((h) => typeof h === "string" && H.test(h)) && new Set(x).size === x.length;

/** bytes of a base64url string once decoded (no padding) */
export function b64uLen(s: string): number {
  const r = s.length % 4;
  if (r === 1) return -1;
  return Math.floor(s.length / 4) * 3 + (r === 0 ? 0 : r - 1);
}

/** shell check: exact fields, codes, numbers, hashes only. → 0 or an error code */
export function validateMem(rec: unknown): number {
  if (!isObj(rec)) return E.shape;
  if (!exact(rec, ["aua", "key", "seq", "prev", "kind", "kv", "t", "size", "enc", "refs", "sup", "upto", "sig"])) return E.free_text;
  const r = rec as Record<string, any>;
  if (typeof r.aua !== "string" || !H.test(r.aua)) return E.shape;
  if (typeof r.key !== "string" || !H.test(r.key)) return E.shape;
  if (!uint(r.seq)) return E.shape;
  if (r.seq === 0 ? r.prev !== null : !(typeof r.prev === "string" && H.test(r.prev))) return E.shape;
  if (!Number.isInteger(r.kind) || !KINDS.has(r.kind)) return E.shape;
  if (!uint(r.kv) || r.kv < 1) return E.shape;
  if (!uint(r.t) || r.t % DAY !== 0) return E.shape;
  if (typeof r.enc !== "string" || !B64U.test(r.enc)) return E.shape;
  if (!uint(r.size) || r.size < 29 || r.size > L.enc) return r.size > L.enc ? E.too_large : E.shape; // iv 12 + tag 16 + >= 1
  if (b64uLen(r.enc) !== r.size) return E.shape;
  if (!hashList(r.refs, L.refs) || !hashList(r.sup, L.sup)) return E.shape;
  if (r.kind === 4 ? !(uint(r.upto) && r.upto < r.seq) : r.upto !== null) return E.shape;
  if (typeof r.sig !== "string" || !SIG.test(r.sig)) return E.shape;
  return 0;
}

/** a signed read / delete request → 0 or an error code */
export function validateMemReq(b: unknown): number {
  if (!isObj(b)) return E.shape;
  const op = b.op;
  const opt = op === "all" ? ["after", "lim"] : op === "del" ? ["ids"] : [];
  if (!exact(b, ["op", "aua", "key", "t", "sig"], opt)) return E.free_text;
  if (typeof b.aua !== "string" || !H.test(b.aua) || typeof b.key !== "string" || !H.test(b.key)) return E.shape;
  if (!uint(b.t) || typeof b.sig !== "string" || !SIG.test(b.sig)) return E.shape;
  if (op === "all") {
    if ("after" in b && !(Number.isSafeInteger(b.after) && (b.after as number) >= -1)) return E.shape;
    if ("lim" in b && !(Number.isInteger(b.lim) && (b.lim as number) >= 1 && (b.lim as number) <= L.page)) return E.shape;
  }
  if (op === "del" && !(hashList(b.ids, L.del) && (b.ids as string[]).length >= 1)) return E.shape;
  return 0;
}

const clockOk = (t: number, now: number) => Math.abs(t - now) <= L.clockSkew;
/** a mem's day: today, or yesterday / tomorrow within clockSkew of 00:00 UTC */
export function memDayOk(t: number, now: number): boolean {
  const today = now - (((now % DAY) + DAY) % DAY);
  if (t === today) return true;
  if (t === today - DAY) return now - today <= L.clockSkew;
  if (t === today + DAY) return today + DAY - now <= L.clockSkew;
  return false;
}

/** a box request's shape → 0 or an error code */
export function validateBoxReq(b: unknown): number {
  if (!isObj(b)) return E.shape;
  if (b.op === "box_get") {
    if (!exact(b, ["op", "aua", "door", "t", "sig"])) return E.free_text;
  } else if (b.op === "box_put") {
    if (!exact(b, ["op", "aua", "door", "next", "pub", "ver", "size", "box", "t", "sig", "psig"], ["nsig"])) return E.free_text;
    if (typeof b.next !== "string" || !H.test(b.next) || typeof b.pub !== "string" || !H.test(b.pub)) return E.shape;
    if (!uint(b.ver) || (b.ver as number) < 1) return E.shape;
    if (typeof b.box !== "string" || !B64U.test(b.box) || !uint(b.size)) return E.shape;
    if ((b.size as number) > L.box) return E.too_large;
    if ((b.size as number) < 29 || b64uLen(b.box) !== b.size) return E.shape;
    if (typeof b.psig !== "string" || !SIG.test(b.psig)) return E.shape;
    if (b.next === b.door ? "nsig" in b : !(typeof b.nsig === "string" && SIG.test(b.nsig))) return E.shape;
    if (b.pub === b.door || b.pub === b.next) return E.shape;
  } else return E.shape;
  if (typeof b.aua !== "string" || !H.test(b.aua) || typeof b.door !== "string" || !H.test(b.door)) return E.shape;
  if (!uint(b.t) || typeof b.sig !== "string" || !SIG.test(b.sig)) return E.shape;
  return 0;
}

/** the bytes every signer of a box_put signs: canon(request without sig, nsig, psig) */
export const boxSigningBytes = (b: Record<string, unknown>) => {
  const { sig: _a, nsig: _b, psig: _c, ...rest } = b;
  return bytes(canon(rest));
};

async function handleBox(b: Record<string, any>, d: Deps, aua: string): Promise<Res> {
  const c = validateBoxReq(b);
  if (c) return fail(c);
  if (b.aua !== aua) return fail(E.unknown_aua);
  if (!clockOk(b.t, d.now())) return fail(E.clock);
  if (b.op === "box_get") {
    if (!(await verifyRecord(b, b.door))) return fail(E.sig);
    const r = (await d.rpc("aua_box_get", { p_door: b.door, p_ip: d.ip })) as { err?: number; pub?: string; ver?: number; box?: string };
    return r.err ? fail(r.err) : { status: 200, body: { pub: r.pub, ver: r.ver, box: r.box } };
  }
  const m = boxSigningBytes(b);
  if (!(await verifyEd25519(b.door, b.sig, m))) return fail(E.sig);
  if (!(await verifyEd25519(b.pub, b.psig, m))) return fail(E.sig);
  if (b.next !== b.door && !(await verifyEd25519(b.next, b.nsig, m))) return fail(E.sig);
  const r = (await d.rpc("aua_box_put", {
    p_door: b.door, p_next: b.next, p_pub: b.pub, p_ver: b.ver, p_box: b.box, p_size: b.size, p_ip: d.ip,
  })) as { err?: number; ver?: number };
  return r.err ? fail(r.err) : { status: b.ver === 1 ? 201 : 200, body: { ver: r.ver } };
}

/** the verify-only request → 0 or an error code */
export function validateCheck(b: Record<string, unknown>): number {
  if (!exact(b, ["op", "aua", "key", "n", "t", "sig"])) return E.free_text;
  if (typeof b.aua !== "string" || !H.test(b.aua) || typeof b.key !== "string" || !H.test(b.key)) return E.shape;
  if (typeof b.n !== "string" || !H.test(b.n) || !uint(b.t) || typeof b.sig !== "string" || !SIG.test(b.sig)) return E.shape;
  return 0;
}

export async function handleMem(body: unknown, d: Deps): Promise<Res> {
  if (!isObj(body) || typeof body.op !== "string") return fail(E.shape);
  const aua = await MEM_AUA;
  if (body.op === "box_get" || body.op === "box_put") return handleBox(body, d, aua);
  if (body.op === "check") {
    // verify only (George 11/16): no gate, no counter, no row — the answer is the signature's, and whether the key has a room
    const c = validateCheck(body);
    if (c) return fail(c);
    if (body.aua !== aua) return fail(E.unknown_aua);
    if (!clockOk(body.t as number, d.now())) return fail(E.clock);
    if (!(await verifyRecord(body, body.key as string))) return { status: 200, body: { ok: 0 } };
    return { status: 200, body: { ok: 1, room: (await d.rpc("aua_room_has", { p_pub: body.key })) ? 1 : 0 } };
  }
  if (body.op === "put") {
    if (!exact(body, ["op", "rec"])) return fail(E.free_text);
    const c = validateMem(body.rec);
    if (c) return fail(c);
    const rec = body.rec as Record<string, any>;
    if (rec.aua !== aua) return fail(E.unknown_aua);
    if (!memDayOk(rec.t, d.now())) return fail(E.clock);
    if (!(await verifyRecord(rec, rec.key))) return fail(E.sig);
    const g = (await d.rpc("aua_mem_gate", { p_key: rec.key, p_ip: d.ip, p_op: 0 })) as number;
    if (g) return fail(g);
    const id = await recordId(rec);
    const r = (await d.rpc("aua_mem_put", { p_id: id, p_rec: rec })) as { err?: number; head?: string | null; seq?: number | null; id?: string; dup?: boolean };
    if (r.err === E.mem_head) return { status: 409, body: { err: E.mem_head, head: r.head ?? null, seq: r.seq ?? null } };
    if (r.err) return fail(r.err);
    return { status: r.dup ? 200 : 201, body: { id, seq: rec.seq, dup: r.dup ? 1 : 0 } };
  }
  if (!["head", "boot", "all", "del", "reg"].includes(body.op)) return fail(E.shape);
  const c = validateMemReq(body);
  if (c) return fail(c);
  const q = body as Record<string, any>;
  if (q.aua !== aua) return fail(E.unknown_aua);
  if (!clockOk(q.t, d.now())) return fail(E.clock);
  if (!(await verifyRecord(q, q.key))) return fail(E.sig);
  const g = (await d.rpc("aua_mem_gate", { p_key: q.key, p_ip: d.ip, p_op: q.op === "del" ? 2 : 1 })) as number;
  if (g) return fail(g);
  if (q.op === "head") return { status: 200, body: await d.rpc("aua_mem_head", { p_key: q.key }) };
  if (q.op === "reg") {
    const r = (await d.rpc("aua_room_reg", { p_pub: q.key, p_ip: d.ip })) as { err?: number; room?: number; new?: number };
    return r.err ? fail(r.err) : { status: r.new ? 201 : 200, body: { room: 1, new: r.new ? 1 : 0 } };
  }
  if (q.op === "boot") return { status: 200, body: await d.rpc("aua_mem_boot", { p_key: q.key, p_lim: L.boot }) };
  if (q.op === "all") {
    return { status: 200, body: await d.rpc("aua_mem_all", { p_key: q.key, p_after: q.after ?? -1, p_lim: q.lim ?? L.page }) };
  }
  const n = (await d.rpc("aua_mem_del", { p_key: q.key, p_ids: q.ids })) as number;
  return { status: 200, body: { n } };
}

/** the bytes AES-GCM binds to a shell (both sides compute the same) */
export const memAad = (r: { aua: string; key: string; seq: number; kind: number; kv: number; t: number }) =>
  canon({ aua: r.aua, key: r.key, seq: r.seq, kind: r.kind, kv: r.kv, t: r.t });
