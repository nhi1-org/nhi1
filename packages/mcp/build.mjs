// Builds @nhi1/mcp from the repository's own files (Opus card S1-A, 11/16):
//   mcp/server.ts            → dist/server.js   (types stripped by Node itself; Node does not strip .ts in node_modules)
//   skill/nhi1-aua/aua.mjs   → dist/skill/aua.mjs
//   skill/nhi1-aua/mem.mjs   → dist/skill/mem.mjs
//   skill/nhi1-aua/box.mjs   → dist/skill/box.mjs
//   LICENSE, NOTICE          → package root
// Hash lock (4_ §10): every skill file in the package must have the sha256 the current aua.json publishes
// (site/.well-known/aua.json: skill["aua.mjs"], mem["mem.mjs"], mem["box.mjs"]); any mismatch fails the build.
// Apache-2.0.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(fileURLToPath(import.meta.url));
const ROOT = join(PKG, "..", "..");
const DIST = join(PKG, "dist");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// NHI1_PKG_AUA_JSON: another aua.json to check against (the tests use it to see the lock fail)
const aua = JSON.parse(readFileSync(process.env.NHI1_PKG_AUA_JSON || join(ROOT, "site/.well-known/aua.json"), "utf8"));
const LOCK = { "aua.mjs": aua.skill["aua.mjs"], "mem.mjs": aua.mem["mem.mjs"], "box.mjs": aua.mem["box.mjs"] };

const bad = [];
for (const [f, want] of Object.entries(LOCK)) {
  const got = sha(readFileSync(join(ROOT, "skill/nhi1-aua", f)));
  if (got !== want) bad.push(`${f}: sha256 ${got} ≠ aua.json ${want}`);
}
if (bad.length) {
  console.error("hash lock: the skill files do not match the published aua.json\n  " + bad.join("\n  "));
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "skill"), { recursive: true });
for (const f of Object.keys(LOCK)) copyFileSync(join(ROOT, "skill/nhi1-aua", f), join(DIST, "skill", f));

const IMPORT = 'from "../skill/nhi1-aua/aua.mjs";';
const src = readFileSync(join(ROOT, "mcp/server.ts"), "utf8");
if (src.split(IMPORT).length !== 2) throw new Error("mcp/server.ts: expected one import of ../skill/nhi1-aua/aua.mjs");
const js = stripTypeScriptTypes(src.replace(IMPORT, 'from "./skill/aua.mjs";'), { mode: "strip" });
writeFileSync(join(DIST, "server.js"), "#!/usr/bin/env node\n" + js);
try { chmodSync(join(DIST, "server.js"), 0o755); } catch { /* Windows */ }

for (const f of ["LICENSE", "NOTICE"]) copyFileSync(join(ROOT, f), join(PKG, f));

// the copies in dist are the locked bytes
for (const [f, want] of Object.entries(LOCK)) if (sha(readFileSync(join(DIST, "skill", f))) !== want) throw new Error(`dist/skill/${f}: hash changed while copying`);
console.log(JSON.stringify({ built: "dist/server.js", skill: LOCK }));
