#!/usr/bin/env node
// Holder tool (憲章 四 / AUA §2.6): every look and every act is a signed, public key record.
// Run BY THE HOLDER in their own terminal. Each run asks for the key's password; the unlocked key
// lives only in this process's memory — never written, never logged, never printed.
//
//   node tools/holder.mjs view <table> [--key K] [--id ID] [--since T] [--lim N]   act 0 (table: thing|use|talk|key)
//   node tools/holder.mjs pause <chain> [hours]              act 1 (hours ≤ holders.pause_hours)
//   node tools/holder.mjs unpause <chain>                    act 2
//   node tools/holder.mjs cut <chain>                        act 3 (effective after holders.timelock_days)
//   node tools/holder.mjs fork <chain> <new-root-addr>       act 4 (effective after holders.timelock_days)
//   node tools/holder.mjs handover <next-active-pub>         act 5
//   node tools/holder.mjs wake <dormant-pub-to-wake>         act 6 (every dormant key's password, this machine)
//   node tools/holder.mjs revoke <pending-record-id> [chain] act 7
//
// Key file: ~/.nhi1/holders/holder-active.json (wake: the holder-dormant-*.json files); --file <path> overrides.
// Apache-2.0.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { canon, discover, hashOf, ident, normAddr, post, toHex } from "../skill/nhi1-aua/aua.mjs";
import { HOLDERS_DIR, holderFile, readHolderFile, unlockHolder } from "./holder-crypto.mjs";

const enc = new TextEncoder();
const TABLES = { thing: 0, use: 1, talk: 2, key: 3 };
const HEX = /^[0-9a-f]{64}$/;

async function sign(bytes, key) {
  const pk = await crypto.subtle.importKey("jwk", key.jwk, { name: "Ed25519" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign({ name: "Ed25519" }, pk, bytes));
}
const signRec = async (rec, key) => {
  const { sig: _s, ...rest } = rec;
  return { ...rest, sig: await sign(enc.encode(canon(rest)), key) };
};
const cosignBytes = (rec) => {
  const { sig: _s, cosig: _c, ...rest } = rec;
  return enc.encode(canon(rest));
};

function opt(args, name, def) {
  const i = args.indexOf(name);
  return i < 0 ? def : args[i + 1];
}
const need = (v, what) => {
  if (!v || !HEX.test(v)) throw new Error(`${what}: 64 lowercase hex characters`);
  return v;
};

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!process.stdin.isTTY) throw new Error("Run this yourself in a terminal: it asks for your key's password.");
  const d = await discover(undefined, { fresh: true });
  const h = d.holders || {};
  const t = Math.floor(Date.now() / 1000);
  const base = (by) => ({
    aua: d.aua, act: 0, on: { chain: null, recs: [], q: null, key: null }, until: 0, effective: 0, by: { key: by.pub }, cosig: [], t,
  });
  const file = opt(args, "--file", cmd === "wake" ? holderFile("dormant-1") : holderFile("active"));

  if (cmd === "view") {
    const table = TABLES[args[0]];
    if (table === undefined) throw new Error("table: thing | use | talk | key");
    const query = {
      table, id: opt(args, "--id", null), key: opt(args, "--key", null),
      since: Number(opt(args, "--since", 0)), lim: Number(opt(args, "--lim", 10)),
    };
    const key = await unlockHolder(file);
    const rec = await signRec({ ...base(key), on: { ...base(key).on, q: await hashOf(query) } }, key);
    return post(d.ep["key-view"], { rec, query });
  }

  const acts = {
    pause: async (key) => {
      const hours = Number(args[1] || h.pause_hours || 72);
      return { act: 1, on: { chain: need(args[0], "chain") }, until: t + Math.min(hours, h.pause_hours || 72) * 3600 };
    },
    unpause: async () => ({ act: 2, on: { chain: need(args[0], "chain") } }),
    cut: async () => ({ act: 3, on: { chain: need(args[0], "chain") }, effective: t + (h.timelock_days || 7) * 86400 }),
    fork: async () => ({ act: 4, on: { chain: need(args[0], "chain"), q: await ident(normAddr(args[1])) }, effective: t + (h.timelock_days || 7) * 86400 }),
    handover: async () => ({ act: 5, on: { key: need(args[0], "next active key") } }),
    wake: async () => ({ act: 6, on: { key: need(args[0], "dormant key to wake") } }),
    revoke: async () => ({ act: 7, on: { recs: [need(args[0], "record id")], chain: args[1] ? need(args[1], "chain") : null } }),
  };
  if (!acts[cmd]) throw new Error("command: view | pause | unpause | cut | fork | handover | wake | revoke");

  const key = await unlockHolder(file);
  const f = await acts[cmd](key);
  const b = base(key);
  let rec = { ...b, ...f, on: { ...b.on, ...f.on } };
  if (cmd === "wake") {
    // every other dormant key on this machine co-signs; each asks for its own password
    const others = readdirSync(HOLDERS_DIR()).filter((n) => /^holder-dormant-.*\.json$/.test(n)).map((n) => join(HOLDERS_DIR(), n))
      .filter((p) => readHolderFile(p).pub !== key.pub);
    const cosig = [];
    for (const p of others) {
      const k = await unlockHolder(p);
      cosig.push({ key: k.pub, sig: await sign(cosignBytes(rec), k) });
    }
    rec = { ...rec, cosig };
  }
  return post(d.ep.key, await signRec(rec, key));
}

main(process.argv.slice(2)).then(
  (r) => process.stdout.write(JSON.stringify(r, null, 2) + "\n"),
  (e) => {
    process.stderr.write(String((e && e.message) || e) + "\n");
    process.exit(1);
  },
);
