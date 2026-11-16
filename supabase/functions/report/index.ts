// The daily report (internal job, pg_cron 00:00 UTC = 08:00 台北): nine numbers by SQL, one sentence
// (cheap model, else the fixed sentence), mailed through Resend — also when nothing happened.
import { anthropicModel } from "../_shared/aua/model-anthropic.ts";
import { runDaily } from "../_shared/aua/report.ts";
import { rpc } from "../_shared/aua/serve.ts";
import { windSigner } from "../_shared/aua/wind-key.ts";
import { hashOf } from "../_shared/aua/canon.ts";
import { SCHEMA } from "../_shared/aua/schema.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const secret = req.headers.get("x-aua-export") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc("aua_export_auth", { p_secret: secret }))) {
    return new Response(JSON.stringify({ err: 17 }), { status: 401 });
  }
  try {
    const r = await runDaily({
      rpc, fetch: (u, i) => fetch(u, i), model: anthropicModel(), now: () => new Date(), signer: await windSigner(rpc), aua: await hashOf(SCHEMA),
      mail: { key: Deno.env.get("RESEND_API_KEY"), to: Deno.env.get("NHI1_REPORT_TO"), from: "NHI-1 <report@mail.nhi1.org>" },
    });
    return Response.json({ ok: 1, day: r.day, light: r.light, sent: r.err === 0 ? 1 : 0, err: r.err, wrote: r.wrote ? 1 : 0 });
  } catch (e) {
    console.error(String(e));
    return new Response(JSON.stringify({ err: 16 }), { status: 500 });
  }
});
