/**
 * Money Lab probes
 *
 * Owner plan (2026-10-07), step 3: demand is measured before anything is
 * built. A probe is one useful page, built in a day, aimed at a few
 * searches, published on the bot's domain. Google Search Console then says
 * what Google shows: after the window (14 days by default), the probe
 * passes when its impressions reach the threshold, else it fails. Probes
 * are not experiments: they do not count toward the active limit, and a
 * passing probe becomes evidence on the idea it tests. The runtime checks
 * them daily, tells the owner and wakes the agent when one is decided.
 * When the owner configured Bing Webmaster, Bing's impressions for the page
 * are read too and count toward the threshold (PR 6): a second engine, and
 * numbers that arrive sooner.
 */

import type Database from "better-sqlite3";
import { getKV, queueOwnerNotification, setKV } from "./journal.js";
import { searchAnalyticsRows, searchConsoleSite } from "./searchconsole.js";
import { getIdea, upsertIdea } from "./ideas.js";
import { submitIndexNow } from "./indexnow.js";
import { bingRows, serviceConfigured } from "./services.js";

const PROBES_KEY = "money_lab.probes";
export const MAX_PROBES = 12;
export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MIN_IMPRESSIONS = 50;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 45;

export type ProbeStatus = "live" | "passed" | "failed" | "stopped";

export interface Probe {
  id: string;
  url: string;
  queries: string[];
  ideaId: string | null;
  createdAt: string;
  windowDays: number;
  minImpressions: number;
  status: ProbeStatus;
  checkedAt?: string;
  impressions: number;
  clicks: number;
  position: number | null;
  topQueries: string[];
  bingImpressions?: number;
  bingClicks?: number;
  note?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function listProbes(db: Database.Database): Probe[] {
  try {
    const raw = JSON.parse(getKV(db, PROBES_KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as Probe[]) : [];
  } catch {
    return [];
  }
}

function save(db: Database.Database, probes: Probe[]): void {
  setKV(db, PROBES_KEY, JSON.stringify(probes));
}

/** Registers the probe and tells the IndexNow engines about its page (best effort). */
export async function addProbeAndPing(
  db: Database.Database,
  input: { id: string; url: string; queries: string[]; ideaId?: string; windowDays?: number; minImpressions?: number },
  options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<string> {
  const added = addProbe(db, input, options.now);
  if (!/^Probe "/.test(added)) return added;
  const ping = await submitIndexNow([String(input.url)], { fetchFn: options.fetchFn, env: options.env });
  return `${added}\n${ping}`;
}

export function addProbe(
  db: Database.Database,
  input: { id: string; url: string; queries: string[]; ideaId?: string; windowDays?: number; minImpressions?: number },
  now = new Date(),
): string {
  const id = String(input.id ?? "").trim();
  if (!ID.test(id)) return "id must be 1-40 lowercase letters, digits or dashes (e.g. devis-plombier).";
  let url: URL;
  try {
    url = new URL(String(input.url ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    return "url must be the probe page's public http(s) URL.";
  }
  const site = searchConsoleSite();
  if (!site) return "No Search Console access: a probe cannot be measured. Ask the owner to set it up (guide, Search Console) first.";
  if (!url.toString().startsWith(site) && url.hostname !== new URL(site).hostname) {
    return `The probe must live under the Search Console property ${site} (it is ${url.origin}); otherwise Google's numbers cannot be read.`;
  }
  const queries = [...new Set((input.queries ?? []).map((q) => String(q).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  if (queries.length < 2) return "queries: at least 2 searches the page targets (what people type).";
  const probes = listProbes(db);
  if (probes.some((p) => p.id === id)) return `Probe "${id}" exists already.`;
  if (probes.filter((p) => p.status === "live").length >= MAX_PROBES) return `At most ${MAX_PROBES} live probes: wait for decisions or stop one.`;
  if (input.ideaId && !getIdea(db, input.ideaId)) return `No idea "${input.ideaId}".`;
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.floor(Number(input.windowDays ?? DEFAULT_WINDOW_DAYS)) || DEFAULT_WINDOW_DAYS));
  const minImpressions = Math.max(10, Math.floor(Number(input.minImpressions ?? DEFAULT_MIN_IMPRESSIONS)) || DEFAULT_MIN_IMPRESSIONS);
  probes.push({
    id, url: url.toString(), queries, ideaId: input.ideaId ?? null, createdAt: now.toISOString(), windowDays, minImpressions,
    status: "live", impressions: 0, clicks: 0, position: null, topQueries: [],
  });
  save(db, probes);
  return `Probe "${id}" live: ${url} for ${queries.join(", ")}; decision after ${windowDays} days (passes at ${minImpressions} impressions). ` +
    "Search Console lags about two days; the runtime checks daily and wakes you when it is decided. Make sure the page is in the sitemap.";
}

export function stopProbe(db: Database.Database, id: string, note: string, now = new Date()): string {
  const probes = listProbes(db);
  const probe = probes.find((p) => p.id === id);
  if (!probe) return `No probe "${id}".`;
  if (probe.status !== "live") return `Probe "${id}" is already ${probe.status}.`;
  probe.status = "stopped";
  probe.note = note.trim().slice(0, 300) || "stopped by the agent";
  probe.checkedAt = now.toISOString();
  save(db, probes);
  return `Probe "${id}" stopped (${probe.note}).`;
}

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

export function formatProbe(p: Probe, now = new Date()): string {
  const age = daysSince(p.createdAt, now);
  const numbers = `${p.impressions} impressions, ${p.clicks} clicks${p.position !== null ? `, position ${p.position.toFixed(1)}` : ""}` +
    `${p.bingImpressions !== undefined ? ` on Google; ${p.bingImpressions} impressions, ${p.bingClicks ?? 0} clicks on Bing` : ""}` +
    `${p.checkedAt ? ` (checked ${p.checkedAt.slice(0, 10)})` : " (not checked yet)"}`;
  const head = `- ${p.id} [${p.status}] ${p.url}${p.ideaId ? ` (idea ${p.ideaId})` : ""}: ${numbers}`;
  const tail = p.status === "live"
    ? `; day ${age} of ${p.windowDays}, needs ${p.minImpressions}`
    : p.note ? `; ${p.note}` : "";
  return `${head}${tail}${p.topQueries.length ? `\n  Google shows it for: ${p.topQueries.join(" | ")}` : ""}`;
}

export interface CheckOptions {
  fetchFn?: typeof fetch;
  now?: Date;
  keyFile?: string;
  wake?: (reason: string) => void;
  canWake?: () => boolean;
  env?: NodeJS.ProcessEnv;
  db?: Database.Database;
}

/** Bing impressions and clicks for a page, from the page stats of its site; null when Bing is not configured or fails. */
async function bingNumbers(probe: Probe, options: CheckOptions, cache: Map<string, ReturnType<typeof bingRows>>): Promise<{ impressions: number; clicks: number } | null> {
  if (!serviceConfigured("bing", options.env)) return null;
  const url = new URL(probe.url);
  const site = `${url.origin}/`;
  try {
    if (!cache.has(site)) cache.set(site, bingRows(site, "page", { env: options.env, fetchFn: options.fetchFn, db: options.db, now: options.now }));
    const rows = await cache.get(site)!;
    const mine = rows.filter((r) => { try { return new URL(String(r.Query ?? "")).pathname.startsWith(url.pathname); } catch { return false; } });
    return { impressions: mine.reduce((n, r) => n + (r.Impressions ?? 0), 0), clicks: mine.reduce((n, r) => n + (r.Clicks ?? 0), 0) };
  } catch {
    return null;
  }
}

/**
 * Reads Search Console for every live probe (page filter, the probe's
 * window) and decides the ones whose window has elapsed. A decided probe
 * notifies the owner, wakes the agent and, when linked to an idea still
 * open, adds its numbers to the idea's evidence.
 */
export async function checkProbes(db: Database.Database, options: CheckOptions = {}): Promise<string[]> {
  const now = options.now ?? new Date();
  const site = searchConsoleSite();
  const probes = listProbes(db);
  const live = probes.filter((p) => p.status === "live");
  if (live.length === 0) return [];
  if (!site) return ["No Search Console access: probes cannot be checked."];
  const report: string[] = [];
  const decided: Probe[] = [];
  const bingCache = new Map<string, ReturnType<typeof bingRows>>();
  for (const probe of live) {
    const probePath = new URL(probe.url).pathname;
    const days = Math.max(1, Math.min(probe.windowDays, daysSince(probe.createdAt, now) + 2));
    try {
      const [pages, queries] = await Promise.all([
        searchAnalyticsRows({ site, dimension: "page", days, contains: probePath, rowLimit: 50 }, { fetchFn: options.fetchFn, now, keyFile: options.keyFile }),
        searchAnalyticsRows({ site, dimension: "query", days, rowLimit: 200 }, { fetchFn: options.fetchFn, now, keyFile: options.keyFile }).catch(() => ({ rows: [] })),
      ]);
      // The page filter is "contains": keep rows that are this page (or its sub-paths).
      const rows = pages.rows.filter((r) => { try { return new URL(r.key).pathname.startsWith(probePath); } catch { return false; } });
      probe.impressions = rows.reduce((n, r) => n + r.impressions, 0);
      probe.clicks = rows.reduce((n, r) => n + r.clicks, 0);
      probe.position = probe.impressions > 0 ? rows.reduce((n, r) => n + r.position * r.impressions, 0) / probe.impressions : null;
      // Queries are site-wide: keep the ones the probe targets, or that contain its words.
      const words = probe.queries.flatMap((q) => q.split(/\s+/)).filter((w) => w.length > 3);
      probe.topQueries = queries.rows
        .filter((r) => probe.queries.includes(r.key.toLowerCase()) || words.some((w) => r.key.toLowerCase().includes(w)))
        .sort((a, b) => b.impressions - a.impressions).slice(0, 5)
        .map((r) => `${r.key} (${r.impressions} impr., ${r.clicks} clicks)`);
      const bing = await bingNumbers(probe, options, bingCache);
      if (bing) { probe.bingImpressions = bing.impressions; probe.bingClicks = bing.clicks; }
      probe.checkedAt = now.toISOString();
      if (daysSince(probe.createdAt, now) >= probe.windowDays) {
        const total = probe.impressions + (probe.bingImpressions ?? 0);
        const where = probe.bingImpressions !== undefined ? ` (${probe.impressions} Google + ${probe.bingImpressions} Bing)` : "";
        probe.status = total >= probe.minImpressions ? "passed" : "failed";
        probe.note = probe.status === "passed"
          ? `demand shown: ${total} impressions${where} in ${probe.windowDays} days (threshold ${probe.minImpressions})`
          : `too few impressions: ${total}${where} in ${probe.windowDays} days (threshold ${probe.minImpressions})`;
        decided.push(probe);
      }
      report.push(formatProbe(probe, now));
    } catch (err: any) {
      report.push(`- ${probe.id}: check failed (${String(err?.message ?? err).slice(0, 120)})`);
    }
  }
  save(db, probes);
  for (const probe of decided) {
    if (probe.ideaId) {
      const idea = getIdea(db, probe.ideaId);
      if (idea && idea.status === "candidate") {
        upsertIdea(db, { id: probe.ideaId, evidence: [`probe ${probe.id} (${now.toISOString().slice(0, 10)}): ${probe.note} — ${probe.url}`] }, now);
      }
    }
    const emoji = probe.status === "passed" ? "🟢" : "🔴";
    queueOwnerNotification(db, `${emoji} Sonde ${probe.id} ${probe.status === "passed" ? "réussie" : "échouée"} : ${probe.note} (${probe.url}). Le bot est prévenu.`);
    if (options.wake && (!options.canWake || options.canWake())) options.wake(`Sonde ${probe.id} ${probe.status === "passed" ? "réussie" : "échouée"} : ${probe.note}`);
  }
  return report;
}

/** One line for the prompt and the reports. */
export function describeProbes(db: Database.Database, now = new Date()): string {
  const probes = listProbes(db);
  if (probes.length === 0) return "none yet";
  const count = (s: ProbeStatus) => probes.filter((p) => p.status === s).length;
  const live = probes.filter((p) => p.status === "live").map((p) => `${p.id} day ${daysSince(p.createdAt, now)}/${p.windowDays} ${p.impressions} impr.`);
  return `${count("live")} live${live.length ? ` (${live.join("; ")})` : ""}, ${count("passed")} passed, ${count("failed")} failed, ${count("stopped")} stopped`;
}

/** Probe results linked to an idea, for the Opus dossier. */
export function probeEvidenceFor(db: Database.Database, ideaId: string, now = new Date()): string {
  const probes = listProbes(db).filter((p) => p.ideaId === ideaId);
  if (probes.length === 0) return "";
  return `Probes measured by Search Console for this idea:\n${probes.map((p) => formatProbe(p, now)).join("\n")}`;
}
