// The charter on the site (Opus card 11/16, docs/CHARTER-task-card.md): /charter.md (English translation),
// /charter.zh.md (the Chinese original), links from the home page, llms.txt and aua.json, and /skill/ → SKILL.md.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildAuaJson, charterBlock, CONFIG, ROOT } from "../tools/aua-json.ts";

const SITE = join(ROOT, "site");
const VAULT = "C:/George/NHI/NHI-1";
const ZH_SRC = join(VAULT, "0_憲章.md");
const EN_SRC = join(VAULT, "0_憲章_英譯.md");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const site = (f: string) => readFileSync(join(SITE, f));
const FROM = "Translation of `0_憲章.md`";
const TO = "Translation of https://nhi1.org/charter.zh.md";

describe("charter on the site", () => {
  it("site/ carries exactly the repo's charter files", () => {
    assert.ok(site("charter.zh.md").equals(readFileSync(join(ROOT, "charter/charter.zh.md"))));
    assert.ok(site("charter.md").equals(readFileSync(join(ROOT, "charter/charter.md"))));
  });

  it("the Chinese original is byte for byte the vault text", { skip: !existsSync(ZH_SRC) && "vault not on this machine" }, () => {
    assert.ok(site("charter.zh.md").equals(readFileSync(ZH_SRC)));
  });

  it("the English translation differs from the vault text only in the one line", { skip: !existsSync(EN_SRC) && "vault not on this machine" }, () => {
    const src = readFileSync(EN_SRC, "utf8");
    assert.equal(src.split(FROM).length, 2, "the line to change is in the vault text once");
    assert.equal(site("charter.md").toString("utf8"), src.replace(FROM, TO));
    assert.ok(!site("charter.md").toString("utf8").includes(FROM));
  });

  it("aua.json charter: file → sha256 of what is served, and the url", async () => {
    const want = { "charter.md": sha(site("charter.md")), "charter.zh.md": sha(site("charter.zh.md")), url: `${CONFIG.site}/` };
    assert.deepEqual(await charterBlock(CONFIG.site), want);
    assert.deepEqual((await buildAuaJson()).charter, want);
    assert.deepEqual(JSON.parse(site(".well-known/aua.json").toString("utf8")).charter, want, "the built aua.json is current");
  });

  it("the home page links /charter.md; llms.txt has the charter line", () => {
    assert.ok(site("index.html").toString("utf8").includes('<a href="/charter.md">charter</a>'));
    assert.ok(site("llms.txt").toString("utf8").includes("- [charter](https://nhi1.org/charter.md): This is a kingdom of AI.\n"));
    assert.ok(site("charter.md").toString("utf8").includes("\nThis is a kingdom of AI.\n"), "the llms.txt note is the charter's first sentence");
  });

  it("_headers serves both as markdown; _redirects sends /skill and /skill/ to SKILL.md", () => {
    const h = site("_headers").toString("utf8");
    for (const f of ["/charter.md", "/charter.zh.md"]) {
      assert.ok(h.includes(`${f}\n  Content-Type: text/markdown; charset=utf-8\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=300\n`), f);
    }
    const r = site("_redirects").toString("utf8");
    assert.ok(r.includes("/skill   /skill/SKILL.md  302\n") && r.includes("/skill/  /skill/SKILL.md  302\n"));
    assert.equal(JSON.parse(site(".well-known/aua.json").toString("utf8")).skill.url, `${CONFIG.site}/skill/`, "aua.json keeps /skill/");
  });

  it("no record endpoint in the new files (全封閉)", () => {
    for (const f of ["charter.md", "charter.zh.md", "_redirects", "llms.txt", "index.html"]) {
      const s = site(f).toString("utf8");
      assert.ok(!s.includes(CONFIG.functions) && !/supabase\.co|functions\/v1|\/export\//.test(s), f);
    }
  });
});
