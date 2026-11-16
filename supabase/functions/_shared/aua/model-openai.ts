// Deno-only: the model of the other family for rpf (George 11/13: OpenAI GPT). Key from Supabase secrets
// (OPENAI_API_KEY, set by George; never read by CODE). Model from the secret NHI1_RPF_MODEL (a knob that
// needs no redeploy), default gpt-5.6-sol (George 11/13 一 1). OpenAI Responses API, direct HTTPS: no tools, nothing stored
// (store: false), the answer forced into a JSON schema. The family is fixed here ("openai"). Apache-2.0.
import type { RpfModel, RpfReq, RpfRes } from "./rpf.ts";

declare const Deno: { env: { get(k: string): string | undefined } };

export function openaiModel(): RpfModel | undefined {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return undefined;
  const model = Deno.env.get("NHI1_RPF_MODEL") || "gpt-5.6-sol";
  return {
    family: "openai",
    model,
    call: async (req: RpfReq): Promise<RpfRes> => {
      let r: Response;
      try {
        r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model, instructions: req.system, input: req.input, max_output_tokens: req.maxTokens, store: false, tools: [],
            text: { format: { type: "json_schema", name: "answer", schema: req.schema, strict: true } },
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        return { ok: false, err: "network" };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, err: "auth" };
      if (r.status === 404) return { ok: false, err: "model_gone", model }; // withdrawn, or this key has no access to it
      // deno-lint-ignore no-explicit-any
      let j: any;
      try {
        j = await r.json();
      } catch {
        return { ok: false, err: "api" };
      }
      const usage = { model: String(j?.model ?? model), tin: Number(j?.usage?.input_tokens ?? 0), tout: Number(j?.usage?.output_tokens ?? 0) };
      if (j?.error?.code === "model_not_found") return { ok: false, err: "model_gone", ...usage };
      if (!r.ok) return { ok: false, err: "api", ...usage };
      if (j.status && j.status !== "completed") return { ok: false, err: "invalid", ...usage };
      // deno-lint-ignore no-explicit-any
      const msg = (j.output ?? []).find((o: any) => o.type === "message");
      // deno-lint-ignore no-explicit-any
      const part = msg?.content?.find((c: any) => c.type === "output_text" || c.type === "refusal");
      if (!part || part.type === "refusal") return { ok: false, err: "refusal", ...usage };
      try {
        return { ok: true, out: JSON.parse(part.text), ...usage };
      } catch {
        return { ok: false, err: "invalid", ...usage };
      }
    },
  };
}
