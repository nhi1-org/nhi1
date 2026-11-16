// One "session": sends N uses through the reference client, as the hook would, and prints the results.
//   node send-n.mjs <n> <tag>      (env: NHI1_HOME, NHI1_DISCOVERY, NHI1_HOOK_CONFIG)
import { makeUse, loadKey, sendUse } from "../../skill/nhi1-aua/aua.mjs";
import { join } from "node:path";

const n = Number(process.argv[2] || 3);
const tag = process.argv[3] || "a";
const key = loadKey(join(process.env.NHI1_HOME, "key.jwk"));
const H = (c) => c.repeat(64);
const out = [];
await Promise.all(Array.from({ length: n }, async (_, i) => {
  const t0 = Date.now();
  const body = await makeUse({
    addr: "https://mcp.chain-test.org/mcp", iface: H("1"), op: H("2"), in: H("3"), out: H("4"), task: H("5"),
    code: 0, err: 0, tin: i + 1, tout: tag.charCodeAt(0), ms: 1, effect: 0, model: H("6"), rt: H("7"),
  }, key);
  const r = await sendUse(body, { cfg: null, key, via: "test" });
  out.push({ status: r.status, id: r.body && r.body.id, queued: r.queued, ms: Date.now() - t0 });
}));
process.stdout.write(JSON.stringify(out));
