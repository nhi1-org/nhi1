// Canonical JSON (RFC 8785 JCS subset: objects, arrays, strings, finite numbers, bool, null)
// + SHA-256 + Ed25519 over Web Crypto. Runs unchanged in Deno (edge functions) and Node >= 22.
// Apache-2.0.

export function canon(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canon: non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const ks = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return "{" + ks.map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  }
  throw new Error("canon: unsupported type " + typeof v);
}

const enc = new TextEncoder();

export function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

export function toHex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("fromHex: bad hex");
  const u = new Uint8Array(h.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return u;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const b = typeof data === "string" ? bytes(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", b as BufferSource));
}

/** Hash of a JSON value: sha256(canon(v)). */
export function hashOf(v: unknown): Promise<string> {
  return sha256Hex(canon(v));
}

/** Identifier → code: op / model / rt are sha256 of their UTF-8 name (zero free text). */
export function ident(name: string): Promise<string> {
  return sha256Hex(name);
}

/** Bytes that get signed: canon(record without "sig"). */
export function signingBytes(rec: Record<string, unknown>): Uint8Array {
  const { sig: _sig, ...rest } = rec;
  return bytes(canon(rest));
}

/** Bytes a key-record co-signer signs (act 6): canon(record without "sig" and "cosig"). */
export function cosigningBytes(rec: Record<string, unknown>): Uint8Array {
  const { sig: _sig, cosig: _cosig, ...rest } = rec;
  return bytes(canon(rest));
}

/** Record id: sha256(canon(record incl. sig)). Content-addressed. */
export function recordId(rec: unknown): Promise<string> {
  return hashOf(rec);
}

export async function verifyEd25519(pubHex: string, sigHex: string, msg: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromHex(pubHex) as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(sigHex) as BufferSource, msg as BufferSource);
  } catch {
    return false;
  }
}

export async function verifyRecord(rec: Record<string, unknown>, pubHex: string): Promise<boolean> {
  const sig = rec.sig;
  if (typeof sig !== "string") return false;
  return verifyEd25519(pubHex, sig, signingBytes(rec));
}
