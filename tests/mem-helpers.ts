// NHI-2 test harness: the cabin's own migrations on top of the board (tests/helpers.ts makeDb). Kept apart from
// helpers.ts so the NHI-1 migration list stays as it is.
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MEM_MIGRATIONS = ["20261113000020_nhi2_mem.sql", "20261113000021_nhi2_box.sql", "20261116000022_nhi2_key_local.sql"];

export async function applyMem(db: PGlite) {
  for (const m of MEM_MIGRATIONS) await db.exec(readFileSync(join(import.meta.dirname, "..", "supabase/migrations", m), "utf8"));
}
