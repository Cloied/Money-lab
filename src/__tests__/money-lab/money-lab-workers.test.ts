/**
 * Money Lab PR 6: Cloudflare Workers deployment, Bing as a second probe
 * measurement, Cloudflare Web Analytics reading. Commands and network are
 * stubbed; the token must reach only the wrangler command's environment.
 */

import { describe, it, expect, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonDatabase } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema } from "../../money-lab/journal.js";
import { COMPATIBILITY_DATE, deployWorker, describeWorkers, listWorkers, workerCodeProblem, wranglerToml } from "../../money-lab/workers.js";
import { webAnalytics } from "../../money-lab/cfanalytics.js";
import { addProbe, checkProbes, listProbes } from "../../money-lab/probes.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp("money-lab-workers-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
  delete process.env.GSC_SITE;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const WORKER = `export default {
  async fetch(request, env) {
    const n = Number(await env.KV.get("count")) + 1;
    await env.KV.put("count", String(n));
    return Response.json({ count: n });
  },
};
`;

describe("Worker code rules and wrangler.toml", () => {
  it("refuses empty, non-module and model-calling code, accepts a plain fetch handler", () => {
    expect(workerCodeProblem("")).toContain("empty");
    expect(workerCodeProblem("function handler() {}")).toContain("export default");
    expect(workerCodeProblem(`export default { fetch() { return fetch("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": "k" } }); } }`)).toContain("Anthropic API");
    expect(workerCodeProblem(`export default { fetch(r, env) { return env.AI.run("@cf/meta/llama", {}); } }`)).toContain("Workers AI binding");
    expect(workerCodeProblem(`export default { fetch() { return fetch("https://openrouter.ai/api/v1/chat/completions"); } }`)).toContain("a model API");
    expect(workerCodeProblem(`export default { fetch() { return fetch("https://api.telegram.org/bot1:x/sendMessage"); } }`)).toContain("Telegram");
    expect(workerCodeProblem(WORKER)).toBeNull();
    const toml = wranglerToml("waitlist", { kvId: "abc123abc123abc123abc123abc123ab", d1Id: "11111111-2222-3333-4444-555555555555" });
    expect(toml).toContain(`name = "waitlist"`);
    expect(toml).toContain(`compatibility_date = "${COMPATIBILITY_DATE}"`);
    expect(toml).toContain(`binding = "KV"\nid = "abc123abc123abc123abc123abc123ab"`);
    expect(toml).toContain(`binding = "DB"\ndatabase_name = "waitlist"\ndatabase_id = "11111111-2222-3333-4444-555555555555"`);
    expect(wranglerToml("plain", {})).not.toContain("kv_namespaces");
  });
});

describe("deploy_worker", () => {
  it("creates KV once, writes wrangler.toml, deploys with the token confined to the command, remembers the URL", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const dir = path.join(home, "workers", "compteur");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "worker.js"), WORKER);
    const runs: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const run = async (command: string, _t: number, env: NodeJS.ProcessEnv) => {
      runs.push({ command, env });
      if (/kv namespace create/.test(command)) return { exitCode: 0, stdout: `🌀 Creating namespace with title "compteur-kv"\n✨ Success!\n[[kv_namespaces]]\nbinding = "compteur_kv"\nid = "0f2ac74b498b48028cb68387c421e279"\n`, stderr: "" };
      if (/wrangler@4 deploy/.test(command)) return { exitCode: 0, stdout: "Uploaded compteur (1.2 sec)\nDeployed compteur triggers (0.5 sec)\n  https://compteur.moneylab.workers.dev\nCurrent Version ID: abc\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    };
    const env = { CLOUDFLARE_PAGES_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc1", ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/nonexistent" };
    const fetchFn = (async () => new Response('{"count":1}', { status: 200 })) as any;
    expect(await deployWorker({ name: "compteur" }, { home, db: db.raw, env: {}, run })).toContain("not configured");
    expect(await deployWorker({ name: "Bad Name" }, { home, db: db.raw, env, run })).toContain("name: 2-54 lowercase");
    expect(await deployWorker({ name: "absent" }, { home, db: db.raw, env, run })).toContain("does not exist");
    const out = await deployWorker({ name: "compteur", kv: true }, { home, db: db.raw, env, run, fetchFn, now: new Date("2026-10-08T10:00:00Z") });
    expect(out).toContain("Deployed Worker compteur (KV namespace created).");
    expect(out).toContain("URL: https://compteur.moneylab.workers.dev");
    expect(out).toContain("Binding: env.KV");
    expect(out).toContain("GET https://compteur.moneylab.workers.dev answers 200.");
    expect(runs).toHaveLength(2);
    expect(runs[0].command).toContain("npx --yes wrangler@4 kv namespace create 'compteur-kv'");
    expect(runs[1].command).toMatch(/cd '.*compteur' && npx --yes wrangler@4 deploy/);
    expect(runs[1].env.CLOUDFLARE_API_TOKEN).toBe("cf-token");
    expect(runs[1].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runs[1].env.CLOUDFLARE_PAGES_TOKEN).toBeUndefined();
    const toml = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf-8");
    expect(toml).toContain(`id = "0f2ac74b498b48028cb68387c421e279"`);
    expect(listWorkers(db.raw)).toEqual([{ name: "compteur", url: "https://compteur.moneylab.workers.dev", kvId: "0f2ac74b498b48028cb68387c421e279", deployedAt: "2026-10-08T10:00:00.000Z", deployments: 1 }]);
    // Second deployment: the namespace is reused, not recreated.
    const again = await deployWorker({ name: "compteur", kv: true }, { home, db: db.raw, env, run, fetchFn });
    expect(again).toContain("Deployed Worker compteur.");
    expect(runs.filter((r) => /kv namespace create/.test(r.command))).toHaveLength(1);
    expect(listWorkers(db.raw)[0].deployments).toBe(2);
    expect(describeWorkers(db.raw)).toContain("- compteur: https://compteur.moneylab.workers.dev (KV), 2 deployment(s)");
    // Code that calls a model is refused before any command runs.
    fs.writeFileSync(path.join(dir, "worker.js"), `export default { fetch() { return fetch("https://openrouter.ai/api/v1/chat/completions"); } }`);
    const before = runs.length;
    expect(await deployWorker({ name: "compteur" }, { home, db: db.raw, env, run })).toContain("calls a model API");
    expect(runs).toHaveLength(before);
  });

  it("applies a D1 schema and reports a failed deployment", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const dir = path.join(home, "workers", "liste");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "worker.js"), `export default { async fetch(request, env) { const r = await env.DB.prepare("select count(*) as n from signups").all(); return Response.json(r.results); } }`);
    fs.writeFileSync(path.join(dir, "schema.sql"), "create table if not exists signups (email text primary key, at text);");
    const commands: string[] = [];
    const run = async (command: string) => {
      commands.push(command);
      if (/d1 create/.test(command)) return { exitCode: 0, stdout: `✅ Successfully created DB 'liste'\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "liste"\ndatabase_id = "6b1e2a9c-1111-4f2a-9c3d-aaaaaaaaaaaa"\n`, stderr: "" };
      if (/d1 execute/.test(command)) return { exitCode: 0, stdout: "🚣 Executed 1 command", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]" };
    };
    const env = { CLOUDFLARE_PAGES_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc1" };
    expect(await deployWorker({ name: "liste", d1: true, schema: "../other.sql" }, { home, db: db.raw, env, run })).toContain("schema must be a .sql file inside");
    const out = await deployWorker({ name: "liste", d1: true, schema: "schema.sql" }, { home, db: db.raw, env, run });
    expect(out).toContain("Worker deployment failed (exit 1)");
    expect(out).toContain("Authentication error");
    expect(commands[1]).toContain("d1 execute 'liste' --remote --file 'schema.sql'");
    // The database id is kept even though the deploy failed.
    expect(listWorkers(db.raw)[0]).toMatchObject({ name: "liste", d1Id: "6b1e2a9c-1111-4f2a-9c3d-aaaaaaaaaaaa", deployments: 0 });
    expect(fs.readFileSync(path.join(dir, "wrangler.toml"), "utf-8")).toContain(`database_id = "6b1e2a9c-1111-4f2a-9c3d-aaaaaaaaaaaa"`);
  });

  it("registers the new tools", () => {
    const names = createMoneyLabTools().map((t) => t.name);
    expect(names).toContain("deploy_worker");
    expect(names).toContain("web_analytics");
  });
});

describe("Cloudflare Web Analytics", () => {
  it("finds the site by host, queries GraphQL for the window and formats the groups", async () => {
    const calls: Array<{ url: string; body?: any; auth?: string }> = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.authorization });
      if (/rum\/site_info\/list/.test(String(url))) return json({ success: true, result: [{ site_tag: "tagA", ruleset: { zone_name: "old.pages.dev" } }, { site_tag: "tagB", ruleset: { zone_name: "devis.pages.dev" } }] });
      return json({ data: { viewer: { accounts: [{
        total: [{ count: 420, sum: { visits: 310 } }],
        pages: [{ count: 300, sum: { visits: 220 }, dimensions: { requestPath: "/" } }, { count: 120, sum: { visits: 90 }, dimensions: { requestPath: "/devis/" } }],
        referers: [{ count: 50, sum: { visits: 40 }, dimensions: { refererHost: "www.reddit.com" } }],
        countries: [{ count: 400, sum: { visits: 300 }, dimensions: { countryName: "France" } }],
        devices: [{ count: 260, sum: { visits: 200 }, dimensions: { deviceType: "mobile" } }],
        days: [{ count: 200, dimensions: { date: "2026-10-06" } }, { count: 220, dimensions: { date: "2026-10-07" } }],
      }] } } });
    }) as any;
    const env = { CLOUDFLARE_PAGES_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acc1" };
    expect(await webAnalytics({}, { env: {}, fetchFn })).toContain("not readable");
    const out = await webAnalytics({ host: "https://devis.pages.dev/", days: 7 }, { env, fetchFn, now: new Date("2026-10-08T00:00:00Z") });
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/rum/site_info/list?per_page=50");
    expect(calls[0].auth).toBe("Bearer cf-token");
    expect(calls[1].url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(calls[1].body.variables).toEqual({ accountTag: "acc1", filter: { siteTag: "tagB", datetime_geq: "2026-10-01T00:00:00.000Z", datetime_leq: "2026-10-08T00:00:00.000Z" } });
    expect(calls[1].body.query).toContain("rumPageloadEventsAdaptiveGroups");
    expect(out).toContain("Cloudflare Web Analytics for devis.pages.dev, last 7 days: 420 page views, 310 visits.");
    expect(out).toContain("- /devis/: 120 views, 90 visits");
    expect(out).toContain("- www.reddit.com: 50 views, 40 visits");
    expect(out).toContain("Views per day: 10-06 200, 10-07 220");
    expect(await webAnalytics({ host: "nope.fr" }, { env, fetchFn })).toContain("No Web Analytics site for nope.fr. Known: old.pages.dev, devis.pages.dev.");
  });
});

describe("Probes with Bing as a second measurement", () => {
  it("adds Bing impressions for the probe page and decides on the combined total", async () => {
    const db = openDb();
    const home = tmp("home-");
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(path.join(home, ".automaton", "gsc-key.json"), JSON.stringify({ client_email: "bot@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
    process.env.GSC_SITE = "https://brand.fr/";
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const t0 = new Date("2026-09-20T00:00:00Z");
      expect(addProbe(db.raw, { id: "devis-plombier", url: "https://brand.fr/devis-plombier/", queries: ["devis plombier", "prix plombier"] }, t0)).toContain('Probe "devis-plombier" live');
      const bingCalls: string[] = [];
      const fetchFn = (async (url: any, init?: RequestInit) => {
        const u = String(url);
        if (/oauth2\.googleapis\.com/.test(u)) return json({ access_token: "g", expires_in: 3600 });
        if (/searchanalytics\/query/i.test(u)) {
          const body = JSON.parse(String(init?.body));
          if (body.dimensions?.[0] === "page") return json({ rows: [{ keys: ["https://brand.fr/devis-plombier/"], clicks: 2, impressions: 30, ctr: 0.06, position: 8.1 }] });
          return json({ rows: [{ keys: ["devis plombier"], clicks: 2, impressions: 30, ctr: 0.06, position: 8.1 }] });
        }
        if (/GetPageStats/.test(u)) {
          bingCalls.push(u);
          return json({ d: [{ Query: "https://brand.fr/devis-plombier/", Impressions: 25, Clicks: 1 }, { Query: "https://brand.fr/", Impressions: 500, Clicks: 20 }] });
        }
        return json({}, 404);
      }) as any;
      const now = new Date("2026-10-05T00:00:00Z");
      const report = await checkProbes(db.raw, { fetchFn, now, env: { BING_WEBMASTER_KEY: "bing" }, db: db.raw, keyFile: path.join(home, ".automaton", "gsc-key.json") });
      expect(bingCalls).toHaveLength(1);
      expect(bingCalls[0]).toContain("siteUrl=https%3A%2F%2Fbrand.fr%2F");
      const probe = listProbes(db.raw)[0];
      expect(probe).toMatchObject({ status: "passed", impressions: 30, bingImpressions: 25, bingClicks: 1 });
      expect(probe.note).toBe("demand shown: 55 impressions (30 Google + 25 Bing) in 14 days (threshold 50)");
      expect(report[0]).toContain("30 impressions, 2 clicks, position 8.1 on Google; 25 impressions, 1 clicks on Bing");
    } finally {
      process.env.HOME = prev;
    }
  });
});
