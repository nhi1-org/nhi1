// A wind re-run row (replay_result, S4 A) straight into the local board, for tests that only need the counts.
// how 0 = stub re-run; how 1 = cross-family (fam = the family hash). code 0 = pass.
import { toHex } from "../supabase/functions/_shared/aua/canon.ts";

const rnd = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
export async function rerunRow(db: any, use: string, o: { how?: 0 | 1; code?: number; fam?: string | null; req?: string | null; id?: string } = {}) {
  const how = o.how ?? (o.fam ? 1 : 0);
  const id = o.id ?? rnd();
  await db.query(
    "insert into public.replay_result (id, rec, use_id, req_id, how, code, err, fam, model, by_key, t) values ($1, '{}', $2, $3, $4, $5, $6, $7, $8, $9, 0)",
    [id, use, o.req ?? null, how, o.code ?? 0, o.code ? 6 : 0, how === 1 ? (o.fam ?? "f".repeat(64)) : null, how === 1 ? "c".repeat(64) : null, "e".repeat(64)],
  );
  return id;
}
