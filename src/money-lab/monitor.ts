/**
 * Money Lab site monitoring
 *
 * The runtime checks the bot's sites every 30 minutes, for free: the URLs
 * the agent registers with monitor_site plus the http(s) artifact of every
 * active experiment. A site is down after two failed checks in a row; the
 * owner is told on Telegram and the agent is woken once per outage (at most
 * hourly), then both hear when it is back.
 */

import type Database from "better-sqlite3";
import { getKV, getPauseState, listExperiments, queueOwnerNotification, setKV } from "./journal.js";

export const MONITOR_INTERVAL_MS = 30 * 60_000;
const SITES_KEY = "money_lab.monitor.sites";
const STATE_KEY = "money_lab.monitor.state";
const LAST_WAKE_KEY = "money_lab.monitor.last_wake";
export const MAX_MONITORED = 10;
const FAILS_FOR_DOWN = 2;
const TIMEOUT_MS = 15_000;
const WAKE_INTERVAL_MS = 60 * 60_000;
const ACTIVE = new Set(["building", "observing", "waiting_for_owner"]);

type FetchFn = typeof fetch;

export interface SiteState {
  status: "up" | "down" | "unknown";
  since: string;
  lastCheckAt?: string;
  lastResult?: string;
  latencyMs?: number;
  fails: number;
}

function loadState(db: Database.Database): Record<string, SiteState> {
  try {
    const raw = JSON.parse(getKV(db, STATE_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function agentSites(db: Database.Database): string[] {
  try {
    const raw = JSON.parse(getKV(db, SITES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

export function normalizeSiteUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** URLs checked: the agent's list, then active experiments' artifacts (unique, bounded). */
export function monitoredSites(db: Database.Database): string[] {
  const urls = [...agentSites(db)];
  for (const e of listExperiments(db)) {
    if (!ACTIVE.has(e.status) || !e.artifactRef) continue;
    const url = normalizeSiteUrl(e.artifactRef.split(/\s+/)[0]);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, MAX_MONITORED + 3);
}

export function addSite(db: Database.Database, value: string): string {
  const url = normalizeSiteUrl(value);
  if (!url) return "url must be an http(s) address, e.g. https://org.github.io/site/";
  const sites = agentSites(db);
  if (sites.includes(url)) return `${url} is already monitored.`;
  if (sites.length >= MAX_MONITORED) return `At most ${MAX_MONITORED} sites: remove one first.`;
  setKV(db, SITES_KEY, JSON.stringify([...sites, url]));
  return `Monitoring ${url} every 30 minutes.`;
}

export function removeSite(db: Database.Database, value: string): string {
  const url = normalizeSiteUrl(value) ?? value;
  const sites = agentSites(db);
  if (!sites.includes(url)) return `${url} is not in your list (active experiments' artifacts are monitored automatically).`;
  setKV(db, SITES_KEY, JSON.stringify(sites.filter((s) => s !== url)));
  const state = loadState(db);
  delete state[url];
  setKV(db, STATE_KEY, JSON.stringify(state));
  return `Stopped monitoring ${url}.`;
}

/** One check: up for any answer below 400 (and 401/403/429: the site answers, it just refuses bots). */
export async function checkSite(url: string, fetchFn: FetchFn = fetch): Promise<{ ok: boolean; result: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetchFn(url, {
      redirect: "follow",
      headers: { "user-agent": "MoneyLabBot/1.0 (uptime check)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await resp.body?.cancel().catch(() => undefined);
    const ok = resp.status < 400 || [401, 403, 429].includes(resp.status);
    return { ok, result: `HTTP ${resp.status}`, latencyMs: Date.now() - start };
  } catch (err: any) {
    const reason = err?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : String(err?.cause?.code ?? err?.message ?? err).slice(0, 80);
    return { ok: false, result: reason, latencyMs: Date.now() - start };
  }
}

function minutes(fromIso: string, now: Date): string {
  const m = Math.max(1, Math.round((now.getTime() - Date.parse(fromIso)) / 60_000));
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** Checks every monitored site; tells the owner and wakes the agent on a new outage. */
export async function checkSites(
  db: Database.Database,
  options: { fetchFn?: FetchFn; now?: Date; wake?: (reason: string) => void; canWake?: () => boolean } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  if (getPauseState(db)) return [];
  const sites = monitoredSites(db);
  const state = loadState(db);
  const wentDown: string[] = [];
  const report: string[] = [];
  for (const url of sites) {
    const check = await checkSite(url, options.fetchFn);
    const previous = state[url] ?? { status: "unknown", since: now.toISOString(), fails: 0 };
    const next: SiteState = { ...previous, lastCheckAt: now.toISOString(), lastResult: check.result, latencyMs: check.latencyMs };
    if (check.ok) {
      if (previous.status === "down") {
        queueOwnerNotification(db, `🟢 Site de nouveau en ligne : ${url} (hors ligne pendant ${minutes(previous.since, now)}).`);
      }
      if (previous.status !== "up") next.since = now.toISOString();
      next.status = "up";
      next.fails = 0;
    } else {
      next.fails = previous.fails + 1;
      if (previous.status !== "down" && next.fails >= FAILS_FOR_DOWN) {
        next.status = "down";
        next.since = now.toISOString();
        wentDown.push(`${url} (${check.result})`);
        queueOwnerNotification(db, `🔴 Site hors ligne : ${url} (${check.result}, ${next.fails} vérifications de suite). Le bot est prévenu.`);
      }
    }
    state[url] = next;
    report.push(`${url}: ${next.status} (${check.result}, ${check.latencyMs} ms)`);
  }
  // Forget sites no longer monitored.
  for (const url of Object.keys(state)) if (!sites.includes(url)) delete state[url];
  setKV(db, STATE_KEY, JSON.stringify(state));
  if (wentDown.length && options.wake && (options.canWake?.() ?? true)) {
    const last = Number(getKV(db, LAST_WAKE_KEY) ?? "0");
    if (now.getTime() - last >= WAKE_INTERVAL_MS) {
      setKV(db, LAST_WAKE_KEY, String(now.getTime()));
      options.wake(`site down: ${wentDown.join(", ")}`);
    }
  }
  return report;
}

export function siteStates(db: Database.Database): Array<{ url: string } & SiteState> {
  const state = loadState(db);
  return monitoredSites(db).map((url) => ({ url, ...(state[url] ?? { status: "unknown" as const, since: "", fails: 0 }) }));
}

/** One line for the prompt. */
export function describeSites(db: Database.Database, now = new Date()): string {
  const sites = siteStates(db);
  if (sites.length === 0) return "none";
  return sites.map((s) => s.status === "down"
    ? `${s.url} DOWN for ${minutes(s.since, now)} (${s.lastResult ?? "?"})`
    : `${s.url} ${s.status}`).join(", ");
}
