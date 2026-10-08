/**
 * Money Lab web tools policy (free first)
 *
 * Anthropic's server tools web_search and web_fetch are convenient and the
 * agent reaches for them by reflex, but each search is paid and every page
 * fetched lands in the paid context. Once the owner configured Tavily,
 * free_search does the searching for free; once free models are configured,
 * harvest and delegate read pages for free through the reader. This policy
 * removes the paid tools from the request in those cases, so the free path
 * is the only path. MONEY_LAB_WEB_TOOLS=anthropic puts both back,
 * MONEY_LAB_WEB_TOOLS=off removes both.
 */

import type Database from "better-sqlite3";
import { availableFreeProviders, configuredFreeProviders } from "./freeai.js";
import { serviceAvailable, serviceConfigured } from "./services.js";
import { withSecrets } from "./selfhosted.js";

export interface WebToolsPolicy {
  search: boolean;
  fetch: boolean;
  reason: string;
}

export interface PolicyOptions {
  env?: NodeJS.ProcessEnv;
  /** With the database, availability is live: a used-up Tavily quota or resting free models bring the paid tools back. */
  db?: Database.Database;
  now?: Date;
}

/**
 * Which paid tools to attach to the next request. The owner's rule: the paid
 * tools stay off only while the free equivalents are available; the moment
 * Tavily is out of quota or refused, or every free model is resting or out
 * of quota, the paid tool comes back for that request.
 */
export function webToolsPolicy(options: PolicyOptions | NodeJS.ProcessEnv = {}): WebToolsPolicy {
  const opts: PolicyOptions = "env" in options || "db" in options || "now" in options ? options as PolicyOptions : { env: options as NodeJS.ProcessEnv };
  const env = opts.env ?? withSecrets();
  const now = opts.now ?? new Date();
  const override = (env.MONEY_LAB_WEB_TOOLS ?? "").trim().toLowerCase();
  if (override === "anthropic") return { search: true, fetch: true, reason: "forced on by MONEY_LAB_WEB_TOOLS=anthropic" };
  if (override === "off") return { search: false, fetch: false, reason: "forced off by MONEY_LAB_WEB_TOOLS=off" };
  const tavilyConfigured = serviceConfigured("tavily", env);
  const tavilyNow = opts.db ? serviceAvailable(opts.db, "tavily", env, now) : tavilyConfigured;
  const freeConfigured = configuredFreeProviders(env).length > 0;
  const freeNow = opts.db ? availableFreeProviders(opts.db, env, now).length > 0 : freeConfigured;
  const search = !tavilyNow;
  const fetch = !freeNow;
  const reasons: string[] = [];
  if (!search) reasons.push("Tavily (free_search) replaces the paid web_search");
  else if (tavilyConfigured) reasons.push("Tavily is out of quota or refused: the paid web_search is back for now");
  if (!fetch) reasons.push("free models (harvest, delegate through the reader) replace the paid web_fetch");
  else if (freeConfigured) reasons.push("every free model is resting or out of quota: the paid web_fetch is back for now");
  return { search, fetch, reason: reasons.length ? reasons.join("; ") : "no free alternative configured" };
}

/** One sentence for the mission prompt. */
export function describeWebTools(policy: WebToolsPolicy = webToolsPolicy()): string {
  if (policy.search && policy.fetch && !/back for now/.test(policy.reason)) {
    return "Research: the web_search and web_fetch tools search the web and read pages (about 1 cent per search plus " +
      "the tokens read). Keep durable notes in ~/research/ (sources with dates): your context window forgets.";
  }
  const parts = [
    policy.search
      ? "web_search searches the web (about 1 cent per search) while the free search is unavailable"
      : "free_search (Tavily) searches the web for free; the paid web_search is off while Tavily is available",
    policy.fetch
      ? "web_fetch reads a page into your context (paid tokens) while the free models are unavailable"
      : "harvest and delegate read pages for free through the reader (summaries, not raw pages); the paid web_fetch is off while a free model is available",
  ];
  return `Research: ${parts.join("; ")}. Keep durable notes in ~/research/ (sources with dates): your context window forgets.`;
}
