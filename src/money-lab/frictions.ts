/**
 * Money Lab frictions: where the bot looks for frustrations (2026-10-08)
 *
 * Profitable ideas start from a pain people already talk about. For a theme,
 * the runtime gathers public posts where people complain, ask for a tool or
 * look for an alternative (Reddit search, Ask HN, and Tavily when the owner
 * configured it), then the free models extract each distinct frustration
 * with who has it, a short quote, the link, the date and how strong it is.
 * Results go to the "frictions" dataset; the bot builds its proposals from
 * them. Free sources and free models only: no paid fallback.
 */

import type Database from "better-sqlite3";
import { serviceAvailable, tavilySearch } from "./services.js";
import { withSecrets } from "./selfhosted.js";
import { countFrictions } from "./proposals.js";

type FetchFn = typeof fetch;
const USER_AGENT = "MoneyLabBot/1.0 (frustration research; https://github.com/moneylab-djib/Money-lab)";
const TIMEOUT_MS = 15_000;
const MAX_CORPUS = 60_000;

export interface FrictionArgs {
  theme: string;
  lang?: "fr" | "en" | "both";
}

export interface FrictionOptions {
  db?: Database.Database;
  fetchFn?: FetchFn;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** harvest with free models only; returns the extraction. */
  extract: (task: string, text: string) => Promise<{ text: string; provider: string }>;
}

interface Item { source: string; url: string; date: string; strength: string; title: string; text: string }

const QUERIES: Record<"fr" | "en", string[]> = {
  en: ["{t} frustrating", "{t} \"is there a tool\"", "{t} I hate", "{t} alternative to"],
  fr: ["{t} galère", "{t} \"existe-t-il\"", "{t} problème", "{t} alternative à"],
};

async function getJson(fetchFn: FetchFn, url: string): Promise<any> {
  const resp = await fetchFn(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  return resp.json();
}

function day(epochSeconds: number): string {
  return Number.isFinite(epochSeconds) && epochSeconds > 0 ? new Date(epochSeconds * 1000).toISOString().slice(0, 10) : "?";
}

function clean(text: unknown, max: number): string {
  return String(text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

async function reddit(query: string, fetchFn: FetchFn): Promise<Item[]> {
  const data = await getJson(fetchFn, `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=15&raw_json=1`);
  return (data?.data?.children ?? []).map((c: any) => c.data).filter(Boolean).map((p: any) => ({
    source: `reddit r/${p.subreddit}`, url: `https://www.reddit.com${p.permalink}`, date: day(p.created_utc),
    strength: `${p.score ?? 0} votes, ${p.num_comments ?? 0} comments`, title: clean(p.title, 200), text: clean(p.selftext, 700),
  }));
}

async function askHn(theme: string, fetchFn: FetchFn): Promise<Item[]> {
  const data = await getJson(fetchFn, `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(theme)}&tags=ask_hn&hitsPerPage=15`);
  return (data?.hits ?? []).map((h: any) => ({
    source: "Ask HN", url: `https://news.ycombinator.com/item?id=${h.objectID}`, date: String(h.created_at ?? "?").slice(0, 10),
    strength: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments`, title: clean(h.title, 200), text: clean(h.story_text, 700),
  }));
}

const TASK = `From these public posts, list every distinct frustration people have (a task that is painful, slow, costly,
confusing, or a tool they look for and cannot find). For each, one line:
frustration in one sentence | who has it (profession or situation) | a short verbatim quote | source URL | date | strength (votes, comments) | do they pay or say they would pay for a fix (quote it, or "unknown")
Merge duplicates (keep every URL), rank the strongest first, at most 15 lines. Only what the posts say; no invented
frustration, quote or URL. If the posts show no real frustration, say so.`;

/** Gathers posts for a theme and extracts the frustrations with the free models. */
export async function scanFrictions(args: FrictionArgs, options: FrictionOptions): Promise<string> {
  const theme = String(args.theme ?? "").trim().slice(0, 80);
  if (theme.length < 3) return "theme: a field, profession or task, e.g. \"plumbers quotes\" or \"déclaration TVA auto-entrepreneur\".";
  const fetchFn = options.fetchFn ?? fetch;
  const env = options.env ?? withSecrets();
  const langs: Array<"fr" | "en"> = args.lang === "fr" ? ["fr"] : args.lang === "en" ? ["en"] : ["fr", "en"];
  const items: Item[] = [];
  const notes: string[] = [];
  for (const lang of langs) {
    for (const q of QUERIES[lang]) {
      const query = q.replace("{t}", theme);
      try {
        items.push(...await reddit(query, fetchFn));
      } catch (err: any) {
        notes.push(`reddit "${query}": ${err?.status ?? String(err?.message ?? err).slice(0, 60)}`);
        if (err?.status === 403 || err?.status === 429) break;
      }
    }
  }
  try {
    items.push(...await askHn(theme, fetchFn));
  } catch (err: any) {
    notes.push(`Ask HN: ${err?.status ?? String(err?.message ?? err).slice(0, 60)}`);
  }
  let tavily = "";
  if (serviceAvailable(options.db, "tavily", env, options.now)) {
    const query = langs[0] === "fr" ? `${theme} galère forum avis` : `${theme} frustrated forum "is there a tool"`;
    try {
      tavily = await tavilySearch({ query, maxResults: 8 }, { env, fetchFn, db: options.db, now: options.now });
    } catch (err: any) {
      notes.push(`Tavily: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  const seen = new Set<string>();
  const unique = items.filter((i) => (i.title || i.text) && !seen.has(i.url) && (seen.add(i.url), true));
  let corpus = unique.map((i) => `SOURCE: ${i.url} (${i.source}, ${i.date}, ${i.strength})\n${i.title}\n${i.text}`).join("\n\n");
  if (tavily) corpus += `\n\nWEB SEARCH RESULTS:\n${tavily}`;
  corpus = corpus.slice(0, MAX_CORPUS);
  if (unique.length < 3 && !tavily) {
    return `Too few posts for "${theme}" (${unique.length}). ${notes.join("; ")}\nTry a narrower or more concrete theme (a profession and a task), or another language.`;
  }
  const result = await options.extract(TASK, corpus);
  const lines = result.text.split("\n").filter((l) => /\|/.test(l) && /https?:\/\//.test(l)).length;
  if (options.db && lines) countFrictions(options.db, lines, options.now);
  return [
    `Frictions for "${theme}" (${unique.length} posts${tavily ? " + web search" : ""}, read by ${result.provider}):`,
    result.text,
    notes.length ? `Sources not available: ${notes.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}
