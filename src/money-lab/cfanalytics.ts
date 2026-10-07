/**
 * Money Lab Cloudflare Web Analytics (read, PR 6)
 *
 * scaffold_site places the Web Analytics beacon when CF_WEB_ANALYTICS_TOKEN
 * is set; this module reads the numbers back through Cloudflare's GraphQL
 * API with the owner's token (Account Analytics: Read). The site is found
 * from its hostname in the account's Web Analytics sites; the last N days
 * of page views are grouped by page, referrer, country, device and day.
 */

import { withSecrets } from "./selfhosted.js";

type FetchFn = typeof fetch;
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 20_000;

export function cfAnalyticsConfigured(env: NodeJS.ProcessEnv = withSecrets()): boolean {
  return Boolean(env.CLOUDFLARE_PAGES_TOKEN?.trim() && env.CLOUDFLARE_ACCOUNT_ID?.trim());
}

interface SiteInfo { site_tag: string; host?: string; snippet?: string; created?: string }

async function cfJson(fetchFn: FetchFn, url: string, token: string, init: RequestInit = {}): Promise<any> {
  const resp = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
  });
  const text = await resp.text().catch(() => "");
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Cloudflare: unreadable answer (HTTP ${resp.status})`); }
  if (!resp.ok) throw new Error(`Cloudflare HTTP ${resp.status}: ${(data.errors?.[0]?.message ?? text).slice(0, 200)}`);
  if (Array.isArray(data.errors) && data.errors.length) throw new Error(`Cloudflare: ${String(data.errors[0].message ?? "error").slice(0, 200)}`);
  return data;
}

/** The account's Web Analytics sites (host and tag). */
export async function listAnalyticsSites(options: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn } = {}): Promise<SiteInfo[]> {
  const env = options.env ?? withSecrets();
  const data = await cfJson(options.fetchFn ?? fetch, `${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID!.trim()}/rum/site_info/list?per_page=50`, env.CLOUDFLARE_PAGES_TOKEN!.trim());
  const sites: any[] = Array.isArray(data.result) ? data.result : [];
  return sites.map((s) => ({ site_tag: String(s.site_tag ?? ""), host: s.ruleset?.zone_name ?? s.host ?? undefined, snippet: s.snippet, created: s.created }));
}

function groupQuery(alias: string, dimension: string, limit: number, order: string): string {
  return `${alias}: rumPageloadEventsAdaptiveGroups(limit: ${limit}, filter: $filter, orderBy: [${order}]) { count sum { visits } dimensions { ${dimension} } }`;
}

export interface AnalyticsArgs {
  host?: string;
  days?: number;
}

/** Page views, visits, pages, referrers, countries, devices and the daily curve for one site. */
export async function webAnalytics(args: AnalyticsArgs, options: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn; now?: Date } = {}): Promise<string> {
  const env = options.env ?? withSecrets();
  if (!cfAnalyticsConfigured(env)) return "Cloudflare Web Analytics is not readable (CLOUDFLARE_PAGES_TOKEN with Account Analytics: Read, CLOUDFLARE_ACCOUNT_ID): ask the owner, or read GoatCounter.";
  const fetchFn = options.fetchFn ?? fetch;
  const sites = await listAnalyticsSites({ env, fetchFn });
  if (sites.length === 0) return "No Web Analytics site in the Cloudflare account yet: the owner adds the site in Analytics & Logs → Web Analytics (the beacon token is already placed by scaffold_site).";
  const host = args.host?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const site = host ? sites.find((s) => (s.host ?? "").toLowerCase() === host) : sites[0];
  if (!site) return `No Web Analytics site for ${host}. Known: ${sites.map((s) => s.host ?? s.site_tag).join(", ")}.`;
  const days = Math.min(90, Math.max(1, Math.floor(args.days ?? 28)));
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const query = `query ($accountTag: string, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: $filter) { count sum { visits } }
    ${groupQuery("pages", "requestPath", 15, "count_DESC")}
    ${groupQuery("referers", "refererHost", 10, "count_DESC")}
    ${groupQuery("countries", "countryName", 8, "count_DESC")}
    ${groupQuery("devices", "deviceType", 4, "count_DESC")}
    ${groupQuery("days", "date", 90, "date_ASC")}
  } }
}`;
  const data = await cfJson(fetchFn, `${API}/graphql`, env.CLOUDFLARE_PAGES_TOKEN!.trim(), {
    method: "POST",
    body: JSON.stringify({ query, variables: { accountTag: env.CLOUDFLARE_ACCOUNT_ID!.trim(), filter: { siteTag: site.site_tag, datetime_geq: since, datetime_leq: now.toISOString() } } }),
  });
  const account = data?.data?.viewer?.accounts?.[0];
  if (!account) return `Cloudflare Web Analytics: no data for ${site.host ?? site.site_tag}.`;
  const total = account.total?.[0];
  const row = (r: any, dim: string) => `${String(r.dimensions?.[dim] ?? "(unknown)").slice(0, 80)}: ${r.count} views, ${r.sum?.visits ?? 0} visits`;
  const section = (title: string, rows: any[], dim: string) => rows?.length ? [`${title}:`, ...rows.map((r) => `- ${row(r, dim)}`)] : [];
  const daysRows: any[] = account.days ?? [];
  const curve = daysRows.map((r) => `${String(r.dimensions?.date ?? "").slice(5)} ${r.count}`).join(", ");
  return [
    `Cloudflare Web Analytics for ${site.host ?? site.site_tag}, last ${days} days: ${total?.count ?? 0} page views, ${total?.sum?.visits ?? 0} visits.`,
    ...section("Pages", account.pages, "requestPath"),
    ...section("Referrers", account.referers, "refererHost"),
    ...section("Countries", account.countries, "countryName"),
    ...section("Devices", account.devices, "deviceType"),
    curve ? `Views per day: ${curve}` : "",
  ].filter(Boolean).join("\n");
}
