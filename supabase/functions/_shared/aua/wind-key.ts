// The wind key (schema batch): made on first use inside the edge function, kept in the vault, never
// leaves Supabase. Returns { pub, jwk } for signing report records. Apache-2.0.
import { toHex } from "./canon.ts";
import type { Rpc } from "./handlers.ts";

export async function windSigner(rpc: Rpc): Promise<{ pub: string; jwk: JsonWebKey } | undefined> {
  try {
    let raw = (await rpc("aua_wind_key", {})) as string | null;
    if (!raw) {
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const pub = toHex(await crypto.subtle.exportKey("raw", kp.publicKey));
      await rpc("aua_wind_key_init", { p_jwk: JSON.stringify({ pub, jwk }) });
      raw = (await rpc("aua_wind_key", {})) as string | null; // whoever won the race
    }
    if (!raw) return undefined;
    const k = JSON.parse(raw);
    return { pub: k.pub, jwk: k.jwk };
  } catch {
    return undefined; // no key → reports still go out, just not signed into the trail
  }
}

/**
 * The digest key (S4 Q9 (c)): the digest agent is a citizen of its own, not the wind tunnel, so its uses are
 * signed by a key of their own — made the same way on first use, kept in the vault (aua_digest_key), never
 * leaving Supabase; only its public half is published (aua.json `digest`).
 */
export async function digestSigner(rpc: Rpc): Promise<{ pub: string; jwk: JsonWebKey } | undefined> {
  try {
    let raw = (await rpc("aua_digest_key", {})) as string | null;
    if (!raw) {
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const pub = toHex(await crypto.subtle.exportKey("raw", kp.publicKey));
      await rpc("aua_digest_key_init", { p_jwk: JSON.stringify({ pub, jwk }) });
      raw = (await rpc("aua_digest_key", {})) as string | null;
    }
    if (!raw) return undefined;
    const k = JSON.parse(raw);
    return { pub: k.pub, jwk: k.jwk };
  } catch {
    return undefined; // no key → no digest that day
  }
}
