/**
 * Money Lab code workshop
 *
 * Owner plan (2026-10-07), step 2: the agent built every site from scratch
 * with exec and write_file. These tools make each product faster and
 * sounder:
 * - repo_scout: finds GitHub repositories worth reusing (permissive
 *   licence, maintained, starred) and reads their READMEs;
 * - vendor_code: copies a permissively licensed repository, or part of it,
 *   into ~/library/vendor with a NOTICE that keeps the licence and source;
 * - scaffold_site: starts a complete site from the design kit in one call
 *   (pages, analytics, robots, sitemap, 404, git) in French or English;
 * - test_site: drives a real browser through a scenario on a site, crawls
 *   its internal links and reports console errors, broken links and images.
 * Nothing here runs code from a vendored repository: it is copied, never
 * installed or executed.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { ExecResult } from "../types.js";
import { saveRecord } from "./datasets.js";
import { findBrowser, runLocalCommand, scrubbedEnv, shellQuote } from "./selfhosted.js";
import { DESIGN_KIT_DIR } from "./assets.js";

type FetchFn = typeof fetch;

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "MoneyLabBot/1.0 (code reuse; https://github.com/Cloied/Money-lab)";
const TIMEOUT_MS = 20_000;

/** Licences the owner allows the agent to copy from (attribution kept in NOTICE.md). */
export const PERMISSIVE_LICENSES = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0", "MIT-0", "Zlib", "BSL-1.0",
]);
/** Usable as a dependency but not to copy pieces from without care. */
const WEAK_COPYLEFT = new Set(["MPL-2.0", "LGPL-2.1", "LGPL-3.0", "EPL-2.0"]);

export function licenseVerdict(spdx: string | null | undefined): { ok: boolean; note: string } {
  if (!spdx || spdx === "NOASSERTION") return { ok: false, note: "no licence detected: do not copy" };
  if (PERMISSIVE_LICENSES.has(spdx)) return { ok: true, note: `${spdx}: reusable with attribution` };
  if (WEAK_COPYLEFT.has(spdx)) return { ok: false, note: `${spdx}: use as an unmodified dependency only, do not copy pieces` };
  return { ok: false, note: `${spdx}: not reusable here (copyleft or custom)` };
}

async function githubJson(fetchFn: FetchFn, url: string, env: NodeJS.ProcessEnv, accept = "application/vnd.github+json"): Promise<any> {
  const headers: Record<string, string> = { accept, "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" };
  // The bot's own token raises the search limit from 10 to 30 per minute; public data only.
  if (env.GH_TOKEN) headers.authorization = `Bearer ${env.GH_TOKEN}`;
  const resp = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GitHub ${resp.status}: ${body.slice(0, 160)}`);
  }
  return accept.includes("raw") ? resp.text() : resp.json();
}

// ─── repo_scout ─────────────────────────────────────────────────

export interface ScoutArgs {
  query: string;
  language?: string;
  minStars?: number;
  maxAgeDays?: number;
  readmes?: number;
  saveTo?: string;
}

export interface ScoutHit {
  repo: string;
  url: string;
  stars: number;
  pushed: string;
  license: string | null;
  reusable: boolean;
  description: string;
  topics: string[];
}

const SCOUT_CACHE_MS = 86_400_000;

function cacheFile(home: string, kind: string, key: string): string {
  return path.join(home, ".money-lab", "cache", kind, `${key}.json`);
}

/**
 * Searches GitHub for repositories to learn from or reuse. Permissive,
 * maintained and starred first; the first READMEs are returned (trimmed) so
 * the agent can judge without cloning. Results are cached for a day.
 */
export async function repoScout(
  args: ScoutArgs,
  options: { home: string; env?: NodeJS.ProcessEnv; fetchFn?: FetchFn; now?: Date; summarize?: (readme: string, repo: string) => Promise<string> },
): Promise<string> {
  const query = args.query?.trim();
  if (!query) return "query is required (what the code must do, e.g. \"pdf merge browser\").";
  const env = options.env ?? scrubbedEnv();
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? new Date();
  const minStars = Math.max(0, Math.floor(Number(args.minStars ?? 50)));
  const maxAge = Math.max(30, Math.floor(Number(args.maxAgeDays ?? 730)));
  const since = new Date(now.getTime() - maxAge * 86_400_000).toISOString().slice(0, 10);
  const q = [query, args.language ? `language:${args.language}` : "", `stars:>=${minStars}`, `pushed:>=${since}`, "archived:false"]
    .filter(Boolean).join(" ");
  const key = crypto.createHash("sha256").update(JSON.stringify({ q, readmes: args.readmes ?? 3 })).digest("hex").slice(0, 24);
  const cached = cacheFile(options.home, "repos", key);
  try {
    const entry = JSON.parse(fs.readFileSync(cached, "utf-8"));
    if (now.getTime() - Date.parse(entry.at) < SCOUT_CACHE_MS) return `${entry.text}\n[repo_scout: cached ${entry.at.slice(0, 16).replace("T", " ")} UTC]`;
  } catch {
    // no cache
  }

  let data: any;
  try {
    data = await githubJson(fetchFn, `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=12`, env);
  } catch (err: any) {
    return `repo_scout failed: ${String(err?.message ?? err).slice(0, 200)}`;
  }
  const hits: ScoutHit[] = (Array.isArray(data?.items) ? data.items : []).map((r: any) => {
    const spdx = r?.license?.spdx_id ?? null;
    return {
      repo: String(r.full_name), url: String(r.html_url), stars: Number(r.stargazers_count ?? 0),
      pushed: String(r.pushed_at ?? "").slice(0, 10), license: spdx === "NOASSERTION" ? null : spdx,
      reusable: licenseVerdict(spdx).ok, description: String(r.description ?? "").slice(0, 160),
      topics: Array.isArray(r.topics) ? r.topics.slice(0, 6).map(String) : [],
    };
  });
  if (hits.length === 0) return `No repository matched "${q}". Loosen the query, lower min_stars or raise max_age_days.`;
  // Reusable first, then stars.
  hits.sort((a, b) => Number(b.reusable) - Number(a.reusable) || b.stars - a.stars);

  const lines = [`Repositories for "${query}" (${hits.length}, GitHub search ${q}):`];
  for (const h of hits) {
    lines.push(`- ${h.repo} ★${h.stars.toLocaleString("en-US")} pushed ${h.pushed} — ${licenseVerdict(h.license).note}` +
      `${h.description ? `\n  ${h.description}` : ""}${h.topics.length ? `\n  topics: ${h.topics.join(", ")}` : ""}\n  ${h.url}`);
  }
  const readmeCount = Math.min(5, Math.max(0, Math.floor(Number(args.readmes ?? 3))));
  for (const h of hits.filter((x) => x.reusable).slice(0, readmeCount)) {
    try {
      const readme = String(await githubJson(fetchFn, `${GITHUB_API}/repos/${h.repo}/readme`, env, "application/vnd.github.raw+json"));
      const trimmed = readme.replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
      const summary = options.summarize ? await options.summarize(trimmed.slice(0, 12_000), h.repo) : trimmed.slice(0, 1200);
      lines.push(`\nREADME ${h.repo}:\n${summary}`);
    } catch (err: any) {
      lines.push(`\nREADME ${h.repo}: not read (${String(err?.message ?? err).slice(0, 80)})`);
    }
  }
  lines.push("\nNext: vendor_code to copy a reusable one into ~/library/vendor (licence kept), or read it with harvest (urls).");
  const text = lines.join("\n");
  try {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, JSON.stringify({ at: now.toISOString(), text }));
  } catch {
    // cache is optional
  }
  if (args.saveTo) {
    const error = saveRecord(options.home, args.saveTo, { source: "repo_scout", ref: q, data: { query, hits } }, now);
    return error ? `${text}\n[not saved: ${error}]` : `${text}\n[saved to dataset ${args.saveTo}]`;
  }
  return text;
}

// ─── vendor_code ────────────────────────────────────────────────

export interface VendorArgs {
  repo: string;
  paths?: string[];
  name?: string;
  ref?: string;
}

const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPO_KB = 200_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5000;
const SKIP_DIRS = new Set([".git", "node_modules", ".github", "dist", "build", "coverage"]);

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "vendor";
}

/** Copies a tree without following symbolic links; returns the files copied. */
function copyTree(src: string, dst: string, counter: { files: number; skipped: string[] }): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (counter.files >= MAX_FILES) return;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      counter.skipped.push(`${entry.name} (symbolic link)`);
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to, counter);
    } else if (entry.isFile()) {
      const size = fs.statSync(from).size;
      if (size > MAX_FILE_BYTES) {
        counter.skipped.push(`${entry.name} (${Math.round(size / 1_048_576)} MB)`);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      counter.files++;
    }
  }
}

/**
 * Clones a public repository (shallow, no credentials), checks its licence,
 * copies the requested paths into ~/library/vendor/<name> and writes
 * NOTICE.md with the source, commit, licence and date.
 */
export async function vendorCode(
  args: VendorArgs,
  options: {
    home: string;
    env?: NodeJS.ProcessEnv;
    fetchFn?: FetchFn;
    run?: (command: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<ExecResult>;
    /** Where to clone from (tests use a local repository). */
    cloneUrl?: (repo: string) => string;
    now?: Date;
  },
): Promise<string> {
  const repo = String(args.repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!REPO_ID.test(repo)) return "repo must be owner/name (or its GitHub URL).";
  const env = options.env ?? scrubbedEnv();
  const fetchFn = options.fetchFn ?? fetch;
  const run = options.run ?? ((c, t, e) => runLocalCommand(c, t, e));
  const now = options.now ?? new Date();

  let meta: any;
  try {
    meta = await githubJson(fetchFn, `${GITHUB_API}/repos/${repo}`, env);
  } catch (err: any) {
    return `vendor_code failed: ${String(err?.message ?? err).slice(0, 200)}`;
  }
  const spdx = meta?.license?.spdx_id ?? null;
  const verdict = licenseVerdict(spdx);
  if (!verdict.ok) return `Not copied: ${repo} — ${verdict.note}. Study it with harvest, or find a permissive alternative with repo_scout.`;
  if (Number(meta?.size ?? 0) > MAX_REPO_KB) return `Not copied: ${repo} is ${Math.round(Number(meta.size) / 1024)} MB; vendor only the paths you need from a smaller repository.`;
  if (meta?.private) return `Not copied: ${repo} is private.`;

  const name = safeName(args.name ?? repo.split("/")[1]);
  const vendorRoot = path.join(options.home, "library", "vendor");
  const dest = path.join(vendorRoot, name);
  if (fs.existsSync(dest)) return `~/library/vendor/${name} exists already: choose another name, or remove it first.`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-vendor-"));
  try {
    const url = options.cloneUrl ? options.cloneUrl(repo) : `https://github.com/${repo}.git`;
    const branch = args.ref ? `--branch ${shellQuote(String(args.ref))} ` : "";
    // No credentials: public repositories only, and the token never reaches git.
    const cloneEnv = { ...scrubbedEnv(env), GH_TOKEN: undefined, GIT_TERMINAL_PROMPT: "0" };
    const clone = await run(`git clone --quiet --depth 1 ${branch}${shellQuote(url)} ${shellQuote(path.join(tmp, "repo"))}`, 300_000, cloneEnv);
    if (clone.exitCode !== 0) return `Clone failed: ${(clone.stderr || clone.stdout).slice(0, 300)}`;
    const head = await run(`git -C ${shellQuote(path.join(tmp, "repo"))} rev-parse HEAD`, 20_000, cloneEnv);
    const commit = head.stdout.trim().slice(0, 40);

    const source = path.join(tmp, "repo");
    const wanted = (args.paths ?? []).map((p) => String(p).replace(/^\/+/, "")).filter(Boolean);
    const counter = { files: 0, skipped: [] as string[] };
    fs.mkdirSync(dest, { recursive: true });
    if (wanted.length === 0) {
      copyTree(source, dest, counter);
    } else {
      for (const rel of wanted) {
        const from = path.resolve(source, rel);
        if (!from.startsWith(source + path.sep)) {
          counter.skipped.push(`${rel} (outside the repository)`);
          continue;
        }
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(from);
        } catch {
          counter.skipped.push(`${rel} (not found)`);
          continue;
        }
        const to = path.join(dest, rel);
        if (stat.isDirectory()) {
          fs.mkdirSync(to, { recursive: true });
          copyTree(from, to, counter);
        } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          counter.files++;
        } else {
          counter.skipped.push(`${rel} (${stat.isSymbolicLink() ? "symbolic link" : "too large"})`);
        }
      }
      // The licence travels with every partial copy.
      for (const lic of fs.readdirSync(source).filter((f) => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(f))) {
        if (!fs.lstatSync(path.join(source, lic)).isSymbolicLink()) fs.copyFileSync(path.join(source, lic), path.join(dest, lic));
      }
    }
    if (counter.files === 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      return `Nothing copied from ${repo}${counter.skipped.length ? ` (${counter.skipped.join("; ")})` : ""}.`;
    }
    const notice = [
      `# ${name}`, "",
      `Source: https://github.com/${repo} (commit ${commit || "unknown"}${args.ref ? `, ref ${args.ref}` : ""})`,
      `Licence: ${spdx} — keep this notice and the LICENSE file with any copy or derivative.`,
      `Copied: ${now.toISOString().slice(0, 10)}; ${wanted.length ? `paths ${wanted.join(", ")}` : "whole repository"}; ${counter.files} files.`,
      counter.skipped.length ? `Skipped: ${counter.skipped.slice(0, 20).join("; ")}.` : "",
      "", "Do not run install scripts or binaries from this copy; read and reuse the code.",
    ].filter((l) => l !== null).join("\n");
    fs.writeFileSync(path.join(dest, "NOTICE.md"), `${notice}\n`);
    const index = path.join(vendorRoot, "INDEX.md");
    const line = `- ${name}: ${repo} (${spdx}, ${now.toISOString().slice(0, 10)}) — ${String(meta?.description ?? "").slice(0, 100)}\n`;
    fs.appendFileSync(index, (fs.existsSync(index) ? "" : "# Vendored code (see each NOTICE.md)\n\n") + line);
    return `Copied ${counter.files} files from ${repo} (${spdx}) into ~/library/vendor/${name} (NOTICE.md written, listed in ~/library/vendor/INDEX.md).` +
      `${counter.skipped.length ? `\nSkipped: ${counter.skipped.slice(0, 10).join("; ")}.` : ""}\nRead before reusing; never execute its scripts.`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── scaffold_site ──────────────────────────────────────────────

export interface ScaffoldArgs {
  name: string;
  template?: "tool" | "landing";
  theme?: string;
  lang?: "fr" | "en";
  title: string;
  description: string;
  h1?: string;
  lede?: string;
  brand?: string;
  contactEmail?: string;
  publish?: boolean;
}

const THEMES = ["sober", "warm", "editorial", "playful", "technical", "retro"];

/** Fixed French strings of the templates and their English counterparts. */
const EN_STRINGS: Array<[string, string]> = [
  ["Comment ça marche", "How it works"], ["Questions fréquentes", "Frequently asked questions"], ["Questions", "FAQ"],
  ["À propos", "About"], ["Gratuit · sans inscription", "Free · no sign-up"], ["Commencer", "Start"], ["Voir un exemple", "See an example"],
  ["Premier champ", "First field"], ["Deuxième champ", "Second field"], ["Exemple de valeur", "Example value"],
  ["Une aide courte si besoin.", "A short hint if needed."], ["Calculer", "Calculate"], ["Le résultat apparaît ici.", "The result appears here."],
  ["L'outil", "The tool"], ["1. Vous saisissez", "1. You enter"], ["2. L'outil calcule", "2. The tool computes"], ["3. Vous repartez avec", "3. You leave with"],
  ["Ce que la personne doit fournir, en une phrase.", "What the person provides, in one sentence."],
  ["Ce qui se passe, et pourquoi c'est fiable (source, règle).", "What happens, and why it is reliable (source, rule)."],
  ["Le livrable concret : PDF, lien, chiffre, liste.", "The concrete deliverable: PDF, link, number, list."],
  ["Est-ce vraiment gratuit ?", "Is it really free?"], ["Oui. Explique ce qui finance le site, honnêtement.", "Yes. Say honestly what funds the site."],
  ["Mes données sont-elles envoyées quelque part ?", "Is my data sent anywhere?"],
  ["Dis exactement ce qui est traité dans le navigateur et ce qui ne l'est pas.", "Say exactly what is processed in the browser and what is not."],
  ["Qui a fait cet outil ?", "Who made this tool?"], ["Une phrase vraie sur le projet, avec un lien vers la page À propos.", "One true sentence about the project, with a link to the About page."],
  ["Mentions", "Legal"], ["Confidentialité", "Privacy"], ["Nous écrire", "Contact us"], ["Principal", "Main"],
  ["/a-propos/", "/about/"], ["/mentions/", "/legal/"], ["/confidentialite/", "/privacy/"],
];

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Creates ~/sites/<name> from the kit: index.html (texts and metadata set,
 * design files local), site.css, about page, 404, robots.txt, sitemap.xml,
 * analytics snippet when configured, README with the publishing steps, and
 * a git repository. With publish: true and GitHub credentials, creates the
 * repository in the bot's organization and enables Pages.
 */
export async function scaffoldSite(
  args: ScaffoldArgs,
  options: {
    home: string;
    env?: NodeJS.ProcessEnv;
    kitDir?: string;
    run?: (command: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<ExecResult>;
    now?: Date;
  },
): Promise<string> {
  const name = safeName(String(args.name ?? ""));
  if (!args.name || name !== String(args.name).trim().toLowerCase()) return "name must be lowercase letters, digits and dashes (it becomes the repository and URL path).";
  if (!args.title?.trim() || !args.description?.trim()) return "title and description are required (the description is the meta description, 150 characters at most).";
  const env = options.env ?? process.env;
  const kit = options.kitDir ?? path.join(options.home, DESIGN_KIT_DIR);
  const template = args.template === "landing" ? "landing" : "tool";
  const theme = THEMES.includes(String(args.theme)) ? String(args.theme) : "sober";
  const lang = args.lang === "en" ? "en" : "fr";
  const templateFile = path.join(kit, "templates", `${template}.html`);
  if (!fs.existsSync(templateFile)) return `Design kit not found at ${kit}: the runtime installs it at start (~/library/design).`;
  const dir = path.join(options.home, "sites", name);
  if (fs.existsSync(dir)) return `~/sites/${name} exists already.`;

  const org = env.GITHUB_ORG?.trim();
  const baseUrl = org ? `https://${org.toLowerCase()}.github.io/${name}/` : `https://EXAMPLE/${name}/`;
  const brand = args.brand?.trim() || args.title.trim();
  const email = args.contactEmail?.trim() || "";
  let html = fs.readFileSync(templateFile, "utf-8");
  html = html.replace(/<html lang="fr">/, `<html lang="${lang}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(args.title.trim())}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${escapeHtml(args.description.trim())}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeHtml(args.title.trim())}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeHtml(args.description.trim())}$2`)
    .replace(/https:\/\/EXEMPLE\/og\.png/, `${baseUrl}og.png`)
    .replace(/themes\/sober\.css/, `themes/${theme}.css`)
    .replace(/href="\/design\//g, "href=\"design/").replace(/href="\/site\.css"/, "href=\"site.css\"").replace(/href="\/favicon\.png"/, "href=\"favicon.png\"")
    .replace(/>\s*Marque\s*<\/a>/, `>${escapeHtml(brand)}</a>`).replace(/© 2026 Marque/, `© ${(options.now ?? new Date()).getUTCFullYear()} ${escapeHtml(brand)}`)
    .replace(/mailto:contact@exemple\.fr/, email ? `mailto:${email}` : `${baseUrl}${lang === "en" ? "about/" : "a-propos/"}`);
  if (args.h1?.trim()) html = html.replace(/<h1>[^<]*<\/h1>/, `<h1>${escapeHtml(args.h1.trim())}</h1>`);
  if (args.lede?.trim()) html = html.replace(/<p class="lede">[^<]*<\/p>/, `<p class="lede">${escapeHtml(args.lede.trim())}</p>`);
  if (lang === "en") for (const [fr, en] of EN_STRINGS) html = html.split(fr).join(en);
  const analytics = env.GOATCOUNTER_SITE
    ? `  <script data-goatcounter="https://${env.GOATCOUNTER_SITE}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>\n`
    : "";
  html = html.replace(/<\/body>/, `${analytics}</body>`);

  fs.mkdirSync(path.join(dir, "design", "themes"), { recursive: true });
  fs.copyFileSync(path.join(kit, "base.css"), path.join(dir, "design", "base.css"));
  fs.copyFileSync(path.join(kit, "themes", `${theme}.css`), path.join(dir, "design", "themes", `${theme}.css`));
  fs.writeFileSync(path.join(dir, "index.html"), html);
  fs.writeFileSync(path.join(dir, "site.css"), `/* ${name}: what is specific to this site. Override the kit's custom properties here (--accent, fonts, radius). */\n:root {\n}\n`);
  const aboutDir = path.join(dir, lang === "en" ? "about" : "a-propos");
  fs.mkdirSync(aboutDir);
  const aboutTitle = lang === "en" ? `About ${brand}` : `À propos de ${brand}`;
  const aboutBody = lang === "en"
    ? "<p>Who made this, how it works, what happens to your data, how to contact us. Write it truthfully.</p>"
    : "<p>Qui a fait ce site, comment il fonctionne, ce que deviennent vos données, comment nous écrire. À écrire honnêtement.</p>";
  const page = (title: string, body: string) => `<!doctype html>\n<html lang="${lang}">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeHtml(title)}</title>\n  <link rel="stylesheet" href="../design/base.css">\n  <link rel="stylesheet" href="../design/themes/${theme}.css">\n  <link rel="stylesheet" href="../site.css">\n</head>\n<body>\n  <main class="narrow section">\n    <h1>${escapeHtml(title)}</h1>\n    ${body}\n    <p><a href="../">${lang === "en" ? "Back to the tool" : "Retour à l'outil"}</a></p>\n  </main>\n${analytics}</body>\n</html>\n`;
  fs.writeFileSync(path.join(aboutDir, "index.html"), page(aboutTitle, aboutBody));
  fs.writeFileSync(path.join(dir, "404.html"), page(lang === "en" ? "Page not found" : "Page introuvable",
    lang === "en" ? "<p>This page does not exist.</p>" : "<p>Cette page n'existe pas.</p>").replace(/\.\.\//g, "./"));
  fs.writeFileSync(path.join(dir, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${baseUrl}sitemap.xml\n`);
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${baseUrl}</loc><lastmod>${today}</lastmod></url>\n  <url><loc>${baseUrl}${lang === "en" ? "about/" : "a-propos/"}</loc><lastmod>${today}</lastmod></url>\n</urlset>\n`);
  fs.writeFileSync(path.join(dir, ".nojekyll"), "");
  fs.writeFileSync(path.join(dir, "README.md"), [
    `# ${args.title.trim()}`, "", args.description.trim(), "",
    `Built from the Money Lab design kit (theme ${theme}). Site URL once published: ${baseUrl}`, "",
    "## Before publishing", "- Replace every placeholder text in index.html (search for \"field\", \"Exemple\", \"Premier\").",
    "- Make favicon.png and og.png with render_image (presets favicon, og).",
    "- Run check_design, first_impression, test_site, then design_review.", "",
    "## Publish", org
      ? `gh repo create ${org}/${name} --public --source=. --push\ngh api -X POST repos/${org}/${name}/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'`
      : "Ask the owner for GitHub credentials (request_help), then create the repository and enable Pages.",
  ].join("\n") + "\n");

  const run = options.run ?? ((c, t, e) => runLocalCommand(c, t, e));
  const gitEnv = { ...scrubbedEnv(env), GIT_TERMINAL_PROMPT: "0" };
  const git = await run(`cd ${shellQuote(dir)} && git init -q -b main && git add -A && git -c user.name='Money Lab' -c user.email='bot@money-lab.invalid' commit -q -m 'Scaffold ${name} from the design kit'`, 60_000, gitEnv);
  const notes: string[] = [];
  if (git.exitCode !== 0) notes.push(`git init failed: ${(git.stderr || git.stdout).slice(0, 160)}`);
  let published = "";
  if (args.publish) {
    if (!org || !env.GH_TOKEN) {
      notes.push("not published: no GitHub organization or token (ask the owner with request_help)");
    } else {
      const create = await run(`cd ${shellQuote(dir)} && gh repo create ${shellQuote(`${org}/${name}`)} --public --source=. --push 2>&1 && ` +
        `gh api -X POST ${shellQuote(`repos/${org}/${name}/pages`)} -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/' 2>&1`, 180_000, { ...scrubbedEnv(env), GH_TOKEN: env.GH_TOKEN, GIT_TERMINAL_PROMPT: "0" });
      published = create.exitCode === 0
        ? `Published: repository ${org}/${name} created and GitHub Pages enabled; ${baseUrl} goes live within a few minutes.`
        : `Publishing failed: ${(create.stderr || create.stdout).slice(0, 300)}`;
    }
  }
  const files = ["index.html", "site.css", `design/base.css`, `design/themes/${theme}.css`, `${lang === "en" ? "about" : "a-propos"}/index.html`, "404.html", "robots.txt", "sitemap.xml", ".nojekyll", "README.md"];
  return [
    `Site ~/sites/${name} created (${template} template, theme ${theme}, ${lang}): ${files.join(", ")}.`,
    analytics ? "Analytics snippet included." : "No analytics token: no snippet.",
    published,
    ...notes,
    "Next: replace the placeholder texts in index.html (keep one main action), add favicon.png and og.png (render_image), " +
      "then check_design, first_impression and test_site before design_review and publishing (see README.md).",
  ].filter(Boolean).join("\n");
}

// ─── test_site ──────────────────────────────────────────────────

export interface TestStep {
  action: "goto" | "click" | "fill" | "select" | "press" | "expect_text" | "expect_visible" | "expect_hidden" | "expect_url" | "wait";
  selector?: string;
  value?: string;
}

export interface TestSiteArgs {
  url: string;
  steps?: TestStep[];
  crawl?: boolean;
  maxPages?: number;
  mobile?: boolean;
}

const STEP_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 20_000;
const MAX_STEPS = 40;

/**
 * Drives a fresh headless browser (no profile, no cookies) through the
 * scenario, then crawls same-origin links. Reports failures with a
 * screenshot path, console and page errors, failed requests, broken links
 * and images. Free: no inference.
 */
export async function testSite(args: TestSiteArgs, options: { home: string; env?: NodeJS.ProcessEnv; now?: Date }): Promise<string> {
  let start: URL;
  try {
    start = new URL(String(args.url ?? ""));
    if (start.protocol !== "http:" && start.protocol !== "https:") throw new Error("http(s) only");
  } catch {
    return "url must be an http(s) URL.";
  }
  const env = options.env ?? process.env;
  const executablePath = findBrowser(env);
  if (!executablePath) return "No headless browser on this server: ask the owner to install Google Chrome.";
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu"], env: scrubbedEnv(env) as Record<string, string> });
  const shotsDir = path.join(options.home, ".money-lab", "tests");
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const report: string[] = [];
  const problems: string[] = [];
  let failed = 0;
  try {
    const context = await browser.newContext(args.mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    // Resource failures are reported from the responses, not twice.
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 160)); });
    page.on("pageerror", (e) => consoleErrors.push(`uncaught: ${String(e?.message ?? e).slice(0, 160)}`));
    page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 120)}`); });

    const steps: TestStep[] = [{ action: "goto", value: start.toString() }, ...(args.steps ?? []).slice(0, MAX_STEPS)];
    for (const [i, step] of steps.entries()) {
      const label = `${i + 1}. ${step.action}${step.selector ? ` ${step.selector}` : ""}${step.value ? ` "${String(step.value).slice(0, 60)}"` : ""}`;
      try {
        switch (step.action) {
          case "goto": {
            const target = new URL(String(step.value ?? ""), start);
            const resp = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
            if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp?.status() ?? "no response"}`);
            await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
            break;
          }
          case "click": await page.click(String(step.selector)); break;
          case "fill": await page.fill(String(step.selector), String(step.value ?? "")); break;
          case "select": await page.selectOption(String(step.selector), String(step.value ?? "")); break;
          case "press": await page.press(String(step.selector ?? "body"), String(step.value ?? "Enter")); break;
          case "wait": await page.waitForTimeout(Math.min(5_000, Math.max(100, Number(step.value ?? 500)))); break;
          case "expect_visible": await page.locator(String(step.selector)).first().waitFor({ state: "visible" }); break;
          case "expect_hidden": await page.locator(String(step.selector)).first().waitFor({ state: "hidden" }); break;
          case "expect_text": {
            const locator = step.selector ? page.locator(String(step.selector)).first() : page.locator("body");
            await locator.waitFor({ state: "attached" });
            const text = (await locator.innerText()).replace(/\s+/g, " ");
            if (!text.includes(String(step.value ?? ""))) throw new Error(`text not found; got "${text.slice(0, 160)}"`);
            break;
          }
          case "expect_url":
            if (!page.url().includes(String(step.value ?? ""))) throw new Error(`url is ${page.url()}`);
            break;
          default: throw new Error(`unknown action ${String((step as any).action)}`);
        }
        report.push(`✓ ${label}`);
      } catch (err: any) {
        failed++;
        fs.mkdirSync(shotsDir, { recursive: true });
        const shot = path.join(shotsDir, `${stamp}-step${i + 1}.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
        report.push(`✗ ${label} — ${String(err?.message ?? err).split("\n")[0].slice(0, 200)} (screenshot ${shot.replace(options.home, "~")})`);
      }
    }

    // Images without pixels on the final page.
    const brokenImages = await page.evaluate(() =>
      Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute("src") ?? "?").slice(0, 10),
    ).catch(() => [] as string[]);
    if (brokenImages.length) problems.push(`Broken images: ${brokenImages.join(", ")}`);

    if (args.crawl !== false) {
      const maxPages = Math.min(50, Math.max(1, Math.floor(Number(args.maxPages ?? 20))));
      const seen = new Set<string>([start.toString()]);
      const queue: string[] = [];
      const broken: string[] = [];
      const collect = async () => {
        const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
        for (const href of hrefs) {
          try {
            const u = new URL(href);
            u.hash = "";
            if (u.origin === start.origin && !seen.has(u.toString()) && !/\.(png|jpe?g|gif|svg|webp|pdf|zip|ico)$/i.test(u.pathname)) {
              seen.add(u.toString());
              queue.push(u.toString());
            }
          } catch {
            // not a URL
          }
        }
      };
      await collect();
      let visited = 1;
      while (queue.length && visited < maxPages) {
        const next = queue.shift()!;
        visited++;
        try {
          const resp = await page.goto(next, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
          if (!resp || resp.status() >= 400) broken.push(`${resp?.status() ?? "no response"} ${next}`);
          else await collect();
        } catch (err: any) {
          broken.push(`${String(err?.message ?? err).split("\n")[0].slice(0, 80)} ${next}`);
        }
      }
      report.push(`Crawl: ${visited} page(s) visited${queue.length ? `, ${queue.length} not visited (max_pages ${maxPages})` : ""}` +
        `${broken.length ? `; broken links:\n  ${broken.join("\n  ")}` : "; no broken link"}`);
      if (broken.length) problems.push(`${broken.length} broken link(s)`);
    }
    if (consoleErrors.length) problems.push(`Console errors (${consoleErrors.length}): ${[...new Set(consoleErrors)].slice(0, 5).join(" | ")}`);
    const notable = failedRequests.filter((r) => !/favicon/.test(r));
    if (notable.length) problems.push(`Failed requests (${notable.length}): ${[...new Set(notable)].slice(0, 5).join(" | ")}`);
    await context.close();
  } finally {
    await browser.close().catch(() => undefined);
  }
  const verdict = failed === 0 && problems.length === 0 ? "PASS" : failed ? `FAIL (${failed} step${failed > 1 ? "s" : ""})` : "PASS WITH WARNINGS";
  return [`test_site ${verdict} — ${start.toString()}${args.mobile ? " (mobile 390px)" : ""}`, ...report, ...problems.map((p) => `! ${p}`),
    failed ? "Look at the screenshots with view_page (file path) and fix before publishing." : ""].filter(Boolean).join("\n");
}
