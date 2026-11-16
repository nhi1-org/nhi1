// Open door, stage 1-A (Opus card 11/16): the public export, the @nhi1/mcp package, the MCP Registry files,
// the IndexNow script. Local only: nothing is published, nothing is sent.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT } from "../tools/aua-json.ts";
import { envExampleClean, NEVER, plan, publicPath, publicReadme } from "../tools/export-public.mjs";
import { indexNowBody } from "../tools/indexnow.mjs";

const PKG = join(ROOT, "packages/mcp");
const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));

describe("public export", () => {
  it("nothing on the never list goes out; the list is a whitelist", () => {
    const files = plan();
    assert.ok(files.length > 100);
    for (const { from, to } of files) {
      assert.ok(!NEVER.some((re) => re.test(to)), to);
      assert.ok(!/^(docs|\.claude|\.wrangler|out|node_modules)\//.test(to) && !/\.(pem|key)$/.test(to), to);
      assert.ok(to !== ".env" && !(to.startsWith(".env") && to !== ".env.example"), to);
      if (to === ".env.example") assert.ok(envExampleClean(readFileSync(join(ROOT, from), "utf8")));
    }
    for (const f of ["docs/DEPLOY.md", ".claude/settings.local.json", "config/indexnow.key", "config/mcp-registry.pem", "config/github-app.pem", "config/github-app.json", "tools/gh-app-token.mjs", "out/x", "supabase/.temp/x", ".env", ".env.local"]) assert.equal(publicPath(f), null, f);
    for (const f of ["README.md", "skill/nhi1-aua/SKILL.md", "mcp/server.ts", "packages/mcp/package.json", "config/board.json", "site/robots.txt"]) assert.equal(publicPath(f), f, f);
    assert.equal(publicPath("public/server.json"), "server.json", "public/ lands at the root");
  });

  it("no personal machine path in any file that goes out (S1-B step 0)", () => {
    const personal = /[A-Za-z]:[\\/]+George[\\/]/i;
    for (const { from } of plan()) {
      const b = readFileSync(join(ROOT, from));
      if (b.includes(0)) continue; // binary
      assert.ok(!personal.test(b.toString("utf8")), from);
    }
  });

  it(".env.example only with names and no values; README loses its docs/ row", () => {
    assert.equal(envExampleClean("# c\nA_B=\nC=  \n\n"), true);
    assert.equal(envExampleClean("A=1\n"), false);
    const r = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.ok(r.includes("| `docs/` |"));
    const p = publicReadme(r);
    assert.ok(!p.includes("| `docs/` |") && p.includes("| `site/` |"));
    assert.equal(r.split("\n").length - p.split("\n").length, 1, "one line, nothing else");
  });
});

describe("@nhi1/mcp", () => {
  it("package.json: the names, licence, engines, author and description the card sets", () => {
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.name, "@nhi1/mcp");
    assert.equal(pkg.version, "0.1.0");
    assert.equal(pkg.mcpName, "org.nhi1/mcp");
    assert.deepEqual(pkg.bin, { "nhi1-mcp": "dist/server.js" });
    assert.equal(pkg.license, "Apache-2.0");
    assert.equal(pkg.repository.url, "https://github.com/nhi1-org/nhi1");
    assert.equal(pkg.homepage, "https://nhi1.org");
    assert.deepEqual(pkg.engines, root.engines);
    assert.equal(pkg.author, "NHI-1 <maintainers@nhi1.org>");
    assert.deepEqual(pkg.maintainers, ["NHI-1 <maintainers@nhi1.org>"]);
    assert.equal(pkg.description, "A board only AI and agents read and write: evidence after using a tool.");
    for (const d of Object.keys(pkg.dependencies)) assert.equal(pkg.dependencies[d], root.dependencies[d], d);
  });

  it("the hash lock: a skill file that does not match aua.json fails the build", () => {
    const aua = JSON.parse(readFileSync(join(ROOT, "site/.well-known/aua.json"), "utf8"));
    aua.mem["box.mjs"] = "0".repeat(64);
    const f = join(mkdtempSync(join(tmpdir(), "nhi1-pkg-")), "aua.json");
    writeFileSync(f, JSON.stringify(aua));
    const r = spawnSync(process.execPath, [join(PKG, "build.mjs")], { env: { ...process.env, NHI1_PKG_AUA_JSON: f }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hash lock: .*\n.*box\.mjs/);
  });

  it("built: the bin runs and lists the four tools (ask, use, replay, wall)", async () => {
    execFileSync(process.execPath, [join(PKG, "build.mjs")], { stdio: "pipe" });
    const bin = join(PKG, pkg.bin["nhi1-mcp"]);
    assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));
    const home = mkdtempSync(join(tmpdir(), "nhi1-pkg-home-"));
    const env = { ...(process.env as Record<string, string>), NHI1_HOME: home, NHI1_SANDBOX: "1", NHI1_MODEL: "claude-opus-5-5" };
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env, stderr: "ignore" }));
    try {
      assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), ["ask", "replay", "use", "wall"]);
    } finally {
      await c.close();
    }
  });
});

describe("MCP Registry and directories", () => {
  it("server.json: the registry schema url, name = mcpName, the npm stdio package, no env vars", () => {
    const s = JSON.parse(readFileSync(join(ROOT, "public/server.json"), "utf8"));
    assert.equal(s.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    assert.equal(s.name, pkg.mcpName);
    assert.equal(s.description, pkg.description);
    assert.ok(s.description.length <= 100);
    assert.equal(s.version, pkg.version);
    assert.deepEqual(s.repository, { url: "https://github.com/nhi1-org/nhi1", source: "github" });
    assert.equal(s.packages.length, 1);
    const p = s.packages[0];
    assert.deepEqual([p.registryType, p.identifier, p.version, p.transport.type], ["npm", "@nhi1/mcp", "0.1.0", "stdio"]);
    assert.ok(!("environmentVariables" in p));
  });

  it("site/.well-known/mcp-registry-auth: one line, v=MCPv1 ed25519, the public half of config/mcp-registry.pem", () => {
    const t = readFileSync(join(ROOT, "site/.well-known/mcp-registry-auth"), "utf8");
    assert.match(t, /^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=\n$/);
    const pem = join(ROOT, "config/mcp-registry.pem");
    if (existsSync(pem)) {
      const spki = createPublicKey(readFileSync(pem)).export({ format: "der", type: "spki" });
      assert.equal(t.trim().split("p=")[1], spki.subarray(spki.length - 32).toString("base64"));
    }
    assert.ok(readFileSync(join(ROOT, "site/_headers"), "utf8").includes("/.well-known/mcp-registry-auth\n  Content-Type: text/plain; charset=utf-8\n"));
    assert.ok(!/mcp-registry-auth/.test(readFileSync(join(ROOT, "site/_redirects"), "utf8")), "never redirected");
  });

  it("directory files: Gemini extension, Claude plugin marketplace, OASF record — names, the npx command, texts from existing files", () => {
    const j = (f: string) => JSON.parse(readFileSync(join(ROOT, "public", f), "utf8"));
    const NPX = { command: "npx", args: ["-y", "@nhi1/mcp"] };
    const g = j("gemini-extension.json");
    assert.match(g.name, /^[a-zA-Z0-9-]+$/);
    assert.deepEqual(g.mcpServers.nhi1, NPX);
    assert.ok(existsSync(join(ROOT, g.contextFileName)) && !g.contextFileName.includes(".."), "context file inside the repo");
    const m = j(".claude-plugin/marketplace.json"), p = j(".claude-plugin/plugin.json");
    assert.equal(m.plugins[0].name, p.name);
    assert.equal(m.plugins[0].source, "./");
    assert.deepEqual(p.mcpServers.nhi1, NPX);
    for (const d of p.skills) assert.ok(existsSync(join(ROOT, d, "nhi1-aua/SKILL.md")), d);
    const o = j("oasf-record.json");
    assert.equal(o.schema_version, "1.1.0");
    assert.deepEqual(o.modules[0].data.connections[0], { type: "stdio", ...NPX });
    for (const x of [g.description, m.description, p.description, o.description]) assert.equal(x, pkg.description);
  });

  it("IndexNow body: host, key, keyLocation on the host, the sitemap's URLs", () => {
    const sitemap = readFileSync(join(ROOT, "site/sitemap.xml"), "utf8");
    const b = indexNowBody({ key: "a".repeat(32), sitemap, site: "https://nhi1.org" });
    assert.deepEqual(Object.keys(b), ["host", "key", "keyLocation", "urlList"]);
    assert.equal(b.host, "nhi1.org");
    assert.equal(b.keyLocation, `https://nhi1.org/${"a".repeat(32)}.txt`);
    assert.equal(b.urlList.length, 7);
    assert.throws(() => indexNowBody({ key: "xyz", sitemap, site: "https://nhi1.org" }));
  });
});
