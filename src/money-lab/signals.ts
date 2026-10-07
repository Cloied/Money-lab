/**
 * Money Lab market signals
 *
 * Countable, dated evidence of demand for an idea, from free public sources
 * that need no account: Hacker News (Algolia search), Reddit (public JSON),
 * Google search suggestions, Wikipedia page views, GitHub repository search
 * and Stack Exchange questions. No inference and no cost: the agent gets
 * counts, trends and links it can cite as evidence, instead of impressions.
 * Each source fails on its own (Reddit often blocks servers); results are
 * cached for a day.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { saveRecord } from "./datasets.js";

export const SIGNAL_SOURCES = ["hackernews", "reddit", "google_suggest", "wikipedia", "github", "stackexchange"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
export const DEFAULT_SIGNAL_SOURCES: SignalSource[] = ["hackernews", "reddit", "google_suggest", "wikipedia"];

const USER_AGENT = "MoneyLabBot/1.0 (market research; https://github.com/moneylab-djib/Money-lab)";
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 86_400_000;
const CACHE_MAX_FILES = 300;

type FetchFn = typeof fetch;

export interface SignalOptions {
  lang?: string;
  site?: string;
  fetchFn?: FetchFn;
  now?: Date;
  githubToken?: string;
}

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetchFn(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  }
  return resp.json();
}

function day(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

async function hackerNews(query: string, o: Required<Pick<SignalOptions, "fetchFn" | "now">>): Promise<string> {
  const q = encodeURIComponent(query);
  const yearAgo = Math.floor(o.now.getTime() / 1000) - 365 * 86_400;
  const [all, recent] = await Promise.all([
    getJson(o.fetchFn, `https://hn.algolia.com/api/v1/search?query=${q}&tags=(story,ask_hn,show_hn)&hitsPerPage=8`),
    getJson(o.fetchFn, `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=(story,ask_hn,show_hn)&numericFilters=created_at_i>${yearAgo}&hitsPerPage=0`),
  ]);
  const hits = (all?.hits ?? []) as any[];
  const lines = hits.slice(0, 8).map((h) =>
    `  - ${String(h.title ?? h.story_title ?? "").slice(0, 120)} (${h.points ?? 0} points, ${h.num_comments ?? 0} comments, ` +
    `${String(h.created_at ?? "").slice(0, 10)}) https://news.ycombinator.com/item?id=${h.objectID}`);
  return `Hacker News: ${n(all?.nbHits ?? 0)} stories match, ${n(recent?.nbHits ?? 0)} in the last 12 months.` +
    (lines.length ? `\n${lines.join("\n")}` : "");
}

async function reddit(query: string, o: Required<Pick<SignalOptions, "fetchFn" | "now">>): Promise<string> {
  const data = await getJson(o.fetchFn, `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=10&raw_json=1`);
  const posts = ((data?.data?.children ?? []) as any[]).map((c) => c?.data).filter(Boolean);
  const subs = new Map<string, number>();
  for (const p of posts) subs.set(p.subreddit_name_prefixed, (subs.get(p.subreddit_name_prefixed) ?? 0) + 1);
  const lines = posts.slice(0, 8).map((p) =>
    `  - ${String(p.title ?? "").slice(0, 120)} (${p.subreddit_name_prefixed}, ${p.score ?? 0} votes, ${p.num_comments ?? 0} comments, ` +
    `${day(p.created_utc ?? 0)}) https://www.reddit.com${p.permalink}`);
  return `Reddit (last 12 months, top 10 by relevance): ${posts.length} posts` +
    (subs.size ? ` in ${[...subs].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s} (${c})`).join(", ")}` : "") +
    (lines.length ? `.\n${lines.join("\n")}` : ".");
}

async function googleSuggest(query: string, o: Required<Pick<SignalOptions, "fetchFn" | "now" | "lang">>): Promise<string> {
  // Each variant shows a different intent; suggestions reflect what people actually type.
  const variants = o.lang === "fr"
    ? [query, `${query} gratuit`, `${query} comment`, `${query} prix`]
    : [query, `${query} free`, `how to ${query}`, `${query} best`];
  const all = new Set<string>();
  for (const variant of variants) {
    const data = await getJson(o.fetchFn,
      `https://suggestqueries.google.com/complete/search?client=firefox&ie=UTF-8&oe=UTF-8&hl=${o.lang}&q=${encodeURIComponent(variant)}`);
    for (const s of Array.isArray(data?.[1]) ? data[1] : []) all.add(String(s));
  }
  const list = [...all].filter((s) => s.toLowerCase() !== query.toLowerCase()).slice(0, 30);
  return `Google suggestions (${o.lang}): ${list.length ? list.join(" | ") : "none (few people type this)"}.`;
}

async function wikipedia(query: string, o: Required<Pick<SignalOptions, "fetchFn" | "now" | "lang">>): Promise<string> {
  const search = await getJson(o.fetchFn,
    `https://${o.lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`);
  const titles: string[] = Array.isArray(search?.[1]) ? search[1] : [];
  if (titles.length === 0) return `Wikipedia (${o.lang}): no article about "${query}".`;
  const end = new Date(Date.UTC(o.now.getUTCFullYear(), o.now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), 1));
  const stamp = (d: Date) => `${d.toISOString().slice(0, 10).replace(/-/g, "")}00`;
  const lines: string[] = [];
  for (const title of titles.slice(0, 2)) {
    const article = encodeURIComponent(title.replace(/ /g, "_"));
    try {
      const data = await getJson(o.fetchFn,
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${o.lang}.wikipedia/all-access/user/${article}/monthly/${stamp(start)}/${stamp(end)}`);
      const views = ((data?.items ?? []) as any[]).map((i) => Number(i.views) || 0);
      if (views.length === 0) continue;
      const avg = Math.round(views.reduce((a, b) => a + b, 0) / views.length);
      const last3 = views.slice(-3).reduce((a, b) => a + b, 0);
      const prev3 = views.slice(-6, -3).reduce((a, b) => a + b, 0);
      const trend = prev3 > 0 ? `${last3 >= prev3 ? "+" : ""}${Math.round(((last3 - prev3) / prev3) * 100)}%` : "n/a";
      lines.push(`  - "${title}": ${n(avg)} views/month on average over ${views.length} months, last 3 months vs previous 3: ${trend} ` +
        `https://${o.lang}.wikipedia.org/wiki/${article}`);
    } catch {
      // No page views for this title: skip it.
    }
  }
  return `Wikipedia (${o.lang}) audience:${lines.length ? `\n${lines.join("\n")}` : " no page view data."}`;
}

async function github(query: string, o: Required<Pick<SignalOptions, "fetchFn" | "now">> & { githubToken?: string }): Promise<string> {
  const data = await getJson(o.fetchFn,
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=8`,
    { accept: "application/vnd.github+json", ...(o.githubToken ? { authorization: `Bearer ${o.githubToken}` } : {}) });
  const items = (data?.items ?? []) as any[];
  const lines = items.map((r) =>
    `  - ${r.full_name}: ${n(r.stargazers_count ?? 0)} stars, updated ${String(r.pushed_at ?? "").slice(0, 10)}, ` +
    `${String(r.description ?? "").slice(0, 100)} ${r.html_url}`);
  return `GitHub: ${n(data?.total_count ?? 0)} repositories match (existing open-source alternatives).` +
    (lines.length ? `\n${lines.join("\n")}` : "");
}

async function stackExchange(query: string, o: Required<Pick<SignalOptions, "fetchFn" | "now" | "site">>): Promise<string> {
  const data = await getJson(o.fetchFn,
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${encodeURIComponent(query)}&site=${encodeURIComponent(o.site)}&pagesize=8`);
  const items = (data?.items ?? []) as any[];
  const lines = items.map((q) =>
    `  - ${String(q.title ?? "").slice(0, 120)} (${n(q.view_count ?? 0)} views, ${q.answer_count ?? 0} answers, ` +
    `${day(q.creation_date ?? 0)}) ${q.link}`);
  return `Stack Exchange (${o.site}): ${items.length} top questions${data?.has_more ? " (more exist)" : ""}.` +
    (lines.length ? `\n${lines.join("\n")}` : "");
}

function failure(source: SignalSource, err: any): string {
  const status = err?.status;
  const hint = source === "reddit" && (status === 403 || status === 429)
    ? " (Reddit often blocks servers: search with web_search and site:reddit.com instead)"
    : source === "google_suggest" && (status === 403 || status === 429)
      ? " (Google is limiting this server: try again later)"
      : "";
  return `${source}: unavailable (${String(err?.message ?? err).slice(0, 80)})${hint}.`;
}

function cacheFile(home: string, key: string): string {
  return path.join(home, ".money-lab", "cache", "signals", `${key}.json`);
}

export async function marketSignals(
  query: string,
  sources: SignalSource[],
  options: SignalOptions & { home: string; saveTo?: string; fresh?: boolean },
): Promise<string> {
  const q = query.trim();
  if (q.length < 2) return "query is required (the words people would use, e.g. \"devis plombier\").";
  const lang = /^[a-z]{2}$/.test(options.lang ?? "") ? options.lang! : "fr";
  const site = /^[a-z.]{2,40}$/.test(options.site ?? "") ? options.site! : "stackoverflow";
  const now = options.now ?? new Date();
  const fetchFn = options.fetchFn ?? fetch;
  const wanted = sources.length ? [...new Set(sources)] : DEFAULT_SIGNAL_SOURCES;
  const key = crypto.createHash("sha256").update(JSON.stringify({ q: q.toLowerCase(), wanted, lang, site })).digest("hex").slice(0, 32);
  const file = cacheFile(options.home, key);

  let text: string | null = null;
  if (!options.fresh) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (now.getTime() - Date.parse(entry.at) < CACHE_TTL_MS) {
        text = `${entry.text}\n[cached from ${String(entry.at).slice(0, 16).replace("T", " ")} UTC; fresh: true to redo]`;
      }
    } catch {
      // not cached
    }
  }
  if (text === null) {
    const base = { fetchFn, now };
    const run: Record<SignalSource, () => Promise<string>> = {
      hackernews: () => hackerNews(q, base),
      reddit: () => reddit(q, base),
      google_suggest: () => googleSuggest(q, { ...base, lang }),
      wikipedia: () => wikipedia(q, { ...base, lang }),
      github: () => github(q, { ...base, githubToken: options.githubToken }),
      stackexchange: () => stackExchange(q, { ...base, site }),
    };
    const results = await Promise.all(wanted.map((s) => run[s]().catch((err) => failure(s, err))));
    text = `Market signals for "${q}" (${now.toISOString().slice(0, 10)}; cite these links with their dates as evidence):\n` +
      results.join("\n\n");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: now.toISOString(), text }));
      const dir = path.dirname(file);
      const files = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
      for (const { f } of files.slice(0, Math.max(0, files.length - CACHE_MAX_FILES))) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      // The cache is an optimisation.
    }
  }
  if (options.saveTo) {
    const error = saveRecord(options.home, options.saveTo, { source: "market_signals", ref: q, data: text.slice(0, 20_000) }, now);
    text += error ? `\n[not saved: ${error}]` : `\n[saved to dataset ${options.saveTo}]`;
  }
  // The agent reads at most 10,000 characters of a tool result.
  return text.length > 9800 ? `${text.slice(0, 9700)}\n[... truncated: ask fewer sources]` : text;
}
