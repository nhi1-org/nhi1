// NHI-2: the citizen's key, on this machine only (George 11/16: 鑰匙存本機、分散存放). Zero dependencies (Node >= 22).
// Apache-2.0.
//
// One key per machine and per citizen (model line). What is secret: the Ed25519 signing key and the memory keys
// (AES-256-GCM, one per kv). Nothing of it goes to the root: the root keeps only the public key (the citizen's id)
// and checks signatures with it. The secret is split into three pieces (Shamir over GF(256), threshold 2): any two
// rebuild it, one alone says nothing. The pieces sit in three folders under the user's own account:
//   A  $NHI1_HOME/citizen            (default ~/.nhi1/citizen)
//   B  the OS's local app data       (Windows %LOCALAPPDATA%\nhi1 · macOS ~/Library/Application Support/nhi1 ·
//                                     Linux ${XDG_DATA_HOME:-~/.local/share}/nhi1)
//   C  the OS's local state          (Windows %USERPROFILE%\AppData\LocalLow\nhi1 · macOS / Linux
//                                     ${XDG_STATE_HOME:-~/.local/state}/nhi1)
// (NHI1_KEY_DIRS = three folders, separated like PATH, replaces all three: tests.) Never inside the skill folder
// (an upgrade replaces it), never inside a git work tree (§4); a file name is a hash, never the word "key".
// The key bytes are made here and stay here: never printed, never logged, never given to a model.
//
// A piece: { v: 1, i: 1|2|3, g, pub, y }. Every change of the secret (a new memory key, forgetting) writes all three
// again with g + 1: first as .tmp files, then renamed into place. Any two pieces of one g (final or .tmp) are a whole
// secret, so a crash anywhere leaves either the old secret or the new one, never neither.
//
// Test seam: NHI2_CRASH_AT=<step> kills this process right after that step.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canon, home, sandboxWhy } from "./aua.mjs";

export { sandboxWhy }; // sessions that start from nothing (aua.mjs: the same test decides what is never written)

const enc = new TextEncoder();
const dec = new TextDecoder();
const H = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const b64u = (u8) => Buffer.from(u8).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const hex = (u8) => Buffer.from(u8).toString("hex");
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** fixed codes this side answers with (never key material, never the text of anything) */
export const BOX_CODES = {
  none: "no_room", // no piece of this citizen's key on this machine
  partial: "key_partial", // only one piece (of three) on this machine: the key cannot be rebuilt
  bad: "key_bad", // the pieces do not rebuild a key that matches their public key
  sandbox: "sandbox", // a session that starts from nothing every time: a key made here would be lost
  dirs: "key_dirs", // a piece folder is not usable (inside a git work tree or the skill folder, or not three)
  exists: "key_exists", // a piece is already here: a new key is never made over it
  no_name: "no_citizen",
};

/** the test seam: die hard right after `step` when NHI2_CRASH_AT names it */
export function crashAt(step) {
  if (process.env.NHI2_CRASH_AT === step) process.kill(process.pid, "SIGKILL");
}

// ───────── where the pieces are ─────────

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

/** the three piece folders (A, B, C), in order */
export function pieceDirs(env = process.env) {
  if (env.NHI1_KEY_DIRS) return env.NHI1_KEY_DIRS.split(delimiter).filter(Boolean).map((d) => resolve(d));
  // under the test runner, never the real folders: a test that forgot NHI1_KEY_DIRS gets three under its NHI1_HOME
  if (env.NODE_TEST_CONTEXT) return ["a", "b", "c"].map((x) => join(home(), "test-pieces-" + x));
  const h = homedir();
  const a = join(home(), "citizen");
  if (process.platform === "win32") {
    return [a, join(env.LOCALAPPDATA || join(h, "AppData", "Local"), "nhi1"), join(env.USERPROFILE || h, "AppData", "LocalLow", "nhi1")];
  }
  const state = join(env.XDG_STATE_HOME || join(h, ".local", "state"), "nhi1");
  if (process.platform === "darwin") return [a, join(h, "Library", "Application Support", "nhi1"), state];
  return [a, join(env.XDG_DATA_HOME || join(h, ".local", "share"), "nhi1"), state];
}

/** the first folder up from d (d included) that holds .git, or null */
function gitRoot(d) {
  let cur = resolve(d);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
const inside = (d, root) => {
  const a = resolve(d).toLowerCase();
  const r = resolve(root).toLowerCase();
  return a === r || a.startsWith(r.endsWith("\\") || r.endsWith("/") ? r : r + (process.platform === "win32" ? "\\" : "/"));
};
/** null if the three folders may hold pieces; else a reason (never a path) */
export function dirsProblem(dirs = pieceDirs()) {
  if (dirs.length !== 3) return "not_three";
  if (new Set(dirs.map((d) => resolve(d).toLowerCase())).size !== 3) return "not_three";
  for (const d of dirs) {
    if (inside(d, SKILL_DIR)) return "skill_folder";
    if (gitRoot(d)) return "git_repo";
  }
  return null;
}

/** a piece's file name: a hash of the citizen and the piece number (no name, no word "key") */
async function pieceFile(dirs, citizen, i) {
  const h = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`nhi2/piece/v1\n${citizen}\n${i}`)))).slice(0, 24);
  return join(dirs[i - 1], h + ".dat");
}

// ───────── Shamir 2-of-3 over GF(2^8) (x^8 + x^4 + x^3 + x + 1) ─────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff; // x * 3
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const gdiv = (a, b) => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0);

/** secret bytes → three shares y1, y2, y3 (f(x) = s + a·x, a random per byte) */
export function split3(s) {
  const a = crypto.getRandomValues(new Uint8Array(s.length));
  const ys = [1, 2, 3].map((x) => s.map((b, j) => b ^ gmul(a[j], x)));
  a.fill(0);
  return ys;
}
/** two shares (x1, y1), (x2, y2) → the secret bytes */
export function join2(x1, y1, x2, y2) {
  const d = x1 ^ x2;
  const l1 = gdiv(x2, d);
  const l2 = gdiv(x1, d);
  return y1.map((b, j) => gmul(b, l1) ^ gmul(y2[j], l2));
}

// ───────── files ─────────

function readPiece(p, i) {
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    if (o && o.v === 1 && o.i === i && Number.isSafeInteger(o.g) && o.g >= 1 && H.test(o.pub) && typeof o.y === "string" && o.y.length) return o;
  } catch { /* missing or broken */ }
  return null;
}
/** write-then-rename, fsync'd: a crash leaves the old piece or the new one, never half of one */
function writePiece(p, o) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + ".part";
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(o) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

/** every piece of this citizen here: the final file and a waiting .tmp (written, not yet renamed) for each of A, B, C */
async function readAll(citizen, dirs) {
  const out = [];
  for (const i of [1, 2, 3]) {
    const f = await pieceFile(dirs, citizen, i);
    const o = readPiece(f, i);
    if (o) out.push({ ...o, tmp: false });
    const t = readPiece(f + ".tmp", i);
    if (t) out.push({ ...t, tmp: true });
  }
  return out;
}
/**
 * The best group: the highest g whose pieces (final or waiting) cover two of A, B, C or more — any such group is a
 * whole secret. Else one final piece if there is one (鑰匙不全); a waiting piece alone is a write that was cut off
 * before it counted, and is ignored. → [piece] with distinct i
 */
function bestGroup(pieces) {
  const groups = new Map();
  for (const p of pieces) {
    const k = p.pub + ":" + p.g;
    if (!groups.has(k)) groups.set(k, new Map());
    const m = groups.get(k);
    if (!m.has(p.i) || (m.get(p.i).tmp && !p.tmp)) m.set(p.i, p);
  }
  const full = [...groups.values()].filter((m) => m.size >= 2).map((m) => [...m.values()]).sort((a, b) => b[0].g - a[0].g);
  if (full.length) return full[0];
  const fin = pieces.filter((p) => !p.tmp).sort((a, b) => b.g - a.g);
  return fin.length ? [fin[0]] : [];
}

/**
 * How many usable pieces of this citizen's key are here — read only, nothing is rebuilt.
 * → { pieces: 0..3 (of the best group), pub?: public key }
 */
export async function pieceCount(citizen, dirs = pieceDirs()) {
  if (!NAME.test(citizen || "")) return { pieces: 0 };
  const best = bestGroup(await readAll(citizen, dirs));
  return best.length ? { pieces: best.length, pub: best[0].pub } : { pieces: 0 };
}

// ───────── key material (only inside this module) ─────────

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
const innerBytes = (inner) => enc.encode(JSON.stringify({ v: 1, sk: b64u(inner.sk), keys: [...inner.keys].map(([kv, k]) => ({ kv, k: b64u(k) })) }));
function innerFrom(bytes) {
  let o = null;
  try { o = JSON.parse(dec.decode(bytes)); } catch { return null; }
  if (!o || o.v !== 1 || typeof o.sk !== "string" || !Array.isArray(o.keys) || !o.keys.length) return null;
  const keys = new Map();
  for (const x of o.keys) {
    if (!x || !Number.isSafeInteger(x.kv) || x.kv < 1 || typeof x.k !== "string" || unb64u(x.k).length !== 32) return null;
    keys.set(x.kv, unb64u(x.k));
  }
  return { sk: unb64u(o.sk), keys };
}

// the secrets object's private state: only this module can reach it
const STATE = new WeakMap();

/**
 * The one interface everything secret goes behind. Methods and public values only; the key bytes stay in STATE.
 * inner: { sk: pkcs8 bytes, keys: Map kv → raw 32 bytes }
 */
async function makeSecrets({ citizen, pub, g, inner, dirs, local, extra = [] }) {
  const signer = (await edFromPkcs8(inner.sk)).key;
  const memKeys = new Map();
  for (const [kv, raw] of inner.keys) memKeys.set(kv, await aes(raw));
  const kvs = [...memKeys.keys()].sort((a, b) => a - b);
  const kv = kvs[kvs.length - 1];
  const needles = [b64u(inner.sk), b64u(inner.sk.slice(16)), hex(inner.sk.slice(16)), ...[...inner.keys.values()].flatMap((k) => [b64u(k), hex(k)]), ...extra];
  const backend = local ? "local" : "memory";
  const s = Object.freeze({
    backend,
    citizen: citizen || null,
    pub,
    g,
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
    leaks: (text) => needles.some((n) => n && String(text).includes(n)),
    toJSON: () => ({ backend, citizen: citizen || null, pub, kv, keys: kvs.length }),
  });
  STATE.set(s, { citizen, inner, g, dirs });
  return s;
}

/** a cabin that lives only in this process: never saved (tests and dry runs) */
export async function memorySecrets({ citizen = null } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const sk = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return makeSecrets({ citizen, pub, g: 0, inner: { sk, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) }, local: false });
}

/**
 * split the secret and write the three pieces with generation g: first all three as .tmp (each fsync'd), then each
 * renamed into place. A crash before two .tmp are down leaves the old pieces in charge; after that, the new ones.
 */
async function writeAll(citizen, dirs, pub, inner, g, step) {
  const bytes = innerBytes(inner);
  const ys = split3(bytes);
  bytes.fill(0);
  const files = [];
  for (const i of [1, 2, 3]) {
    const f = await pieceFile(dirs, citizen, i);
    writePiece(f + ".tmp", { v: 1, i, g, pub, y: b64u(ys[i - 1]) });
    ys[i - 1].fill(0);
    files.push(f);
    crashAt(`${step}.tmp${i}`);
  }
  for (const [n, f] of files.entries()) {
    renameSync(f + ".tmp", f);
    crashAt(`${step}.${n + 1}`);
  }
}

/**
 * Rebuild this citizen's key from any two pieces on this machine (no network).
 * → { secrets, pieces } | { err: no_room | key_partial | key_bad | no_citizen }
 */
export async function loadKey(citizen, dirs = pieceDirs()) {
  if (!NAME.test(citizen || "")) return { err: BOX_CODES.no_name };
  const best = bestGroup(await readAll(citizen, dirs));
  if (!best.length) return { err: BOX_CODES.none };
  if (best.length < 2) return { err: BOX_CODES.partial };
  const [p, q] = best;
  const bytes = join2(p.i, unb64u(p.y), q.i, unb64u(q.y));
  const inner = innerFrom(bytes);
  bytes.fill(0);
  if (!inner) return { err: BOX_CODES.bad };
  let pub;
  try { pub = (await edFromPkcs8(inner.sk)).pub; } catch { return { err: BOX_CODES.bad }; }
  if (pub !== p.pub) return { err: BOX_CODES.bad };
  const whole = best.length === 3 && best.every((x) => !x.tmp); // else: open writes all three again
  return { secrets: await makeSecrets({ citizen, pub, g: p.g, inner, dirs, local: true, extra: best.map((x) => x.y) }), pieces: best.length, whole };
}

/** write a fresh secret as three pieces, only where no piece of this citizen exists yet */
async function firstWrite(citizen, dirs, inner, env) {
  if (!NAME.test(citizen || "")) return { err: BOX_CODES.no_name };
  const sb = sandboxWhy(env);
  if (sb) return { err: BOX_CODES.sandbox, why: sb };
  if (dirsProblem(dirs)) return { err: BOX_CODES.dirs, why: dirsProblem(dirs) };
  if (bestGroup(await readAll(citizen, dirs)).length) return { err: BOX_CODES.exists };
  const pub = (await edFromPkcs8(inner.sk)).pub;
  await writeAll(citizen, dirs, pub, inner, 1, "create");
  return loadKey(citizen, dirs);
}

/**
 * A new citizen key on this machine: made here, split, written. Never over an existing piece.
 * → { secrets, pieces } | { err, why? }
 */
export async function createKey(citizen, { dirs = pieceDirs(), env = process.env } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const sk = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return firstWrite(citizen, dirs, { sk, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) }, env);
}

/**
 * Moving in (11/16, once, from the old key box): the same signing key and memory keys, now as three pieces here.
 * The public key — the citizen's id — does not change. → { secrets, pieces } | { err }
 */
export async function importKey(citizen, { sk, keys }, { dirs = pieceDirs(), env = process.env } = {}) {
  if (!(sk instanceof Uint8Array) || !(keys instanceof Map) || !keys.size) return { err: BOX_CODES.bad };
  return firstWrite(citizen, dirs, { sk, keys }, env);
}

/** rewrite all three pieces (g + 1) with this inner; → the reopened secrets | { err } */
async function rewrite(secrets, inner, step) {
  const st = STATE.get(secrets);
  if (!st || !st.dirs) return { err: BOX_CODES.bad };
  if (dirsProblem(st.dirs)) return { err: BOX_CODES.dirs, why: dirsProblem(st.dirs) };
  await writeAll(st.citizen, st.dirs, secrets.pub, inner, st.g + 1, step);
  return loadKey(st.citizen, st.dirs);
}

/** two pieces left of three: write all three again (same key) → { secrets, pieces } | { err } */
export const repairKey = (secrets) => rewrite(secrets, STATE.get(secrets)?.inner, "repair");

/**
 * Forgetting, step 1: a new random memory key (all three pieces rewritten). New mems use it from now on.
 * → { secrets } | { err }
 */
export async function cabinAddKey(secrets) {
  const st = STATE.get(secrets);
  if (!st || !st.dirs) return { err: BOX_CODES.bad };
  const keys = new Map(st.inner.keys);
  keys.set(secrets.kv + 1, crypto.getRandomValues(new Uint8Array(32)));
  return rewrite(secrets, { sk: st.inner.sk, keys }, "add");
}

/**
 * Forgetting, last step: only the memory keys kv >= keepFrom stay (all three pieces rewritten); a mem sealed under a
 * dropped key can never be opened again. → { secrets } | { err }
 */
export async function cabinDropOld(secrets, { keepFrom }) {
  const st = STATE.get(secrets);
  if (!st || !st.dirs) return { err: BOX_CODES.bad };
  const keys = new Map([...st.inner.keys].filter(([kv]) => kv >= keepFrom));
  if (!keys.size) return { err: BOX_CODES.bad };
  return rewrite(secrets, { sk: st.inner.sk, keys }, "drop");
}

// ───────── sessions that start from nothing (George 11/16 第 5 點) ─────────

/**
 * In a session that starts from nothing and has no room here (George 11/16 第 6 點): a key that lives only in this
 * process — made now, never saved, never registered, no room. Its private half cannot be exported. It can sign reads
 * (ask, the wall); aua.mjs refuses it for every record (use, talk, work, sign-in). → { pub, citizen, temp, sign, signBytes }
 */
export async function tempKey(citizen) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pub = hex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const signBytes = async (bytes) => hex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes)));
  return Object.freeze({
    pub, citizen: citizen || null, temp: true, signBytes,
    sign: async (rec) => {
      const { sig: _s, ...rest } = rec;
      return { ...rest, sig: await signBytes(enc.encode(canon(rest))) };
    },
  });
}

/**
 * key.jwk retires (寓言 11/13 3): the old one is renamed, never deleted, never read. → { retired: bool, to? }
 */
export function retireJwk(dir = home()) {
  const from = join(dir, "key.jwk");
  if (!existsSync(from)) return { retired: false };
  let to = from + ".retired";
  for (let i = 2; existsSync(to); i++) to = from + ".retired-" + i;
  renameSync(from, to);
  return { retired: true, to };
}
