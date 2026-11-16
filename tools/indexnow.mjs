// IndexNow: tell the search engines that share IndexNow about the site's entrances (Opus card S1-A, 11/16).
// Run on the day the door opens, not before:
//   node tools/indexnow.mjs          send (POST https://api.indexnow.org/indexnow)
//   node tools/indexnow.mjs --dry    print what would be sent, send nothing (the key is shown as <key>)
// Reads the key from config/indexnow.key (never in the repo; served at https://<host>/<key>.txt by build:site)
// and the URLs from site/sitemap.xml. Prints the status only, never the key. Apache-2.0.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENDPOINT = "https://api.indexnow.org/indexnow";

/** the request body: host, key, keyLocation, urlList (all on the key's host) */
export function indexNowBody({ key, sitemap, site }) {
  if (!/^[0-9a-f]{32}$/.test(key)) throw new Error("config/indexnow.key: expected 32 hex characters");
  const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const host = new URL(site).hostname;
  if (!urlList.length) throw new Error("site/sitemap.xml: no <loc>");
  for (const u of urlList) if (new URL(u).hostname !== host) throw new Error(`not on ${host}: ${u}`);
  return { host, key, keyLocation: `${site}/${key}.txt`, urlList };
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes("--dry");
  const site = JSON.parse(readFileSync(join(ROOT, "config/board.json"), "utf8")).site;
  const body = indexNowBody({
    key: readFileSync(join(ROOT, "config/indexnow.key"), "utf8").trim(),
    sitemap: readFileSync(join(ROOT, "site/sitemap.xml"), "utf8"),
    site,
  });
  if (dry) {
    console.log(JSON.stringify({ endpoint: ENDPOINT, ...body, key: "<key>", keyLocation: `${site}/<key>.txt` }, null, 2));
  } else {
    const r = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    // 200 / 202 accepted; 400 bad request; 403 key not found or not valid; 422 URLs not on the host; 429 too many requests
    console.log(JSON.stringify({ status: r.status, urls: body.urlList.length }));
    if (r.status !== 200 && r.status !== 202) process.exitCode = 1;
  }
}
