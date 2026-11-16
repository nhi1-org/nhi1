#!/usr/bin/env node
// Moving out of the old key box (George 11/16, task card step 13–14). Repo tool, not part of the skill. Apache-2.0.
//
//   node tools/migrate-box.mjs list            which citizens have an old password file here (names only)
//   node tools/migrate-box.mjs dry             open each box once and check it; write nothing
//   node tools/migrate-box.mjs move            open each box once, write its key as three pieces on this machine
//                                              (box.mjs importKey: never over an existing piece), register the
//                                              public half on the root. The id (public key) does not change.
//   node tools/migrate-box.mjs done            delete the old password file of every citizen whose pieces here
//                                              rebuild the same key (run only after the old box is closed and cleared)
//
// It prints citizen names, public keys and codes only: never a password, a piece or a key byte.
// The old box code below is the 11/13 box.mjs's opening half (fromPassword, box_get, unseal), kept only here.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canon, home, post } from "../skill/nhi1-aua/aua.mjs";
import { importKey, loadKey } from "../skill/nhi1-aua/box.mjs";
import { MEM_AUA, memReg } from "../skill/nhi1-aua/mem.mjs";
import { discover } from "../skill/nhi1-aua/aua.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const H = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const hex = (u8) => Buffer.from(u8).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const oldDir = () => join(home(), "citizen");

function readPass(p) {
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    if (o && o.v === 1 && NAME.test(o.citizen) && typeof o.pass === "string" && unb64u(o.pass).length === 32 && H.test(o.pub) && Number.isSafeInteger(o.ver)) return o;
  } catch { /* missing or broken */ }
  return null;
}
async function hkdf(pass, label) {
  const ikm = await crypto.subtle.importKey("raw", pass, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("nhi2"), info: enc.encode(label) }, ikm, 256));
}
async function edFromPkcs8(p8) {
  const ex = await crypto.subtle.importKey("pkcs8", p8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", ex);
  return { pub: hex(unb64u(jwk.x)), key: await crypto.subtle.importKey("pkcs8", p8, { name: "Ed25519" }, false, ["sign"]) };
}
async function edFromSeed(seed) {
  const p8 = new Uint8Array(48);
  p8.set(PKCS8_ED25519);
  p8.set(seed, 16);
  const r = await edFromPkcs8(p8);
  p8.fill(0);
  return r;
}
const boxAad = (pub, ver) => canon({ v: "nhi2/box/v1", pub, ver });

/** a pass file → { sk, keys, pub } out of its box on the root | { err } */
async function openOld(url, p) {
  const P = unb64u(p.pass);
  const door = await edFromSeed(await hkdf(P, "nhi2/door/v1"));
  const wrapRaw = await hkdf(P, "nhi2/wrap/v1");
  const wrap = await crypto.subtle.importKey("raw", wrapRaw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  wrapRaw.fill(0);
  P.fill(0);
  const q = { op: "box_get", aua: MEM_AUA, door: door.pub, t: nowS() };
  const sig = hex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, door.key, enc.encode(canon(q)))));
  let r;
  try { r = await post(url, { ...q, sig }, 30000); } catch { return { err: "network" }; }
  if (r.status !== 200 || !r.body || typeof r.body.box !== "string") return { err: "board_" + ((r.body && r.body.err) || r.status) };
  if (r.body.pub !== p.pub) return { err: "box_bad" };
  if (r.body.ver < p.ver) return { err: "box_rollback" };
  let pt = null;
  try {
    const u = unb64u(r.body.box);
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12), additionalData: enc.encode(boxAad(p.pub, r.body.ver)) }, wrap, u.slice(12)));
  } catch { return { err: "box_bad" }; }
  let o = null;
  try { o = JSON.parse(dec.decode(pt)); } catch { /* broken */ }
  pt.fill(0);
  if (!o || o.v !== 1 || o.pub !== p.pub || typeof o.sk !== "string" || !Array.isArray(o.keys) || !o.keys.length) return { err: "box_bad" };
  const keys = new Map();
  for (const x of o.keys) {
    if (!x || !Number.isSafeInteger(x.kv) || x.kv < 1 || typeof x.k !== "string" || unb64u(x.k).length !== 32) return { err: "box_bad" };
    keys.set(x.kv, unb64u(x.k));
  }
  const sk = unb64u(o.sk);
  if ((await edFromPkcs8(sk)).pub !== p.pub) return { err: "box_bad" };
  return { sk, keys, pub: p.pub, kvs: [...keys.keys()] };
}

/** every citizen with an old password file here: the pending new one first (as the old openCabin did) */
function passFiles() {
  if (!existsSync(oldDir())) return [];
  const names = new Set(readdirSync(oldDir()).map((f) => f.match(/^([a-z][a-z0-9-]{0,31})\.pass(\.new)?$/)?.[1]).filter(Boolean));
  return [...names].sort().map((c) => ({ citizen: c, files: [join(oldDir(), c + ".pass.new"), join(oldDir(), c + ".pass")].filter(existsSync) }));
}

async function main(cmd) {
  const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + "\n");
  const list = passFiles();
  if (cmd === "list") return out(list.map((x) => ({ citizen: x.citizen, files: x.files.length })));
  if (cmd === "done") {
    const res = [];
    for (const x of list) {
      const p = x.files.map(readPass).find(Boolean);
      const k = await loadKey(x.citizen);
      if (!p || !k.secrets || k.secrets.pub !== p.pub) { res.push({ citizen: x.citizen, deleted: false, why: k.err || "not_moved" }); continue; }
      for (const f of x.files) rmSync(f, { force: true });
      res.push({ citizen: x.citizen, pub: p.pub, deleted: true });
    }
    return out(res);
  }
  if (cmd !== "dry" && cmd !== "move") return process.stdout.write("usage: list | dry | move | done\n");
  const d = await discover(undefined, { fresh: true });
  if (!d.ep || !d.ep.mem || !d.mem || d.mem.aua !== MEM_AUA) return out({ err: "mem_schema", want: MEM_AUA, board: d.mem && d.mem.aua });
  const res = [];
  for (const x of list) {
    let got = null;
    let why = "no_pass";
    for (const f of x.files) {
      const p = readPass(f);
      if (!p) continue;
      const o = await openOld(d.ep.mem, p);
      if (!o.err) { got = o; break; }
      why = o.err;
    }
    if (!got) { res.push({ citizen: x.citizen, moved: false, why }); continue; }
    if (cmd === "dry") { res.push({ citizen: x.citizen, pub: got.pub, opens: true, memory_keys: got.kvs.length }); got.sk.fill(0); continue; }
    const have = await loadKey(x.citizen);
    let secrets = have.secrets;
    if (secrets && secrets.pub !== got.pub) { res.push({ citizen: x.citizen, moved: false, why: "other_key_here", here: secrets.pub, box: got.pub }); continue; }
    if (!secrets) {
      const r = await importKey(x.citizen, { sk: got.sk, keys: got.keys });
      if (!r.secrets) { res.push({ citizen: x.citizen, moved: false, why: r.err, ...(r.why ? { detail: r.why } : {}) }); continue; }
      secrets = r.secrets;
    }
    got.sk.fill(0);
    for (const k of got.keys.values()) k.fill(0);
    const again = await loadKey(x.citizen);
    const g = await memReg(secrets);
    res.push({ citizen: x.citizen, pub: secrets.pub, moved: again.secrets?.pub === got.pub, pieces: again.pieces, memory_keys: secrets.kvs.length, reg: g.err ? "pending:" + g.err : g.new ? "new" : "known" });
  }
  return out(res);
}

main(process.argv[2]).catch((e) => {
  process.stderr.write(String((e && e.message) || e) + "\n");
  process.exit(1);
});
