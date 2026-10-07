/**
 * Money Lab free services with owner accounts (step 5b)
 *
 * Every service here has a permanent free tier that needs an account the
 * owner creates (see the guide). The runtime calls them with keys the agent
 * never sees (sealed like the other secrets); the agent only gets results.
 * Each service has a daily cap below its free quota, counted in KV, so the
 * bot can run for months without a surprise.
 *
 * - Tavily: web search built for agents (1,000 credits a month).
 * - Bing Webmaster: what Bing shows for the bot's sites, URL submission.
 * - INSEE Sirene: how many French businesses exist in a trade and area.
 * - API Adresse (data.geopf.fr): French geocoding, no account.
 * - Légifrance through PISTE: French law and regulation search.
 * - UptimeRobot: external checks of the bot's sites every 5 minutes.
 * - Resend: e-mail to the owner for reports too long for Telegram.
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "./journal.js";
import { withSecrets } from "./selfhosted.js";

type FetchFn = typeof fetch;
const TIMEOUT_MS = 20_000;
const USAGE_KEY = "money_lab.services";

export interface ServiceOptions {
  fetchFn?: FetchFn;
  env?: NodeJS.ProcessEnv;
  db?: Database.Database;
  now?: Date;
}

/** Daily caps, each well under the provider's free quota. */
export const SERVICE_DAILY_CAPS: Record<string, number> = {
  tavily: 30, // 1,000 credits a month
  bing: 100,
  sirene: 200, // 30 a minute
  adresse: 300, // 50 a second, no account
  legifrance: 50,
  uptimerobot: 50,
  email: 3,
};

export const SERVICE_ENV: Record<string, string[]> = {
  tavily: ["TAVILY_API_KEY"],
  bing: ["BING_WEBMASTER_KEY"],
  sirene: ["INSEE_API_KEY"],
  legifrance: ["PISTE_CLIENT_ID", "PISTE_CLIENT_SECRET"],
  uptimerobot: ["UPTIMEROBOT_API_KEY"],
  email: ["RESEND_API_KEY", "MONEY_LAB_OWNER_EMAIL"],
  devto: ["DEVTO_API_KEY"],
  mastodon: ["MASTODON_INSTANCE", "MASTODON_TOKEN"],
  pages: ["CLOUDFLARE_PAGES_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
};

export function serviceConfigured(name: string, env: NodeJS.ProcessEnv = withSecrets()): boolean {
  return (SERVICE_ENV[name] ?? []).every((key) => Boolean(env[key]?.trim()));
}

/** Names of the services the owner has set up (for the prompt, the log and the health report). */
export function configuredServices(env: NodeJS.ProcessEnv = withSecrets()): string[] {
  return Object.keys(SERVICE_ENV).filter((name) => serviceConfigured(name, env));
}

interface Usage { day: string; counts: Record<string, number> }

function loadUsage(db: Database.Database, now: Date): Usage {
  const day = now.toISOString().slice(0, 10);
  try {
    const raw = JSON.parse(getKV(db, USAGE_KEY) ?? "{}") as Usage;
    if (raw && raw.day === day && raw.counts) return raw;
  } catch { /* fresh */ }
  return { day, counts: {} };
}

/**
 * Counts one call; returns null when allowed, else the refusal text. The
 * count happens before the call: a failed call still costs quota upstream.
 */
export function takeServiceQuota(db: Database.Database | undefined, name: string, now = new Date()): string | null {
  if (!db) return null;
  const usage = loadUsage(db, now);
  const cap = SERVICE_DAILY_CAPS[name] ?? 100;
  const used = usage.counts[name] ?? 0;
  if (used >= cap) return `${name}: daily cap reached (${used}/${cap}); it resets at midnight UTC. Use the free alternatives meanwhile.`;
  usage.counts[name] = used + 1;
  setKV(db, USAGE_KEY, JSON.stringify(usage));
  return null;
}

export function servicesUsageToday(db: Database.Database, now = new Date()): string {
  const usage = loadUsage(db, now);
  const parts = Object.entries(usage.counts).map(([name, n]) => `${name} ${n}/${SERVICE_DAILY_CAPS[name] ?? "?"}`);
  return parts.length ? parts.join(", ") : "aucun appel aujourd'hui";
}

async function call(fetchFn: FetchFn, url: string, init: RequestInit, label: string): Promise<any> {
  const resp = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    const err: any = new Error(`${label} HTTP ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label}: unreadable answer`);
  }
}

// ─── Tavily ─────────────────────────────────────────────────────

export interface TavilyArgs {
  query: string;
  maxResults?: number;
  depth?: "basic" | "advanced";
  includeDomains?: string[];
  days?: number;
}

/** Web search through Tavily: an answer plus sources, built for agents. advanced costs 2 credits. */
export async function tavilySearch(args: TavilyArgs, options: ServiceOptions = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  const key = env.TAVILY_API_KEY?.trim();
  if (!key) return "Tavily is not configured (TAVILY_API_KEY): ask the owner, or use the paid web search sparingly.";
  const query = args.query.trim().slice(0, 400);
  if (!query) return "query is required.";
  const refused = takeServiceQuota(options.db, "tavily", options.now);
  if (refused) return refused;
  const body: Record<string, unknown> = {
    query,
    search_depth: args.depth === "advanced" ? "advanced" : "basic",
    max_results: Math.min(10, Math.max(1, Math.floor(args.maxResults ?? 6))),
    include_answer: "basic",
  };
  if (args.includeDomains?.length) body.include_domains = args.includeDomains.slice(0, 10);
  if (args.days && args.days > 0) { body.topic = "news"; body.days = Math.floor(args.days); }
  const data = await call(options.fetchFn ?? fetch, "https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, "Tavily");
  const results: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }> = Array.isArray(data.results) ? data.results : [];
  const lines = [`Tavily search "${query}" (${body.search_depth}, ${results.length} results)`];
  if (data.answer) lines.push(`Answer: ${String(data.answer).slice(0, 800)}`);
  for (const r of results) {
    lines.push(`- ${(r.title ?? "").slice(0, 120)} — ${r.url ?? ""}${r.published_date ? ` (${String(r.published_date).slice(0, 10)})` : ""}`);
    if (r.content) lines.push(`  ${String(r.content).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return lines.join("\n");
}

// ─── Bing Webmaster ─────────────────────────────────────────────

const BING_API = "https://ssl.bing.com/webmaster/api.svc/json";

export interface BingRow { Query?: string; Impressions?: number; Clicks?: number; AvgImpressionPosition?: number; Date?: string }

/** Raw Bing rows (queries or pages; Query holds the page URL for pages). Throws without a key or on HTTP errors. */
export async function bingRows(site: string, dimension: "query" | "page", options: ServiceOptions = {}): Promise<BingRow[]> {
  const env = options.env ?? withSecrets();
  const key = env.BING_WEBMASTER_KEY?.trim();
  if (!key) throw new Error("Bing Webmaster is not configured (BING_WEBMASTER_KEY).");
  const refused = takeServiceQuota(options.db, "bing", options.now);
  if (refused) throw new Error(refused);
  const method = dimension === "page" ? "GetPageStats" : "GetQueryStats";
  const data = await call(options.fetchFn ?? fetch, `${BING_API}/${method}?siteUrl=${encodeURIComponent(site)}&apikey=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } }, "Bing Webmaster");
  return Array.isArray(data.d) ? data.d : [];
}

export async function bingQueryStats(site: string, options: ServiceOptions & { dimension?: "query" | "page" } = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  if (!env.BING_WEBMASTER_KEY?.trim()) return "Bing Webmaster is not configured (BING_WEBMASTER_KEY): ask the owner.";
  let rows: BingRow[];
  try {
    rows = await bingRows(site, options.dimension === "page" ? "page" : "query", { ...options, env });
  } catch (err: any) {
    if (/daily cap reached/.test(String(err?.message))) return String(err.message);
    throw err;
  }
  if (rows.length === 0) return `Bing Webmaster: no ${options.dimension === "page" ? "page" : "query"} data yet for ${site} (Bing needs a few days after verification).`;
  const sorted = [...rows].sort((a, b) => (b.Impressions ?? 0) - (a.Impressions ?? 0)).slice(0, 25);
  const total = rows.reduce((n, r) => n + (r.Impressions ?? 0), 0);
  const clicks = rows.reduce((n, r) => n + (r.Clicks ?? 0), 0);
  return [`Bing ${options.dimension === "page" ? "pages" : "queries"} for ${site}: ${total} impressions, ${clicks} clicks (${rows.length} rows)`,
    ...sorted.map((r) => `- ${String(r.Query ?? "").slice(0, 100)}: ${r.Impressions ?? 0} impr., ${r.Clicks ?? 0} clicks${r.AvgImpressionPosition ? `, position ${Number(r.AvgImpressionPosition).toFixed(1)}` : ""}`)].join("\n");
}

export async function bingSubmitUrls(site: string, urls: string[], options: ServiceOptions = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  const key = env.BING_WEBMASTER_KEY?.trim();
  if (!key) return "Bing Webmaster is not configured (BING_WEBMASTER_KEY): ask the owner.";
  const list = urls.map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u)).slice(0, 50);
  if (list.length === 0) return "urls: at least one http(s) URL under the site.";
  const refused = takeServiceQuota(options.db, "bing", options.now);
  if (refused) return refused;
  await call(options.fetchFn ?? fetch, `${BING_API}/SubmitUrlBatch?apikey=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteUrl: site, urlList: list }),
  }, "Bing Webmaster");
  return `Submitted ${list.length} URL(s) to Bing for ${site}.`;
}

// ─── INSEE Sirene ───────────────────────────────────────────────

export interface SireneArgs {
  naf?: string;
  postcode?: string;
  department?: string;
  keyword?: string;
  sample?: number;
}

function sireneQuery(args: SireneArgs): string | null {
  const parts: string[] = [];
  const period: string[] = ["etatAdministratifEtablissement:A"];
  const naf = args.naf?.trim().toUpperCase();
  if (naf) {
    if (!/^\d{2}(\.\d{2}[A-Z]?)?$/.test(naf)) return null;
    period.push(naf.length === 2 ? `activitePrincipaleEtablissement:${naf}*` : `activitePrincipaleEtablissement:${naf}`);
  }
  parts.push(`periode(${period.join(" AND ")})`);
  const postcode = args.postcode?.trim();
  const department = args.department?.trim();
  if (postcode && /^\d{2,5}$/.test(postcode)) parts.push(`codePostalEtablissement:${postcode}${postcode.length < 5 ? "*" : ""}`);
  else if (department && /^(\d{2}|2A|2B|97\d)$/i.test(department)) parts.push(`codePostalEtablissement:${department.toUpperCase().replace(/^2A$/, "200").replace(/^2B$/, "202")}*`);
  const keyword = args.keyword?.trim().replace(/["\\]/g, "");
  if (keyword) parts.push(`denominationUniteLegale:"${keyword}"`);
  if (parts.length === 1 && !naf) return null;
  return parts.join(" AND ");
}

/** How many active French establishments match a trade (NAF code) and an area; a few names as a sample. */
export async function sireneCount(args: SireneArgs, options: ServiceOptions = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  const key = env.INSEE_API_KEY?.trim();
  if (!key) return "Sirene is not configured (INSEE_API_KEY): ask the owner.";
  const q = sireneQuery(args);
  if (!q) return "Give a NAF code (e.g. 43.22A for plumbers, 56.10A restaurants, 96.02A hairdressers; 2 digits for a whole division) and optionally a postcode prefix, a department or a name keyword.";
  const refused = takeServiceQuota(options.db, "sirene", options.now);
  if (refused) return refused;
  const sample = Math.min(20, Math.max(0, Math.floor(args.sample ?? 8)));
  const url = `https://api.insee.fr/api-sirene/3.11/siret?q=${encodeURIComponent(q)}&nombre=${sample}&tri=dateCreationEtablissement`;
  let data: any;
  try {
    data = await call(options.fetchFn ?? fetch, url, { headers: { accept: "application/json", "X-INSEE-Api-Key-Integration": key } }, "Sirene");
  } catch (err: any) {
    if (err?.status === 404) return `Sirene: no active establishment matches ${q}.`;
    throw err;
  }
  const total = Number(data?.header?.total ?? 0);
  const rows: any[] = Array.isArray(data?.etablissements) ? data.etablissements : [];
  const names = rows.map((e) => {
    const u = e.uniteLegale ?? {};
    const name = u.denominationUniteLegale || [u.prenom1UniteLegale, u.nomUniteLegale].filter(Boolean).join(" ") || "(name withheld)";
    const a = e.adresseEtablissement ?? {};
    return `- ${name} — ${a.codePostalEtablissement ?? ""} ${a.libelleCommuneEtablissement ?? ""}${u.dateCreationUniteLegale ? ` (since ${String(u.dateCreationUniteLegale).slice(0, 4)})` : ""}`.trim();
  });
  return [`Sirene: ${total.toLocaleString("en-US")} active establishment(s) for ${q}`, ...names].join("\n");
}

// ─── API Adresse (no account) ───────────────────────────────────

export async function geocode(query: string, options: ServiceOptions & { limit?: number } = {}): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (q.length < 3) return "query: an address, a town or a postcode.";
  const refused = takeServiceQuota(options.db, "adresse", options.now);
  if (refused) return refused;
  const limit = Math.min(10, Math.max(1, Math.floor(options.limit ?? 5)));
  const data = await call(options.fetchFn ?? fetch, `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: { accept: "application/json" } }, "API Adresse");
  const features: any[] = Array.isArray(data?.features) ? data.features : [];
  if (features.length === 0) return `API Adresse: nothing found for "${q}".`;
  return features.map((f) => {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    return `- ${p.label ?? ""} (${p.type ?? ""}, ${p.context ?? ""}; score ${Number(p.score ?? 0).toFixed(2)})${lat !== undefined ? ` at ${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}` : ""}${p.population ? `, population ${p.population}` : ""}`;
  }).join("\n");
}

// ─── Légifrance (PISTE) ─────────────────────────────────────────

let pisteToken: { token: string; expires: number; host: string } | null = null;

export function resetPisteToken(): void {
  pisteToken = null;
}

function pisteHosts(env: NodeJS.ProcessEnv): { oauth: string; api: string } {
  return env.PISTE_SANDBOX === "1"
    ? { oauth: "https://sandbox-oauth.piste.gouv.fr", api: "https://sandbox-api.piste.gouv.fr" }
    : { oauth: "https://oauth.piste.gouv.fr", api: "https://api.piste.gouv.fr" };
}

async function pisteAccessToken(env: NodeJS.ProcessEnv, fetchFn: FetchFn, now: number): Promise<string> {
  const hosts = pisteHosts(env);
  if (pisteToken && pisteToken.host === hosts.api && pisteToken.expires > now + 60_000) return pisteToken.token;
  const data = await call(fetchFn, `${hosts.oauth}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: env.PISTE_CLIENT_ID!.trim(), client_secret: env.PISTE_CLIENT_SECRET!.trim(), scope: "openid",
    }).toString(),
  }, "PISTE token");
  if (!data.access_token) throw new Error("PISTE token: no access_token");
  pisteToken = { token: data.access_token, expires: now + Number(data.expires_in ?? 3600) * 1000, host: hosts.api };
  return pisteToken.token;
}

export const LEGIFRANCE_FONDS = ["ALL", "CODE_DATE", "LODA_DATE", "JORF", "KALI", "CETAT", "JURI", "CNIL"] as const;

/** Full-text search in French law (codes, laws, decrees, case law, collective agreements). */
export async function legifranceSearch(query: string, options: ServiceOptions & { fond?: string; pageSize?: number } = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  if (!env.PISTE_CLIENT_ID?.trim() || !env.PISTE_CLIENT_SECRET?.trim()) return "Légifrance is not configured (PISTE_CLIENT_ID and PISTE_CLIENT_SECRET): ask the owner.";
  const q = query.trim().slice(0, 300);
  if (!q) return "query is required.";
  const refused = takeServiceQuota(options.db, "legifrance", options.now);
  if (refused) return refused;
  const fetchFn = options.fetchFn ?? fetch;
  const now = (options.now ?? new Date()).getTime();
  const fond = (LEGIFRANCE_FONDS as readonly string[]).includes(options.fond ?? "") ? options.fond! : "ALL";
  const token = await pisteAccessToken(env, fetchFn, now);
  const data = await call(fetchFn, `${pisteHosts(env).api}/dila/legifrance/lf-engine-app/search`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fond,
      recherche: {
        champs: [{ typeChamp: "ALL", criteres: [{ typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: q, operateur: "ET" }], operateur: "ET" }],
        filtres: [], pageNumber: 1, pageSize: Math.min(20, Math.max(1, Math.floor(options.pageSize ?? 8))),
        operateur: "ET", sort: "PERTINENCE", typePagination: "DEFAUT",
      },
    }),
  }, "Légifrance");
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) return `Légifrance: nothing for "${q}" in ${fond}.`;
  const lines = [`Légifrance "${q}" (${fond}): ${data.totalResultNumber ?? results.length} result(s)`];
  for (const r of results) {
    const title = r.titles?.[0] ?? {};
    const extract = (r.sections ?? []).flatMap((s: any) => s.extracts ?? []).flatMap((e: any) => e.values ?? [])
      .map((v: any) => String(v).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean)[0];
    lines.push(`- ${String(title.title ?? "").slice(0, 160)}${r.nature ? ` [${r.nature}]` : ""}${r.date ? ` ${String(r.date).slice(0, 10)}` : ""}${title.id ? ` — https://www.legifrance.gouv.fr/search/all?query=${encodeURIComponent(title.id)}` : ""}`);
    if (extract) lines.push(`  ${extract.slice(0, 240)}`);
  }
  return lines.join("\n");
}

// ─── UptimeRobot ────────────────────────────────────────────────

const UPTIMEROBOT_API = "https://api.uptimerobot.com/v2";
const UPTIME_STATUS: Record<number, string> = { 0: "paused", 1: "not checked yet", 2: "up", 8: "seems down", 9: "down" };

async function uptimeRobot(method: string, params: Record<string, string>, options: ServiceOptions): Promise<any> {
  const env = options.env ?? withSecrets();
  const key = env.UPTIMEROBOT_API_KEY?.trim();
  if (!key) throw new Error("UptimeRobot is not configured (UPTIMEROBOT_API_KEY).");
  const data = await call(options.fetchFn ?? fetch, `${UPTIMEROBOT_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
    body: new URLSearchParams({ api_key: key, format: "json", ...params }).toString(),
  }, "UptimeRobot");
  if (data.stat !== "ok") throw new Error(`UptimeRobot: ${data.error?.message ?? data.error?.type ?? "refused"}`);
  return data;
}

/** External check every 5 minutes (free plan), in addition to the runtime's own 30-minute check. */
export async function uptimeRobotCreate(url: string, options: ServiceOptions = {}): Promise<string> {
  if (!serviceConfigured("uptimerobot", options.env)) return "";
  const refused = takeServiceQuota(options.db, "uptimerobot", options.now);
  if (refused) return refused;
  try {
    const name = url.replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 50);
    const data = await uptimeRobot("newMonitor", { type: "1", url, friendly_name: name, interval: "300" }, options);
    return `UptimeRobot checks it every 5 minutes too (monitor ${data.monitor?.id ?? "?"}).`;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    return /already exists|exists/i.test(msg) ? "UptimeRobot already checks it." : `UptimeRobot: ${msg.slice(0, 160)}`;
  }
}

export async function uptimeRobotStatus(options: ServiceOptions = {}): Promise<string> {
  if (!serviceConfigured("uptimerobot", options.env)) return "";
  const refused = takeServiceQuota(options.db, "uptimerobot", options.now);
  if (refused) return refused;
  try {
    const data = await uptimeRobot("getMonitors", { all_time_uptime_ratio: "1" }, options);
    const monitors: any[] = Array.isArray(data.monitors) ? data.monitors : [];
    if (monitors.length === 0) return "UptimeRobot: no monitor yet.";
    return `UptimeRobot (external, every 5 min):\n${monitors.map((m) => `- ${m.url}: ${UPTIME_STATUS[Number(m.status)] ?? m.status}${m.all_time_uptime_ratio ? `, uptime ${Number(m.all_time_uptime_ratio).toFixed(2)}%` : ""}`).join("\n")}`;
  } catch (err: any) {
    return `UptimeRobot: ${String(err?.message ?? err).slice(0, 160)}`;
  }
}

// ─── E-mail to the owner (Resend) ───────────────────────────────

/** Sends to the owner's own address only: long reports Telegram would cut. */
export async function emailOwner(subject: string, text: string, options: ServiceOptions = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  const key = env.RESEND_API_KEY?.trim();
  const to = env.MONEY_LAB_OWNER_EMAIL?.trim();
  if (!key || !to) return "E-mail is not configured (RESEND_API_KEY and MONEY_LAB_OWNER_EMAIL): use message_owner.";
  const subj = subject.trim().slice(0, 150);
  const body = text.trim().slice(0, 60_000);
  if (!subj || body.length < 20) return "subject and text (20+ characters) are required.";
  const refused = takeServiceQuota(options.db, "email", options.now);
  if (refused) return refused;
  const data = await call(options.fetchFn ?? fetch, "https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: env.RESEND_FROM?.trim() || "Money Lab <onboarding@resend.dev>", to: [to], subject: `[Money Lab] ${subj}`, text: body }),
  }, "Resend");
  return `E-mail sent to the owner (${data.id ?? "queued"}): "${subj}", ${body.length} characters.`;
}
