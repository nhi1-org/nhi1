// A complete board on this machine: real Postgres (PGlite) + the same handlers the edge functions run.
//   node tools/local-board.ts [port]   → http://127.0.0.1:<port>/.well-known/aua.json
// Used by the smoke test before (and independently of) the Supabase deployment.
import { createServer, type Server } from "node:http";
import { sha256Hex, toHex } from "../supabase/functions/_shared/aua/canon.ts";
import { type Deps, handleAsk, handleHead, handleKey, handleKeyView, handleReplay, handleReplica, handleTalk, handleUse, handleWall, handleWork } from "../supabase/functions/_shared/aua/handlers.ts";
import { HOLDERS, type Holders } from "../supabase/functions/_shared/aua/holders.ts";
import { AUA, makeDb, rpcFor } from "../tests/helpers.ts";
import { buildAuaJson } from "./aua-json.ts";
import { handleMem } from "../supabase/functions/_shared/aua/mem.ts";
import { applyMem } from "../tests/mem-helpers.ts";

export async function startLocalBoard(port = 8788, holders: Holders = HOLDERS): Promise<{ server: Server; url: string; db: Awaited<ReturnType<typeof makeDb>> }> {
  const db = await makeDb();
  await applyMem(db); // NHI-2 private cabin (own migration)
  const base = `http://127.0.0.1:${port}`;
  const wk = await buildAuaJson({ functions: base, site: base });
  const routes: Record<string, (b: unknown, d: Deps) => Promise<{ status: number; body: unknown }>> = {
    "/ask": handleAsk, "/use": handleUse, "/head": handleHead, "/talk": handleTalk, "/wall": handleWall, "/work": handleWork, "/replay": handleReplay, "/replica": handleReplica, "/key": handleKey, "/key-view": handleKeyView,
    "/mem": handleMem,
  };
  let chain = Promise.resolve(); // PGlite is single-connection: serialize requests
  const server = createServer(async (req, res) => {
    const send = (s: number, b: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (req.method === "GET" && req.url === "/.well-known/aua.json") return send(200, wk);
    const h = routes[req.url || ""];
    if (!h || req.method !== "POST") return send(404, { err: 15 });
    let raw = "";
    for await (const c of req) raw += c;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { err: 1 });
    }
    const ip = await sha256Hex("local:" + (req.socket.remoteAddress || ""));
    const run = chain.then(() => h(body, {
      rpc: rpcFor(db), now: () => Math.floor(Date.now() / 1000), ip, aua: AUA, holders,
      randomHex: (n) => toHex(crypto.getRandomValues(new Uint8Array(n))),
    }));
    chain = run.then(() => undefined, () => undefined);
    try {
      const r = await run;
      send(r.status, r.body);
    } catch (e) {
      console.error(e);
      send(500, { err: 16 });
    }
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  return { server, url: `${base}/.well-known/aua.json`, db };
}

if (import.meta.main) {
  const { url } = await startLocalBoard(Number(process.argv[2] || 8788));
  console.log("local board:", url);
}
