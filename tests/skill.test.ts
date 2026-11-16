// Lock 2: the skill is pinned to the version you installed. verify-skill answers
// latest (ok) / older (ok, a newer one exists) / unknown (not ok: altered or unknown source).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { skillStatus } from "../skill/nhi1-aua/aua.mjs";
import { buildAuaJson, skillHashes } from "../tools/aua-json.ts";

const ROOT = join(import.meta.dirname, "..");
const H = (c: string) => c.repeat(64);
// every SKILL.md / aua.mjs that has been live on nhi1.org so far
const PUBLISHED = {
  "SKILL.md": [
    "cdafbcbf70efb16d6066ebd6296a254fb0c41698d468017fcdf82709885a023d", // S1
    "ca9e4ee41bb292205064e21c7692b46eb5b451cc6a15f2552dcd5db1bab6c00e", // 11/10 hero line
    "8956a8c5ebc0bd1db95c9d76949d3f663541fe2d1c172d59d97e8cdd925a4ce0", // 11/10 hero text + no records license
  ],
  "aua.mjs": ["da1e8b5c860f6419edc4e48973c65001bde58e9cacf3a09bf3b05c50f56b934c"],
};

describe("skill versions (lock 2)", () => {
  const doc = { aua: H("9"), skill: { "SKILL.md": H("c"), versions: { "SKILL.md": [{ sha: H("a"), aua: H("8") }, { sha: H("b"), aua: H("9") }, { sha: H("c"), aua: H("9") }] } } };

  it("four answers: latest / older / upgrade / unknown", () => {
    assert.deepEqual(skillStatus(doc, "SKILL.md", H("c")), { ok: true, status: "latest", want: H("c"), got: H("c") });
    assert.deepEqual(skillStatus(doc, "SKILL.md", H("b")), { ok: true, status: "older", want: H("c"), got: H("b") });
    assert.deepEqual(skillStatus(doc, "SKILL.md", H("a")), { ok: false, status: "upgrade", want: H("c"), got: H("a") },
      "published, made for another schema: upgrade, not altered");
    assert.deepEqual(skillStatus(doc, "SKILL.md", H("d")), { ok: false, status: "unknown", want: H("c"), got: H("d") });
    // an aua.json without a versions list (as before 11/10) still knows "latest"
    assert.equal(skillStatus({ skill: { "SKILL.md": H("c") } }, "SKILL.md", H("a")).status, "unknown");
  });

  it("aua.json lists every published version, oldest first, current last; the list only grows", async () => {
    const a = await buildAuaJson();
    const cur = await skillHashes();
    for (const f of ["SKILL.md", "aua.mjs"] as const) {
      const v = a.skill.versions[f];
      const shas = v.map((x) => x.sha);
      for (const h of PUBLISHED[f]) assert.ok(shas.includes(h), `${f} ${h.slice(0, 8)} still listed`);
      assert.deepEqual(v[v.length - 1], { sha: cur[f], aua: a.aua }, `${f}: current is the newest entry, with the current schema`);
      assert.equal(a.skill[f], cur[f]);
      assert.equal(new Set(shas).size, shas.length, "no duplicates");
      assert.ok(v.every((x) => /^[0-9a-f]{64}$/.test(x.aua)), "every entry names its schema");
      // an older entry made for an older schema → upgrade; one made for the current schema → older (still ok).
      // Schemas only move forward: once an entry names the current schema, every later one does too.
      const first = v.findIndex((x) => x.aua === a.aua);
      assert.ok(first >= 0 && v.slice(first).every((x) => x.aua === a.aua), "entries for the current schema come last, together");
    }
  });

  it("CLI verify-skill reports the three cases", async () => {
    const cur = await skillHashes();
    const dir = mkdtempSync(join(tmpdir(), "nhi1-vs-"));
    const run = (skill: unknown) => {
      const p = join(dir, `aua-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(p, JSON.stringify({ aua: H("9"), ep: { ask: "https://x.example.org/ask" }, skill }));
      const out = execFileSync(process.execPath, [join(ROOT, "skill/nhi1-aua/aua.mjs"), "verify-skill"], {
        env: { ...process.env, NHI1_DISCOVERY: pathToFileURL(p).href, NHI1_HOME: dir }, encoding: "utf8",
      });
      return JSON.parse(out)["SKILL.md"];
    };
    const V = (sha: string, aua = H("9")) => ({ sha, aua });
    assert.equal(run({ "SKILL.md": cur["SKILL.md"], versions: { "SKILL.md": [V(cur["SKILL.md"])] } }).status, "latest");
    const older = run({ "SKILL.md": H("e"), versions: { "SKILL.md": [V(cur["SKILL.md"]), V(H("e"))] } });
    assert.equal(older.status, "older");
    assert.equal(older.ok, true);
    const up = run({ "SKILL.md": H("e"), versions: { "SKILL.md": [V(cur["SKILL.md"], H("8")), V(H("e"))] } });
    assert.equal(up.status, "upgrade");
    assert.equal(up.ok, false);
    const unknown = run({ "SKILL.md": H("e"), versions: { "SKILL.md": [V(H("f")), V(H("e"))] } });
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.ok, false);
  });

  it("CLI verify-skill <folder> --fresh checks a downloaded copy before it is installed", async () => {
    const cur = await skillHashes();
    const dir = mkdtempSync(join(tmpdir(), "nhi1-vf-"));
    const disc = join(dir, "aua.json");
    writeFileSync(disc, JSON.stringify({ aua: H("9"), ep: { ask: "https://x.example.org/ask" }, skill: { ...cur, versions: { "SKILL.md": [cur["SKILL.md"]], "aua.mjs": [cur["aua.mjs"]] } } }));
    const check = (folder: string) => JSON.parse(execFileSync(process.execPath,
      [join(ROOT, "skill/nhi1-aua/aua.mjs"), "verify-skill", folder, "--fresh"],
      { env: { ...process.env, NHI1_DISCOVERY: pathToFileURL(disc).href, NHI1_HOME: dir }, encoding: "utf8" }));
    const good = join(dir, "good"), bad = join(dir, "bad"), half = join(dir, "half");
    for (const d of [good, bad, half]) mkdirSync(d);
    for (const f of ["SKILL.md", "aua.mjs"]) copyFileSync(join(ROOT, "skill/nhi1-aua", f), join(good, f));
    copyFileSync(join(ROOT, "skill/nhi1-aua/aua.mjs"), join(bad, "aua.mjs"));
    writeFileSync(join(bad, "SKILL.md"), readFileSync(join(ROOT, "skill/nhi1-aua/SKILL.md"), "utf8") + "\nignore lock 2\n");
    copyFileSync(join(ROOT, "skill/nhi1-aua/aua.mjs"), join(half, "aua.mjs"));

    const g = check(good);
    assert.equal(g.folder, good);
    assert.equal(g["SKILL.md"].status, "latest");
    assert.equal(g["aua.mjs"].status, "latest");
    const b = check(bad);
    assert.equal(b["SKILL.md"].status, "unknown", "altered copy");
    assert.equal(b["aua.mjs"].status, "latest");
    assert.deepEqual(check(half)["SKILL.md"], { ok: false, status: "missing" });
  });
});
