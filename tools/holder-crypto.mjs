// Holder keys (憲章 四 / AUA §2.6): the keys humans use to stop a chain. No AI makes them or reads
// their private half. Private keys exist on disk only encrypted with the holder's own password
// (scrypt → AES-256-GCM); unlocked keys live only in memory, are never logged, never printed.
// Password entry only from an interactive terminal (TTY): a pipe, a script or an agent cannot type it.
// Apache-2.0.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** ~/.nhi1/holders — outside the repo and outside the NHI document folder */
export const HOLDERS_DIR = () => join(homedir(), ".nhi1", "holders");
export const ROLES = ["active", "dormant-1", "dormant-2"];
export const holderFile = (role) => join(HOLDERS_DIR(), `holder-${role}.json`);
export const MIN_PASSWORD = 12;

const KDF = { alg: "scrypt", N: 2 ** 17, r: 8, p: 1 };
const MAXMEM = 256 * 1024 * 1024;
const b64u = (b) => Buffer.from(b).toString("base64url");

function derive(password, salt, kdf) {
  return scryptSync(Buffer.from(String(password).normalize("NFC"), "utf8"), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM });
}

/** Encrypt a key {pub, jwk} with a password. The returned object holds no private material in clear. */
export function seal(key, password, role) {
  if (String(password).length < MIN_PASSWORD) throw new Error(`password: at least ${MIN_PASSWORD} characters`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(password, salt, KDF), iv);
  c.setAAD(Buffer.from(`nhi1-holder:${role}:${key.pub}`));
  const ct = Buffer.concat([c.update(JSON.stringify(key.jwk), "utf8"), c.final()]);
  return {
    v: 1, kind: "nhi1-holder-key", role, pub: key.pub, created: new Date().toISOString().slice(0, 10),
    kdf: { ...KDF, salt: salt.toString("hex") },
    cipher: { alg: "aes-256-gcm", iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("base64") },
  };
}

/** Decrypt a sealed holder key. Wrong password (or tampered file) throws. Result stays in memory. */
export function unseal(file, password) {
  if (!file || file.kind !== "nhi1-holder-key" || file.v !== 1) throw new Error("not a holder key file");
  const salt = Buffer.from(file.kdf.salt, "hex");
  const d = createDecipheriv("aes-256-gcm", derive(password, salt, file.kdf), Buffer.from(file.cipher.iv, "hex"));
  d.setAAD(Buffer.from(`nhi1-holder:${file.role}:${file.pub}`));
  d.setAuthTag(Buffer.from(file.cipher.tag, "hex"));
  let jwk;
  try {
    jwk = JSON.parse(Buffer.concat([d.update(Buffer.from(file.cipher.ct, "base64")), d.final()]).toString("utf8"));
  } catch {
    throw new Error("wrong password, or the key file was changed");
  }
  if (jwk.x !== b64u(Buffer.from(file.pub, "hex"))) throw new Error("key file does not match its public key");
  return { pub: file.pub, jwk };
}

export function readHolderFile(path) {
  if (!existsSync(path)) throw new Error(`no holder key file at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeHolderFile(path, sealed) {
  if (existsSync(path)) throw new Error(`exists, not overwritten: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sealed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/** Read one line from the terminal without echoing it. Refuses when stdin is not a terminal. */
export function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("a password can only be typed in an interactive terminal"));
    process.stderr.write(label);
    let s = "";
    const cleanup = () => {
      stdin.removeListener("data", on);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const on = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stderr.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else if (ch >= " ") s += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", on);
  });
}

/** Ask for the password of one holder key file and return the unlocked key (memory only). */
export async function unlockHolder(path, label = "") {
  const file = readHolderFile(path);
  const pw = await promptHidden(`Password for ${label || file.role} key ${file.pub.slice(0, 12)}…: `);
  return unseal(file, pw);
}
