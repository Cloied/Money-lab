/**
 * Money Lab niche funnel and probes: public sources and Search Console are
 * stubbed; the formula and the memory are checked directly.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonDatabase } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, pendingOwnerNotifications } from "../../money-lab/journal.js";
import { MAX_NICHES_PER_SCAN, NICHE_SEEDS, describeFunnel, describeSeeds, listNiches, rejectNiche, scanNiches, scoreNiche } from "../../money-lab/funnel.js";
import { addProbe, checkProbes, describeProbes, listProbes, probeEvidenceFor, stopProbe } from "../../money-lab/probes.js";
import { resetSearchConsoleToken } from "../../money-lab/searchconsole.js";
import { CRITERIA, getIdea, upsertIdea } from "../../money-lab/ideas.js";
import { readDataset } from "../../money-lab/datasets.js";
import { isOperatorWake } from "../../money-lab/cycle.js";

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp("money-lab-funnel-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Niche funnel", () => {
  it("scores with the fixed formula", () => {
    expect(scoreNiche({ suggestions: 0, commercial: 0, wikipediaViews: null, hackerNews: null, githubRepos: null, examples: [] }).total).toBe(0);
    const strong = scoreNiche({ suggestions: 40, commercial: 5, wikipediaViews: 100_000, hackerNews: 50, githubRepos: 5, examples: [] });
    expect(strong).toEqual({ demand: 10, intent: 10, audience: 9, discussion: 10, competition: 1, total: 95 });
    const crowded = scoreNiche({ suggestions: 20, commercial: 1, wikipediaViews: 1000, hackerNews: 0, githubRepos: 5000, examples: [] });
    expect(crowded).toEqual({ demand: 5, intent: 2, audience: 3, discussion: 0, competition: 7, total: 14 });
  });

  it("scans niches from public sources, keeps the memory, skips rejected and recent ones, saves a dataset", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const calls: string[] = [];
    const fetchFn = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (/suggestqueries/.test(url)) {
        const q = decodeURIComponent(new URL(url).searchParams.get("q")!);
        if (/devis plombier/.test(q)) return json([q, [`${q} gratuit`, `${q} prix`, `${q} pdf`, `${q} exemple`]]);
        return json([q, []]);
      }
      if (/wikipedia\.org\/w\/api\.php/.test(url)) return json(["x", /plombier/.test(url) ? ["Plombier"] : []]);
      if (/wikimedia\.org/.test(url)) return json({ items: Array.from({ length: 12 }, () => ({ views: 20_000 })) });
      if (/hn\.algolia/.test(url)) return json({ nbHits: 3 });
      if (/api\.github\.com\/search/.test(url)) return json({ total_count: /plombier/.test(url) ? 4 : 2500 });
      return new Response("?", { status: 404 });
    }) as any;
    const sleep = async () => undefined;
    const now = new Date("2026-10-07T10:00:00Z");
    const text = await scanNiches(db.raw, ["Devis plombier", "truc obscur"], "fr", { home, fetchFn, now, sleep, githubToken: "ghp_x" });
    expect(text).toContain("Niche scan (fr, 2026-10-07");
    expect(text).toMatch(/- devis plombier: \d+\/100 — demand 6 \(24 suggestions\), intent 10 \(24 commercial\), audience 7 \(20,000 views\/month\)/);
    expect(text).toContain("people type: devis plombier gratuit");
    expect(text).toMatch(/- truc obscur: 0\/100 — demand 0 \(0 suggestions\).*audience 0 \(no article\).*competition -7 \(2500 repos\)/);
    expect(calls.filter((u) => /suggestqueries/.test(u))).toHaveLength(12);
    expect(readDataset(home, "niches")).toHaveLength(2);

    // A week's cache, and the rejected memory.
    expect(rejectNiche(db.raw, "truc obscur", "aucune recherche, 2500 alternatives", now)).toContain('rejected (aucune recherche');
    const again = await scanNiches(db.raw, ["devis plombier", "truc obscur", "x"], "fr", { home, fetchFn, now: new Date("2026-10-09T10:00:00Z"), sleep });
    expect(again).toContain("(cached 2026-10-07)");
    expect(again).toContain("- truc obscur: rejected earlier (aucune recherche, 2500 alternatives); not scanned");
    expect(calls.filter((u) => /suggestqueries/.test(u))).toHaveLength(12);
    const list = listNiches(db.raw);
    expect(list).toMatch(/^1 niche\(s\) scanned, 1 rejected; top 1 by score:\n- devis plombier/);
    expect(describeFunnel(db.raw)).toMatch(/^1 scanned, 1 rejected; top: devis plombier \d+$/);
    expect(await scanNiches(db.raw, [], "fr", { home, fetchFn, sleep })).toContain("niches is required");
    const many = Array.from({ length: MAX_NICHES_PER_SCAN + 3 }, (_, i) => `niche numéro ${i}`);
    expect(await scanNiches(db.raw, many, "fr", { home, fetchFn, sleep, now })).toContain("3 more not scanned this call");
    db.close();
  });

  it("stops the batch when Google limits the server and keeps partial signals", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const fetchFn = (async (input: any) => {
      const url = String(input);
      if (/suggestqueries/.test(url)) return new Response("slow down", { status: 429 });
      if (/wikipedia\.org\/w\/api\.php/.test(url)) return json(["x", []]);
      if (/hn\.algolia/.test(url)) return json({ nbHits: 0 });
      return json({ total_count: 0 });
    }) as any;
    const text = await scanNiches(db.raw, ["aaa bbb", "ccc ddd"], "en", { home, fetchFn, sleep: async () => undefined });
    expect(text).toContain("partial: google_suggest: HTTP 429");
    expect(text).toContain("- ccc ddd: not scanned (Google is limiting this server; try again in an hour)");
    db.close();
  });

  it("describes the seed universe", () => {
    expect(Object.keys(NICHE_SEEDS).length).toBeGreaterThanOrEqual(12);
    expect(describeSeeds()).toContain("Seed categories (");
    expect(describeSeeds("immobilier", "fr")).toMatch(/^Seeds for "immobilier et logement":\nfr: calcul frais de notaire/);
    expect(describeSeeds("nope")).toContain("Unknown category");
  });
});

describe("Probes", () => {
  function searchConsoleEnv(home: string) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    const keyFile = path.join(home, ".automaton", "gsc-key.json");
    fs.writeFileSync(keyFile, JSON.stringify({ client_email: "bot@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
    return keyFile;
  }

  it("registers probes under the property, checks Search Console, decides after the window, feeds the idea and wakes", async () => {
    resetSearchConsoleToken();
    const db = openDb();
    const home = tmp("money-lab-home-");
    const keyFile = searchConsoleEnv(home);
    const previous = { HOME: process.env.HOME, GSC_SITE: process.env.GSC_SITE };
    process.env.HOME = home;
    process.env.GSC_SITE = "https://lab.github.io/site/";
    try {
      const t0 = new Date("2026-10-01T00:00:00Z");
      expect(addProbe(db.raw, { id: "Bad id", url: "https://lab.github.io/site/x/", queries: ["a", "b"] }, t0)).toContain("id must be");
      expect(addProbe(db.raw, { id: "elsewhere", url: "https://other.example/x/", queries: ["a", "b"] }, t0)).toContain("must live under the Search Console property");
      expect(addProbe(db.raw, { id: "one", url: "https://lab.github.io/site/devis/", queries: ["devis plombier"] }, t0)).toContain("at least 2 searches");
      const scores = Object.fromEntries(CRITERIA.map((c) => [c, { score: 5, why: "fait vérifié et sourcé" }]));
      upsertIdea(db.raw, { id: "devis", title: "Devis", problem: "p", scores }, t0);
      expect(addProbe(db.raw, { id: "devis-plombier", url: "https://lab.github.io/site/devis/", queries: ["devis plombier", "Devis plombier gratuit", "modèle devis plomberie"], ideaId: "devis", windowDays: 3, minImpressions: 20 }, t0))
        .toMatch(/^Probe "devis-plombier" live: https:\/\/lab\.github\.io\/site\/devis\/ for devis plombier, devis plombier gratuit, modèle devis plomberie; decision after 7 days \(passes at 20 impressions\)/);
      expect(addProbe(db.raw, { id: "weak", url: "https://lab.github.io/site/weak/", queries: ["a b", "c d"], windowDays: 7, minImpressions: 500 }, t0)).toContain("live");
      expect(describeProbes(db.raw, t0)).toBe("2 live (devis-plombier day 0/7 0 impr.; weak day 0/7 0 impr.), 0 passed, 0 failed, 0 stopped");

      const bodies: any[] = [];
      const fetchFn = (async (url: any, init?: RequestInit) => {
        if (/oauth2/.test(String(url))) return json({ access_token: "ya29.t", expires_in: 3600 });
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.dimensions[0] === "page") {
          const filter = body.dimensionFilterGroups?.[0]?.filters?.[0]?.expression;
          return json({ rows: filter === "/site/devis/"
            ? [{ keys: ["https://lab.github.io/site/devis/"], clicks: 4, impressions: 30, ctr: 0.13, position: 12 }, { keys: ["https://lab.github.io/site/devis/faq/"], clicks: 0, impressions: 10, ctr: 0, position: 30 }]
            : [] });
        }
        return json({ rows: [
          { keys: ["devis plombier gratuit"], clicks: 3, impressions: 25, ctr: 0.12, position: 11 },
          { keys: ["recette crêpes"], clicks: 9, impressions: 900, ctr: 0.01, position: 3 },
        ] });
      }) as any;
      // Day 3: numbers read, nothing decided yet.
      const mid = await checkProbes(db.raw, { fetchFn, now: new Date("2026-10-04T00:00:00Z"), keyFile });
      expect(mid[0]).toMatch(/^- devis-plombier \[live\] .*: 40 impressions, 4 clicks, position 16\.5 \(checked 2026-10-04\); day 3 of 7, needs 20\n {2}Google shows it for: devis plombier gratuit \(25 impr\., 3 clicks\)$/);
      expect(bodies[0]).toMatchObject({ dimensions: ["page"], rowLimit: 50, dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: "/site/devis/" }] }] });
      expect(pendingOwnerNotifications(db.raw)).toHaveLength(0);
      // Day 7: decided; the idea gets the evidence; the owner and the agent are told.
      const wakes: string[] = [];
      const end = await checkProbes(db.raw, { fetchFn, now: new Date("2026-10-08T00:00:00Z"), keyFile, wake: (r) => wakes.push(r) });
      expect(end[0]).toContain("[passed]");
      expect(end[1]).toContain("[failed]");
      expect(listProbes(db.raw).map((p) => p.status)).toEqual(["passed", "failed"]);
      expect(getIdea(db.raw, "devis")!.evidence[0]).toMatch(/^probe devis-plombier \(2026-10-08\): demand shown: 40 impressions in 7 days \(threshold 20\) — https:\/\/lab\.github\.io\/site\/devis\//);
      const notices = pendingOwnerNotifications(db.raw).map((n) => n.text);
      expect(notices.some((t) => /🟢 Sonde devis-plombier réussie/.test(t))).toBe(true);
      expect(notices.some((t) => /🔴 Sonde weak échouée : too few impressions: 0 in 7 days/.test(t))).toBe(true);
      expect(wakes).toHaveLength(2);
      expect(isOperatorWake({ source: "money_lab_probe" })).toBe(true);
      expect(probeEvidenceFor(db.raw, "devis")).toContain("Probes measured by Search Console for this idea:\n- devis-plombier [passed]");
      expect(probeEvidenceFor(db.raw, "other")).toBe("");
      expect(stopProbe(db.raw, "weak", "done")).toContain("already failed");
      expect(await checkProbes(db.raw, { fetchFn, keyFile })).toEqual([]);
      db.close();
    } finally {
      process.env.HOME = previous.HOME;
      if (previous.GSC_SITE === undefined) delete process.env.GSC_SITE; else process.env.GSC_SITE = previous.GSC_SITE;
      resetSearchConsoleToken();
      vi.restoreAllMocks();
    }
  });
});
