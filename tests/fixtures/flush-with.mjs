// One "machine" resends what waits in its pending.ndjson, with the test's explicit throwaway key (the CLI's
// `flush` uses the running citizen's key from its box instead).   node flush-with.mjs   (env: NHI1_HOME, NHI1_DISCOVERY)
import { join } from "node:path";
import { loadKey, sendChained } from "../../skill/nhi1-aua/aua.mjs";

const key = loadKey(join(process.env.NHI1_HOME, "key" + ".jwk"));
process.stdout.write(JSON.stringify(await sendChained(null, { key, budgetMs: 30000 })));
