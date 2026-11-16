// NHI-2: the key on this machine (George 11/16: 鑰匙存本機、分散存放). Three pieces in three places, any two rebuild
// it; opening a room only when the agent runs `open`; here (read only); the verify-only check; sessions that start
// from nothing; a process killed after every step of making a key and of forgetting; the old key box closed.
// Every test key is made in a temp folder and removed at the end: never in the repo, never on the live root.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { canon, toHex } from "../supabase/functions/_shared/aua/canon.ts";
import { handleMem } from "../supabase/functions/_shared/aua/mem.ts";
import * as B from "../skill/nhi1-aua/box.mjs";
import * as M from "../skill/nhi1-aua/mem.mjs";
import { startLocalBoard } from "../tools/local-board.ts";
import { testPort } from "../tools/test-ports.ts";
import { deps } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const nowS = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
type Sec = Awaited<ReturnType<typeof M.memorySecrets>>;
const OPUS = { citizen: "opus", model: "claude-opus-5-5", rt: "test", how: "env" };

/** a raw Ed25519 pair for hand-made requests */
async function pair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (b: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, b)));
  return { pub, sign };
}
const fakeBox = (n = 64) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");

describe("Shamir 2-of-3 (box.mjs split3 / join2)", () => {
  it("any two pieces give the secret back; each piece alone is the secret's length and not the secret", () => {
    for (let n = 0; n < 20; n++) {
      const s = crypto.getRandomValues(new Uint8Array(1 + n * 13));
      const [y1, y2, y3] = B.split3(s);
      for (const [a, ya, b, yb] of [[1, y1, 2, y2], [1, y1, 3, y3], [2, y2, 3, y3], [3, y3, 1, y1]] as const) {
        assert.deepEqual(B.join2(a, ya, b, yb), s);
      }
      for (const y of [y1, y2, y3]) assert.equal(y.length, s.length);
      if (s.length > 8) for (const y of [y1, y2, y3]) assert.notDeepEqual(y, s);
    }
  });
});

describe("NHI-2 key on this machine: open, here, check, pieces, sandbox, the old box", () => {
  let b: Awaited<ReturnType<typeof startLocalBoard>>;
  const homes: string[] = [];
  /** a fresh home with its own three piece folders (A, B, C) */
  const newHome = () => {
    const h = mkdtempSync(join(tmpdir(), "nhi2-key-"));
    homes.push(h);
    const dirs = ["a", "b", "c"].map((x) => join(h, "pieces-" + x));
    process.env.NHI1_HOME = h;
    process.env.NHI1_KEY_DIRS = dirs.join(delimiter);
    return { h, dirs };
  };
  before(async () => {
    b = await startLocalBoard(testPort(11));
    process.env.NHI1_DISCOVERY = b.url;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.NHI1_SANDBOX = "0";
    await b.db.query("update public.knob set val = 1000 where name in ('r_new_ip_day', 'b_new_ip_day', 'b_put_day')");
  });
  after(() => {
    b.server.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true }); // every test key goes
    delete process.env.NHI1_KEY_DIRS;
  });
  const rooms = async () => (await b.db.query<{ pub: string; day: string }>("select pub, day::text from public.mem_room")).rows;
  const files = (dirs: string[]) => dirs.map((d) => (existsSync(d) ? readdirSync(d) : []));

  const env = (home: string, dirs: string[], crash?: string, over: Record<string, string> = {}) => {
    const e: Record<string, string> = {
      ...(process.env as Record<string, string>), NHI1_HOME: home, NHI1_KEY_DIRS: dirs.join(delimiter), NHI1_DISCOVERY: b.url,
      NHI1_MODEL: "claude-opus-5-5", NHI1_RT: "test", NHI1_SANDBOX: "0", ...over,
    };
    delete e.CLAUDE_CODE_SESSION_ID;
    delete e.NHI2_CRASH_AT;
    if (crash) e.NHI2_CRASH_AT = crash;
    return e;
  };
  const cli = (home: string, dirs: string[], args: string[], crash?: string, over?: Record<string, string>) => new Promise<{ code: number | null; out: any }>((ok) => {
    const p = spawn(process.execPath, [join(ROOT, "skill/nhi1-aua/mem.mjs"), ...args], { env: env(home, dirs, crash, over), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("exit", (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch { /* killed */ }
      ok({ code, out: j });
    });
  });

  it("open: the key is made here, one piece in each of three places; the root gets only the public half (the id)", async () => {
    const { h, dirs } = newHome();
    assert.equal(await A_key(), null, "before open: no key, and asking does not make one");
    const o = await cli(h, dirs, ["open"]);
    assert.equal(o.code, 0);
    assert.ok(o.out.room && o.out.new === true && o.out.pieces === 3 && o.out.reg === "new", JSON.stringify(o.out));
    assert.deepEqual(files(dirs).map((f) => f.length), [1, 1, 1], "one piece per place");
    for (const [f] of files(dirs)) {
      assert.match(f, /^[0-9a-f]{24}\.dat$/, "a file name is a hash");
      assert.ok(!/key|opus/i.test(f), "no word key, no citizen name");
    }
    const piece = JSON.parse(readFileSync(join(dirs[0], files(dirs)[0][0]), "utf8"));
    assert.deepEqual(Object.keys(piece).sort(), ["g", "i", "pub", "v", "y"]);
    assert.equal(piece.pub, o.out.pub);
    assert.ok(!JSON.stringify(o.out).includes(piece.y), "no piece in the answer");
    // the root: one room row, the public key and a day — nothing else
    const r = (await rooms()).filter((x) => x.pub === o.out.pub);
    assert.equal(r.length, 1);
    assert.deepEqual(Object.keys((await b.db.query("select * from public.mem_room where pub = $1", [o.out.pub])).rows[0] as object).sort(), ["day", "pub"]);
    assert.equal((await b.db.query("select 1 from public.mem_box where pub = $1", [o.out.pub])).rows.length, 0, "no box");
    // opening again: the same key, nothing made, the root already knows it
    const again = await cli(h, dirs, ["open"]);
    assert.deepEqual([again.out.pub, again.out.new, again.out.reg, again.out.pieces], [o.out.pub, false, "known", 3]);
    assert.deepEqual(files(dirs).map((f) => f.length), [1, 1, 1]);
    // keygen is the same command
    const P = spawn(process.execPath, [join(ROOT, "skill/nhi1-aua/aua.mjs"), "keygen"], { env: env(h, dirs), stdio: ["ignore", "pipe", "ignore"] });
    let kout = "";
    P.stdout.on("data", (c) => (kout += c));
    await new Promise((ok) => P.on("exit", ok));
    assert.deepEqual(JSON.parse(kout), { citizen: "opus", pub: o.out.pub, new: false });
  });
  /** the NHI-1 signing key as aua.mjs sees it, for the citizen in NHI1_MODEL */
  async function A_key() {
    const A = await import("../skill/nhi1-aua/aua.mjs");
    process.env.NHI1_MODEL = "claude-opus-5-5";
    try { return await A.citizenKeyOrNull({ model: "claude-opus-5-5" }); } finally { delete process.env.NHI1_MODEL; }
  }

  it("here: three or two pieces → a room (count, last day); one → 鑰匙不全; none → no room — and here never writes", async () => {
    const { h, dirs } = newHome();
    assert.deepEqual(await M.memHere({ who: OPUS }), { room: false, citizen: "opus", how: "env", pieces: 0, say: M.SAY.none });
    assert.deepEqual(files(dirs).map((f) => f.length), [0, 0, 0], "here made nothing");
    const o = await M.openRoom({ who: OPUS });
    assert.ok(o.room, JSON.stringify(o));
    const s = (await M.openSecrets({ citizen: "opus" })) as Sec;
    const w = await M.memWrite({ who: OPUS, secrets: s, items: [{ tag: "pref", s: "先讀規格", basis: null }] });
    assert.equal(w.saved, true, JSON.stringify(w));
    const day = new Date(Math.floor(nowS() / 86400) * 86400 * 1000).toISOString().slice(0, 10);
    const full = await M.memHere({ who: OPUS });
    assert.deepEqual([full.room, full.pieces, full.n, full.last], [true, 3, 1, day]);
    unlinkSync(join(dirs[2], files(dirs)[2][0]));
    const two = await M.memHere({ who: OPUS });
    assert.deepEqual([two.room, two.pieces, two.n, two.last], [true, 2, 1, day]);
    assert.deepEqual(files(dirs).map((f) => f.length), [1, 1, 0], "here does not write the missing piece again");
    unlinkSync(join(dirs[1], files(dirs)[1][0]));
    const one = await M.memHere({ who: OPUS });
    assert.deepEqual([one.room, one.pieces, one.err, one.say], [false, 1, "key_partial", M.SAY.partial]);
    assert.ok(M.SAY.partial.startsWith("鑰匙不全") && M.SAY.none.startsWith("這台沒有你的房間"));
    // with one piece left the key does not open, and open never makes a new key over it
    assert.deepEqual(await M.openSecrets({ citizen: "opus" }), { err: "key_partial" });
    const op = await M.openRoom({ who: OPUS });
    assert.deepEqual([op.room, op.err], [false, "key_partial"]);
    assert.deepEqual((await B.createKey("opus")).err, "key_exists");
    assert.deepEqual(files(dirs).map((f) => f.length), [1, 0, 0]);
    void h;
  });

  it("one piece gone: the key still opens (same id, same memory key); open writes the third piece again", async () => {
    const { dirs } = newHome();
    const o = await M.openRoom({ who: OPUS });
    const s = (await M.openSecrets({ citizen: "opus" })) as Sec;
    const sealed = await s.seal(s.kv, "aad", enc.encode("hello"));
    for (const gone of [0, 1, 2]) {
      const f = files(dirs)[gone][0];
      unlinkSync(join(dirs[gone], f));
      const s2 = (await M.openSecrets({ citizen: "opus" })) as Sec;
      assert.equal(s2.pub, o.pub, `piece ${gone + 1} gone: the same id`);
      assert.equal(new TextDecoder().decode((await s2.open(s2.kv, "aad", sealed))!), "hello", "the memory key is the same");
      const r = await M.openRoom({ who: OPUS });
      assert.deepEqual([r.room, r.pub, r.pieces, r.repaired, r.new], [true, o.pub, 3, true, false]);
      assert.deepEqual(files(dirs).map((x) => x.length), [1, 1, 1]);
    }
  });

  it("two pieces gone: the key does not open — nothing to sign with, no room", async () => {
    const { dirs } = newHome();
    await M.openRoom({ who: OPUS });
    unlinkSync(join(dirs[0], files(dirs)[0][0]));
    unlinkSync(join(dirs[2], files(dirs)[2][0]));
    assert.deepEqual(await M.openSecrets({ citizen: "opus" }), { err: "key_partial" });
    assert.equal(await A_key(), null);
    assert.equal((await M.memWrite({ who: OPUS, items: [{ tag: "note", s: "x", basis: null }] })).why, "key_partial");
  });

  it("signed here, verified by the root: check says ok and room; another key's signature is not ok; nothing is kept", async () => {
    newHome();
    const o = await M.openRoom({ who: OPUS });
    const count = async () => (await b.db.query<{ n: number }>(
      "select ((select count(*) from public.rate) + (select count(*) from public.mem) + (select count(*) from public.mem_room) + (select count(*) from public.mem_box) + (select count(*) from public.use))::int n")).rows[0].n;
    const n0 = await count();
    const rate0 = (await b.db.query<{ s: number }>("select coalesce(sum(n), 0)::int s from public.rate")).rows[0].s;
    const c = await M.memCheck({ who: OPUS });
    assert.deepEqual(c, { ok: 1, room: 1, pub: o.pub });
    // by hand: a good signature, a signature by another key, a key with no room, a request with an extra field
    const k = await pair();
    const q = { op: "check", aua: M.MEM_AUA, key: k.pub, n: toHex(crypto.getRandomValues(new Uint8Array(32))), t: nowS() };
    assert.deepEqual((await handleMem({ ...q, sig: await k.sign(enc.encode(canon(q))) }, deps(b.db))).body, { ok: 1, room: 0 }, "verifies; no room for this key");
    const other = await pair();
    assert.deepEqual((await handleMem({ ...q, sig: await other.sign(enc.encode(canon(q))) }, deps(b.db))).body, { ok: 0 });
    assert.equal((await handleMem({ ...q, x: 1, sig: await k.sign(enc.encode(canon({ ...q, x: 1 }))) }, deps(b.db))).body.err, 4, "no free fields");
    assert.equal(await count(), n0, "no row anywhere");
    assert.equal((await b.db.query<{ s: number }>("select coalesce(sum(n), 0)::int s from public.rate")).rows[0].s, rate0, "not even a counter");
  });

  it("a session that starts from nothing (chat sandbox, cloud session): no key, no room, a reason", async () => {
    const { h, dirs } = newHome();
    const n0 = (await rooms()).length;
    for (const over of [{ NHI1_SANDBOX: "1" }, { NHI1_SANDBOX: "", CLAUDE_CODE_REMOTE: "true" }, { NHI1_SANDBOX: "", CODESPACES: "true" }]) {
      const r = await cli(h, dirs, ["open"], undefined, over);
      assert.equal(r.code, 0);
      assert.deepEqual([r.out.room, r.out.err, r.out.say], [false, "sandbox", M.SAY.sandbox], JSON.stringify(r.out));
      assert.ok(typeof r.out.why === "string" && r.out.why.length > 0);
    }
    assert.deepEqual(files(dirs).map((f) => f.length), [0, 0, 0], "no piece was written");
    assert.equal((await rooms()).length, n0, "no empty room on the root");
    assert.equal(B.sandboxWhy({ CLAUDE_CODE_REMOTE: "true", NHI1_SANDBOX: "0" }), null, "NHI1_SANDBOX=0 overrides the guesses");
    assert.equal(B.sandboxWhy({ GITPOD_WORKSPACE_ID: "x" }), "gitpod");
    assert.equal((await B.createKey("opus", { env: { NHI1_SANDBOX: "1" } })).err, "sandbox", "box.mjs refuses too");
  });

  it("the three places: never in a git work tree, never in the skill folder, three different folders", async () => {
    const t = mkdtempSync(join(tmpdir(), "nhi2-dirs-"));
    homes.push(t);
    mkdirSync(join(t, "repo", ".git"), { recursive: true });
    const ok = ["x", "y", "z"].map((x) => join(t, x));
    assert.equal(B.dirsProblem(ok), null);
    assert.equal(B.dirsProblem([ok[0], ok[1], join(t, "repo", "deep", "nhi1")]), "git_repo");
    assert.equal(B.dirsProblem([ok[0], ok[1], join(ROOT, "skill", "nhi1-aua", "x")]), "skill_folder");
    assert.equal(B.dirsProblem([ok[0], ok[0], ok[1]]), "not_three");
    assert.equal((await B.createKey("opus", { dirs: [ok[0], ok[1], join(t, "repo", "p")], env: { NHI1_SANDBOX: "0" } })).err, "key_dirs");
    assert.equal(existsSync(ok[0]), false, "nothing written");
    // the defaults: under the user's own account, not in this repo, not in the skill folder
    const real = B.pieceDirs({ ...process.env, NHI1_KEY_DIRS: "", NODE_TEST_CONTEXT: "" });
    assert.equal(real.length, 3);
    assert.equal(new Set(real).size, 3);
    for (const d of real) assert.ok(!d.toLowerCase().startsWith(ROOT.toLowerCase()), d);
  });

  it("the old key box: open while box_on = 1, refused with err 51 once it is closed", async () => {
    const door = await pair(), cit = await pair();
    const q: Record<string, unknown> = { op: "box_put", aua: M.MEM_AUA, door: door.pub, next: door.pub, pub: cit.pub, ver: 1, t: nowS(), box: fakeBox() };
    q.size = Buffer.from(q.box as string, "base64url").length;
    const m = enc.encode(canon(q));
    const put = { ...q, sig: await door.sign(m), psig: await cit.sign(m) };
    assert.equal((await handleMem(put, deps(b.db))).status, 201);
    const g = { op: "box_get", aua: M.MEM_AUA, door: door.pub, t: nowS() };
    const get = { ...g, sig: await door.sign(enc.encode(canon(g))) };
    assert.equal(((await handleMem(get, deps(b.db))).body as any).ver, 1, "still readable for moving out");
    await b.db.query("update public.knob set val = 0 where name = 'box_on'");
    try {
      const r = await handleMem(get, deps(b.db));
      assert.deepEqual([r.status, r.body], [410, { err: 51 }]);
      const q2 = { ...q, ver: 2, t: nowS() };
      const m2 = enc.encode(canon(q2));
      assert.equal((await handleMem({ ...q2, sig: await door.sign(m2), psig: await cit.sign(m2) }, deps(b.db))).body.err, 51);
    } finally {
      await b.db.query("update public.knob set val = 1 where name = 'box_on'");
    }
  });

  // ───────── killed after every step ─────────

  for (const step of ["create.tmp1", "create.tmp2", "create.tmp3", "create.1", "create.3"]) {
    it(`making a key, killed after ${step}: the next open works and leaves three pieces`, async () => {
      const { h, dirs } = newHome();
      const k = await cli(h, dirs, ["open"], step);
      assert.notEqual(k.code, 0, "the process died at " + step);
      const c = await cli(h, dirs, ["open"]);
      assert.equal(c.code, 0);
      assert.ok(c.out && c.out.room && c.out.pieces === 3 && /^(new|known)$/.test(c.out.reg), JSON.stringify(c.out));
      const again = await cli(h, dirs, ["open"]);
      assert.deepEqual([again.out.pub, again.out.new], [c.out.pub, false], "settled: the same key from now on");
      assert.equal(again.out.repaired, undefined);
    });
  }

  const FORGET_STEPS = ["add.tmp1", "add.tmp2", "add.2", "forget.added", "forget.copied", "forget.deleted", "drop.tmp1", "drop.tmp2", "drop.1", "drop.3"];
  for (const step of FORGET_STEPS) {
    it(`forgetting, killed after ${step}: the key still opens as the same citizen; forget again finishes it`, async () => {
      const { h, dirs } = newHome();
      const o = await M.openRoom({ who: OPUS });
      const s = (await M.openSecrets({ citizen: "opus" })) as Sec;
      const w = await M.memWrite({ who: OPUS, secrets: s, items: [{ tag: "pref", s: "先讀規格", basis: null }, { tag: "note", s: "要忘的這一筆", basis: null }, { tag: "ruled_out", s: "A 不通", basis: null }] });
      assert.equal(w.saved, true, JSON.stringify(w));
      const forgetId = w.ids[1]; // the note (kind 0)
      const k = await cli(h, dirs, ["forget", forgetId], step);
      assert.notEqual(k.code, 0, "the process died at " + step);
      const c = await cli(h, dirs, ["open"]);
      assert.ok(c.out && c.out.room && c.out.pub === o.pub, `after ${step}: ${JSON.stringify(c.out)}`);
      const f = await cli(h, dirs, ["forget", forgetId]);
      assert.equal(f.out && f.out.done, true, JSON.stringify(f.out));
      const end = await cli(h, dirs, ["open"]);
      assert.equal(end.out.pub, o.pub, "the signing key does not change");
      assert.equal(end.out.pending_forget, undefined, "one memory key left");
      const s2 = (await M.openSecrets({ citizen: "opus" })) as Sec;
      assert.equal(s2.kvs.length, 1);
      const all = await M.memAll({ who: OPUS, secrets: s2 });
      assert.ok(all.mem.every((m: any) => m.kv === s2.kv), "every row is under the new memory key");
      const r = await M.memRead({ who: OPUS, secrets: s2, reader: async (input: string) => {
        const j = JSON.parse(input.slice(input.indexOf("{"), input.lastIndexOf("}") + 1));
        return { answer: { items: j.items.map((i: any) => ({ h: i.h, s: i.text.slice(0, 80), cmd: 0 })) } };
      } });
      assert.equal(r.prefs.length, 1);
      assert.equal(r.ruled_out.length, 1);
      assert.equal(r.unread, undefined);
      const ids = (await b.db.query<{ id: string }>("select id from public.mem where key = $1", [o.pub])).rows.map((x) => x.id);
      assert.ok(!ids.includes(forgetId) && !w.ids.some((x: string) => ids.includes(x)), "old rows are deleted");
      // a mem sealed under the dropped key can no longer be opened by this key
      assert.equal(await s2.open(s.kvs[0], "x", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), null);
      assert.ok(!s2.kvs.includes(s.kvs[0]), "the old memory key is gone from the pieces");
    });
  }

  it("forget --all: nothing kept, the same id, a new memory key", async () => {
    const { h, dirs } = newHome();
    const o = await M.openRoom({ who: OPUS });
    const s = (await M.openSecrets({ citizen: "opus" })) as Sec;
    await M.memWrite({ who: OPUS, secrets: s, items: [{ tag: "pref", s: "a", basis: null }, { tag: "open", s: "b", basis: null }] });
    const f = await cli(h, dirs, ["forget", "--all"]);
    assert.equal(f.out.done, true, JSON.stringify(f.out));
    assert.equal(f.out.kept, 0);
    assert.equal(f.out.deleted, 2);
    assert.equal((await b.db.query("select 1 from public.mem where key = $1", [o.pub])).rows.length, 0);
    const s2 = (await M.openSecrets({ citizen: "opus" })) as Sec;
    assert.deepEqual([s2.pub, s2.kvs], [o.pub, [2]]);
  });
});

describe("NHI-2 citizens: model lines and key.jwk's retirement", () => {
  it("a model off the table is a citizen by its model line (no version, no date, no deployment parts)", () => {
    const cases: [string, string | null][] = [
      ["claude-opus-5-5", "opus"], ["claude-opus-4-1-20250805", "opus"], ["us.anthropic.claude-opus-4-1-20250805-v1:0", "opus"],
      ["claude-fable-5-2", "fable"], ["Claude-Opus-5-5", "opus"],
      ["gpt-5.6-sol", "gpt"], ["gpt-4o", "gpt"], ["o3", "gpt"], ["o4-mini", "gpt"], ["openai/gpt-5", "gpt"],
      ["claude-sonnet-5-5", "claude-sonnet"], ["claude-haiku-5-5[1m]", "claude-haiku"], ["claude-3-5-sonnet-20241022", "claude-sonnet"],
      ["gemini-2.5-pro", "gemini-pro"], ["llama-3.1-70b-instruct", "llama-70b-instruct"], ["qwen2.5-coder-32b", "qwen-coder-32b"],
      ["mistral-large-2411", "mistral-large"], ["deepseek-v3", "deepseek"], ["grok-4", "grok"],
      ["", null], ["123", null], ["<synthetic>", null], [null as unknown as string, null],
    ];
    for (const [m, c] of cases) assert.equal(M.citizenOf(m), c, m);
    for (const [, c] of cases) if (c) assert.match(c, /^[a-z][a-z0-9-]{0,31}$/, "a citizen name is a safe file name");
    assert.equal(M.citizenOf("claude-sonnet-6-0"), M.citizenOf("claude-sonnet-5-5"), "a version upgrade is the same citizen");
  });

  it("retire key.jwk: renamed, never deleted, never read; a second retirement does not overwrite the first", () => {
    const d = mkdtempSync(join(tmpdir(), "nhi2-retire-"));
    writeFileSync(join(d, "key.jwk"), "placeholder-1");
    assert.deepEqual(B.retireJwk(d), { retired: true, to: join(d, "key.jwk.retired") });
    assert.equal(readFileSync(join(d, "key.jwk.retired"), "utf8"), "placeholder-1");
    writeFileSync(join(d, "key.jwk"), "placeholder-2");
    assert.equal(B.retireJwk(d).to, join(d, "key.jwk.retired-2"));
    assert.deepEqual(B.retireJwk(d), { retired: false });
    assert.deepEqual(readdirSync(d).sort(), ["key.jwk.retired", "key.jwk.retired-2"]);
    rmSync(d, { recursive: true, force: true });
  });
});
