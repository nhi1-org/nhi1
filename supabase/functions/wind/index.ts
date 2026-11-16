// The wind tunnel run (internal job, pg_cron; same vault-held secret as export).
//   {}                 (aua-wind-daily 23:30 UTC): interface re-runs + canary rules, model judgement for rule-uncertain
//                      text, emergency mail on a new hit, the canary on talk.
//   {"part":"replay"}  (aua-wind-replay 23:45 UTC; S4): stub re-runs (no tokens), cross-family re-runs (OpenAI), the
//                      digest. Off while the knobs replay_on / digest_on are 0.
// The response carries numbers only: no addr, no text, no tool answer.
import { anthropicModel } from "../_shared/aua/model-anthropic.ts";
import { openaiModel } from "../_shared/aua/model-openai.ts";
import { runDigest } from "../_shared/aua/digest.ts";
import { runStubReplay } from "../_shared/aua/rerun.ts";
import { runRpf } from "../_shared/aua/rpf.ts";
import { rpc } from "../_shared/aua/serve.ts";
import { digestSigner, windSigner } from "../_shared/aua/wind-key.ts";
import { hashOf } from "../_shared/aua/canon.ts";
import { SCHEMA } from "../_shared/aua/schema.ts";
import { runTalkCanary, runWind } from "../_shared/aua/wind.ts";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const secret = req.headers.get("x-aua-export") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc("aua_export_auth", { p_secret: secret }))) {
    return new Response(JSON.stringify({ err: 17 }), { status: 401 });
  }
  let part = "";
  try {
    part = String(((await req.json()) as { part?: unknown })?.part ?? "");
  } catch { /* {} or no body: the daily part */ }
  try {
    const deps = {
      rpc, fetch: (u: string, i?: RequestInit) => fetch(u, i), model: anthropicModel(), now: () => new Date(), signer: await windSigner(rpc), aua: await hashOf(SCHEMA),
      mail: { key: Deno.env.get("RESEND_API_KEY"), to: Deno.env.get("NHI1_REPORT_TO"), from: "NHI-1 <report@mail.nhi1.org>" },
    };
    if (part === "replay") {
      const stub = await runStubReplay(deps);
      const rpf = await runRpf({ ...deps, rpfModel: openaiModel() });
      const digestOn = Number(await rpc("aua_knob", { p: "digest_on" })) === 1;
      const digest = await runDigest({ ...deps, rpfModel: openaiModel(), digestSigner: digestOn ? await digestSigner(rpc) : undefined });
      return Response.json({
        ok: 1, part, stub, digest: { status: digest.status, read: digest.read, made: digest.made },
        rpf: { status: rpf.status, state: rpf.state, ran: rpf.ran, pass: rpf.pass, fail: rpf.fail, skipped: rpf.skipped },
      });
    }
    const out = await runWind(deps);
    const talk = await runTalkCanary(deps);
    const count = (k: number) => out.filter((x) => x.result === k).length;
    return Response.json({ ok: 1, checked: out.length, same: count(0), changed: count(1), gone: count(2), unreachable: count(3), flagged: out.filter((x) => x.rules.length).length, talk });
  } catch (e) {
    console.error(String(e));
    return new Response(JSON.stringify({ err: 16 }), { status: 500 });
  }
});
