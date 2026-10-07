/**
 * Money Lab free capability pack (step 5b): services with owner accounts,
 * Cloudflare Pages deployment, kits posted by the runtime. Every network
 * call and command is stubbed; keys are fakes and must never leak.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonDatabase } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, pendingOwnerNotifications } from "../../money-lab/journal.js";
import {
  SERVICE_DAILY_CAPS, bingQueryStats, bingSubmitUrls, configuredServices, emailOwner, geocode, legifranceSearch, resetPisteToken,
  servicesUsageToday, sireneCount, takeServiceQuota, tavilySearch, uptimeRobotCreate, uptimeRobotStatus,
} from "../../money-lab/services.js";
import { deploySite, wranglerCommand } from "../../money-lab/deploy.js";
import { decideKit, draftKit, formatKitForOwner, kitChannel, listKits, publishApprovedKits } from "../../money-lab/kits.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { SECRET_ENV_VARS, redactSecrets } from "../../money-lab/selfhosted.js";

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp("money-lab-pack-b-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
  resetPisteToken();
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = new Date("2026-10-08T09:00:00Z");

describe("Service quotas", () => {
  it("counts calls per day under each cap and reports usage", () => {
    const db = openDb();
    for (let i = 0; i < SERVICE_DAILY_CAPS.email; i++) expect(takeServiceQuota(db.raw, "email", now)).toBeNull();
    expect(takeServiceQuota(db.raw, "email", now)).toContain("daily cap reached (3/3)");
    expect(servicesUsageToday(db.raw, now)).toBe("email 3/3");
    // A new day starts fresh.
    expect(takeServiceQuota(db.raw, "email", new Date("2026-10-09T00:01:00Z"))).toBeNull();
    expect(takeServiceQuota(undefined, "email")).toBeNull();
  });

  it("lists the configured services from the environment and seals every key", () => {
    expect(configuredServices({})).toEqual([]);
    expect(configuredServices({ TAVILY_API_KEY: "tvly-x", PISTE_CLIENT_ID: "id", MASTODON_INSTANCE: "piaille.fr", MASTODON_TOKEN: "t" })).toEqual(["tavily", "mastodon"]);
    for (const key of ["TAVILY_API_KEY", "BING_WEBMASTER_KEY", "INSEE_API_KEY", "PISTE_CLIENT_SECRET", "DEVTO_API_KEY", "MASTODON_TOKEN", "RESEND_API_KEY", "UPTIMEROBOT_API_KEY", "CLOUDFLARE_PAGES_TOKEN"]) {
      expect(SECRET_ENV_VARS).toContain(key);
    }
    expect(redactSecrets("key tvly-abcdefghijklmnopqrstuvwxyz0123 and re_abcdefghijklmnopqrstuvwxyz0123 and u123456-0123456789abcdef0123456789", {})).not.toMatch(/tvly-abc|re_abc|u123456-0123/);
  });
});

describe("Tavily, Bing, Sirene, Adresse, Légifrance", () => {
  it("searches through Tavily with the bearer key, formats the answer and sources, respects the cap", async () => {
    const db = openDb();
    const calls: any[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) });
      return json({ answer: "Les plombiers facturent 60 à 90 € de l'heure.", results: [{ title: "Tarifs plombier 2026", url: "https://example.fr/tarifs", content: "Le tarif horaire moyen…", score: 0.9 }] });
    }) as any;
    expect(await tavilySearch({ query: "x" }, { env: {}, fetchFn })).toContain("not configured");
    const out = await tavilySearch({ query: "tarif plombier 2026", includeDomains: ["example.fr"], maxResults: 3 }, { env: { TAVILY_API_KEY: "tvly-test" }, fetchFn, db: db.raw, now });
    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect((calls[0].headers as any).authorization).toBe("Bearer tvly-test");
    expect(calls[0].body).toMatchObject({ query: "tarif plombier 2026", search_depth: "basic", max_results: 3, include_domains: ["example.fr"] });
    expect(out).toContain("Answer: Les plombiers facturent");
    expect(out).toContain("- Tarifs plombier 2026 — https://example.fr/tarifs");
    expect(out).not.toContain("tvly-test");
    for (let i = 1; i < SERVICE_DAILY_CAPS.tavily; i++) await tavilySearch({ query: `q${i}` }, { env: { TAVILY_API_KEY: "tvly-test" }, fetchFn, db: db.raw, now });
    expect(await tavilySearch({ query: "one more" }, { env: { TAVILY_API_KEY: "tvly-test" }, fetchFn, db: db.raw, now })).toContain("daily cap reached");
  });

  it("reads Bing query and page stats and submits URLs with the key in the query string", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (/GetQueryStats/.test(String(url))) return json({ d: [{ Query: "devis plombier", Impressions: 40, Clicks: 3, AvgImpressionPosition: 6.2 }, { Query: "plombier paris", Impressions: 10, Clicks: 0 }] });
      if (/GetPageStats/.test(String(url))) return json({ d: [] });
      if (/SubmitUrlBatch/.test(String(url))) { expect(JSON.parse(String(init?.body))).toEqual({ siteUrl: "https://brand.fr/", urlList: ["https://brand.fr/devis/"] }); return json({ d: null }); }
      return json({}, 404);
    }) as any;
    const env = { BING_WEBMASTER_KEY: "bingkey" };
    const queries = await bingQueryStats("https://brand.fr/", { env, fetchFn });
    expect(queries).toContain("Bing queries for https://brand.fr/: 50 impressions, 3 clicks (2 rows)");
    expect(queries).toContain("- devis plombier: 40 impr., 3 clicks, position 6.2");
    expect(await bingQueryStats("https://brand.fr/", { env, fetchFn, dimension: "page" })).toContain("no page data yet");
    expect(await bingSubmitUrls("https://brand.fr/", ["https://brand.fr/devis/", "ftp://no"], { env, fetchFn })).toBe("Submitted 1 URL(s) to Bing for https://brand.fr/.");
    expect(calls[0]).toContain("siteUrl=https%3A%2F%2Fbrand.fr%2F&apikey=bingkey");
    expect(await bingSubmitUrls("https://brand.fr/", [], { env, fetchFn })).toContain("at least one http(s) URL");
  });

  it("counts Sirene establishments for a trade and area, treats 404 as zero, and geocodes with API Adresse", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      seen.push(String(url));
      if (/api-sirene/.test(String(url))) {
        expect((init?.headers as any)["X-INSEE-Api-Key-Integration"]).toBe("insee-key");
        if (/96\.02A/.test(decodeURIComponent(String(url)))) return json({ header: { message: "Aucun élément trouvé" } }, 404);
        return json({ header: { total: 1234 }, etablissements: [
          { uniteLegale: { denominationUniteLegale: "PLOMBERIE DUPONT", dateCreationUniteLegale: "2015-03-01" }, adresseEtablissement: { codePostalEtablissement: "75011", libelleCommuneEtablissement: "PARIS" } },
          { uniteLegale: { nomUniteLegale: "MARTIN", prenom1UniteLegale: "JEAN" }, adresseEtablissement: { codePostalEtablissement: "75020", libelleCommuneEtablissement: "PARIS" } },
        ] });
      }
      if (/geocodage\/search/.test(String(url))) return json({ features: [{ properties: { label: "Lyon", type: "municipality", context: "69, Rhône, Auvergne-Rhône-Alpes", score: 0.97, population: 522000 }, geometry: { coordinates: [4.8357, 45.764] } }] });
      return json({}, 500);
    }) as any;
    expect(await sireneCount({ naf: "43.22A" }, { env: {}, fetchFn })).toContain("not configured");
    expect(await sireneCount({}, { env: { INSEE_API_KEY: "insee-key" }, fetchFn })).toContain("Give a NAF code");
    const out = await sireneCount({ naf: "43.22a", postcode: "75" }, { env: { INSEE_API_KEY: "insee-key" }, fetchFn });
    expect(decodeURIComponent(seen[0])).toContain("q=periode(etatAdministratifEtablissement:A AND activitePrincipaleEtablissement:43.22A) AND codePostalEtablissement:75*");
    expect(out).toContain("Sirene: 1,234 active establishment(s)");
    expect(out).toContain("- PLOMBERIE DUPONT — 75011 PARIS (since 2015)");
    expect(out).toContain("- JEAN MARTIN — 75020 PARIS");
    expect(await sireneCount({ naf: "96.02A", department: "2A" }, { env: { INSEE_API_KEY: "insee-key" }, fetchFn })).toContain("no active establishment matches");
    expect(decodeURIComponent(seen[1])).toContain("codePostalEtablissement:200*");
    const geo = await geocode("Lyon", { fetchFn });
    expect(geo).toContain("- Lyon (municipality, 69, Rhône, Auvergne-Rhône-Alpes; score 0.97) at 45.76400,4.83570, population 522000");
    expect(seen[2]).toBe("https://data.geopf.fr/geocodage/search?q=Lyon&limit=5");
  });

  it("gets a PISTE token once and searches Légifrance, listing titles and extracts", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (/oauth\/token/.test(String(url))) return json({ access_token: "tok", expires_in: 3600 });
      expect((init?.headers as any).authorization).toBe("Bearer tok");
      return json({ totalResultNumber: 2, results: [
        { titles: [{ title: "Code de la consommation - Article L221-18", id: "LEGIARTI000032227637" }], nature: "CODE", date: "2016-07-01", sections: [{ extracts: [{ values: ["Le consommateur dispose d'un délai de <b>quatorze</b> jours…"] }] }] },
        { titles: [{ title: "Loi n° 2014-344 du 17 mars 2014 relative à la consommation" }], nature: "LOI" },
      ] });
    }) as any;
    const env = { PISTE_CLIENT_ID: "cid", PISTE_CLIENT_SECRET: "csecret" };
    expect(await legifranceSearch("x", { env: {}, fetchFn })).toContain("not configured");
    const out = await legifranceSearch("délai de rétractation vente à distance", { env, fetchFn, fond: "CODE_DATE", now });
    expect(calls[0].url).toBe("https://oauth.piste.gouv.fr/api/oauth/token");
    expect(calls[0].body).toContain("grant_type=client_credentials&client_id=cid&client_secret=csecret&scope=openid");
    expect(calls[1].url).toBe("https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search");
    expect(JSON.parse(calls[1].body)).toMatchObject({ fond: "CODE_DATE", recherche: { pageSize: 8, champs: [{ criteres: [{ valeur: "délai de rétractation vente à distance" }] }] } });
    expect(out).toContain('Légifrance "délai de rétractation vente à distance" (CODE_DATE): 2 result(s)');
    expect(out).toContain("- Code de la consommation - Article L221-18 [CODE] 2016-07-01 — https://www.legifrance.gouv.fr/search/all?query=LEGIARTI000032227637");
    expect(out).toContain("  Le consommateur dispose d'un délai de quatorze jours");
    await legifranceSearch("autre", { env, fetchFn, now });
    expect(calls.filter((c) => /oauth/.test(c.url))).toHaveLength(1);
    expect(out).not.toContain("csecret");
  });
});

describe("UptimeRobot and e-mail", () => {
  it("creates a 5-minute monitor, lists statuses, and stays silent when not configured", async () => {
    const bodies: string[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      bodies.push(`${url} ${init?.body}`);
      if (/newMonitor/.test(String(url))) return json({ stat: "ok", monitor: { id: 777, status: 1 } });
      return json({ stat: "ok", monitors: [{ url: "https://brand.fr/", status: 2, all_time_uptime_ratio: "99.950" }, { url: "https://old.fr/", status: 9 }] });
    }) as any;
    expect(await uptimeRobotCreate("https://brand.fr/", { env: {}, fetchFn })).toBe("");
    expect(await uptimeRobotCreate("https://brand.fr/", { env: { UPTIMEROBOT_API_KEY: "u1-k" }, fetchFn })).toBe("UptimeRobot checks it every 5 minutes too (monitor 777).");
    expect(bodies[0]).toContain("api_key=u1-k&format=json&type=1&url=https%3A%2F%2Fbrand.fr%2F&friendly_name=brand.fr&interval=300");
    const status = await uptimeRobotStatus({ env: { UPTIMEROBOT_API_KEY: "u1-k" }, fetchFn });
    expect(status).toContain("- https://brand.fr/: up, uptime 99.95%");
    expect(status).toContain("- https://old.fr/: down");
  });

  it("e-mails the owner only, with the Resend key, 3 a day", async () => {
    const db = openDb();
    const calls: any[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) }); return json({ id: "em_1" }); }) as any;
    expect(await emailOwner("Rapport", "x".repeat(30), { env: { RESEND_API_KEY: "re_k" }, fetchFn })).toContain("not configured");
    const env = { RESEND_API_KEY: "re_k", MONEY_LAB_OWNER_EMAIL: "owner@example.com" };
    expect(await emailOwner("Rapport", "court", { env, fetchFn })).toContain("20+ characters");
    expect(await emailOwner("Rapport hebdo", "Voici le rapport complet de la semaine.", { env, fetchFn, db: db.raw, now })).toBe('E-mail sent to the owner (em_1): "Rapport hebdo", 39 characters.');
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].body).toEqual({ from: "Money Lab <onboarding@resend.dev>", to: ["owner@example.com"], subject: "[Money Lab] Rapport hebdo", text: "Voici le rapport complet de la semaine." });
    await emailOwner("2", "Deuxième rapport de la journée.", { env, fetchFn, db: db.raw, now });
    await emailOwner("3", "Troisième rapport de la journée.", { env, fetchFn, db: db.raw, now });
    expect(await emailOwner("4", "Quatrième rapport de la journée.", { env, fetchFn, db: db.raw, now })).toContain("daily cap reached (3/3)");
  });
});

describe("Cloudflare Pages deployment", () => {
  it("creates the project when missing, deploys the folder with the token only in that command, and refuses bad input", async () => {
    const home = tmp("money-lab-home-");
    fs.mkdirSync(path.join(home, "sites", "devis"), { recursive: true });
    fs.writeFileSync(path.join(home, "sites", "devis", "index.html"), "<!doctype html><title>Devis</title>");
    const runs: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const run = async (command: string, _timeout: number, env: NodeJS.ProcessEnv) => {
      runs.push({ command, env });
      if (/project create/.test(command)) return { exitCode: 1, stdout: "", stderr: "A project with this name already exists [code: 8000017]" };
      return { exitCode: 0, stdout: "✨ Deployment complete! Take a peek over at https://1a2b3c4d.devis.pages.dev\n", stderr: "" };
    };
    const env = { CLOUDFLARE_PAGES_TOKEN: "cf-pages-token", CLOUDFLARE_ACCOUNT_ID: "acc123", ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/nonexistent" };
    expect(await deploySite({ name: "devis" }, { home, env: {}, run })).toContain("not configured");
    expect(await deploySite({ name: "Devis Site" }, { home, env, run })).toContain("name: 2-58 lowercase");
    expect(await deploySite({ name: "nope" }, { home, env, run })).toContain("does not exist");
    const out = await deploySite({ name: "devis" }, { home, env, run });
    expect(out).toContain("Deployed ");
    expect(out).toContain("(project devis exists)");
    expect(out).toContain("Site: https://devis.pages.dev/ (this deployment: https://1a2b3c4d.devis.pages.dev)");
    expect(runs).toHaveLength(2);
    expect(runs[0].command).toContain("npx --yes wrangler@4 pages project create 'devis' --production-branch main");
    expect(runs[1].command).toContain("pages deploy . --project-name 'devis' --branch main --commit-dirty=true");
    expect(runs[1].env.CLOUDFLARE_API_TOKEN).toBe("cf-pages-token");
    expect(runs[1].env.CLOUDFLARE_ACCOUNT_ID).toBe("acc123");
    expect(runs[1].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runs[1].env.CLOUDFLARE_PAGES_TOKEN).toBeUndefined();
    const bin = tmp("bin-");
    fs.writeFileSync(path.join(bin, "wrangler"), "#!/bin/sh\n");
    expect(wranglerCommand({ PATH: bin })).toBe("wrangler");
    const failing = async (command: string) => (/project create/.test(command) ? { exitCode: 0, stdout: "ok", stderr: "" } : { exitCode: 1, stdout: "", stderr: "Authentication error [code: 10000]" });
    expect(await deploySite({ name: "devis" }, { home, env, run: failing })).toContain("deployment failed (exit 1): Authentication error");
  });
});

describe("Kits posted by the runtime", () => {
  const kitInput = (over: Record<string, unknown> = {}) => ({
    platform: "dev.to", where: "https://dev.to/new", audience: "Developers", title: "How I built a free invoice generator in a weekend",
    body: "I built a small, dependency-free invoice generator that runs in the browser. Here is what I learned about PDF generation, print CSS and keeping everything client-side: https://lab.github.io/invoice/",
    link: "https://lab.github.io/invoice/", rules: "Original content, tags relevant", value: "A working approach to client-side PDF", tags: ["webdev", "showdev"],
    ...over,
  });

  it("detects a channel from the platform only when configured, approves on /publie and posts through dev.to and Mastodon", async () => {
    const db = openDb();
    const t0 = new Date("2026-10-08T10:00:00Z");
    expect(kitChannel("dev.to", {})).toBeNull();
    expect(kitChannel("dev.to", { DEVTO_API_KEY: "k" })).toBe("devto");
    expect(kitChannel("Mastodon piaille.fr", { MASTODON_INSTANCE: "piaille.fr", MASTODON_TOKEN: "t" })).toBe("mastodon");
    expect(kitChannel("Reddit r/webdev", { DEVTO_API_KEY: "k" })).toBeNull();
    const env = { DEVTO_API_KEY: "devkey", MASTODON_INSTANCE: "https://piaille.fr/", MASTODON_TOKEN: "masto" };
    const kit = draftKit(db.raw, kitInput(), t0, env);
    if (typeof kit === "string") throw new Error(kit);
    expect(kit.channel).toBe("devto");
    expect(kit.tags).toEqual(["webdev", "showdev"]);
    expect(formatKitForOwner(kit)).toContain(`Rien à coller : réponds /publie ${kit.id} et je le publie moi-même sur dev.to`);
    const long = draftKit(db.raw, kitInput({ platform: "Mastodon", body: "Un ".repeat(300) }), new Date("2026-10-08T11:00:00Z"), env);
    expect(long).toContain("Mastodon posts are 500 characters at most");
    const toot = draftKit(db.raw, kitInput({ platform: "Mastodon", body: "Un générateur de factures gratuit, sans inscription, qui tourne dans le navigateur : rien n'est envoyé. Retours bienvenus ! https://lab.github.io/invoice/" }), new Date("2026-10-08T11:00:00Z"), env);
    if (typeof toot === "string") throw new Error(toot);
    expect(toot.channel).toBe("mastodon");
    // Approval: no link given means "post it for me"; a link means the owner posted it.
    expect(decideKit(db.raw, kit.id, true, "", t0)).toContain("approuvé : je le publie sur dev.to dans la minute");
    expect(decideKit(db.raw, toot.id, true, "", t0)).toContain("approuvé : je le publie sur Mastodon");
    expect(listKits(db.raw).filter((k) => k.status === "approved")).toHaveLength(2);
    const calls: any[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) });
      if (/dev\.to/.test(String(url))) return json({ url: "https://dev.to/moneylab/how-i-built-1a2b", id: 1 });
      return json({ url: "https://piaille.fr/@moneylab/113" });
    }) as any;
    const wakes: string[] = [];
    expect(await publishApprovedKits(db.raw, { env, fetchFn, now: t0, wake: (r) => wakes.push(r) })).toBe(2);
    expect(calls[0].url).toBe("https://dev.to/api/articles");
    expect((calls[0].headers as any)["api-key"]).toBe("devkey");
    expect(calls[0].body.article).toMatchObject({ title: kit.title, published: true, tags: ["webdev", "showdev"], canonical_url: "https://lab.github.io/invoice/" });
    expect(calls[0].body.article.body_markdown).toContain(`ref=kit-${kit.id}`);
    expect(calls[1].url).toBe("https://piaille.fr/api/v1/statuses");
    expect((calls[1].headers as any).authorization).toBe("Bearer masto");
    expect(calls[1].body).toMatchObject({ visibility: "public", language: "fr" });
    expect(calls[1].body.status).toContain(`ref=kit-${toot.id}`);
    const after = listKits(db.raw);
    expect(after.find((k) => k.id === kit.id)).toMatchObject({ status: "posted", postedUrl: "https://dev.to/moneylab/how-i-built-1a2b" });
    expect(after.find((k) => k.id === toot.id)).toMatchObject({ status: "posted", postedUrl: "https://piaille.fr/@moneylab/113" });
    expect(wakes).toEqual([`Kit ${kit.id} publié sur dev.to (https://dev.to/moneylab/how-i-built-1a2b)`, `Kit ${toot.id} publié sur Mastodon (https://piaille.fr/@moneylab/113)`]);
    expect(pendingOwnerNotifications(db.raw).map((n) => n.text).join("\n")).toContain("📣 Kit " + kit.id + " publié sur dev.to : https://dev.to/moneylab/how-i-built-1a2b");
    expect(await publishApprovedKits(db.raw, { env, fetchFn, now: t0 })).toBe(0);
  });

  it("fails a kit the service refuses and tells the owner to paste it instead", async () => {
    const db = openDb();
    const env = { DEVTO_API_KEY: "devkey" };
    const kit = draftKit(db.raw, kitInput(), now, env);
    if (typeof kit === "string") throw new Error(kit);
    decideKit(db.raw, kit.id, true, "", now);
    const fetchFn = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as any;
    expect(await publishApprovedKits(db.raw, { env, fetchFn, now })).toBe(0);
    expect(listKits(db.raw)[0]).toMatchObject({ status: "failed", note: 'HTTP 401: {"error":"unauthorized"}' });
    expect(pendingOwnerNotifications(db.raw).map((n) => n.text).join("\n")).toContain(`⚠️ Kit ${kit.id} non publié sur dev.to : HTTP 401`);
    // A kit for a venue without a channel keeps the manual flow.
    const manual = draftKit(db.raw, kitInput({ platform: "Reddit r/webdev", body: `Autre angle pour Reddit : ${kitInput().body}` }), new Date("2026-10-08T12:00:00Z"), env);
    if (typeof manual === "string") throw new Error(manual);
    expect(manual.channel).toBeUndefined();
    expect(decideKit(db.raw, manual.id, true, "https://www.reddit.com/r/webdev/comments/x/", now)).toContain("marqué publié (https://www.reddit.com/r/webdev/comments/x/)");
  });

  it("registers the new tools", () => {
    const names = createMoneyLabTools().map((t) => t.name);
    for (const name of ["email_owner", "deploy_site", "free_search", "bing_webmaster", "france_data"]) expect(names).toContain(name);
  });
});
