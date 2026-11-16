// Deno-only: the real model call, Anthropic SDK direct (George's rule D). Key from Supabase secrets
// (ANTHROPIC_API_KEY, the NHI-1 workspace key George sets himself). No tools, structured output only.
// The canary judge runs with server-side fallbacks ("default") so a policy refusal is re-run by the API
// instead of silently leaving the question unanswered. The harm judge does NOT (req.fallback = false): a
// refusal there is answered by mailing the alert anyway, never by another model's verdict. Apache-2.0.
import Anthropic from "npm:@anthropic-ai/sdk@1.7.0";
import { MODELS, type ModelFn, type ModelReq, type ModelRes } from "./model.ts";

declare const Deno: { env: { get(k: string): string | undefined } };

export function anthropicModel(): ModelFn | undefined {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return undefined;
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });

  return async (req: ModelReq): Promise<ModelRes> => {
    const m = MODELS[req.role];
    const params = {
      model: m.id,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user" as const, content: req.input }],
      output_config: { effort: m.effort, format: { type: "json_schema", schema: req.schema } },
    };
    try {
      // deno-lint-ignore no-explicit-any
      const r: any = req.role === "judge" && req.fallback !== false
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never)
        : await client.messages.create(params as never);
      const usage = {
        model: String(r.model ?? m.id),
        tin: (r.usage?.input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0),
        tout: r.usage?.output_tokens ?? 0,
      };
      if (r.stop_reason === "refusal") return { ok: false, err: "refusal", ...usage };
      if (r.stop_reason === "max_tokens") return { ok: false, err: "invalid", ...usage };
      const text = (r.content as { type: string; text?: string }[]).find((b) => b.type === "text")?.text;
      if (!text) return { ok: false, err: "invalid", ...usage };
      let out: Record<string, unknown>;
      try {
        out = JSON.parse(text);
      } catch {
        return { ok: false, err: "invalid", ...usage };
      }
      return { ok: true, out, ...usage };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { ok: false, err: "auth" };
      if (e instanceof Anthropic.APIConnectionError) return { ok: false, err: "network" };
      if (e instanceof Anthropic.APIError) return { ok: false, err: "api" };
      return { ok: false, err: "network" };
    }
  };
}
