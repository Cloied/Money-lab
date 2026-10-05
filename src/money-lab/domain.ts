/**
 * Money Lab domain availability (RDAP)
 *
 * Asks the registries' public RDAP service whether domain names are
 * registered: 404 means nobody holds the name (it is very likely free to
 * buy), 200 means it is taken (with its expiry date). No account, no cost.
 * The agent then asks the owner to buy the chosen name.
 */

type FetchFn = typeof fetch;

const NAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const MAX_DOMAINS = 20;

export interface DomainStatus {
  domain: string;
  status: "available" | "taken" | "unknown" | "invalid";
  detail: string;
}

export async function checkDomain(domain: string, fetchFn: FetchFn = fetch): Promise<DomainStatus> {
  const name = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!NAME.test(name)) return { domain: name, status: "invalid", detail: "not a valid domain name" };
  try {
    const resp = await fetchFn(`https://rdap.org/domain/${name}`, {
      headers: { accept: "application/rdap+json" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 404) return { domain: name, status: "available", detail: "no registration found: very likely free (confirm at the registrar)" };
    if (resp.ok) {
      const data = await resp.json().catch(() => ({})) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
      const expiry = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
      return { domain: name, status: "taken", detail: `registered${expiry ? `, expires ${expiry.slice(0, 10)}` : ""}` };
    }
    return { domain: name, status: "unknown", detail: `registry answered HTTP ${resp.status}` };
  } catch (err: any) {
    return { domain: name, status: "unknown", detail: String(err?.message ?? err).slice(0, 100) };
  }
}

export async function checkDomains(domains: string[], fetchFn: FetchFn = fetch): Promise<string> {
  const unique = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_DOMAINS);
  if (unique.length === 0) return "Give at least one domain name, e.g. devis-artisan.fr.";
  const results = await Promise.all(unique.map((d) => checkDomain(d, fetchFn)));
  const icon = { available: "FREE", taken: "TAKEN", unknown: "?", invalid: "INVALID" };
  return results.map((r) => `${icon[r.status]} ${r.domain}: ${r.detail}`).join("\n") +
    "\nPrices vary by extension (.fr and .com are about 8-15 EUR/year at OVH): check them with web_search before asking the owner.";
}
