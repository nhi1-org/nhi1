// The door count (Opus card BOARD-FIX-1123, 1): every edge function counts each request it answers, by UTC day,
// function, HTTP method, status and whether it came from inside (a cron job that proved the vault secret) or
// from outside. Nothing that tells who came: no IP, no UA, no key (國度不記使用者是誰). For mem, the op name
// (a fixed list) tells reads from writes. A count that fails never changes the answer. Runtime-agnostic. Apache-2.0.
import type { Rpc } from "./handlers.ts";

export const DOOR_FNS = ["ask", "head", "wall", "replica", "mem", "use", "talk", "replay", "work", "key", "key-view", "export", "wind", "report"] as const;
export type DoorFn = typeof DOOR_FNS[number];
const METHODS = ["GET", "POST", "OPTIONS", "HEAD", "PUT", "PATCH", "DELETE"];
export const doorMethod = (m: string) => (METHODS.includes(String(m).toUpperCase()) ? String(m).toUpperCase() : "OTHER");

const MEM_OPS = ["put", "del", "reg", "head", "boot", "all", "check", "box_get", "box_put"];
/** the mem op of a parsed body, from the fixed list; anything else is "?" */
export const memOp = (body: unknown) => {
  const op = body && typeof body === "object" && !Array.isArray(body) ? (body as { op?: unknown }).op : undefined;
  return typeof op === "string" && MEM_OPS.includes(op) ? op : "?";
};

/** what the handler learns about the request while answering it */
export type Mark = { inside?: boolean; op?: string };

const COUNT_MS = 3000;

/** one count; errors and slowness are swallowed (never more than COUNT_MS) */
export async function countDoor(rpc: Rpc, fn: DoorFn, method: string, status: number, inside: boolean, op = ""): Promise<void> {
  try {
    await Promise.race([
      rpc("aua_door", { p_fn: fn, p_method: doorMethod(method), p_status: status, p_inside: inside, p_op: op }),
      new Promise((ok) => setTimeout(ok, COUNT_MS)),
    ]);
  } catch { /* a counter never changes an answer */ }
}

/**
 * Wrap a request handler so every answer is counted, whatever path it took (405, 401, 413, 429, 500 included).
 * `wait` hands the count to the runtime to finish after the answer (EdgeRuntime.waitUntil); without it the
 * count is awaited (bounded by COUNT_MS).
 */
export function withDoor(fn: DoorFn, rpc: Rpc, h: (req: Request, mark: Mark) => Promise<Response>, wait?: (p: Promise<unknown>) => void) {
  return async (req: Request): Promise<Response> => {
    const mark: Mark = {};
    let res: Response;
    try {
      res = await h(req, mark);
    } catch (e) {
      console.error(String(e));
      res = new Response(JSON.stringify({ err: 16 }), { status: 500, headers: { "content-type": "application/json" } });
    }
    const p = countDoor(rpc, fn, req.method, res.status, mark.inside === true, mark.op ?? "");
    if (wait) wait(p);
    else await p;
    return res;
  };
}

/** Supabase Edge Runtime's waitUntil, when there is one */
export function edgeWait(): ((p: Promise<unknown>) => void) | undefined {
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  return er && typeof er.waitUntil === "function" ? (p) => er.waitUntil!(p) : undefined;
}
