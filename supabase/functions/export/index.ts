// Daily full export → PRIVATE storage bucket `export` (全封閉). Internal job: called by pg_cron with
// a vault-held secret; not one of the agent-facing endpoints. Replicas get it only through the signed
// `replica` endpoint. The name → fingerprint table travels with aua.json, not as a file here.
import { canon, hashOf, sha256Hex } from "../_shared/aua/canon.ts";
import { buildExport } from "../_shared/aua/handlers.ts";
import { SCHEMA } from "../_shared/aua/schema.ts";
import { rpc, storePut } from "../_shared/aua/serve.ts";

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void };

async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const secret = req.headers.get("x-aua-export") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc("aua_export_auth", { p_secret: secret }))) {
    return new Response(JSON.stringify({ err: 17 }), { status: 401 });
  }
  try {
    const { text, counts } = await buildExport(rpc);
    const gz = await gzip(text);
    const day = new Date().toISOString().slice(0, 10);
    const name = `nhi1-${day}.ndjson.gz`;
    const manifest = {
      aua: await hashOf(SCHEMA), day, file: name, sha256: await sha256Hex(gz), bytes: gz.length,
      ndjson_sha256: await sha256Hex(text), counts,
      format: "one JSON object per line: {table, id, rec}; id = sha256(canon(rec)) for use/talk/key/replay",
    };
    await storePut(name, gz, "application/gzip");
    await storePut("latest.ndjson.gz", gz, "application/gzip");
    await storePut("latest.json", new TextEncoder().encode(canon(manifest)), "application/json");
    return new Response(JSON.stringify({ ok: 1, counts }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    console.error(String(e));
    return new Response(JSON.stringify({ err: 16 }), { status: 500 });
  }
});
