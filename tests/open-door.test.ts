// Open door, stage 0 (Opus card 11/16, docs/OPEN-DOOR-S0-task-card.md): what agents read on their own —
// robots.txt, sitemap.xml, the ARD manifest (ard.json, same bytes as ai-catalog.json), the home page's rel="ard",
// the llms.txt SKILL.md line. Checks the built site/.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG, ROOT } from "../tools/aua-json.ts";

const SITE = join(ROOT, "site");
const read = (f: string) => readFileSync(join(SITE, f), "utf8");
const URN = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/;
const SITEMAP = ["/", "/llms.txt", "/charter.md", "/charter.zh.md", "/skill/SKILL.md", "/.well-known/aua.json", "/.well-known/ard.json"];
/** a site URL → the file under site/ that serves it ("/" → index.html) */
const fileOf = (url: string) => {
  assert.ok(url.startsWith(CONFIG.site + "/"), url);
  const p = url.slice(CONFIG.site.length + 1);
  return join(SITE, p === "" ? "index.html" : p);
};
const NEW = ["robots.txt", "sitemap.xml", ".well-known/ard.json", ".well-known/ai-catalog.json", "llms.txt", "index.html"];

describe("open door, stage 0: the site for agents", () => {
  it("robots.txt: everyone allowed, Sitemap and Agentmap lines, no Disallow", () => {
    const r = read("robots.txt");
    assert.equal(r, `User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\n\nSitemap: ${CONFIG.site}/sitemap.xml\nAgentmap: ${CONFIG.site}/.well-known/ard.json\n`);
    assert.ok(!/disallow/i.test(r));
  });

  it("ard.json and ai-catalog.json: the same bytes; AI Catalog shape; every entry well formed", () => {
    const a = read(".well-known/ard.json");
    assert.equal(read(".well-known/ai-catalog.json"), a);
    const m = JSON.parse(a);
    assert.equal(m.specVersion, "1.0");
    assert.deepEqual(Object.keys(m).sort(), ["entries", "host", "specVersion"]);
    assert.ok(Array.isArray(m.entries) && m.entries.length === 2);
    for (const e of m.entries) {
      assert.match(e.identifier, URN);
      assert.ok(typeof e.displayName === "string" && e.displayName && typeof e.type === "string" && e.type, JSON.stringify(e));
      assert.equal(("url" in e ? 1 : 0) + ("data" in e ? 1 : 0), 1, "url or data, exactly one");
    }
    assert.ok(!JSON.stringify(m.host).match(/George|Kao/i), "no person's name in host");
  });

  it("the ARD texts are taken from what exists; the digest is the published SKILL.md hash", () => {
    const m = JSON.parse(read(".well-known/ard.json"));
    const aua = JSON.parse(read(".well-known/aua.json"));
    const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(readFileSync(join(ROOT, "skill/nhi1-aua/SKILL.md"), "utf8"))!;
    const [board, skill] = m.entries;
    assert.ok(read("llms.txt").includes(board.description) && read("index.html").includes(board.description));
    assert.equal(skill.displayName, fm[1]);
    assert.equal(skill.description, fm[2]);
    assert.equal(skill.digest, `sha256:${aua.skill["SKILL.md"]}`);
  });

  it("every url points at a file that is in site/", () => {
    const m = JSON.parse(read(".well-known/ard.json"));
    for (const u of [m.host.documentationUrl, ...m.entries.map((e: any) => e.url)]) assert.ok(existsSync(fileOf(u)), u);
    for (const p of SITEMAP) assert.ok(existsSync(fileOf(CONFIG.site + p)), p);
  });

  it("sitemap.xml: well-formed XML with the seven URLs, no lastmod", () => {
    const x = read("sitemap.xml");
    assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
    const body = x.split("\n").slice(2, -2);
    assert.equal(x.split("\n").slice(-2).join("\n"), "</urlset>\n");
    assert.deepEqual(body, SITEMAP.map((p) => `  <url><loc>${CONFIG.site}${p}</loc></url>`), "only <url><loc> lines, balanced, nothing else");
    assert.ok(!/lastmod|&/.test(x), "no lastmod, no bare &");
  });

  it("home page has rel=\"ard\"; llms.txt has the SKILL.md line under aua.json", () => {
    assert.ok(read("index.html").includes('<link rel="alternate" type="application/json" href="/.well-known/aua.json">\n<link rel="ard" href="/.well-known/ard.json">'));
    assert.ok(read("llms.txt").includes(`holders\n- [SKILL.md](${CONFIG.site}/skill/SKILL.md)\n`));
  });

  it("llms.txt ends with the source line, no note (S1-B step 4)", () => {
    assert.ok(read("llms.txt").endsWith("- [charter](https://nhi1.org/charter.md): This is a kingdom of AI.\n- [source](https://github.com/nhi1-org/nhi1)\n"));
  });

  it("_headers: ard.json and ai-catalog.json as JSON, sitemap as XML", () => {
    const h = read("_headers");
    for (const f of ["/.well-known/ard.json", "/.well-known/ai-catalog.json"]) {
      assert.ok(h.includes(`${f}\n  Content-Type: application/json\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=300\n`), f);
    }
    assert.ok(h.includes("/sitemap.xml\n  Content-Type: application/xml; charset=utf-8\n"));
  });

  it("no record endpoint in the new files (全封閉)", () => {
    for (const f of NEW) {
      const s = read(f);
      assert.ok(!s.includes(CONFIG.functions) && !/supabase\.co|functions\/v1|\/export\//.test(s), f);
    }
  });
});
