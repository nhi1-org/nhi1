// Holder keys: made and used only by the holder, in their own terminal; the private half is on disk
// only encrypted with their password, and never printed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateKey } from "../skill/nhi1-aua/aua.mjs";
import { seal, unseal } from "../tools/holder-crypto.mjs";

const ROOT = join(import.meta.dirname, "..");
const PW = "correct horse battery staple";

describe("holder keys (encrypted at rest, terminal only)", () => {
  it("sealed file holds no private key in clear; right password opens it, wrong one does not", async () => {
    const k = await generateKey();
    const sealed = seal(k, PW, "active");
    const text = JSON.stringify(sealed);
    assert.equal(sealed.pub, k.pub);
    assert.ok(!text.includes((k.jwk as { d: string }).d), "private scalar not in the file");
    assert.ok(!/"d"\s*:/.test(text), "no JWK private field in the file");
    const back = unseal(JSON.parse(text), PW);
    assert.deepEqual(back.jwk, k.jwk);
    assert.throws(() => unseal(sealed, PW + "x"), /wrong password/);
    const tampered = { ...sealed, pub: (await generateKey()).pub };
    assert.throws(() => unseal(tampered, PW), /wrong password|does not match/);
    assert.throws(() => seal(k, "short", "active"), /at least 12/);
  });

  it("keygen and the holder tool refuse to run without a terminal; nothing is written", () => {
    const home = mkdtempSync(join(tmpdir(), "nhi1-holder-"));
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const kg = spawnSync(process.execPath, [join(ROOT, "tools/holder-keygen.mjs"), "active"], { env, input: `${PW}\n${PW}\n`, encoding: "utf8" });
    assert.notEqual(kg.status, 0);
    assert.match(kg.stderr, /PowerShell window/);
    assert.equal(existsSync(join(home, ".nhi1", "holders")), false, "no key file made");
    const disc = join(home, "aua.json");
    writeFileSync(disc, JSON.stringify({ aua: "9".repeat(64), ep: { ask: "https://x.example.org/ask" } }));
    const ht = spawnSync(process.execPath, [join(ROOT, "tools/holder.mjs"), "view", "use"], { env: { ...env, NHI1_DISCOVERY: "file:///" + disc.replace(/\\/g, "/") }, input: `${PW}\n`, encoding: "utf8" });
    assert.notEqual(ht.status, 0);
    assert.match(ht.stderr, /terminal/);
  });

  it("bad role is refused before anything happens", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "tools/holder-keygen.mjs"), "boss"], { encoding: "utf8" });
    assert.equal(r.status, 2);
  });
});
