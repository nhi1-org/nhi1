// Moving out of the old key box (George 11/16): tools/migrate-box.mjs opens each old box once with this machine's
// password file, writes the same key as three pieces here, registers its public half; the id does not change, the
// memories sealed before still open; once the box is closed it is refused, and `done` removes the old password file.
// Everything in temp folders, removed at the end.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as Old from "./fixtures/box-11-13.mjs";
import * as M from "../skill/nhi1-aua/mem.mjs";
import { startLocalBoard } from "../tools/local-board.ts";
import { testPort } from "../tools/test-ports.ts";

const ROOT = join(import.meta.dirname, "..");
const OPUS = { citizen: "opus", model: "claude-opus-5-5", rt: "test", how: "env" };

describe("moving out of the old key box", () => {
  let b: Awaited<ReturnType<typeof startLocalBoard>>;
  let home: string, kd: string;
  let dirs: string[];
  before(async () => {
    b = await startLocalBoard(testPort(15));
    home = mkdtempSync(join(tmpdir(), "nhi2-move-"));
    kd = mkdtempSync(join(tmpdir(), "nhi2-move-pieces-"));
    dirs = [join(home, "citizen"), join(kd, "b"), join(kd, "c")];
    Object.assign(process.env, { NHI1_HOME: home, NHI1_DISCOVERY: b.url, NHI1_KEY_DIRS: dirs.join(delimiter), NHI1_SANDBOX: "0" });
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
  after(() => {
    b.server.close();
    for (const d of [home, kd]) rmSync(d, { recursive: true, force: true });
    delete process.env.NHI1_KEY_DIRS;
  });
  const tool = (cmd: string) => new Promise<any>((ok) => {
    const p = spawn(process.execPath, [join(ROOT, "tools/migrate-box.mjs"), cmd], { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
    let o = "";
    p.stdout.on("data", (c) => (o += c));
    p.on("exit", () => ok(JSON.parse(o)));
  });

  it("the same id and memory keys, now as three pieces here; the box closes; the old password file goes", async () => {
    const wk = await (await fetch(b.url)).json();
    const ctx = { url: wk.ep.mem, aua: M.MEM_AUA };
    const old = await Old.openCabin({ citizen: "opus", ctx }); // an old citizen: password file + box on the root
    assert.ok(old.secrets, JSON.stringify(old));
    const oldSec = old.secrets as Awaited<ReturnType<typeof M.memorySecrets>>;
    const w = await M.memWrite({ who: OPUS, secrets: oldSec, items: [{ tag: "pref", s: "先讀規格", basis: null }] });
    assert.equal(w.saved, true, JSON.stringify(w));

    assert.deepEqual(await tool("list"), [{ citizen: "opus", files: 1 }]);
    const dry = await tool("dry");
    assert.deepEqual(dry, [{ citizen: "opus", pub: oldSec.pub, opens: true, memory_keys: 1 }]);
    assert.equal(readdirSync(join(home, "citizen")).length, 1, "dry wrote nothing");

    const mv = await tool("move");
    assert.deepEqual(mv, [{ citizen: "opus", pub: oldSec.pub, moved: true, pieces: 3, memory_keys: 1, reg: "new" }]);
    assert.ok(!JSON.stringify(mv).includes(JSON.parse(JSON.stringify(oldSec)).pub + "x"));
    const s = (await M.openSecrets({ citizen: "opus" })) as Awaited<ReturnType<typeof M.memorySecrets>>;
    assert.equal(s.pub, oldSec.pub, "the id does not change");
    const r = await M.memRead({ who: OPUS, secrets: s, reader: async (input: string) => {
      const j = JSON.parse(input.slice(input.indexOf("{"), input.lastIndexOf("}") + 1));
      return { answer: { items: j.items.map((i: any) => ({ h: i.h, s: i.text.slice(0, 80), cmd: 0 })) } };
    } });
    assert.equal(r.prefs.length, 1, "a memory sealed before the move still opens");
    assert.deepEqual(await M.memCheck({ who: OPUS }), { ok: 1, room: 1, pub: oldSec.pub });
    const here = await M.memHere({ who: OPUS });
    assert.deepEqual([here.room, here.pieces, here.n], [true, 3, 1]);
    assert.equal((await tool("move"))[0].moved, true, "moving again is harmless (the pieces are kept, not rewritten)");

    // close the old box, clear the moved row, remove the old password file
    await b.db.query("update public.knob set val = 0 where name = 'box_on'");
    assert.deepEqual(await Old.openCabin({ citizen: "opus", ctx, create: false }), { err: "board_51" }, "the old way in is refused");
    await b.db.query("delete from public.mem_box where pub = $1", [oldSec.pub]);
    assert.deepEqual(await tool("done"), [{ citizen: "opus", pub: oldSec.pub, deleted: true }]);
    assert.ok(!readdirSync(join(home, "citizen")).some((f) => f.endsWith(".pass")), "no password file left");
    assert.equal((await M.openSecrets({ citizen: "opus" }) as { pub: string }).pub, oldSec.pub, "the key is the pieces now");
    assert.equal((await b.db.query("select 1 from public.mem_box")).rows.length, 0, "no key material left on the root");
    assert.ok(existsSync(dirs[1]) && existsSync(dirs[2]));
  });
});
