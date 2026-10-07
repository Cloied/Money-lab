/**
 * Money Lab owner request (2026-10-06): free models collect, the best model
 * decides. Free-model harvesting with fallbacks, binding Opus decisions,
 * market signals, datasets and site monitoring. All network access goes
 * through stubbed fetch functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import { addLedgerEntry, ensureMoneyLabSchema, getExperiment, getKV, pendingOwnerNotifications, upsertExperiment } from "../../money-lab/journal.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity } from "../mocks.js";
import { chunkDocuments, configuredFreeProviders, freeAiUsageToday, harvest, resetFreeAiProbes } from "../../money-lab/freeai.js";
import { marketSignals } from "../../money-lab/signals.js";
import { deleteDataset, listDatasets, readDataset, saveRecord, searchDatasets } from "../../money-lab/datasets.js";
import { listDecisions, parseDecision } from "../../money-lab/decisions.js";
import { CRITERIA, getIdea, upsertIdea } from "../../money-lab/ideas.js";
import { addSite, checkSites, describeSites, monitoredSites, removeSite } from "../../money-lab/monitor.js";
import { isOperatorWake } from "../../money-lab/cycle.js";
import { buildHealthReport } from "../../money-lab/health.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";
import { recall } from "../../money-lab/recall.js";
import { redactSecrets, scrubbedEnv } from "../../money-lab/selfhosted.js";

function vpsConfig(): AutomatonConfig {
  return applyMoneyLabProfile(createTestConfig({
    moneyLab: {
      enabled: true, profile: "first-run", runtime: "self-hosted",
      telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", ownerChatId: 42 },
      stripe: null,
      inference: { model: "claude-sonnet-5-5", effort: "medium", perCallCents: null, hourlyCents: null, dailyCents: 300, maxOutputTokens: 16000 },
      payments: "disabled", paymentLimits: { perPaymentCents: null, dailyCents: null }, deniedTools: [],
      maxTurnsPerCycle: null, noProgressCycles: 5, noProgressSleepMinutes: 120,
      resources: [{ id: "vps", kind: "server", description: "VPS", expectedDailyCostCents: 20 }],
      funding: { currency: "USD", provisionedCents: 2000, heldBackCents: 0 },
    } as any,
    sandboxId: "", logLevel: "error",
  }));
}

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp("money-lab-free-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Call { url: string; init?: RequestInit; body?: any }
/** A fetch that answers by the first matching route and records every call. */
function fakeFetch(routes: Array<[RegExp, (url: string, call: Call) => Response | Promise<Response>]>) {
  const calls: Call[] = [];
  const fn = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const [pattern, answer] of routes) if (pattern.test(url)) return answer(url, call);
    throw Object.assign(new Error("connect ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
  return { fn, calls };
}

const chatAnswer = (content: string) => json({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network access in a mocked test"); }));
  resetFreeAiProbes();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── Free models (harvest) ──────────────────────────────────────

describe("Harvest with free models", () => {
  const groqModels = () => json({ data: [{ id: "whisper-large-v3" }, { id: "llama-3.1-8b-instant" }, { id: "llama-3.3-70b-versatile" }, { id: "meta-llama/llama-guard-4-12b" }] });

  it("uses a configured free model, masks keys, counts usage and caches the result", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const { fn, calls } = fakeFetch([
      [/api\.groq\.com\/openai\/v1\/models$/, groqModels],
      [/api\.groq\.com\/openai\/v1\/chat\/completions$/, () => chatAnswer("<think>je réfléchis</think>| Outil | Prix |\n| A | 9 € |")],
    ]);
    const env = { GROQ_API_KEY: "gsk_groqsecretkey0123456789abcd", GH_TOKEN: "ghp_botcredential0123456789abcdef0123" };
    const text = "Page: Outil A 9 €/mois. Jeton oublié: ghp_botcredential0123456789abcdef0123 et sk-ant-api03-ABCDEFGHIJKLMNOPQRS.";
    const result = await harvest({ task: "Tableau outil et prix", text }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env });
    expect(result.text).toContain("| A | 9 € |");
    expect(result.text).not.toContain("je réfléchis");
    expect(result.text).toMatch(/\[harvest: groq llama-3\.3-70b-versatile, free, 1 request\]/);
    expect(result.costCents).toBe(0);
    const sent = calls.find((c) => /chat\/completions/.test(c.url))!;
    expect(sent.body.model).toBe("llama-3.3-70b-versatile");
    expect((sent.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${env.GROQ_API_KEY}`);
    const content = JSON.stringify(sent.body.messages);
    expect(content).toContain("Outil A 9 €/mois");
    expect(content).not.toContain("ghp_botcredential");
    expect(content).not.toContain("sk-ant-api03");
    expect(freeAiUsageToday(db.raw).calls).toBe(1);

    const again = await harvest({ task: "Tableau outil et prix", text }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env });
    expect(again.text).toMatch(/cached result/);
    expect(calls.filter((c) => /chat\/completions/.test(c.url))).toHaveLength(1);
    db.close();
  });

  it("rests a rate-limited provider and uses the next one; picks a Gemini Flash model", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const { fn, calls } = fakeFetch([
      [/api\.groq\.com\/openai\/v1\/models$/, groqModels],
      [/api\.groq\.com.*chat/, () => json({ error: { message: "Rate limit reached. Please try again in 7m12s" } }, 429)],
      [/generativelanguage.*\/models$/, () => json({ data: [{ id: "models/gemini-2.5-flash-image" }, { id: "models/gemini-2.0-flash" }, { id: "models/gemini-2.5-flash" }, { id: "models/gemini-3-pro-preview" }, { id: "models/text-embedding-004" }] })],
      [/generativelanguage.*chat\/completions$/, () => chatAnswer("Réponse Gemini")],
    ]);
    const env = { GROQ_API_KEY: "gsk_a", GEMINI_API_KEY: "AIza-test-key" };
    const result = await harvest({ task: "Résume", text: "Un texte." }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env });
    expect(result.text).toMatch(/^Réponse Gemini\n\[harvest: gemini gemini-2\.5-flash, free/);
    expect(calls.find((c) => /generativelanguage.*chat/.test(c.url))!.body.model).toBe("gemini-2.5-flash");
    // Groq rests about 7 minutes: the next harvest goes straight to Gemini.
    const before = calls.length;
    await harvest({ task: "Autre tâche", text: "Un texte." }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env });
    expect(calls.slice(before).some((c) => /groq/.test(c.url))).toBe(false);
    db.close();
  });

  it("tells the owner once when a key is refused and falls back to Haiku through the router", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const { fn } = fakeFetch([
      [/api\.groq\.com\/openai\/v1\/models$/, () => json({ error: { message: "Invalid API Key: gsk_invalidkey0123456789abcdef" } }, 401)],
    ]);
    const routed: any[] = [];
    const router = {
      route: async (request: any) => {
        routed.push(request);
        return { content: "Résumé par Haiku", model: request.model, provider: "anthropic", inputTokens: 100, outputTokens: 20, costCents: 2, latencyMs: 1, finishReason: "stop" } as any;
      },
    };
    const options = { db: db.raw, home, sessionId: "s", fetchFn: fn, env: { GROQ_API_KEY: "gsk_invalidkey0123456789abcdef" }, router, chat: async () => ({}) };
    const result = await harvest({ task: "Résume", text: "Texte" }, options);
    expect(result.text).toMatch(/Résumé par Haiku/);
    expect(result.text).toMatch(/paid fallback to Haiku because no free model answered \(groq: auth/);
    expect(result.costCents).toBe(2);
    expect(routed[0].model).toBe("claude-haiku-4-5");
    const notices = pendingOwnerNotifications(db.raw).filter((n) => /refuse la clé GROQ_API_KEY/.test(n.text));
    expect(notices).toHaveLength(1);
    // The key the service echoed is masked everywhere.
    expect(notices[0].text).not.toContain("gsk_invalidkey");
    expect(result.text).not.toContain("gsk_invalidkey");
    expect(getKV(db.raw, "money_lab.freeai")).not.toContain("gsk_invalidkey");
    expect(freeAiUsageToday(db.raw).fallbacks).toBe(1);
    // free_only: no paid fallback.
    const freeOnly = await harvest({ task: "Résume encore", text: "Texte", freeOnly: true }, options);
    expect(freeOnly.text).toMatch(/^Harvest not done: no free model answered \(groq resting/);
    expect(routed).toHaveLength(1);
    expect(buildHealthReport(db.raw, vpsConfig().moneyLab!, { home }).text).toMatch(/clé refusée par groq/);
    db.close();
  });

  it("uses only OpenRouter models whose id ends in :free", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const { fn, calls } = fakeFetch([
      [/openrouter\.ai\/api\/v1\/models$/, () => json({ data: [{ id: "anthropic/claude-opus-5-5" }, { id: "meta-llama/llama-3.3-70b-instruct" }, { id: "qwen/qwen3-14b:free" }, { id: "meta-llama/llama-3.3-70b-instruct:free" }] })],
      [/openrouter\.ai\/api\/v1\/chat\/completions$/, () => chatAnswer("Libre")],
    ]);
    await harvest({ task: "t", text: "x" }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env: { OPENROUTER_API_KEY: "sk-or-v1-abc" } });
    expect(calls.find((c) => /chat/.test(c.url))!.body.model).toBe("meta-llama/llama-3.3-70b-instruct:free");
    const paid = await harvest({ task: "t2", text: "x" }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env: { OPENROUTER_API_KEY: "sk-or-v1-abc", OPENROUTER_MODEL: "anthropic/claude-opus-5-5" } });
    expect(paid.text).toMatch(/is not a free model/);
    expect(calls.filter((c) => /chat/.test(c.url))).toHaveLength(1);
    db.close();
  });

  it("splits long material for small free limits and drops parts with nothing relevant", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    let n = 0;
    const { fn, calls } = fakeFetch([
      [/api\.groq\.com\/openai\/v1\/models$/, groqModels],
      [/api\.groq\.com.*chat/, () => chatAnswer(++n === 2 ? "NONE" : `note ${n}`)],
    ]);
    const text = "prix ".repeat(5000); // 25,000 characters: three parts for Groq
    const result = await harvest({ task: "Liste les prix", text }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env: { GROQ_API_KEY: "gsk_a" } });
    const chats = calls.filter((c) => /chat/.test(c.url));
    expect(chats).toHaveLength(4); // 3 parts + the final answer
    const final = JSON.stringify(chats[3].body.messages);
    expect(final).toContain("note 1");
    expect(final).not.toContain("NONE");
    expect(result.text).toMatch(/free, 4 requests/);
    expect(chunkDocuments([{ source: "a", content: "x".repeat(10_000) }], 4000).chunks).toHaveLength(3);
    expect(chunkDocuments([{ source: "a", content: "court" }, { source: "b", content: "aussi" }], 4000).chunks).toHaveLength(1);
    db.close();
  });

  it("uses a local Ollama model when one is installed", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const { fn, calls } = fakeFetch([
      [/127\.0\.0\.1:11434\/api\/tags$/, () => json({ models: [{ name: "nomic-embed-text:latest" }, { name: "qwen2.5:3b" }] })],
      [/127\.0\.0\.1:11434\/api\/chat$/, () => json({ message: { role: "assistant", content: "Local" } })],
    ]);
    const result = await harvest({ task: "t", text: "x" }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env: {} });
    expect(result.text).toMatch(/^Local\n\[harvest: ollama qwen2\.5:3b, free/);
    expect(calls.find((c) => /api\/chat/.test(c.url))!.body.options.num_ctx).toBe(8192);
    expect(configuredFreeProviders({})).toEqual(["ollama"]);
    db.close();
  });

  it("skips a model without free quota and picks another one", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const used: string[] = [];
    const { fn } = fakeFetch([
      [/generativelanguage.*\/models$/, () => json({ data: [{ id: "models/gemini-2.5-flash" }, { id: "models/gemini-2.0-flash" }] })],
      [/generativelanguage.*chat/, (_u, call) => {
        used.push(call.body.model);
        return call.body.model === "gemini-2.5-flash"
          ? json({ error: { message: "Quota exceeded for metric generate_content_free_tier_requests, limit: 0" } }, 429)
          : chatAnswer("ok");
      }],
    ]);
    const env = { GEMINI_API_KEY: "AIza-x" };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T08:00:00Z"));
    await harvest({ task: "a", text: "x" }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env });
    vi.setSystemTime(new Date("2026-10-07T08:20:00Z")); // after the 10-minute rest
    const second = await harvest({ task: "b", text: "x" }, { db: db.raw, home, sessionId: "s", fetchFn: fn, env });
    expect(used).toEqual(["gemini-2.5-flash", "gemini-2.0-flash"]);
    expect(second.text).toMatch(/gemini gemini-2\.0-flash/);
    db.close();
  });
});

// ─── Market signals ─────────────────────────────────────────────

describe("Market signals", () => {
  it("collects counts and dated links from several free sources, survives a blocked one, caches and saves", async () => {
    const home = tmp("money-lab-home-");
    const { fn, calls } = fakeFetch([
      [/hn\.algolia\.com\/api\/v1\/search\?/, () => json({ nbHits: 1234, hits: [{ title: "Ask HN: invoice tools?", points: 120, num_comments: 80, created_at: "2026-03-02T10:00:00Z", objectID: "42" }] })],
      [/hn\.algolia\.com\/api\/v1\/search_by_date/, () => json({ nbHits: 56, hits: [] })],
      [/www\.reddit\.com/, () => json({ message: "Forbidden" }, 403)],
      [/suggestqueries\.google\.com/, (url) => json([decodeURIComponent(url.split("q=")[1]), ["devis plombier gratuit", "devis plombier en ligne"]])],
      [/fr\.wikipedia\.org/, () => json(["devis plombier", ["Plombier"], [""], ["https://fr.wikipedia.org/wiki/Plombier"]])],
      [/wikimedia\.org\/api\/rest_v1\/metrics\/pageviews/, () => json({ items: [100, 100, 100, 120, 120, 120].map((views) => ({ views })) })],
    ]);
    const now = new Date("2026-10-07T08:00:00Z");
    const text = await marketSignals("devis plombier", [], { home, fetchFn: fn, now, saveTo: "signaux-plomberie" });
    expect(text).toContain("Hacker News: 1,234 stories match, 56 in the last 12 months.");
    expect(text).toContain("https://news.ycombinator.com/item?id=42");
    expect(text).toMatch(/reddit: unavailable \(HTTP 403\) \(Reddit often blocks servers/);
    expect(text).toContain("devis plombier gratuit | devis plombier en ligne");
    expect(text).toMatch(/"Plombier": 110 views\/month on average over 6 months, last 3 months vs previous 3: \+20%/);
    expect(text).toMatch(/\[saved to dataset signaux-plomberie\]/);
    const year = calls.find((c) => /search_by_date/.test(c.url))!.url;
    expect(year).toContain(`created_at_i>${Math.floor(now.getTime() / 1000) - 365 * 86_400}`);
    const before = calls.length;
    expect(await marketSignals("devis plombier", [], { home, fetchFn: fn, now })).toMatch(/\[cached from 2026-10-07 08:00 UTC/);
    expect(calls.length).toBe(before);
    expect(readDataset(home, "signaux-plomberie")).toHaveLength(1);
  });

  it("reads GitHub and Stack Exchange when asked", async () => {
    const home = tmp("money-lab-home-");
    const { fn, calls } = fakeFetch([
      [/api\.github\.com\/search\/repositories/, () => json({ total_count: 321, items: [{ full_name: "a/invoice", stargazers_count: 4500, pushed_at: "2026-09-01T00:00:00Z", description: "Invoices", html_url: "https://github.com/a/invoice" }] })],
      [/api\.stackexchange\.com/, () => json({ items: [{ title: "Generate PDF invoice", view_count: 9000, answer_count: 4, creation_date: 1700000000, link: "https://stackoverflow.com/q/1" }], has_more: true })],
    ]);
    const text = await marketSignals("invoice generator", ["github", "stackexchange"], { home, fetchFn: fn, githubToken: "ghp_x" });
    expect(text).toContain("GitHub: 321 repositories match");
    expect(text).toContain("a/invoice: 4,500 stars");
    expect(text).toContain("Stack Exchange (stackoverflow): 1 top questions (more exist)");
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe("Bearer ghp_x");
  });
});

// ─── Datasets ───────────────────────────────────────────────────

describe("Datasets", () => {
  it("saves, lists, reads, searches and deletes, and recall finds the records", () => {
    const home = tmp("money-lab-home-");
    expect(saveRecord(home, "../escape", { source: "agent", data: "x" })).toMatch(/name must be/);
    expect(saveRecord(home, "Prix", { source: "agent", data: "x" })).toMatch(/name must be/);
    expect(saveRecord(home, "prix-concurrents", { source: "agent", data: "" })).toMatch(/empty/);
    expect(saveRecord(home, "prix-concurrents", { source: "agent", ref: "https://a.example 2026-10-05", data: { outil: "Facturo", prix: "9 €/mois" } })).toBeNull();
    expect(saveRecord(home, "prix-concurrents", { source: "harvest", data: "Devizo gratuit jusqu'à 5 devis" })).toBeNull();
    expect(listDatasets(home, { countRecords: true })).toMatchObject([{ name: "prix-concurrents", records: 2 }]);
    expect(readDataset(home, "prix-concurrents", { contains: "facturo" })).toHaveLength(1);
    expect(searchDatasets(home, "devizo gratuit")[0].record.data).toBe("Devizo gratuit jusqu'à 5 devis");
    expect(recall("Facturo", { home }).map((h) => h.source)).toContain("~/datasets/prix-concurrents.jsonl");
    expect(saveRecord(home, "gros", { source: "agent", data: "x".repeat(70_000) })).toMatch(/max 60000/);
    // A symbolic link never redirects the runtime's writes.
    fs.symlinkSync("/etc/hostname", path.join(home, "datasets", "lien.jsonl"));
    expect(saveRecord(home, "lien", { source: "agent", data: "x" })).toMatch(/symbolic link/);
    expect(deleteDataset(home, "prix-concurrents")).toBe(true);
    expect(readDataset(home, "prix-concurrents")).toMatch(/No dataset/);
  });

  it("is a tool that stores JSON text as JSON", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx: ToolContext = { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
      const call = (args: Record<string, unknown>) => executeTool("dataset", args, createMoneyLabTools(), ctx, new PolicyEngine(db.raw, createDefaultRules()),
        { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) }).then((r) => r.result || r.error || "");
      expect(await call({ action: "save", name: "prix", data: "{\"outil\": \"A\", \"prix\": 9}", ref: "https://a.example" })).toBe("Saved to dataset prix.");
      expect(readDataset(home, "prix")).toMatchObject([{ data: { outil: "A", prix: 9 }, source: "agent" }]);
      expect(await call({ action: "list" })).toMatch(/^prix: 1 records/);
      expect(await call({ action: "search", query: "outil" })).toMatch(/\[prix\].*"outil":"A"/);
      expect(buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!)).toMatch(/Datasets: prix \(1 KB\)/);
    } finally {
      process.env.HOME = previous;
      db.close();
    }
  });
});

// ─── Binding Opus decisions ─────────────────────────────────────

describe("Binding Opus decisions", () => {
  function setup(answer: () => { content: string; finishReason?: string }) {
    const db = openDb();
    const routed: any[] = [];
    const ctx: ToolContext = {
      identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
      inferenceRouter: {
        route: async (request: any) => {
          routed.push(request);
          const committee = /investment committee/.test(request.messages[0].content);
          const a = committee ? answer() : { content: "Verdict: GO\nWeakest points: aucun." };
          return { content: a.content, model: request.model, provider: "anthropic", inputTokens: 1000, outputTokens: 300, costCents: 6, latencyMs: 1, finishReason: a.finishReason ?? "stop" } as any;
        },
      },
    };
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const call = (name: string, args: Record<string, unknown>) => executeTool(name, args, createMoneyLabTools(), ctx, engine,
      { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) }).then((r) => r.result || r.error || "");
    const scores = (n: number) => Object.fromEntries(CRITERIA.map((c) => [c, { score: n, why: `fait vérifié pour ${c}` }]));
    const full = (id: string, n: number) => call("idea", {
      action: "update", id, title: `Idée ${id}`, problem: "Un vrai problème", audience: "plombiers", solution: "outil",
      revenue_model: "affiliation", channels: "SEO longue traîne", server_edge: "collecte quotidienne",
      evidence: ["forum A 2026-10", "recherche B", "fil C"], competitors: ["X (gratuit)", "Y (29 €/mois)"],
      kill_criteria: "moins de 50 visites/semaine après 4 semaines", scores: scores(n),
    });
    const ready = async () => {
      for (const [id, n] of [["a", 8], ["b", 7], ["c", 6], ["d", 5], ["e", 4]] as const) await full(id, n);
      await call("idea", { action: "challenge", id: "a" });
      await call("idea", { action: "update", id: "a", response_to_critic: "Pris en compte." });
    };
    return { db, call, routed, ready, full };
  }

  it("lets Opus approve, and sends it the full dossier with the agent's case", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T08:00:00Z"));
    const { db, call, routed, ready } = setup(() => ({ content: "Decision: APPROVE\nReasons:\n- demande prouvée" }));
    await ready();
    expect(await call("idea", { action: "decide", id: "a", decision: "approve", note: "x" })).toMatch(/let it mature/);
    expect(routed.filter((r) => /investment committee/.test(r.messages[0].content))).toHaveLength(0);
    vi.setSystemTime(new Date("2026-10-07T15:00:00Z"));
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 2000, source: "operator", reference: "f" });
    const result = await call("idea", { action: "decide", id: "a", decision: "approve", note: "Meilleure demande du pipeline, 3 sources." });
    expect(result).toMatch(/Decision: APPROVE[\s\S]*binding[\s\S]*approved \(80\/100\)/);
    const request = routed.find((r) => /investment committee/.test(r.messages[0].content));
    expect(request.model).toBe("claude-opus-5-5");
    const dossier = request.messages[1].content;
    expect(dossier).toContain("The agent's case for approval now: Meilleure demande du pipeline, 3 sources.");
    expect(dossier).toContain("Idée b (b): 70/100, candidate");
    expect(dossier).toMatch(/Runway: balance \$/);
    expect(dossier).toContain("Critique 1");
    expect(getIdea(db.raw, "a")!.status).toBe("approved");
    expect(getIdea(db.raw, "a")!.decisionNote).toMatch(/^Opus APPROVE/);
    expect(listDecisions(db.raw)).toMatchObject([{ kind: "approve_idea", target: "a", verdict: "APPROVE", costCents: 6 }]);
    expect(await call("record_experiment", { status: "building", hypothesis: "Devis", idea_id: "a" })).toMatch(/recorded with status building/);
    db.close();
  });

  it("applies NOT YET and REJECT, refuses to ask again without changes, ignores unreadable answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T08:00:00Z"));
    let content = "Decision: NOT YET\nConditions or missing evidence:\n- chiffres de recherche";
    const { db, call, ready } = setup(() => ({ content }));
    await ready();
    vi.setSystemTime(new Date("2026-10-07T15:00:00Z"));
    expect(await call("idea", { action: "decide", id: "a", decision: "approve", note: "dossier complet" })).toMatch(/Not yet: get the missing evidence/);
    expect(getIdea(db.raw, "a")!.status).toBe("candidate");
    expect(await call("idea", { action: "decide", id: "a", decision: "approve", note: "encore" })).toMatch(/Nothing changed since Opus said NOT YET/);
    vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
    await call("idea", { action: "update", id: "a", evidence: ["market_signals 2026-10-07: 56 fils HN"] });
    content = "Je pense que c'est bien.";
    expect(await call("idea", { action: "decide", id: "a", decision: "approve", note: "preuves ajoutées" })).toMatch(/No decision line: nothing applied/);
    expect(listDecisions(db.raw)).toHaveLength(1);
    content = "**Decision:** REJECT\nReasons:\n- concurrence gratuite";
    expect(await call("idea", { action: "decide", id: "a", decision: "approve", note: "preuves ajoutées" })).toMatch(/rejected by Opus/);
    expect(getIdea(db.raw, "a")!.status).toBe("rejected");
    db.close();
  });

  it("stops an active experiment only on Opus's STOP, keeps it on CONTINUE", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T08:00:00Z"));
    let decision = "CONTINUE";
    const { db, call, routed } = setup(() => ({ content: `Decision: ${decision}\nReasons:\n- 40 impressions\nNext: ajouter une FAQ, revoir le 2026-10-21` }));
    db.raw.prepare("INSERT INTO money_lab_experiments (id, status, hypothesis, evidence, metrics, created_at, updated_at) VALUES (?, 'observing', 'Factures', '[]', '{}', ?, ?)")
      .run("exp_old", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
    expect(await call("record_experiment", { id: "exp_old", status: "finished" })).toMatch(/give your reason in result/);
    const kept = await call("record_experiment", { id: "exp_old", status: "finished", result: "5 visites en 6 jours", metrics: { visits: 5 } });
    expect(kept).toMatch(/Decision: CONTINUE[\s\S]*Status unchanged/);
    const exp = getExperiment(db.raw, "exp_old")!;
    expect(exp.status).toBe("observing");
    expect(exp.metrics.visits).toBe(5);
    expect(exp.result).toBeNull();
    expect(exp.evidence.at(-1)).toMatch(/^Opus CONTINUE 2026-10-07: ajouter une FAQ/);
    const dossier = routed.at(-1).messages[1].content;
    expect(dossier).toContain("The agent proposes: status finished. Reason: 5 visites en 6 jours");
    // Within 24 hours, no new decision.
    const calls = routed.length;
    expect(await call("record_experiment", { id: "exp_old", status: "paused", result: "toujours rien" })).toMatch(/to continue this experiment/);
    expect(routed.length).toBe(calls);
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    decision = "STOP";
    expect(await call("record_experiment", { id: "exp_old", status: "paused", result: "toujours 5 visites" })).toMatch(/recorded with status paused/);
    expect(getExperiment(db.raw, "exp_old")!.result).toBe("toujours 5 visites");
    // Between inactive statuses, no decision is needed.
    expect(await call("record_experiment", { id: "exp_old", status: "finished" })).toMatch(/recorded with status finished/);
    expect(listDecisions(db.raw).map((d) => d.verdict)).toEqual(["CONTINUE", "STOP"]);
    db.close();
  });

  it("changes nothing when the decision cannot run (budget)", async () => {
    const { db, call } = setup(() => ({ content: "Daily budget exhausted", finishReason: "budget_exceeded" }));
    upsertExperiment(db.raw, { id: "exp_b", status: "exploring", hypothesis: "h" });
    db.raw.prepare("UPDATE money_lab_experiments SET status = 'building', created_at = '2026-10-01T00:00:00Z' WHERE id = 'exp_b'").run();
    expect(await call("record_experiment", { id: "exp_b", status: "finished", result: "abandon" })).toMatch(/Decision not made \(budget_exceeded\)[\s\S]*Status unchanged/);
    expect(getExperiment(db.raw, "exp_b")!.status).toBe("building");
    expect(parseDecision("Decision: maybe", ["STOP", "CONTINUE"])).toBeNull();
    db.close();
  });
});

// ─── Site monitoring ────────────────────────────────────────────

describe("Site monitoring", () => {
  it("alerts once when a site goes down, wakes the agent, and announces the recovery", async () => {
    const db = openDb();
    expect(addSite(db.raw, "ftp://x")).toMatch(/http\(s\)/);
    expect(addSite(db.raw, "https://org.github.io/devis/#top")).toBe("Monitoring https://org.github.io/devis/ every 30 minutes.");
    upsertExperiment(db.raw, { id: "exp_c", status: "exploring", hypothesis: "h", artifactRef: "https://org.github.io/factures/ (v2)" });
    db.raw.prepare("UPDATE money_lab_experiments SET status = 'observing' WHERE id = 'exp_c'").run();
    expect(monitoredSites(db.raw)).toEqual(["https://org.github.io/devis/", "https://org.github.io/factures/"]);
    let down = true;
    const { fn } = fakeFetch([
      [/factures/, () => new Response("ok", { status: 200 })],
      [/devis/, () => (down ? new Response("not found", { status: 404 }) : new Response("ok", { status: 200 }))],
    ]);
    const wakes: string[] = [];
    const tick = (at: string) => checkSites(db.raw, { fetchFn: fn, now: new Date(at), wake: (r) => wakes.push(r) });
    await tick("2026-10-07T08:00:00Z");
    expect(pendingOwnerNotifications(db.raw)).toHaveLength(0); // one failure is not an outage
    await tick("2026-10-07T08:30:00Z");
    await tick("2026-10-07T09:00:00Z");
    const alerts = pendingOwnerNotifications(db.raw).filter((n) => /Site hors ligne/.test(n.text));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("https://org.github.io/devis/ (HTTP 404");
    expect(wakes).toEqual(["site down: https://org.github.io/devis/ (HTTP 404)"]);
    expect(isOperatorWake({ source: "money_lab_monitor" })).toBe(true);
    expect(describeSites(db.raw, new Date("2026-10-07T10:00:00Z"))).toContain("https://org.github.io/devis/ DOWN for 90 min (HTTP 404)");
    const health = buildHealthReport(db.raw, vpsConfig().moneyLab!, { now: new Date("2026-10-07T10:00:00Z"), home: tmp("h-") });
    expect(health.text).toMatch(/🚨 Problème : .*le site https:\/\/org\.github\.io\/devis\/ est hors ligne depuis plus d'1 h/);
    expect(health.text).toMatch(/1 hors ligne sur 2/);
    down = false;
    await tick("2026-10-07T10:30:00Z");
    expect(pendingOwnerNotifications(db.raw).some((n) => /de nouveau en ligne : https:\/\/org\.github\.io\/devis\/ \(hors ligne pendant 2 h\)/.test(n.text))).toBe(true);
    expect(removeSite(db.raw, "https://org.github.io/devis/")).toMatch(/Stopped/);
    expect(monitoredSites(db.raw)).toEqual(["https://org.github.io/factures/"]);
    db.close();
  });
});

// ─── Keys, prompt and report ────────────────────────────────────

describe("Free model keys and the prompt", () => {
  it("keeps the free model keys away from the agent's shell", async () => {
    expect(scrubbedEnv({ PATH: "/bin", GROQ_API_KEY: "a", GEMINI_API_KEY: "b", OPENROUTER_API_KEY: "c" })).toEqual({ PATH: "/bin" });
    expect(redactSecrets("cle gsk_abcdefghijklmnopqrstuv et AIzaSyA1234567890abcdefghijklmnopqrstu", {})).toBe("cle [clé masquée] et [clé masquée]");
    expect(redactSecrets("https://x.example/?api_key=abcdef0123456789abcd&q=1 Authorization: Bearer abcdefghijklmnop1234", {}))
      .toBe("https://x.example/?api_key= [masqué]&q=1 Authorization: Bearer [masqué]");
    const db = openDb();
    const ctx: ToolContext = { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const { createBuiltinTools } = await import("../../agent/tools.js");
    const result = await executeTool("exec", { command: "echo $GROQ_API_KEY" }, createBuiltinTools(""), ctx, new PolicyEngine(db.raw, createDefaultRules()),
      { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });
    expect(result.error ?? "").toMatch(/disabled/);
    db.close();
  });

  it("tells the agent which model does what", () => {
    const db = openDb();
    const prompt = buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!);
    expect(prompt).toMatch(/Models, cheapest first: harvest collects and extracts with free models \(none configured yet: it falls back to Haiku, paid\)/);
    expect(prompt).toMatch(/Opus makes the binding calls/);
    expect(prompt).toMatch(/Monitored sites: none/);
    expect(getKV(db.raw, "money_lab.freeai")).toBeUndefined();
    db.close();
  });
});

// ─── Lighter turns and free-first delegate (2026-10-07) ─────────
import { buildContextMessages, shortenOldResult } from "../../agent/context.js";

describe("Lighter turns", () => {
  const turn = (i: number, result: string) => ({
    id: `t${i}`, timestamp: `2026-10-07T0${i}:00:00Z`, state: "running" as const, thinking: `tour ${i}`,
    toolCalls: [{ id: `c${i}`, name: "exec", arguments: { command: "cat index.html" }, result, durationMs: 1 }],
    tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, costCents: 1,
  });

  it("keeps the last results whole and shortens older ones to their start and end", () => {
    const big = `DEBUT ${"x".repeat(9000)} FIN`;
    const turns = [1, 2, 3, 4, 5, 6].map((i) => turn(i, big)) as any[];
    const messages = buildContextMessages("system", turns, undefined, { fullResultTurns: 4, oldResultChars: 1200, budget: { total: 1e9, systemPrompt: 1e9, recentTurns: 1e9, toolResults: 1e9, memoryRetrieval: 1e9 } as any });
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results).toHaveLength(6);
    for (const old of results.slice(0, 2)) {
      expect(old.length).toBeLessThan(1400);
      expect(old).toMatch(/^DEBUT/);
      expect(old).toMatch(/FIN$/);
      expect(old).toMatch(/older result shortened: 7810 of 9010 characters/);
    }
    for (const recent of results.slice(2)) expect(recent).toBe(big);
    // Without the option (upstream), nothing changes.
    const upstream = buildContextMessages("system", turns, undefined, { budget: { total: 1e9, systemPrompt: 1e9, recentTurns: 1e9, toolResults: 1e9, memoryRetrieval: 1e9 } as any });
    expect(upstream.filter((m) => m.role === "tool").every((m) => m.content === big)).toBe(true);
    expect(shortenOldResult("court", 1200)).toBe("court");
  });

  it("sends delegate to the free models first, and to Haiku for quality high", async () => {
    const db = openDb();
    const previous = { GROQ_API_KEY: process.env.GROQ_API_KEY, HOME: process.env.HOME };
    process.env.GROQ_API_KEY = "gsk_test0123456789abcdefghij";
    process.env.HOME = tmp("money-lab-home-");
    const routed: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      if (/models$/.test(String(url))) return json({ data: [{ id: "llama-3.3-70b-versatile" }] });
      return chatAnswer("Résumé gratuit");
    }));
    try {
      const ctx: ToolContext = {
        identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
        inferenceRouter: { route: async (request: any) => { routed.push(request); return { content: "Résumé Haiku", model: request.model, provider: "anthropic", inputTokens: 1, outputTokens: 1, costCents: 1, latencyMs: 1, finishReason: "stop" } as any; } },
      };
      const call = (args: Record<string, unknown>) => executeTool("delegate", args, createMoneyLabTools(), ctx, new PolicyEngine(db.raw, createDefaultRules()),
        { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) }).then((r) => r.result || r.error || "");
      expect(await call({ task: "Résume", text: "Un texte" })).toMatch(/^Résumé gratuit[\s\S]*answered by a free model/);
      expect(routed).toHaveLength(0);
      expect(await call({ task: "Résume finement", text: "Un texte", quality: "high" })).toMatch(/^Résumé Haiku/);
      expect(routed[0].model).toBe("claude-haiku-4-5");
    } finally {
      for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      db.close();
    }
  });

  it("shows the average turn size in the health report", () => {
    const db = openDb();
    db.raw.prepare("INSERT INTO inference_costs (id, session_id, model, provider, input_tokens, cost_cents, tier, task_type, created_at) VALUES ('a', 's', 'm', 'anthropic', 40000, 3, 'normal', 'agent_turn', '2026-10-07 05:00:00')").run();
    db.raw.prepare("INSERT INTO inference_costs (id, session_id, model, provider, input_tokens, cost_cents, tier, task_type, created_at) VALUES ('b', 's', 'm', 'anthropic', 20000, 2, 'normal', 'agent_turn', '2026-10-07 06:00:00')").run();
    const report = buildHealthReport(db.raw, vpsConfig().moneyLab!, { now: new Date("2026-10-07T08:00:00Z"), home: tmp("h-") });
    expect(report.text).toContain("Taille moyenne d'un tour aujourd'hui : 30 k tokens lus");
    db.close();
  });
});
