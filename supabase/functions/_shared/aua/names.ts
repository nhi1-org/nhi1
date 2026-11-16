// Name → fingerprint table (AUA §5, board item 1 accepted as 【暫】 2026-11-09).
// Records carry only sha256(utf-8 name) for call.op, by.model, by.rt. This table lets anyone read
// them back. It is published with every daily export as names.json, CC0-1.0.
// The board never sees names, so this list is curated: add a name here (PR welcome) and the next
// export carries it. Hash function: sha256 over the exact UTF-8 bytes — locked in aua.json `ident`.
import { ident } from "./canon.ts";

export const NAMES: Record<"rt" | "model" | "op", string[]> = {
  rt: ["claude-code", "claude-desktop", "claude-agent-sdk", "unknown"],
  model: ["claude-fable-5-1", "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "unknown"],
  op: ["read_wiki_structure", "read_wiki_contents", "ask_question"],
};

export const IDENT = { fn: "sha256", input: "utf-8 bytes of the exact name", out: "lowercase hex, 64 chars", v: 1 } as const;

export async function namesTable(): Promise<{ license: string; ident: typeof IDENT; names: { kind: string; name: string; hash: string }[] }> {
  const names: { kind: string; name: string; hash: string }[] = [];
  for (const kind of Object.keys(NAMES).sort() as (keyof typeof NAMES)[]) {
    for (const name of [...NAMES[kind]].sort()) names.push({ kind, name, hash: await ident(name) });
  }
  return { license: "CC0-1.0", ident: IDENT, names };
}
