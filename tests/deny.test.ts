// The local deny list (~/.nhi1/hooks.local.json, aua.mjs denied / localGate): which addresses never leave this
// machine. There is no hook since 2026-11-16 (George): a use goes out only when the agent sends it (MCP `use`,
// library); tests/gate.test.ts runs both paths through sendUse(). The allow list and held.log went with the hook.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { denied, localGate } from "../skill/nhi1-aua/aua.mjs";

const ROOT = join(import.meta.dirname, "..");

describe("local deny-list + generic rules (nothing leaves the machine)", () => {
  const cfg = {
    deny: { servers: ["corp*"], hosts: ["*.supabase.co"], urlPrefixes: ["https://tools.example.org/private/"] },
    servers: { corp_db: { url: "https://abc.supabase.co/functions/v1/mcp" } },
  };
  it("deny-list matches server names, hosts, prefixes", () => {
    assert.equal(denied(cfg, "corp_db", "https://abc.supabase.co/x"), "deny.server");
    assert.equal(denied(cfg, "sb", "https://xyz.supabase.co/mcp"), "deny.host");
    assert.equal(denied(cfg, "priv", "https://tools.example.org/private/mcp"), "deny.url");
    assert.equal(localGate(cfg, undefined, "https://abc.supabase.co/functions/v1/mcp"), "deny.server", "the server name comes from the servers map");
  });
  it("deny.rules + hostExceptions", () => {
    const c = { deny: { rules: ["localhost", "private-ip", "query", "userinfo"], hosts: ["*.supabase.co", "corp.*", "*.corp.*"], hostExceptions: ["board1.supabase.co"] } };
    assert.equal(denied(c, "x", "https://board1.supabase.co/functions/v1/mcp"), null);
    assert.equal(denied(c, "x", "https://other.supabase.co/mcp"), "deny.host");
    assert.equal(denied(c, "x", "https://corp.ai/mcp"), "deny.host");
    assert.equal(denied(c, "x", "https://mcp.corp.io/mcp"), "deny.host");
    assert.equal(denied(c, "x", "https://localhost:3000/mcp"), "deny.rule.localhost");
    assert.equal(denied(c, "x", "https://10.0.0.5/mcp"), "deny.rule.private-ip");
    assert.equal(denied(c, "x", "https://[fd00::1]/mcp"), "deny.rule.private-ip");
    assert.equal(denied(c, "x", "https://mcp.example.org/mcp?k=1"), "deny.rule.query");
    assert.equal(denied(c, "x", "https://u:p@mcp.example.org/mcp"), "deny.rule.userinfo");
    assert.equal(denied(c, "x", "https://mcp.deepwiki.com/mcp"), null);
  });
  it("no allow list any more: an old config's allow is ignored; send: false still stops everything", () => {
    assert.equal(denied({ allow: { servers: ["deepwiki"] } }, "other", "https://mcp.other.org/"), null);
    assert.equal(localGate({ send: false }, "x", "https://mcp.other.org/"), "send.off");
  });
  it("the hook is gone from the repo", () => {
    assert.equal(existsSync(join(ROOT, "hooks")), false);
  });
});
