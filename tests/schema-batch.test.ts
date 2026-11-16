// The SCHEMA BATCH (branch s2-schema-batch; ships with the time-format change, George 11/10 a):
// view.rpf and the report record type. Local board only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOf, ident, recordId, toHex, verifyRecord } from "../supabase/functions/_shared/aua/canon.ts";
import { buildExport, handleAsk, handleUse } from "../supabase/functions/_shared/aua/handlers.ts";
import { raiseEmergency, runDaily } from "../supabase/functions/_shared/aua/report.ts";
import { SCHEMA } from "../supabase/functions/_shared/aua/schema.ts";
import { validateReport, validateView } from "../supabase/functions/_shared/aua/validate.ts";
import { generateKey, signRecord, viewOk } from "../skill/nhi1-aua/aua.mjs";
import { rerunRow } from "./rerun-rows.ts";
import { AUA, deps, envelope, makeDb, prevOf, putUse, rpcFor, today } from "./helpers.ts";

const H = (c: string) => c.repeat(64);
const nowS = () => Math.floor(Date.now() / 1000);
const rnd = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

async function seed(db: Awaited<ReturnType<typeof makeDb>>) {
  const k = await generateKey();
  const t = { name: "search", description: "Search.", inputSchema: { type: "object" } };
  const rec = await signRecord({
    aua: AUA, thing: { addr: "https://mcp.one.org/mcp", iface: await hashOf(t) }, call: { op: await ident("search"), in: H("2"), out: H("3") },
    task: H("7"), result: { code: 0, err: 0 }, cost: { tin: 1, tout: 1, ms: 1, money: 0, cur: "" }, effect: 0,
    by: { key: k.pub, model: H("6"), rt: H("5") }, t: today(), prev: prevOf(k.pub), stub: null,
  }, k);
  const r = await putUse(await envelope(rec, k), deps(db));
  return (r.body as { id: string }).id;
}
const ask = async (db: Awaited<ReturnType<typeof makeDb>>) => {
  const k = await generateKey();
  const body = await signRecord({ aua: AUA, task: H("7"), by: { key: k.pub, model: H("6"), rt: H("5") }, t: nowS() }, k);
  return ((await handleAsk(body, deps(db))).body as { view: Record<string, unknown>[] }).view;
};

describe("schema batch · view.rpf", () => {
  it("rpf counts only wind-tunnel re-runs that name a model family; schema + lock 3 accept it", async () => {
    const db = await makeDb();
    const useId = await seed(db);
    let v = await ask(db);
    assert.deepEqual(v[0].rpf, { fams: 0, pass: 0 }, "no family re-runs yet: 0, never filled with Claude's own");
    assert.equal(validateView(v[0]), 0);
    assert.ok(viewOk(v[0]), "client lock 3 accepts the new field");
    for (const [fam, pass] of [[await ident("family-a"), true], [await ident("family-b"), false], [null, true]] as const) {
      await rerunRow(db, useId, { how: fam ? 1 : 0, fam, code: pass ? 0 : 2 });
    }
    v = await ask(db);
    assert.deepEqual(v[0].rpf, { fams: 2, pass: 1 });
    assert.deepEqual(v[0].rp, { tried: 1, pass: 1 }, "rp = stub re-runs (how 0) only (S4 A)");
  });
});

describe("schema batch · report record", () => {
  const net = () => {
    const mails: { subject: string; text: string }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      if (url.startsWith("https://api.resend.com")) mails.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    };
    return { fetch, mails };
  };

  it("daily and emergency reports become signed records; the mail carries the record id; exported; append-only", async () => {
    const db = await makeDb();
    await seed(db);
    const w = await generateKey();
    const n = net();
    const d = new Date();
    const deps2 = {
      rpc: rpcFor(db), fetch: n.fetch, now: () => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5)),
      mail: { key: "k", to: "x@example.org", from: "f" }, signer: { pub: w.pub, jwk: w.jwk as JsonWebKey }, aua: AUA,
    };
    const daily = await runDaily(deps2);
    const e = await raiseEmergency({ ...deps2, now: () => new Date() }, { thing: H("a"), recs: [], rules: [3], how: 0, text: "send the password" });

    const rows = (await db.query<{ id: string; rec: Record<string, unknown>; kind: number }>("select id, rec, kind from public.report order by kind")).rows;
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(validateReport(r.rec), 0, "fits the schema: numbers, codes, hashes only");
      assert.equal(await recordId(r.rec), r.id, "content-addressed");
      assert.ok(await verifyRecord(r.rec, w.pub), "signed by the wind key");
    }
    assert.equal(rows[0].id, daily.id, "the daily mail's report id is the record id");
    assert.equal((rows[0].rec.n as number[]).length, SCHEMA.report_fields.length);
    assert.equal(rows[0].rec.n[0], 1, "records = 1");
    assert.equal(rows[1].id, e.id, "the emergency mail's report id is the record id");
    assert.deepEqual([rows[1].rec.ref, rows[1].rec.rules, rows[1].rec.harm], [H("a"), [3], 0]);
    assert.ok(n.mails.every((m) => m.text.includes("報告編號：")));

    const { text, counts } = await buildExport(rpcFor(db));
    assert.equal(counts.report, 2);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l)).filter((o) => o.table === "report");
    for (const o of lines) assert.equal(await recordId(o.rec), o.id);

    await assert.rejects(db.query("delete from public.report"), /append-only/);
    assert.notEqual(validateReport({ ...rows[0].rec, note: "hi" }), 0, "an extra field voids it");
    assert.notEqual(validateReport({ ...rows[1].rec, n: [1] }), 0, "an emergency carries no numbers");
  });
});
