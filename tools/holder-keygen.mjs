#!/usr/bin/env node
// Holder keygen (憲章 四 / AUA §2.6). Run BY THE HOLDER, in their own terminal — never by an AI.
//
//   node tools/holder-keygen.mjs active       George, the key in use
//   node tools/holder-keygen.mjs dormant-1    daughter 1, asleep
//   node tools/holder-keygen.mjs dormant-2    daughter 2, asleep
//
// Asks for a password twice (nothing shows while typing), makes an Ed25519 key, encrypts the private
// half with that password, and writes ~/.nhi1/holders/holder-<role>.json. Prints only the public key.
// Never overwrites. The private key is never printed, logged, or written unencrypted.
// Keep the file here plus an offline copy (USB). Forget the password = the key is gone.
// Apache-2.0.

import { generateKey } from "../skill/nhi1-aua/aua.mjs";
import { holderFile, MIN_PASSWORD, promptHidden, ROLES, seal, writeHolderFile } from "./holder-crypto.mjs";

const role = process.argv[2];
if (!ROLES.includes(role)) {
  process.stderr.write(`usage: node tools/holder-keygen.mjs <${ROLES.join("|")}>\n`);
  process.exit(2);
}
if (!process.stdin.isTTY) {
  process.stderr.write("Run this yourself in a PowerShell window: it needs to ask you for a password.\n");
  process.exit(2);
}
const path = holderFile(role);
try {
  process.stderr.write(`NHI-1 holder key · ${role}\nChoose a password (at least ${MIN_PASSWORD} characters). Nothing appears while you type.\n`);
  const a = await promptHidden("Password: ");
  if (a.length < MIN_PASSWORD) throw new Error(`too short: at least ${MIN_PASSWORD} characters. Nothing was written.`);
  const b = await promptHidden("Same password again: ");
  if (a !== b) throw new Error("the two passwords differ. Nothing was written.");
  const key = await generateKey();
  writeHolderFile(path, seal(key, a, role));
  process.stdout.write(`\n${role} key made.\n  public key: ${key.pub}\n  file (encrypted): ${path}\nCopy that file to your offline USB now. Only the public key is ever shared.\n`);
} catch (e) {
  process.stderr.write(String((e && e.message) || e) + "\n");
  process.exit(1);
}
