// Test harness: real Postgres (PGlite, WASM) running the real migration, with Supabase's roles.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashOf, recordId, toHex } from "../supabase/functions/_shared/aua/canon.ts";
import { atBytes, dayOf, type Deps, handleReplay, handleTalk, handleUse, type Res, type Rpc } from "../supabase/functions/_shared/aua/handlers.ts";
import { SCHEMA } from "../supabase/functions/_shared/aua/schema.ts";

const ROOT = join(import.meta.dirname, "..");

export async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    -- mimic Supabase's permissive defaults so the migration's revokes are actually tested
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  // migrations 2 and 5 (pg_cron / pg_net / vault / storage) are Supabase-only; 1, 3, 4 are the board itself
  for (const m of ["20261109000001_aua_core.sql", "20261109000003_aua_key_model.sql", "20261110000004_aua_closed_ask.sql", "20261110000006_aua_wind.sql", "20261110000008_aua_canary_clear.sql", "20261110000009_aua_schema_batch.sql", "20261110000011_aua_chain.sql", "20261112000012_aua_talk.sql", "20261113000013_aua_wall_quota.sql", "20261113000014_aua_rerun.sql", "20261113000015_aua_digest.sql", "20261123000023_aua_board_fix.sql"]) {
    await db.exec(readFileSync(join(ROOT, "supabase/migrations", m), "utf8"));
  }
  return db;
}

export function rpcFor(db: PGlite, role = "service_role"): Rpc {
  return async (fn, args) => {
    const ks = Object.keys(args);
    const vals = ks.map((k) => {
      const v = args[k];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const sql = `select public.${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    await db.exec(`set role ${role}`);
    try {
      const r = await db.query<{ r: unknown }>(sql, vals);
      return r.rows[0].r;
    } finally {
      await db.exec("reset role");
    }
  };
}

export const AUA = await hashOf(SCHEMA);

export function deps(db: PGlite, over: Partial<Deps> = {}): Deps {
  return {
    rpc: rpcFor(db),
    now: () => Math.floor(Date.now() / 1000),
    ip: "a".repeat(64),
    aua: AUA,
    holders: { active: [], dormant: [], pause_hours: 72, timelock_days: 7, wake_after_days: 180 },
    randomHex: (n) => toHex(crypto.getRandomValues(new Uint8Array(n))),
    ...over,
  };
}

// ── the chain (2_ §2.2): t = UTC day, prev = the key's head, sent in an envelope {rec, at: {t, sig}} ──
export const nowSec = () => Math.floor(Date.now() / 1000);
export const today = () => dayOf(nowSec());
/** the head each test key has reached (moved by putUse / putReplay on 201 / 202) */
export const HEADS = new Map<string, string>();
export const prevOf = (pub: string) => HEADS.get(pub) ?? null;
export async function envelope(rec: Record<string, unknown>, key: { jwk: unknown }, at = nowSec()) {
  const id = await recordId(rec);
  const pk = await crypto.subtle.importKey("jwk", key.jwk as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
  const sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pk, atBytes(id, at)));
  return { rec, at: { t: at, sig } };
}
const moved = (env: unknown, r: Res) => {
  const e = env as { rec?: { by?: { key?: string } } };
  const id = (r.body as { id?: string } | null)?.id;
  if ((r.status === 201 || r.status === 202) && id && e?.rec?.by?.key) HEADS.set(e.rec.by.key, id);
  return r;
};
export const putUse = async (env: unknown, d: Deps) => moved(env, await handleUse(env, d));
export const putReplay = async (env: unknown, d: Deps) => moved(env, await handleReplay(env, d));
export const putTalk = async (env: unknown, d: Deps) => moved(env, await handleTalk(env, d));
