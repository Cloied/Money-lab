/**
 * Money Lab IndexNow
 *
 * Owner plan (2026-10-07), step 5a: Bing, Yandex and the other IndexNow
 * engines index a new page within minutes when they are told about it,
 * instead of weeks. The key is a text file hosted on the site (written by
 * scaffold_site); a probe page is submitted when it is registered. Google
 * is not part of IndexNow: Search Console and the sitemap still cover it.
 */

import crypto from "crypto";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const TIMEOUT_MS = 15_000;

/** Stable per host (or the owner's fixed key), so the key file never changes. */
export function indexNowKey(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env.MONEY_LAB_INDEXNOW_KEY?.trim();
  if (fixed && /^[a-zA-Z0-9-]{8,128}$/.test(fixed)) return fixed;
  return crypto.createHash("sha256").update(`money-lab-indexnow:${host.toLowerCase()}`).digest("hex").slice(0, 32);
}

/** Where the key file must live for URLs under `base` (a GitHub Pages project site has its own folder). */
export function indexNowKeyLocation(base: URL, env: NodeJS.ProcessEnv = process.env): string {
  const key = indexNowKey(base.hostname, env);
  const dir = base.pathname.endsWith("/") ? base.pathname : `${base.pathname.replace(/[^/]*$/, "")}`;
  return `${base.origin}${dir}${key}.txt`;
}

/**
 * Submits URLs of one host. Returns a one-line status; never throws (the
 * ping is best effort). 200 and 202 mean accepted; 422 means the key file
 * was not found where keyLocation says; 429 means too many submissions.
 */
export async function submitIndexNow(
  urls: string[],
  options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv; keyLocation?: string } = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const env = options.env ?? process.env;
  const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, 10_000);
  if (list.length === 0) return "IndexNow: nothing to submit.";
  let base: URL;
  try {
    base = new URL(list[0]);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error();
  } catch {
    return "IndexNow: not submitted (the first URL is not http(s)).";
  }
  const sameHost = list.filter((u) => { try { return new URL(u).hostname === base.hostname; } catch { return false; } });
  const keyLocation = options.keyLocation ?? indexNowKeyLocation(base, env);
  try {
    const resp = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: base.hostname, key: indexNowKey(base.hostname, env), keyLocation, urlList: sameHost }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resp.status === 200 || resp.status === 202) return `IndexNow: ${sameHost.length} URL(s) submitted to Bing, Yandex and partners (HTTP ${resp.status}).`;
    if (resp.status === 422) return `IndexNow: key file not found at ${keyLocation} (HTTP 422); publish the site with its key file first.`;
    if (resp.status === 429) return "IndexNow: too many submissions today (HTTP 429); try tomorrow.";
    return `IndexNow: HTTP ${resp.status}.`;
  } catch (err: any) {
    return `IndexNow: not reached (${String(err?.message ?? err).slice(0, 80)}).`;
  }
}
