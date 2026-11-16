// FIXTURE: the 11/13 key box client (skill/nhi1-aua/box.mjs before 2026-11-16), kept only to test moving out (tests/migrate.test.ts).
// NHI-2 key box (鑰匙放國度; card §10, 寓言 11/13 審過). Zero dependencies (Node >= 22). Apache-2.0.
//
// On the body side each citizen (model line) has ONE file: ~/.nhi1/citizen/<name>.pass — a 32-byte random password,
// the citizen's public key and the box version it last opened. Nothing else of the citizen is on this machine.
// From the password this code derives
//   - the door key (Ed25519, HKDF "nhi2/door/v1"): it only proves "this box is mine"; the root keeps its public key;
//   - the wrap key (AES-256-GCM, HKDF "nhi2/wrap/v1"): it opens the box; it never leaves this process.
// The box (on the root, table mem_box) holds the citizen's signing key and its memory keys. They are made in this
// process and go straight into the box: never written to disk in the clear, never printed, never given to a model.
//
// Safety rules (寓言 11/13 2a, 2b):
//   - changing the password: new file first (old kept) → new box up → pull back with the new password, open it,
//     same public key → only then the old file goes. A crash anywhere leaves both files; this code tries the new
//     one first, then the old. There is never a moment when the root has the new box and the body only the old file.
//   - rollback: the file records the ver it last opened; a box with a lower ver is refused (box_rollback). The box
//     ciphertext binds the citizen's public key and ver (AAD), so another citizen's box or an old one does not open.
//
// Test seam: NHI2_CRASH_AT=<step> kills this process right after that step (tests/box.test.ts kills it at every step).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { canon, home, post } from "../../skill/nhi1-aua/aua.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const H = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const b64u = (u8) => Buffer.from(u8).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const hex = (u8) => Buffer.from(u8).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** fixed codes this side answers with (never key material, never the text of anything) */
export const BOX_CODES = {
  rollback: "box_rollback", // the root handed back a box older than the one this file last opened
  bad: "box_bad", // the box does not open with this password, or is not this citizen's
  gone: "box_gone", // this password's door has no box on the root (lost, or changed on another machine)
  network: "network",
  no_name: "no_citizen",
};

/** the test seam: die hard right after `step` when NHI2_CRASH_AT names it */
export function crashAt(step) {
  if (process.env.NHI2_CRASH_AT === step) process.kill(process.pid, "SIGKILL");
}

// ───────── files ─────────

export const citizenDir = () => join(home(), "citizen");
const passPath = (name) => join(citizenDir(), name + ".pass");
const newPath = (name) => passPath(name) + ".new";

function readPass(p) {
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    if (o && o.v === 1 && NAME.test(o.citizen) && typeof o.pass === "string" && unb64u(o.pass).length === 32 && H.test(o.pub) && Number.isSafeInteger(o.ver) && o.ver >= 1) return o;
  } catch { /* missing or broken */ }
  return null;
}
/** write-then-rename, fsync'd: a crash leaves the old file or the new one, never half of one */
function writePass(p, o) {
  mkdirSync(citizenDir(), { recursive: true, mode: 0o700 });
  const tmp = p + ".tmp";
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(o) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

// ───────── key material (only inside this module) ─────────

async function hkdf(pass, label, bits = 256) {
  const ikm = await crypto.subtle.importKey("raw", pass, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("nhi2"), info: enc.encode(label) }, ikm, bits));
}
/** Ed25519 from a 32-byte seed → { pub (hex), key (non-extractable, sign only) } */
async function edFromSeed(seed) {
  const p8 = new Uint8Array(48);
  p8.set(PKCS8_ED25519);
  p8.set(seed, 16);
  const ex = await crypto.subtle.importKey("pkcs8", p8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", ex);
  const key = await crypto.subtle.importKey("pkcs8", p8, { name: "Ed25519" }, false, ["sign"]);
  p8.fill(0);
  return { pub: hex(unb64u(jwk.x)), key };
}
async function edFromPkcs8(p8) {
  const ex = await crypto.subtle.importKey("pkcs8", p8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", ex);
  return { pub: hex(unb64u(jwk.x)), key: await crypto.subtle.importKey("pkcs8", p8, { name: "Ed25519" }, false, ["sign"]) };
}
const edSign = async (key, bytes) => hex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes)));
const aes = (raw) => crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
async function aesSeal(key, aad, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}
async function aesOpen(key, aad, s) {
  try {
    const u = unb64u(s);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12), additionalData: enc.encode(aad) }, key, u.slice(12)));
  } catch {
    return null;
  }
}
const boxAad = (pub, ver) => canon({ v: "nhi2/box/v1", pub, ver });

/** what a password opens: the door (sign) and the wrap key */
async function fromPassword(passB64) {
  const P = unb64u(passB64);
  const door = await edFromSeed(await hkdf(P, "nhi2/door/v1"));
  const wrapRaw = await hkdf(P, "nhi2/wrap/v1");
  const wrap = await aes(wrapRaw);
  wrapRaw.fill(0);
  P.fill(0);
  return { door, wrap };
}

// the secrets object's private state: only this module can reach it
const STATE = new WeakMap();

/**
 * The one interface everything secret goes behind. Methods and public values only; the key bytes stay in STATE.
 * inner: { sk: pkcs8 bytes, keys: Map kv → raw 32 bytes }
 */
async function makeSecrets({ citizen, pub, ver, inner, pass, door, wrap, ctx }) {
  const signer = (await edFromPkcs8(inner.sk)).key;
  const memKeys = new Map();
  for (const [kv, raw] of inner.keys) memKeys.set(kv, await aes(raw));
  const kvs = [...memKeys.keys()].sort((a, b) => a - b);
  const kv = kvs[kvs.length - 1];
  const needles = [pass ? pass.pass : null, b64u(inner.sk), ...[...inner.keys.values()].map(b64u)].filter(Boolean);
  const s = Object.freeze({
    backend: pass ? "box" : "memory",
    citizen: citizen || null,
    pub,
    ver,
    kv,
    kvs: Object.freeze(kvs),
    sign: async (rec) => {
      const { sig: _s, ...rest } = rec;
      return { ...rest, sig: await edSign(signer, enc.encode(canon(rest))) };
    },
    signBytes: (bytes) => edSign(signer, bytes),
    async seal(k, aad, bytes) {
      const key = memKeys.get(k);
      if (!key) throw new Error("no memory key " + k);
      return aesSeal(key, aad, bytes);
    },
    async open(k, aad, s) {
      const key = memKeys.get(k);
      return key ? aesOpen(key, aad, s) : null;
    },
    /** true if text carries this citizen's secret material (checked before anything is sealed) */
    leaks: (text) => needles.some((n) => String(text).includes(n)),
    toJSON: () => ({ backend: pass ? "box" : "memory", citizen: citizen || null, pub, ver, kv, keys: kvs.length }),
  });
  STATE.set(s, { citizen, inner, pass, door, wrap, ctx });
  return s;
}

/** a cabin that lives only in this process: never saved, no root (tests and dry runs) */
export async function memorySecrets({ citizen = null } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const sk = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return makeSecrets({ citizen, pub, ver: 1, inner: { sk, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) } });
}

// ───────── the root ─────────

async function getBox(ctx, door) {
  const q = { op: "box_get", aua: ctx.aua, door: door.pub, t: nowS() };
  let r;
  try {
    r = await post(ctx.url, { ...q, sig: await edSign(door.key, enc.encode(canon(q))) }, ctx.timeoutMs || 30000);
  } catch {
    return { err: BOX_CODES.network };
  }
  if (r.status === 200 && r.body && H.test(r.body.pub) && Number.isSafeInteger(r.body.ver) && typeof r.body.box === "string") return { box: r.body };
  if (r.status === 404 && r.body && r.body.err === 48) return { none: true };
  return { err: "board_" + ((r.body && r.body.err) || r.status) };
}

/** store / replace: signed by the door now on the root, the next door (if it changes) and the citizen */
async function putBox(ctx, { door, next, pub, signer, ver, box }) {
  const q = { op: "box_put", aua: ctx.aua, door: door.pub, next: next.pub, pub, ver, size: unb64u(box).length, box, t: nowS() };
  const m = enc.encode(canon(q));
  const body = { ...q, sig: await edSign(door.key, m), psig: await signer(m) };
  if (next.pub !== door.pub) body.nsig = await edSign(next.key, m);
  let r;
  try {
    r = await post(ctx.url, body, ctx.timeoutMs || 30000);
  } catch {
    return { err: BOX_CODES.network };
  }
  return r.status === 200 || r.status === 201 ? { ver: r.body.ver } : { err: "board_" + ((r.body && r.body.err) || r.status) };
}

const boxPlain = (pub, inner) => enc.encode(JSON.stringify({ v: 1, pub, sk: b64u(inner.sk), keys: [...inner.keys].map(([kv, k]) => ({ kv, k: b64u(k) })) }));

/** fetch and open the box behind a pass file → { secrets } | { none } | { err } */
async function tryOpen(ctx, p) {
  const { door, wrap } = await fromPassword(p.pass);
  const g = await getBox(ctx, door);
  if (!g.box) return g;
  if (g.box.pub !== p.pub) return { err: BOX_CODES.bad };
  if (g.box.ver < p.ver) return { err: BOX_CODES.rollback };
  const pt = await aesOpen(wrap, boxAad(p.pub, g.box.ver), g.box.box);
  let o = null;
  try { o = pt ? JSON.parse(dec.decode(pt)) : null; } catch { /* broken */ }
  if (pt) pt.fill(0);
  if (!o || o.v !== 1 || o.pub !== p.pub || typeof o.sk !== "string" || !Array.isArray(o.keys) || !o.keys.length) return { err: BOX_CODES.bad };
  const keys = new Map();
  for (const x of o.keys) {
    if (!x || !Number.isSafeInteger(x.kv) || x.kv < 1 || typeof x.k !== "string" || unb64u(x.k).length !== 32) return { err: BOX_CODES.bad };
    keys.set(x.kv, unb64u(x.k));
  }
  const inner = { sk: unb64u(o.sk), keys };
  let signerPub;
  try { signerPub = (await edFromPkcs8(inner.sk)).pub; } catch { return { err: BOX_CODES.bad }; }
  if (signerPub !== p.pub) return { err: BOX_CODES.bad };
  return { secrets: await makeSecrets({ citizen: p.citizen, pub: p.pub, ver: g.box.ver, inner, pass: p, door, wrap, ctx }) };
}

/** a new citizen: password file first (marked new), then the box, then pull it back and open it */
async function create(ctx, name, reuse) {
  const P = reuse ? reuse.pass : b64u(crypto.getRandomValues(new Uint8Array(32)));
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const sk = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const inner = { sk, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
  const rec = { v: 1, citizen: name, pass: P, pub, ver: 1, state: "new" };
  writePass(passPath(name), rec);
  crashAt("create.pass");
  const { door, wrap } = await fromPassword(P);
  const box = await aesSeal(wrap, boxAad(pub, 1), boxPlain(pub, inner));
  const signer = (await edFromPkcs8(sk)).key;
  const r = await putBox(ctx, { door, next: door, pub, signer: (m) => edSign(signer, m), ver: 1, box });
  crashAt("create.put");
  if (r.err) return { err: r.err };
  return finish(ctx, rec);
}

/** open a pass file that is (or may be) marked new; on success the mark goes */
async function finish(ctx, rec) {
  const o = await tryOpen(ctx, rec);
  if (!o.secrets) return o.none ? { err: BOX_CODES.gone } : o;
  const { state: _s, ...done } = rec;
  writePass(passPath(rec.citizen), { ...done, ver: o.secrets.ver });
  crashAt("create.done");
  return o;
}

/**
 * Open this citizen's cabin. ctx: { url: aua.json ep.mem, aua: mem schema hash, timeoutMs?: per root request }.
 * Order: a pending new password first (finish the change), then the current one; no file → a new citizen
 * (when create is true). → { secrets } | { err: fixed code }
 */
export async function openCabin({ citizen, ctx, create: mayCreate = true }) {
  if (!NAME.test(citizen || "")) return { err: BOX_CODES.no_name };
  const nw = readPass(newPath(citizen));
  const cur = readPass(passPath(citizen));
  if (nw && cur && nw.pub !== cur.pub) return { err: BOX_CODES.bad };
  if (nw) {
    const o = await tryOpen(ctx, nw);
    if (o.secrets) {
      renameSync(newPath(citizen), passPath(citizen)); // the change reached the root: finish it
      return o;
    }
    if (!o.none) return o; // network or refusal: keep both files, decide next time
    rmSync(newPath(citizen), { force: true }); // the change never reached the root: the old password is still the one
  }
  if (cur) {
    const o = await tryOpen(ctx, cur);
    if (o.secrets) {
      if (cur.state === "new") return finish(ctx, cur);
      if (o.secrets.ver > cur.ver) writePass(passPath(citizen), { ...cur, ver: o.secrets.ver });
      return o;
    }
    if (o.none && cur.state === "new") return create(ctx, citizen, cur); // the first box never went up: same password, fresh keys
    return o.none ? { err: BOX_CODES.gone } : o;
  }
  if (!mayCreate) return { err: BOX_CODES.gone };
  return create(ctx, citizen, null);
}

/** a citizen's pass file exists on this machine (no secret read out of it) */
export const hasCabin = (citizen) => NAME.test(citizen || "") && (existsSync(passPath(citizen)) || existsSync(newPath(citizen)));

/**
 * Forgetting, step 1: a new random memory key into the box (same password, ver + 1). New mems use it from now on.
 * → { secrets } | { err }
 */
export async function cabinAddKey(secrets) {
  const st = STATE.get(secrets);
  if (!st || !st.pass) return { err: BOX_CODES.bad };
  const kv = secrets.kv + 1;
  const keys = new Map(st.inner.keys);
  keys.set(kv, crypto.getRandomValues(new Uint8Array(32)));
  const inner = { sk: st.inner.sk, keys };
  const ver = secrets.ver + 1;
  const box = await aesSeal(st.wrap, boxAad(secrets.pub, ver), boxPlain(secrets.pub, inner));
  const r = await putBox(st.ctx, { door: st.door, next: st.door, pub: secrets.pub, signer: secrets.signBytes, ver, box });
  crashAt("add.put");
  if (r.err) return { err: r.err };
  const o = await tryOpen(st.ctx, st.pass);
  if (!o.secrets) return o.none ? { err: BOX_CODES.gone } : o;
  writePass(passPath(st.citizen), { ...st.pass, ver: o.secrets.ver });
  crashAt("add.done");
  return o;
}

/**
 * Forgetting, last step: a new password and a box with only the memory keys kept (kv >= keepFrom).
 * 寓言 2a order: new file (old kept) → new box up → open it with the new password → old file goes.
 * → { secrets } | { err }
 */
export async function cabinRotate(secrets, { keepFrom }) {
  const st = STATE.get(secrets);
  if (!st || !st.pass) return { err: BOX_CODES.bad };
  const keys = new Map([...st.inner.keys].filter(([kv]) => kv >= keepFrom));
  if (!keys.size) return { err: BOX_CODES.bad };
  const ver = secrets.ver + 1;
  const nw = { v: 1, citizen: st.citizen, pass: b64u(crypto.getRandomValues(new Uint8Array(32))), pub: secrets.pub, ver };
  writePass(newPath(st.citizen), nw);
  crashAt("rot.new");
  const next = await fromPassword(nw.pass);
  const box = await aesSeal(next.wrap, boxAad(secrets.pub, ver), boxPlain(secrets.pub, { sk: st.inner.sk, keys }));
  const r = await putBox(st.ctx, { door: st.door, next: next.door, pub: secrets.pub, signer: secrets.signBytes, ver, box });
  crashAt("rot.put");
  if (r.err) return { err: r.err }; // both files stay; openCabin settles it
  const o = await tryOpen(st.ctx, nw);
  crashAt("rot.verify");
  if (!o.secrets) return o.none ? { err: BOX_CODES.gone } : o;
  renameSync(newPath(st.citizen), passPath(st.citizen));
  crashAt("rot.done");
  return o;
}

/**
 * key.jwk retires (寓言 11/13 3: three new keys; the old one is renamed, never deleted, never read).
 * → { retired: bool, to? }
 */
export function retireJwk(dir = home()) {
  const from = join(dir, "key.jwk");
  if (!existsSync(from)) return { retired: false };
  let to = from + ".retired";
  for (let i = 2; existsSync(to); i++) to = from + ".retired-" + i;
  renameSync(from, to);
  return { retired: true, to };
}
