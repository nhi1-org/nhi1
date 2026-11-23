// Deno / Supabase Edge Runtime wrapper. service_role is used only here, inside functions.
import { hashOf, sha256Hex, toHex } from "./canon.ts";
import type { Deps, Res, Rpc } from "./handlers.ts";
import { HOLDERS } from "./holders.ts";
import { rpcBody } from "./rpc-body.ts";
import { SCHEMA } from "./schema.ts";
import { type DoorFn, edgeWait, withDoor } from "./door.ts";
import { handleHttp } from "./http.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUA = hashOf(SCHEMA);
const SALT = sha256Hex("nhi1-ip-salt:" + SRK); // stable per project, never leaves the function

export const rpc: Rpc = async (fn, args) => {
  const h: Record<string, string> = { "content-type": "application/json", apikey: SRK };
  if (SRK.startsWith("eyJ")) h.authorization = "Bearer " + SRK;
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: "POST", headers: h, body: JSON.stringify(args) });
  if (!r.ok) throw new Error("rpc " + fn + " " + r.status + " " + (await r.text()).slice(0, 300));
  return rpcBody(await r.text()); // void functions answer 204 with no body → null
};

export async function storePut(path: string, data: Uint8Array, type: string) {
  const h: Record<string, string> = { "content-type": type, apikey: SRK, "x-upsert": "true", "cache-control": "max-age=300" };
  if (SRK.startsWith("eyJ")) h.authorization = "Bearer " + SRK;
  const r = await fetch(`${URL_}/storage/v1/object/export/${path}`, { method: "POST", headers: h, body: data });
  if (!r.ok) throw new Error("store " + path + " " + r.status + " " + (await r.text()).slice(0, 300));
}

/** read one object from the private `export` bucket (service role; null if missing) */
export async function storeGet(path: string): Promise<Uint8Array | null> {
  const h: Record<string, string> = { apikey: SRK };
  if (SRK.startsWith("eyJ")) h.authorization = "Bearer " + SRK;
  const r = await fetch(`${URL_}/storage/v1/object/authenticated/export/${path}`, { headers: h });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error("store get " + path + " " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf ? xf.split(",")[0] : req.headers.get("cf-connecting-ip") ?? "0").trim();
}

function randomHex(n: number) {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

/** the deps of one request: the IP only as a salted hash, for the rate gate (never stored as such, never counted) */
async function depsOf(req: Request): Promise<Deps> {
  return {
    rpc,
    now: () => Math.floor(Date.now() / 1000),
    ip: await sha256Hex((await SALT) + clientIp(req)),
    aua: await AUA,
    holders: HOLDERS,
    randomHex,
    store: { get: storeGet },
  };
}

/** an agent-facing endpoint: counted at the door (door.ts), then the request core (http.ts), then the handler */
export function serve(fn: DoorFn, handler: (body: unknown, d: Deps) => Promise<Res>, maxBody = 4096) {
  Deno.serve(withDoor(fn, rpc, (req, mark) => handleHttp(req, fn, handler, maxBody, depsOf, mark), edgeWait()));
}
