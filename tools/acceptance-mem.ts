// NHI-2 acceptance against the REAL deployment — READ-ONLY for the cabin, like tools/acceptance.ts for NHI-1.
// A throwaway test key and a throwaway door: refusals, closed doors, hashes, the verify-only check. The test key
// never gets a room, a box or a mem, so no test citizen stays on the root (寓言 11/13). --box-closed: after the old
// key box was closed (11/16), box_get / box_put must answer err 51. Rows of mem / mem_head / mem_box are
// counted before and after and must not change (only rate-bucket rows from the reads are left, as for NHI-1).
//   node --env-file=.env tools/acceptance-mem.ts [--site https://nhi1.org]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canon, hashOf, sha256Hex, toHex } from "../supabase/functions/_shared/aua/canon.ts";
import { MEM_SCHEMA } from "../supabase/functions/_shared/aua/mem-schema.ts";
import * as M from "../skill/nhi1-aua/mem.mjs";
import { CONFIG, ROOT } from "./aua-json.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i < 0 ? undefined : process.argv[i + 1] ?? "";
};
const REF = process.env.SUPABASE_PROJECT_REF || "hjrnskmovwjtaifidldw";
const SUPA = `https://${REF}.supabase.co`;
const ANON = process.env.SUPABASE_ANON_KEY || "";
const site = arg("--site") ?? CONFIG.site;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
let pass = 0, failN = 0;
const check = (ok: boolean, label: string, extra = "") => {
  ok ? pass++ : failN++;
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  · " + extra : ""}`);
};
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j: any = null;
  try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};

function liveCount(): number | null {
  try {
    const out = execFileSync("supabase", ["db", "query", "--linked",
      "select (select count(*) from public.mem)+(select count(*) from public.mem_head)+(select count(*) from public.mem_box)+(select count(*) from public.mem_room) as n"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return Number(JSON.parse(out.slice(out.indexOf("{"))).rows[0].n);
  } catch {
    return null;
  }
}
const before = liveCount();

// ── 1. aua.json, the schema file and the client files ──
const wk = await (await fetch(`${site}/.well-known/aua.json`)).json();
const MEM_AUA = await hashOf(MEM_SCHEMA);
check(typeof wk.ep?.mem === "string", "aua.json has ep.mem", wk.ep?.mem);
check(wk.mem?.aua === MEM_AUA && M.MEM_AUA === MEM_AUA, "mem.aua = this repo's cabin schema hash", MEM_AUA.slice(0, 12));
const sch = await fetch(wk.mem?.schema ?? `${site}/schema/${MEM_AUA}.json`);
check(sch.ok && (await sha256Hex(await sch.text())) === (await sha256Hex(canon(MEM_SCHEMA))), "the cabin schema file is published, byte for byte");
for (const f of ["mem.mjs", "box.mjs"]) {
  const local = await sha256Hex(readFileSync(join(ROOT, "skill/nhi1-aua", f)));
  const pub = await fetch(`${site}/skill/${f}`);
  check(wk.mem?.[f] === local, `aua.json mem["${f}"] = this repo's file`);
  check(pub.ok && (await sha256Hex(new Uint8Array(await pub.arrayBuffer()))) === local, `${site}/skill/${f} is the same file`);
}
const EP = wk.ep.mem as string;

// ── 2. anon sees nothing ──
if (ANON) {
  const h = { apikey: ANON, authorization: `Bearer ${ANON}`, "content-type": "application/json", prefer: "return=minimal" };
  for (const t of ["mem", "mem_head", "mem_box", "mem_room"]) {
    const s = await fetch(`${SUPA}/rest/v1/${t}?select=*&limit=1`, { headers: h });
    const d = await fetch(`${SUPA}/rest/v1/${t}?key=eq.x`, { method: "DELETE", headers: h });
    check(!s.ok && !d.ok, `anon select/delete ${t} denied`, `${s.status}/${d.status}`);
  }
  for (const [fn, a] of [["aua_mem_boot", { p_key: "0".repeat(64), p_lim: 1 }], ["aua_box_get", { p_door: "0".repeat(64), p_ip: "x" }], ["aua_room_reg", { p_pub: "0".repeat(64), p_ip: "x" }], ["aua_room_has", { p_pub: "0".repeat(64) }]] as const) {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: "POST", headers: h, body: JSON.stringify(a) });
    check(!r.ok, `anon cannot call ${fn}`, String(r.status));
  }
} else console.log("⚠️  SUPABASE_ANON_KEY not set — anon checks skipped");

// ── 3. the endpoint refuses, with a throwaway key that never gets a box ──
const tk = await M.memorySecrets({ citizen: "acceptance" });
const shell = async (over: Record<string, unknown> = {}) => {
  const s: Record<string, any> = { aua: MEM_AUA, key: tk.pub, seq: 0, prev: null, kind: 0, kv: 1, t: now() - (now() % 86400), refs: [], sup: [], upto: null, ...over };
  s.enc = await tk.seal(1, M.memAad(s), M.contentBytes({ v: 1, items: [] }));
  s.size = Buffer.from(s.enc, "base64url").length;
  return tk.sign(s);
};
const bad = await shell();
check((await post(EP, { op: "put", rec: { ...bad, sig: "0".repeat(128) } })).body?.err === 5, "put with a wrong signature → err 5");
check((await post(EP, { op: "put", rec: { ...(await shell()), note: "free text" } })).body?.err === 4, "put with a free-text field → err 4");
check((await post(EP, { op: "put", rec: await shell({ aua: "0".repeat(64) }) })).body?.err === 8, "put for another schema → err 8");
const head = await post(EP, await tk.sign({ op: "head", aua: MEM_AUA, key: tk.pub, t: now() }));
check(head.status === 200 && head.body?.head === null, "a key with no room reads an empty head");
check((await post(EP, { op: "boot", aua: MEM_AUA, key: tk.pub, t: now(), sig: "0".repeat(128) })).body?.err === 5, "an unsigned read → err 5");

const door = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const doorPub = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", door.publicKey)));
const dsign = async (m: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, door.privateKey, m)));
// the verify-only check (George 11/16): signed here with the throwaway key; the root says yes / no and keeps nothing
const cq = { op: "check", aua: MEM_AUA, key: tk.pub, n: toHex(crypto.getRandomValues(new Uint8Array(32))), t: now() };
const ck = await post(EP, await tk.sign(cq));
check(ck.status === 200 && ck.body?.ok === 1 && ck.body?.room === 0, "check: a signature made here verifies on the root (this key has no room)", JSON.stringify(ck.body));
const ck0 = await post(EP, { ...cq, sig: (await tk.sign({ ...cq, n: "0".repeat(64) })).sig });
check(ck0.status === 200 && ck0.body?.ok === 0, "check: a signature over other bytes does not verify");
check((await post(EP, { op: "reg", aua: MEM_AUA, key: tk.pub, t: now(), sig: "0".repeat(128) })).body?.err === 5, "reg with a wrong signature → err 5 (no room made)");

const boxClosed = process.argv.includes("--box-closed");
const g = { op: "box_get", aua: MEM_AUA, door: doorPub, t: now() };
const got = await post(EP, { ...g, sig: await dsign(enc.encode(canon(g))) });
if (boxClosed) check(got.status === 410 && got.body?.err === 51, "the old key box is closed: box_get → err 51");
else check((got.status === 404 && got.body?.err === 48) || (got.status === 410 && got.body?.err === 51), "box_get behind a door with no box → err 48 (or 51 once closed)", String(got.body?.err));
const box = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64url");
const p = { op: "box_put", aua: MEM_AUA, door: doorPub, next: doorPub, pub: tk.pub, ver: 2, size: 64, box, t: now() };
const m = enc.encode(canon(p));
if (boxClosed) check((await post(EP, { ...p, sig: await dsign(m), psig: await tk.signBytes(m) })).body?.err === 51, "the old key box is closed: box_put → err 51 (nothing stored)");
else check([49, 51].includes((await post(EP, { ...p, sig: await dsign(m), psig: await tk.signBytes(m) })).body?.err), "a new box that is not ver 1 → err 49 (nothing stored)");
const p1 = { ...p, ver: 1 };
const m1 = enc.encode(canon(p1));
check((await post(EP, { ...p1, sig: await dsign(m1), psig: "0".repeat(128) })).body?.err === 5, "a box without the citizen's signature → err 5 (nothing stored)");

// ── 4. nothing was written ──
const after = liveCount();
if (before === null || after === null) console.log("⚠️  supabase CLI not linked — row count not checked");
else check(after === before, "mem + mem_head + mem_box + mem_room rows unchanged", `${before} → ${after}`);
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
