// The daily report (internal job, pg_cron 00:00 UTC = 08:00 台北; retry 00:40 with {"retry":1}): numbers by SQL,
// one sentence (cheap model, else the fixed sentence), mailed through Resend — also when nothing happened.
// Every run leaves run rows in report_log (started → finished / failed), so a report can no longer silently not
// happen (BOARD-FIX-1123, 4). Counted at the door; "inside" only once the vault secret is proven.
import { anthropicModel } from "../_shared/aua/model-anthropic.ts";
import { runReportJob } from "../_shared/aua/report.ts";
import { rpc } from "../_shared/aua/serve.ts";
import { windSigner } from "../_shared/aua/wind-key.ts";
import { hashOf } from "../_shared/aua/canon.ts";
import { SCHEMA } from "../_shared/aua/schema.ts";
import { edgeWait, withDoor } from "../_shared/aua/door.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

Deno.serve(withDoor("report", rpc, async (req, mark) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const secret = req.headers.get("x-aua-export") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc("aua_export_auth", { p_secret: secret }))) {
    return new Response(JSON.stringify({ err: 17 }), { status: 401 });
  }
  mark.inside = true;
  let retry = false;
  try {
    retry = Number(((await req.json()) as { retry?: unknown })?.retry) === 1;
  } catch { /* {} or no body: the 00:00 run */ }
  try {
    const now = () => new Date();
    const j = await runReportJob(rpc, now, async () => ({
      rpc, fetch: (u, i) => fetch(u, i), model: anthropicModel(), now, signer: await windSigner(rpc), aua: await hashOf(SCHEMA),
      mail: { key: Deno.env.get("RESEND_API_KEY"), to: Deno.env.get("NHI1_REPORT_TO"), from: "NHI-1 <report@mail.nhi1.org>" },
    }), { retry });
    if (!j.r) return Response.json({ ok: 1, day: j.day, skipped: 1 });
    const r = j.r;
    return Response.json({ ok: 1, day: r.day, light: r.light, sent: r.err === 0 ? 1 : 0, err: r.err, wrote: r.wrote ? 1 : 0 });
  } catch (e) {
    console.error(String(e));
    return new Response(JSON.stringify({ err: 16 }), { status: 500 });
  }
}, edgeWait()));
