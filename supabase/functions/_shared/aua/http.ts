// The request core of every agent-facing endpoint (was inside serve.ts; moved here so tests run it without Deno):
// OPTIONS / POST only, a body size limit, strict JSON, then the handler. Runtime-agnostic. Apache-2.0.
import type { DoorFn, Mark } from "./door.ts";
import { memOp } from "./door.ts";
import type { Deps, Res } from "./handlers.ts";
import { BOARD_ERR as E } from "./schema.ts";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export async function handleHttp(
  req: Request, fn: DoorFn, handler: (body: unknown, d: Deps) => Promise<Res>, maxBody: number,
  depsOf: (req: Request) => Promise<Deps>, mark: Mark,
): Promise<Response> {
  if (fn === "mem") mark.op = "?";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { err: E.method });
  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.length > maxBody) return json(413, { err: E.too_large });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return json(400, { err: E.bad_json });
    }
    if (fn === "mem") mark.op = memOp(body);
    const r = await handler(body, await depsOf(req));
    return json(r.status, r.body);
  } catch (e) {
    console.error(String(e)); // server log only; never in the response
    return json(500, { err: E.internal });
  }
}
