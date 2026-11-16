// Export the public repository (Opus card S1-A, 11/16): a clean copy of the files on the list below, into a
// separate folder with its own history. Run it for every release.
//   node tools/export-public.mjs <target> [--list]      (or set NHI1_PUBLIC_DIR; there is no default folder)
// Only files git tracks here are copied (so .gitignore holds: no key file, no .env, no node_modules), and only
// those on the list. public/ holds files that belong at the public repo's root (server.json, gemini-extension.json,
// llms-install.md, .claude-plugin/, the OASF record). The target's .git is kept; everything else is replaced.
// Apache-2.0.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ROOT_FILES = ["README.md", "LICENSE", "LICENSE-SPEC", "NOTICE", "package.json", "package-lock.json", ".gitignore", ".gitattributes"];
export const DIRS = ["charter/", "skill/", "mcp/", "supabase/functions/", "supabase/migrations/", "tools/", "tests/", "site/", "packages/"];
export const CONFIG_FILES = ["config/board.json", "config/skill-versions.json", "config/hooks.local.example.json"];
export const PUBLIC_DIR = "public/"; // copied to the target's root
/** never in the public repo, whatever the list says */
export const NEVER = [/^docs\//, /^\.claude\//, /^\.wrangler\//, /^out\//, /(^|\/)node_modules\//, /(^|\/)\.env(\.|$)/, /^config\/.*\.key$/, /\.pem$/, /\.key$/, /^supabase\/\.temp\//, /^supabase\/\.branches\//, /^tools\/gh-app-token\.mjs$/, /^config\/github-app\./];

/** .env.example goes out only if every line is a comment, blank, or NAME= with no value */
export const envExampleClean = (s) => s.split(/\r?\n/).every((l) => !l.trim() || l.trim().startsWith("#") || /^[A-Z][A-Z0-9_]*=\s*$/.test(l.trim()));

/** README for the public repo: the Repository table without its docs/ row */
export const publicReadme = (s) => s.split("\n").filter((l) => !l.startsWith("| `docs/` |")).join("\n");

/** tracked file → path in the public repo, or null when it stays here */
export function publicPath(f) {
  if (f === ".env.example") return envExampleClean(readFileSync(join(ROOT, f), "utf8")) ? f : null;
  if (NEVER.some((re) => re.test(f))) return null;
  if (f.startsWith(PUBLIC_DIR)) return f.slice(PUBLIC_DIR.length);
  if (ROOT_FILES.includes(f) || CONFIG_FILES.includes(f) || DIRS.some((d) => f.startsWith(d))) return f;
  return null;
}

export function plan() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of tracked) {
    const to = publicPath(f);
    if (to && existsSync(join(ROOT, f))) out.push({ from: f, to });
  }
  return out;
}

function main(argv) {
  const list = argv.includes("--list");
  const files = plan();
  if (list) {
    for (const x of files) console.log(x.from === x.to ? x.to : `${x.from} -> ${x.to}`);
    return;
  }
  const target = argv.find((a) => !a.startsWith("--")) || process.env.NHI1_PUBLIC_DIR;
  if (!target) {
    console.error("export-public: give the target folder as an argument, or set NHI1_PUBLIC_DIR");
    process.exit(2);
  }
  mkdirSync(target, { recursive: true });
  for (const e of readdirSync(target)) if (e !== ".git") rmSync(join(target, e), { recursive: true, force: true });
  for (const { from, to } of files) {
    mkdirSync(dirname(join(target, to)), { recursive: true });
    if (from === "README.md") writeFileSync(join(target, to), publicReadme(readFileSync(join(ROOT, from), "utf8")));
    else copyFileSync(join(ROOT, from), join(target, to));
  }
  console.log(JSON.stringify({ target, files: files.length, envExample: files.some((x) => x.to === ".env.example") }));
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
