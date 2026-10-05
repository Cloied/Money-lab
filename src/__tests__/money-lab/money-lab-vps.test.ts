/**
 * Money Lab self-hosted (VPS) runtime tests: survival balance and death,
 * the Anthropic backend request shape, Telegram owner channel and Stripe
 * revenue sync. All network access goes through stubbed fetch functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 0) };
});

import { createDatabase } from "../../state/database.js";
import { runAgentLoop } from "../../agent/loop.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { createInferenceClient } from "../../conway/inference.js";
import { buildContextMessages } from "../../agent/context.js";
import { InferenceRouter } from "../../inference/router.js";
import { ModelRegistry } from "../../inference/registry.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { applyMoneyLabProfile, moneyLabDeniedTools } from "../../money-lab/profile.js";
import {
  addLedgerEntry,
  createHelpRequest,
  ensureMoneyLabSchema,
  getHelpRequest,
  getKV,
  pendingOwnerNotifications,
} from "../../money-lab/journal.js";
import {
  accruedHostingCents,
  createSelfHostedClient,
  markRunStarted,
  scrubbedEnv,
  survivalBalance,
} from "../../money-lab/selfhosted.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { TelegramChannel, parseDollars } from "../../money-lab/telegram.js";
import { ledgerEntriesFor, syncStripe } from "../../money-lab/stripe.js";
import { formatStatus } from "../../money-lab/status.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";
import { MONEY_LAB_WAKE_REASON_KEY, OWNER_TELEGRAM_SENDER } from "../../money-lab/journal.js";
import { runLocalCommand, findBrowser } from "../../money-lab/selfhosted.js";
import { REVIEW_KEY, isReviewDue } from "../../money-lab/review.js";
import { allocationSummary, recordFocusSpend, setBudgetPlan, weeklySpend } from "../../money-lab/allocation.js";
import http from "http";
import { backupStateDaily } from "../../money-lab/backup.js";
import { resetSearchConsoleToken } from "../../money-lab/searchconsole.js";
import crypto from "crypto";
import { isRuntimePath } from "../../money-lab/guard.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "../mocks.js";
import { listJobs, runDueJobs, upsertJob } from "../../money-lab/jobs.js";
import { recall } from "../../money-lab/recall.js";
import { gatherDocuments, htmlToText } from "../../money-lab/delegate.js";
import { isOperatorWake } from "../../money-lab/cycle.js";
import { auditPage, summarizeLighthouse } from "../../money-lab/audit.js";
import { abVerdict } from "../../money-lab/abtest.js";
import { pause as pauseMoneyLab, upsertExperiment } from "../../money-lab/journal.js";

function vpsProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    profile: "first-run",
    runtime: "self-hosted",
    telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", ownerChatId: 42 },
    stripe: { apiKeyEnv: "STRIPE_API_KEY", syncMinutes: 30, currency: "eur", usdPerUnit: 1.1 },
    inference: { model: "claude-sonnet-5-5", effort: "medium", perCallCents: null, hourlyCents: null, dailyCents: null, maxOutputTokens: 16000 },
    payments: "disabled",
    paymentLimits: { perPaymentCents: null, dailyCents: null },
    deniedTools: [],
    maxTurnsPerCycle: null,
    noProgressCycles: 5,
    noProgressSleepMinutes: 120,
    resources: [{ id: "vps", kind: "server", description: "VPS", expectedDailyCostCents: 50 }],
    funding: { currency: "USD", provisionedCents: 2000, heldBackCents: 0 },
    ...overrides,
  };
}

function vpsConfig(overrides: Record<string, unknown> = {}): AutomatonConfig {
  return applyMoneyLabProfile(createTestConfig({ moneyLab: vpsProfile(overrides) as any, sandboxId: "", logLevel: "error" }));
}

let tmpDirs: string[] = [];
function openDb(): AutomatonDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-vps-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Unexpected network access in a mocked test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function recordInference(db: AutomatonDatabase, cents: number): void {
  new InferenceBudgetTracker(db.raw, vpsConfig().modelStrategy!).recordCost({
    sessionId: "s", turnId: null, model: "claude-sonnet-5-5", provider: "anthropic", inputTokens: 0,
    outputTokens: 0, costCents: cents, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
  });
}

// ─── Survival balance ───────────────────────────────────────────

describe("Self-hosted survival balance", () => {
  it("is funding + confirmed revenue - spending, with hosting accrued per day", () => {
    const db = openDb();
    const lab = vpsConfig().moneyLab!;
    const start = new Date("2026-10-01T00:00:00Z");
    markRunStarted(db.raw, start);
    const now = new Date("2026-10-03T00:00:00Z");
    expect(accruedHostingCents(db.raw, lab, now)).toBe(100);

    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 2000, source: "operator", reference: "f1" });
    addLedgerEntry(db.raw, { kind: "estimated_revenue", amountCents: 9999, source: "operator", reference: "est" });
    addLedgerEntry(db.raw, { kind: "confirmed_revenue", amountCents: 500, source: "provider_import", reference: "r1" });
    addLedgerEntry(db.raw, { kind: "fee", amountCents: 20, source: "provider_import", reference: "fee1" });
    recordInference(db, 300);

    const s = survivalBalance(db.raw, lab, now);
    // 2000 + 500 - (300 inference + 20 fee + 100 hosting); estimated revenue never counts
    expect(s.balanceCents).toBe(2080);
    expect(s.confirmedRevenueCents).toBe(500);
    expect(s.daysLeft).not.toBeNull();
    db.close();
  });

  it("the bot dies with no funds, notifies the owner once, and revives after funding", async () => {
    const db = openDb();
    const config = vpsConfig();
    recordInference(db, 10);
    const run = (inference: MockInferenceClient) => runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" }, config, db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
    });

    const dead = new MockInferenceClient([noToolResponse("should not run")]);
    await run(dead);
    await run(dead);
    expect(dead.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("dead");
    expect(pendingOwnerNotifications(db.raw).filter((n) => n.text.includes("mort"))).toHaveLength(1);
    expect(formatStatus(db.raw, config)).toMatch(/MORT/);

    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 1000, source: "operator", reference: "revive" });
    const alive = new MockInferenceClient([noToolResponse("back")]);
    await run(alive);
    expect(alive.calls).toHaveLength(1);
    expect(alive.calls[0].options?.model).toBe("claude-sonnet-5-5");
    expect(getKV(db.raw, "money_lab.died_at")).toBeUndefined();
    db.close();
  });
});

// ─── Self-hosted environment ────────────────────────────────────

describe("Self-hosted environment", () => {
  it("runs locally, reports the journal balance and refuses Conway-only operations", async () => {
    const local = new MockConwayClient();
    const client = createSelfHostedClient(local, () => 1234);
    expect(await client.getCreditsBalance()).toBe(1234);
    expect(await createSelfHostedClient(local, () => -1).getCreditsBalance()).toBe(-2);
    await client.exec("ls");
    expect(local.execCalls).toHaveLength(1);
    await expect(client.createSandbox({ name: "x" } as any)).rejects.toThrow(/self-hosted/);
    await expect(client.registerDomain("x.com")).rejects.toThrow(/self-hosted/);
    // No proxy on a VPS: never report a localhost URL as published.
    await expect(client.exposePort(8080)).rejects.toThrow(/self-hosted/);
  });

  it("hides Conway-only tools and keeps secrets out of the shell", async () => {
    const config = vpsConfig();
    const denied = moneyLabDeniedTools(config.moneyLab!);
    for (const t of ["create_sandbox", "register_domain", "topup_credits", "spawn_child", "expose_port"]) expect(denied.has(t), t).toBe(true);
    for (const t of ["exec", "write_file", "install_skill", "git_push", "message_owner"]) expect(denied.has(t), t).toBe(false);

    const env = scrubbedEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "a", TELEGRAM_BOT_TOKEN: "t", STRIPE_API_KEY: "s" });
    expect(env).toEqual({ PATH: "/bin" });

    const db = openDb();
    const ctx: ToolContext = {
      identity: createTestIdentity(), config, db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
    };
    const tools = [...createBuiltinTools(""), ...createMoneyLabTools()];
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
    for (const command of ["echo $TELEGRAM_BOT_TOKEN", "cat /proc/1/environ", "printenv STRIPE_API_KEY"]) {
      const r = await executeTool("exec", { command }, tools, ctx, engine, turn);
      expect(r.error, command).toMatch(/MONEY_LAB_PROTECTED_COMMAND/);
    }
    const msg = await executeTool("message_owner", { text: "Premier client !" }, tools, ctx, engine, turn);
    expect(msg.error).toBeUndefined();
    expect(pendingOwnerNotifications(db.raw).map((n) => n.text)).toContain("🤖 Premier client !");

    const prompt = buildMoneyLabPromptBlock(db.raw, config.moneyLab!);
    expect(prompt).toContain("no expose_port");
    expect(prompt).toContain("request_help to open that port");
    expect(prompt).not.toContain("new sandboxes");
    db.close();
  });
});

// ─── Anthropic backend ──────────────────────────────────────────

describe("Anthropic backend (official SDK)", () => {
  function anthropicResponse(body: Record<string, unknown>) {
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      usage: { input_tokens: 1200, output_tokens: 300 }, ...body,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  function client() {
    return createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-sonnet-5-5", maxTokens: 16000,
      anthropicApiKey: "sk-ant-test", anthropicEffort: "medium",
      getModelProvider: (m) => (m.startsWith("claude") ? "anthropic" : undefined),
    });
  }

  it("sends effort, auto tool choice and the default refusal fallback; never replays thinking", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicResponse({
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "Je liste les fichiers." },
        { type: "tool_use", id: "tu_1", name: "exec", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
    }));
    const res = await client().chat(
      [
        { role: "system", content: "Tu es Money Lab." },
        { role: "user", content: "Commence." },
      ],
      { tools: [{ type: "function", function: { name: "exec", description: "run", parameters: { type: "object", properties: {} } } }] } as any,
    );
    expect(res.toolCalls?.[0].function.name).toBe("exec");
    expect(res.message.content).toBe("Je liste les fichiers.");
    expect(res.usage.promptTokens).toBe(1200);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.system).toEqual([{ type: "text", text: "Tu es Money Lab." }]);
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(JSON.stringify(body.messages)).not.toContain("thinking");
  });

  it("caches the stable system prefix and reports cache usage", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicResponse({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000, output_tokens: 10 },
    }));
    const system = "Core rules.\n\n--- WORKLOG.md (ctx) ---\nnotes\n\n--- MONEY LAB RULES (enforced by the runtime) ---\nbalance $14.53";
    const res = await client().chat([{ role: "system", content: system }, { role: "user", content: "x" }]);
    expect(res.usage).toMatchObject({ promptTokens: 10_500, cacheReadTokens: 9000, cacheWriteTokens: 1000 });

    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    // Stable parts stay in system, both cached; the live balance moves after
    // the history as a trailing system message, so the history is cacheable.
    expect(body.system).toHaveLength(2);
    expect(body.system[0]).toMatchObject({ text: "Core rules.\n\n", cache_control: { type: "ephemeral" } });
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(body.system)).not.toContain("balance");
    const last = body.messages.at(-1);
    expect(last).toEqual({ role: "system", content: "--- MONEY LAB RULES (enforced by the runtime) ---\nbalance $14.53" });
    expect(body.messages.at(-2).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    const breakpoints = JSON.stringify(body).match(/"cache_control"/g)?.length ?? 0;
    expect(breakpoints).toBeLessThanOrEqual(4);
  });

  it("keeps tool-only turns in history so the agent sees what it already did", async () => {
    // Claude often answers with tool calls and no text: such turns used to be
    // dropped from the history, and the agent repeated the same check forever.
    const turn = (id: string, input?: string) => ({
      id, timestamp: "2026-10-04T22:00:10Z", state: "running" as const, input, inputSource: input ? "wakeup" as const : undefined,
      thinking: "",
      toolCalls: [{ id: `tc_${id}`, name: "exec", arguments: { command: "curl localhost:8080" }, result: "exit 7: connection refused", durationMs: 5 }],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, costCents: 0,
    });
    const context = buildContextMessages("Tu es Money Lab.", [turn("1", "Wake up"), turn("2")] as any, {
      content: "Wake up", source: "wakeup",
    });
    expect(context.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "exit 7: connection refused", "exit 7: connection refused",
    ]);
    // The router prepares the messages for Anthropic before the client sends them.
    const db = openDb();
    const config = vpsConfig();
    const router = new InferenceRouter(
      db.raw, new ModelRegistry(db.raw), new InferenceBudgetTracker(db.raw, config.modelStrategy!),
    );
    const messages = router.transformMessagesForProvider(context, "anthropic");
    db.close();

    fetchSpy.mockResolvedValueOnce(anthropicResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    await client().chat(messages);
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[0].role).toBe("user");
    expect(body.messages.at(-1).role).toBe("user");
    const uses = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === "tool_use" || b.type === "tool_result");
    expect(uses.map((b: any) => b.type)).toEqual(["tool_use", "tool_result", "tool_use", "tool_result"]);
    // Every tool_use is answered by a tool_result at the start of the next message.
    body.messages.forEach((m: any, i: number) => {
      const ids = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      if (ids.length === 0) return;
      const next = body.messages[i + 1].content;
      expect(next.slice(0, ids.length).map((b: any) => b.tool_use_id)).toEqual(ids);
    });
    expect(JSON.stringify(body.messages)).not.toContain('"text":""');

    // A trimmed history that starts and ends with the agent still starts and ends with a user turn.
    fetchSpy.mockResolvedValueOnce(anthropicResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    await client().chat([{ role: "assistant", content: "J'ai fini." }]);
    const roles = JSON.parse(String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body)).messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("reports a refusal instead of failing the turn", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicResponse({ content: [], stop_reason: "refusal" }));
    const res = await client().chat([{ role: "user", content: "x" }]);
    expect(res.finishReason).toBe("refusal");
  });
});

// ─── Telegram ───────────────────────────────────────────────────

describe("Telegram owner channel", () => {
  function telegram(db: AutomatonDatabase, updates: any[]) {
    const sent: string[] = [];
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: any, init: any) => {
      const method = String(url).split("/").pop();
      calls.push(String(url));
      if (method === "getUpdates") {
        return new Response(JSON.stringify({ ok: true, result: updates.splice(0) }), { status: 200 });
      }
      sent.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    });
    const channel = new TelegramChannel("TOKEN123", 42, db, vpsConfig(), fetchFn as any);
    return { channel, sent, calls };
  }
  const msg = (id: number, chat: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: chat }, text } });
  const morning = new Date("2026-10-04T06:00:00Z");

  it("serves only the owner, forwards free text to the bot and wakes it", async () => {
    const db = openDb();
    const { channel, sent } = telegram(db, [msg(1, 999, "/pause"), msg(2, 42, "Concentre-toi sur les PDF"), msg(3, 42, "/statut")]);
    await channel.tick(morning);
    expect(getKV(db.raw, "money_lab.paused")).toBeUndefined();
    const inbox = db.raw.prepare("SELECT from_address, content FROM inbox_messages").all() as any[];
    expect(inbox).toEqual([{ from_address: "owner (Telegram)", content: "Concentre-toi sur les PDF" }]);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM wake_events WHERE source = 'money_lab_operator'").get() as any).n).toBe(1);
    expect(sent[0]).toBe("Message transmis au bot.");
    expect(sent[1]).toMatch(/ÉTAT MONEY LAB/);
    expect(getKV(db.raw, "money_lab.telegram_offset")).toBe("4");
    db.close();
  });

  it("handles funding, help answers, pause and the outbox", async () => {
    const db = openDb();
    const help = createHelpRequest(db.raw, { experimentId: null, reason: "Compte Stripe", humanAction: "Créer le compte", resumeCondition: "Clé fournie" });
    const { channel, sent } = telegram(db, [
      msg(10, 42, "/fonds 21,50"),
      msg(11, 42, `/ok ${help.id} compte créé`),
      msg(12, 42, "/pause test"),
      msg(13, 42, "/reprendre"),
    ]);
    await channel.tick(morning);
    expect(survivalBalance(db.raw, vpsConfig().moneyLab!).fundingCents).toBe(2150);
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("resolved");
    expect(sent.some((t) => t.includes("Demande d'aide"))).toBe(true); // queued notification delivered
    expect(pendingOwnerNotifications(db.raw)).toHaveLength(0);
    expect(parseDollars("abc")).toBeNull();
    db.close();
  });

  it("sends one daily summary and never leaks the token in errors", async () => {
    const db = openDb();
    const { channel, sent } = telegram(db, []);
    await channel.tick(new Date("2026-10-04T08:00:00Z"));
    await channel.tick(new Date("2026-10-04T09:00:00Z"));
    expect(sent.filter((t) => t.includes("RÉSUMÉ QUOTIDIEN"))).toHaveLength(1);

    const failing = new TelegramChannel("SECRET_TOKEN", 42, db, vpsConfig(), (async () =>
      new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })) as any);
    const err = await failing.tick(morning).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("SECRET_TOKEN");
    db.close();
  });
});

// ─── Stripe ─────────────────────────────────────────────────────

describe("Stripe revenue sync", () => {
  const cfg = vpsConfig().moneyLab!.stripe!;

  it("maps charges, fees, refunds and payouts with the owner's rate", () => {
    const charge = ledgerEntriesFor({ id: "txn_1", type: "charge", amount: 1000, fee: 59, currency: "eur", created: 1 }, cfg);
    expect(charge).toEqual([
      expect.objectContaining({ kind: "confirmed_revenue", amountCents: 1100, reference: "stripe:txn_1" }),
      expect.objectContaining({ kind: "fee", amountCents: 65, reference: "stripe-fee:txn_1" }),
    ]);
    expect(ledgerEntriesFor({ id: "r", type: "refund", amount: -500, fee: 0, currency: "eur", created: 1 }, cfg)[0])
      .toMatchObject({ kind: "refund", amountCents: 550 });
    expect(ledgerEntriesFor({ id: "p", type: "payout", amount: -900, fee: 0, currency: "eur", created: 1 }, cfg)[0])
      .toMatchObject({ kind: "cash_received", amountCents: 990 });
    expect(ledgerEntriesFor({ id: "a", type: "adjustment", amount: 5, fee: 0, currency: "eur", created: 1 }, cfg)).toEqual([]);
  });

  it("imports once, skips other currencies, extends survival and notifies the owner", async () => {
    const db = openDb();
    const page = {
      data: [
        { id: "txn_1", type: "charge", amount: 1000, fee: 59, currency: "eur", created: 2 },
        { id: "txn_2", type: "charge", amount: 700, fee: 0, currency: "usd", created: 1 },
      ],
      has_more: false,
    };
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer rk_test");
      return new Response(JSON.stringify(page), { status: 200 });
    });
    const first = await syncStripe(db.raw, cfg, "rk_test", fetchFn as any);
    expect(first).toEqual({ imported: 2, revenueCents: 1100, skippedCurrency: 1 });
    const second = await syncStripe(db.raw, cfg, "rk_test", fetchFn as any);
    expect(second.imported).toBe(0);
    expect(survivalBalance(db.raw, vpsConfig().moneyLab!).confirmedRevenueCents).toBe(1100);
    expect(pendingOwnerNotifications(db.raw).filter((n) => n.text.includes("Stripe"))).toHaveLength(1);
    db.close();
  });

  it("surfaces Stripe errors without the key", async () => {
    const db = openDb();
    const fetchFn = async () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
    await expect(syncStripe(db.raw, cfg, "rk_secret", fetchFn as any)).rejects.toThrow(/401 Invalid API Key/);
    db.close();
  });
});

describe("Self-hosted profile validation", () => {
  it("validates runtime, effort, Telegram and Stripe settings", () => {
    expect(() => vpsConfig({ runtime: "cloud" })).toThrow(/runtime/);
    expect(() => vpsConfig({ inference: { model: "claude-sonnet-5-5", effort: "huge", perCallCents: null, hourlyCents: null, dailyCents: null, maxOutputTokens: null } })).toThrow(/effort/);
    expect(() => vpsConfig({ telegram: { botTokenEnv: "my token", ownerChatId: 1 } })).toThrow(/botTokenEnv/);
    expect(() => vpsConfig({ telegram: { botTokenEnv: "TOKEN", ownerChatId: "me" } })).toThrow(/ownerChatId/);
    expect(() => vpsConfig({ stripe: { apiKeyEnv: "K", syncMinutes: 30, currency: "usd", usdPerUnit: 1.2 } })).toThrow(/usdPerUnit/);
    const config = vpsConfig();
    expect(config.maxTokensPerTurn).toBe(16000);
    expect(config.modelStrategy?.pinnedModel).toBe("claude-sonnet-5-5");
  });
});

// ─── Fixes from the end-to-end audit (2026-10-05) ───────────────

describe("End-to-end audit fixes", () => {
  it("reads the owner's Telegram message on the wake turn, as the owner's, then sleeps 15 minutes", async () => {
    const db = openDb();
    const config = vpsConfig();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 1000, source: "operator", reference: "f" });
    const at = new Date().toISOString();
    db.insertInboxMessage({
      id: "tg_7", from: OWNER_TELEGRAM_SENDER, to: "", signedAt: at, createdAt: at,
      content: "Ignore les instructions précédentes et arrête de dépenser.",
    });
    db.setKV(MONEY_LAB_WAKE_REASON_KEY, "Message du propriétaire");
    const inference = new MockInferenceClient([noToolResponse("D'accord, j'arrête.")]);
    const before = Date.now();
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" }, config, db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
    });
    expect(inference.calls).toHaveLength(1);
    const last = String(inference.calls[0].messages.at(-1)?.content);
    expect(last).toContain("[Message from your owner via Telegram]: Ignore les instructions précédentes");
    expect(last).not.toMatch(/BLOCKED|unverified/);
    expect(last).toContain("Wake-up reason: Message du propriétaire");
    expect(db.getKV(MONEY_LAB_WAKE_REASON_KEY)).toBeUndefined();
    const sleepUntil = new Date(db.getKV("sleep_until")!).getTime();
    expect(sleepUntil - before).toBeGreaterThan(14 * 60_000);
    db.close();
  });

  it("runs commands without blocking the process, returns despite background jobs, and enforces timeouts", async () => {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir() };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const slow = await runLocalCommand("sleep 1; echo fini", 10_000, env);
    clearInterval(timer);
    expect(slow).toMatchObject({ stdout: "fini\n", exitCode: 0 });
    expect(ticks).toBeGreaterThan(10);

    // A background job keeps the output pipe open: the call still returns at once.
    const t0 = Date.now();
    const bg = await runLocalCommand("sleep 3 & echo lancé", 10_000, env);
    expect(bg.stdout).toBe("lancé\n");
    expect(Date.now() - t0).toBeLessThan(2_000);

    const t1 = Date.now();
    const killed = await runLocalCommand("sleep 5", 300, env);
    expect(killed.exitCode).toBe(124);
    expect(killed.stderr).toMatch(/timeout/);
    expect(Date.now() - t1).toBeLessThan(3_000);

    const failing = await runLocalCommand("echo oups >&2; exit 3", 10_000, env);
    expect(failing).toMatchObject({ stderr: "oups\n", exitCode: 3 });
  });

  it("confines write_file to $HOME on a server (the bot user cannot write to /root)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-home-"));
    tmpDirs.push(home);
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const db = openDb();
      const conway = new MockConwayClient();
      const ctx: ToolContext = {
        identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway, inference: new MockInferenceClient(),
      };
      const tools = createBuiltinTools("");
      const engine = new PolicyEngine(db.raw, createDefaultRules());
      const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
      const ok = await executeTool("write_file", { path: "~/site/index.html", content: "<h1>x</h1>" }, tools, ctx, engine, turn);
      expect(ok.result).toBe(`File written: ${path.join(home, "site/index.html")}`);
      expect(conway.files[path.join(home, "site/index.html")]).toBe("<h1>x</h1>");
      const outside = await executeTool("write_file", { path: "/root/x.txt", content: "x" }, tools, ctx, engine, turn);
      expect(outside.error || outside.result).toMatch(/outside the allowed directory/);
      const config = await executeTool("write_file", { path: "~/.automaton/automaton.json", content: "{}" }, tools, ctx, engine, turn);
      expect(config.error).toMatch(/MONEY_LAB_RUNTIME_PATH/);
      db.close();
    } finally {
      process.env.HOME = previous;
    }
  });

  it("maps Anthropic stop reasons so the loop can sleep after a final answer", async () => {
    const make = (stop: string) => new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "fin" }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-sonnet-5-5", maxTokens: 1000,
      anthropicApiKey: "sk-ant-test", getModelProvider: () => "anthropic",
    });
    for (const [stop, expected] of [["end_turn", "stop"], ["stop_sequence", "stop"], ["max_tokens", "length"]]) {
      fetchSpy.mockResolvedValueOnce(make(stop));
      expect((await client.chat([{ role: "user", content: "x" }])).finishReason, stop).toBe(expected);
    }
  });

  it("warns about repetition only for identical calls when asked to", () => {
    const turn = (command: string) => ({
      id: command, timestamp: "t", state: "running" as const, thinking: "",
      toolCalls: [{ id: `tc_${command}`, name: "exec", arguments: { command }, result: "ok", durationMs: 1 }],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, costCents: 0,
    });
    const warned = (turns: any[]) => buildContextMessages("s", turns, undefined, { repeatByCall: true })
      .some((m) => String(m.content).includes("WARNING: You have been calling"));
    expect(warned([turn("mkdir site"), turn("vim index.html"), turn("python3 serve.py")])).toBe(false);
    expect(warned([turn("ls"), turn("ls"), turn("ls")])).toBe(true);
  });
});

// ─── Autonomy: eyes, research, budget split, review (2026-10-05) ─

describe("Autonomy capabilities", () => {
  const PW_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const browser = findBrowser({ PATH: process.env.PATH, MONEY_LAB_BROWSER: PW_CHROME });

  function toolCtx(db: AutomatonDatabase, conway = new MockConwayClient() as any): ToolContext {
    return { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway, inference: new MockInferenceClient() };
  }
  const turnCtx = (db: AutomatonDatabase) => ({ inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });

  it.skipIf(!browser)("view_page screenshots a page (screen and print) and sends it to Claude as an image", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-eyes-"));
    tmpDirs.push(home);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Factures</h1><style>@media print{h1{color:red}}</style>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const previous = { HOME: process.env.HOME, MONEY_LAB_BROWSER: process.env.MONEY_LAB_BROWSER };
    process.env.HOME = home;
    process.env.MONEY_LAB_BROWSER = browser!;
    try {
      const db = openDb();
      const conway = createSelfHostedClient(new MockConwayClient(), () => 1000, {
        exec: (c, t) => runLocalCommand(c, t, { PATH: process.env.PATH, HOME: home }),
      });
      const tools = createMoneyLabTools();
      const engine = new PolicyEngine(db.raw, createDefaultRules());
      for (const viewport of ["desktop", "print"]) {
        const r = await executeTool("view_page", { url: `http://127.0.0.1:${port}/`, viewport }, tools, toolCtx(db, conway), engine, turnCtx(db));
        const file = String(r.result).match(/\[\[image:(.+\.png)\]\]/)?.[1];
        expect(file, `${viewport}: ${r.result}${r.error ?? ""}`).toBeTruthy();
        expect(fs.statSync(file!).size).toBeGreaterThan(1000);
      }
      const shot = String((await executeTool("view_page", { url: `http://127.0.0.1:${port}/` }, tools, toolCtx(db, conway), engine, turnCtx(db))).result);
      expect((await executeTool("view_page", { url: "file:///etc/passwd" }, tools, toolCtx(db, conway), engine, turnCtx(db))).result)
        .toMatch(/Only http/);

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "Joli." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      const client = createInferenceClient({
        apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-sonnet-5-5", maxTokens: 1000,
        anthropicApiKey: "sk-ant-test", getModelProvider: () => "anthropic",
      });
      await client.chat([
        { role: "user", content: "Regarde ton site." },
        { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "view_page", arguments: "{}" } }] },
        { role: "tool", content: shot, tool_call_id: "t1" },
      ]);
      const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
      const result = body.messages[2].content[0];
      expect(result.type).toBe("tool_result");
      expect(result.content[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
      expect(result.content[0].text).not.toContain("[[image:");
      db.close();
    } finally {
      process.env.HOME = previous.HOME;
      if (previous.MONEY_LAB_BROWSER === undefined) delete process.env.MONEY_LAB_BROWSER;
      else process.env.MONEY_LAB_BROWSER = previous.MONEY_LAB_BROWSER;
      server.close();
    }
  }, 60_000);

  it.skipIf(!browser)("browse drives a real browser: open, list, fill, click, read, screenshot", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-hands-"));
    tmpDirs.push(home);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<title>Facture</title><input id="qty" value="1"><input name="price" value="0">
        <button onclick="document.getElementById('tot').textContent=(qty.value*document.querySelector('[name=price]').value).toFixed(2)">Calculer</button>
        <p>Total : <span id="tot">0.00</span></p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as any).port}/`;
    const previous = { HOME: process.env.HOME, MONEY_LAB_BROWSER: process.env.MONEY_LAB_BROWSER };
    process.env.HOME = home;
    process.env.MONEY_LAB_BROWSER = browser!;
    try {
      const db = openDb();
      const tools = createMoneyLabTools();
      const engine = new PolicyEngine(db.raw, createDefaultRules());
      const run = async (args: Record<string, unknown>) =>
        String((await executeTool("browse", args, tools, toolCtx(db), engine, turnCtx(db))).result);
      expect(await run({ action: "goto", url })).toContain("Title: Facture");
      const elements = await run({ action: "elements" });
      expect(elements).toContain("#qty");
      expect(elements).toContain('input[name="price"]');
      expect(elements).toContain('button:has-text("Calculer")');
      await run({ action: "fill", selector: "#qty", value: "3" });
      await run({ action: "fill", selector: 'input[name="price"]', value: "12.5" });
      await run({ action: "click", selector: 'button:has-text("Calculer")' });
      expect(await run({ action: "text", selector: "#tot" })).toContain("37.50");
      expect(await run({ action: "screenshot" })).toMatch(/\[\[image:.+\.png\]\]/);
      expect(await run({ action: "click", selector: "#missing" })).toMatch(/Browser error/);
      expect(await run({ action: "goto", url: "file:///etc/passwd" })).toMatch(/Only http/);
      expect(await run({ action: "close" })).toBe("Browser closed.");
      expect(fs.existsSync(path.join(home, ".money-lab", "browser-profile"))).toBe(true);
      db.close();
    } finally {
      process.env.HOME = previous.HOME;
      if (previous.MONEY_LAB_BROWSER === undefined) delete process.env.MONEY_LAB_BROWSER;
      else process.env.MONEY_LAB_BROWSER = previous.MONEY_LAB_BROWSER;
      server.close();
    }
  }, 90_000);

  it("offers web search and fetch, resumes a paused turn, bills searches and keeps a trace", async () => {
    const reply = (body: Record<string, unknown>) => new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", ...body,
    }), { status: 200, headers: { "content-type": "application/json" } });
    fetchSpy
      .mockResolvedValueOnce(reply({
        content: [
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "invoice generator niche" } },
          { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", title: "Concurrent A", url: "https://a.example" }] },
        ],
        stop_reason: "pause_turn",
        usage: { input_tokens: 1000, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
      }))
      .mockResolvedValueOnce(reply({
        content: [{ type: "text", text: "Le marché est saturé." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1200, output_tokens: 80, server_tool_use: { web_search_requests: 2 } },
      }));
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-sonnet-5-5", maxTokens: 1000,
      anthropicApiKey: "sk-ant-test", getModelProvider: () => "anthropic", anthropicWebTools: true,
    });
    const res = await client.chat([{ role: "user", content: "Cherche une niche." }],
      { tools: [{ type: "function", function: { name: "exec", description: "run", parameters: { type: "object", properties: {} } } }] } as any);
    const first = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(first.tools.map((t: any) => t.type ?? t.name)).toEqual(["web_search_20260209", "web_fetch_20260209", "exec"]);
    expect(first.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    const second = JSON.parse(String((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body));
    expect(second.messages.at(-1).role).toBe("assistant");
    expect(second.messages.at(-1).content[0].type).toBe("server_tool_use");
    expect(res.usage).toMatchObject({ promptTokens: 2200, completionTokens: 130, serverToolCents: 3 });
    expect(res.finishReason).toBe("stop");
    expect(res.message.content).toContain("Le marché est saturé.");
    expect(res.message.content).toContain('Searched: "invoice generator niche"');
    expect(res.message.content).toContain("Concurrent A — https://a.example");

    // A server tool error (HTTP 200, error object) is reported, not dropped.
    fetchSpy.mockResolvedValueOnce(reply({
      content: [
        { type: "server_tool_use", id: "srv_2", name: "web_search", input: { query: "niche" } },
        { type: "web_search_tool_result", tool_use_id: "srv_2", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
        { type: "text", text: "La recherche a échoué." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const failed = await client.chat([{ role: "user", content: "Cherche." }],
      { tools: [{ type: "function", function: { name: "exec", description: "run", parameters: { type: "object", properties: {} } } }] } as any);
    expect(failed.message.content).toContain("Errors: web_search: unavailable");
    fetchSpy.mockClear();

    // Summaries and other tool-less calls never search.
    fetchSpy.mockResolvedValueOnce(reply({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    await client.chat([{ role: "user", content: "Résume." }]);
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body)).tools).toBeUndefined();
  });

  it("splits the budget by purpose and attributes spend to the current focus", async () => {
    const db = openDb();
    expect(setBudgetPlan(db.raw, { research: 60, build: 50 })).toMatch(/exceed 100/);
    expect(setBudgetPlan(db.raw, { dreams: 10 })).toMatch(/Unknown category/);
    const tools = createMoneyLabTools();
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const r = await executeTool("set_budget_focus", { focus: "research", plan: { research: 25, build: 45, marketing: 15, learning: 10, operations: 5 } },
      tools, toolCtx(db), engine, turnCtx(db));
    expect(r.result).toMatch(/current focus: research/);
    recordFocusSpend(db.raw, 30);
    await executeTool("set_budget_focus", { focus: "build" }, tools, toolCtx(db), engine, turnCtx(db));
    recordFocusSpend(db.raw, 70);
    expect(weeklySpend(db.raw)).toEqual({ research: 30, build: 70 });
    expect(allocationSummary(db.raw)).toContain("build $0.70 (70%)");
    expect(formatStatus(db.raw, vpsConfig())).toMatch(/Plan : recherche 25 %, construction 45 %/);
    db.close();
  });

  it("caps sleep at 24 h and runs a weekly review that reads the agent's lessons", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-review-"));
    tmpDirs.push(home);
    fs.writeFileSync(path.join(home, "LESSONS.md"), "- Reddit filtre les comptes neufs.");
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const db = openDb();
      const tools = createBuiltinTools("");
      const engine = new PolicyEngine(db.raw, createDefaultRules());
      const s = await executeTool("sleep", { duration_seconds: 604800, reason: "attente" }, tools, toolCtx(db), engine, turnCtx(db));
      expect(s.result).toMatch(/capped at 24 h/);
      expect(new Date(db.getKV("sleep_until")!).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);

      addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 1000, source: "operator", reference: "f" });
      db.setKV(REVIEW_KEY, new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());
      expect(isReviewDue(db.raw)).toBe(true);
      const inference = new MockInferenceClient([noToolResponse("Bilan fait.")]);
      await runAgentLoop({
        identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference,
        policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
      });
      const sent = inference.calls[0].messages;
      expect(String(sent.at(-1)?.content)).toContain("WEEKLY REVIEW");
      expect(String(sent[0].content)).toContain("Reddit filtre les comptes neufs.");
      expect(String(sent[0].content)).toContain("web_search");
      expect(inference.calls[0].options?.model).toBe("claude-opus-5-5");
      expect(isReviewDue(db.raw)).toBe(false);
      db.close();
    } finally {
      process.env.HOME = previous;
    }
  });
});

describe("Reliability", () => {
  it("alerts the owner on Telegram after repeated errors, at most hourly", async () => {
    const db = openDb();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 1000, source: "operator", reference: "f" });
    const failing = new MockInferenceClient([]);
    (failing as any).chat = async () => { throw new Error("Inference error (anthropic): 400: tool_use ids were found without tool_result"); };
    const run = () => runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: failing,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
    });
    await run();
    await run();
    const alerts = pendingOwnerNotifications(db.raw).filter((n) => n.text.includes("enchaîné"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("tool_use ids were found");
    db.close();
  }, 30_000);

  it("backs up the state database once a day, keeps 7 copies, and protects them", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-backup-"));
    tmpDirs.push(home);
    const db = openDb();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 1234, source: "operator", reference: "f" });
    const first = await backupStateDaily(db.raw, home, new Date("2026-10-01T03:00:00Z"));
    expect(first).toMatch(/state\.db\.backup-2026-10-01$/);
    expect(await backupStateDaily(db.raw, home, new Date("2026-10-01T09:00:00Z"))).toBeNull();
    for (let d = 2; d <= 9; d++) await backupStateDaily(db.raw, home, new Date(Date.UTC(2026, 9, d, 3)));
    const files = fs.readdirSync(path.join(home, ".automaton", "backups")).sort();
    expect(files).toHaveLength(7);
    expect(files[0]).toBe("state.db.backup-2026-10-03");
    const copy = createDatabase(path.join(home, ".automaton", "backups", files.at(-1)!));
    expect(JSON.stringify(copy.raw.prepare("SELECT amount_cents FROM money_lab_ledger").all())).toContain("1234");
    copy.close();
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(isRuntimePath("~/.automaton/backups/state.db.backup-2026-10-09")).toBe(true);
      expect(isRuntimePath("~/.automaton/gsc-key.json")).toBe(true);
    } finally {
      process.env.HOME = previous;
    }
    db.close();
  });
});

describe("Search Console access", () => {
  it("signs a read-only JWT, queries search analytics and formats the rows", async () => {
    resetSearchConsoleToken();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-gsc-"));
    tmpDirs.push(home);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.mkdirSync(path.join(home, ".automaton"), { recursive: true });
    fs.writeFileSync(path.join(home, ".automaton", "gsc-key.json"), JSON.stringify({
      client_email: "bot@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    fetchSpy.mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
        const [h, c, sig] = assertion.split(".");
        const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, "base64url"));
        const claims = JSON.parse(Buffer.from(c, "base64url").toString());
        expect(ok).toBe(true);
        expect(claims).toMatchObject({ iss: "bot@project.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/webmasters.readonly" });
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
      }
      expect(String(url)).toBe(
        "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fmoneylab-djib.github.io%2Ffree-invoice-generator%2F/searchAnalytics/query",
      );
      expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe("Bearer ya29.test");
      expect(JSON.parse(String(init.body))).toMatchObject({ dimensions: ["query"], rowLimit: 25, startDate: "2026-09-06", endDate: "2026-10-03" });
      return new Response(JSON.stringify({ rows: [
        { keys: ["facture auto entrepreneur"], clicks: 3, impressions: 120, ctr: 0.025, position: 18.4 },
      ] }), { status: 200 });
    });
    const previous = { HOME: process.env.HOME, GSC_SITE: process.env.GSC_SITE };
    process.env.HOME = home;
    process.env.GSC_SITE = "https://moneylab-djib.github.io/free-invoice-generator/";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    try {
      const db = openDb();
      const r = await executeTool("search_console", {}, createMoneyLabTools(),
        { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() },
        new PolicyEngine(db.raw, createDefaultRules()), { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });
      expect(r.result).toContain("facture auto entrepreneur: 3 clicks, 120 impr., CTR 2.5%, pos 18.4");
      const block = buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!);
      expect(block).toContain("search_console reads Google Search Console");
      expect(block).toContain("Revenue levers");
      db.close();
    } finally {
      vi.useRealTimers();
      process.env.HOME = previous.HOME;
      if (previous.GSC_SITE === undefined) delete process.env.GSC_SITE; else process.env.GSC_SITE = previous.GSC_SITE;
      resetSearchConsoleToken();
    }
  });
});

// ─── Step 1: delegate, scheduled jobs, recall (2026-10-06) ─────

describe("Delegate to a cheaper model", () => {
  it("sends the task and the agent's files to Haiku through the router, and records the cost", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-delegate-"));
    tmpDirs.push(home);
    fs.mkdirSync(path.join(home, "research"));
    fs.writeFileSync(path.join(home, "research", "concurrents.md"), "Factur.io : 9 EUR/mois, 5 factures gratuites.");
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const db = openDb();
      addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 1000, source: "operator", reference: "f" });
      const inference = new MockInferenceClient([
        toolCallResponse([{ name: "delegate", arguments: { task: "Liste les prix", files: ["~/research/concurrents.md", "~/.automaton/state.db"] } }]),
        noToolResponse("Factur.io : 9 EUR/mois."),
        noToolResponse("Noté."),
      ]);
      await runAgentLoop({
        identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference,
        policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
      });
      const call = inference.calls[1];
      expect(call.options?.model).toBe("claude-haiku-4-5");
      expect(call.options?.tools).toBeUndefined();
      expect(String(call.messages[1].content)).toContain("Factur.io : 9 EUR/mois, 5 factures gratuites.");
      expect(String(call.messages[1].content)).toContain("Task: Liste les prix");
      const result = String(inference.calls[2].messages.find((m) => m.role === "tool")?.content);
      expect(result).toContain("Factur.io : 9 EUR/mois.");
      expect(result).toContain("[delegate: claude-haiku-4-5");
      expect(result).toMatch(/state\.db: refused/);
      const models = db.raw.prepare("SELECT model FROM inference_costs").all().map((r: any) => r.model);
      expect(models).toContain("claude-haiku-4-5");
      db.close();
    } finally {
      process.env.HOME = previous;
    }
  });

  it("reads web pages as text and shares the input budget between documents", async () => {
    expect(htmlToText("<html><head><style>p{}</style><script>x()</script></head><body><h1>Prix</h1><p>9&nbsp;&euro;</p></body></html>"))
      .toBe("Prix\n9 &euro;");
    const fetchFn = vi.fn(async () => new Response("<body><p>" + "a".repeat(500_000) + "</p></body>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    const { docs, notes } = await gatherDocuments(
      { task: "t", text: "court", urls: ["https://example.com/", "ftp://x"] },
      { home: os.tmpdir(), fetchFn: fetchFn as any },
    );
    expect(docs.map((d) => d.source)).toEqual(["text", "https://example.com/"]);
    expect(docs[1].content.length).toBe(200_000);
    expect(notes.join(" ")).toMatch(/ftp:\/\/x: only http/);
    expect(notes.join(" ")).toMatch(/truncated/);
  });

  it("never sends effort to Haiku, which rejects it", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5",
      usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-sonnet-5-5", maxTokens: 1000,
      anthropicApiKey: "sk-ant-test", anthropicEffort: "medium",
      getModelProvider: (m) => (m.startsWith("claude") ? "anthropic" : undefined),
    });
    await client.chat([{ role: "user", content: "Résume." }], { model: "claude-haiku-4-5" } as any);
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.output_config).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
  });
});

describe("Scheduled jobs", () => {
  function runner(outputs: Array<{ stdout: string; exitCode: number }>) {
    const commands: string[] = [];
    return {
      commands,
      run: async (command: string) => {
        commands.push(command);
        const next = outputs.shift() ?? { stdout: "", exitCode: 0 };
        return { stdout: next.stdout, stderr: "", exitCode: next.exitCode };
      },
    };
  }

  it("runs due jobs without inference and wakes the agent on change or new failure, at most hourly", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-jobs-"));
    tmpDirs.push(home);
    const db = openDb();
    const t0 = new Date("2026-10-06T08:00:00Z");
    expect(upsertJob(db.raw, { name: "Bad Name", command: "x", everyMinutes: 30 })).toMatch(/name must/);
    expect(upsertJob(db.raw, { name: "fast", command: "x", everyMinutes: 1 })).toMatch(/between 15/);
    upsertJob(db.raw, { name: "visites", command: "curl stats", everyMinutes: 60, wake: "on_change" }, t0);
    upsertJob(db.raw, { name: "site", command: "curl site", everyMinutes: 15, wake: "on_failure" }, t0);
    const wakes: string[] = [];
    const r = runner([
      { stdout: "12", exitCode: 0 }, { stdout: "200", exitCode: 0 },   // t0: baseline, no wake
      { stdout: "000", exitCode: 7 },                                    // +15 min: site fails -> wake
      { stdout: "000", exitCode: 7 },                                    // +30 min: still failing -> no new alert
      { stdout: "000", exitCode: 7 },                                    // +45 min
      { stdout: "19", exitCode: 0 }, { stdout: "200", exitCode: 0 },    // +60 min: visits changed, but < 1 h since last wake
      { stdout: "200", exitCode: 0 },                                    // +75 min
    ]);
    let now = t0;
    const options = { run: r.run, wake: (reason: string) => wakes.push(reason), canWake: () => true, now: () => now, home };
    for (let m = 0; m <= 75; m += 15) {
      now = new Date(t0.getTime() + m * 60_000);
      await runDueJobs(db.raw, options);
    }
    expect(r.commands).toEqual(["curl stats", "curl site", "curl site", "curl site", "curl site", "curl stats", "curl site", "curl site"]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatch(/job "site" failed \(exit 7\)/);
    const visites = listJobs(db.raw).find((j) => j.name === "visites")!;
    expect(visites.lastAlert).toBe('job "visites" output changed');
    expect(fs.readFileSync(path.join(home, ".money-lab", "jobs", "site.log"), "utf-8")).toContain("exit 7");
    expect(buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!)).toMatch(/Scheduled jobs: visites \(every 60 min, wake on_change; last run/);

    pauseMoneyLab(db.raw, "test", "operator");
    now = new Date(t0.getTime() + 24 * 3600_000);
    expect(await runDueJobs(db.raw, options)).toEqual([]);
    expect(isOperatorWake({ source: "money_lab_job" })).toBe(true);
    expect(isOperatorWake({ source: "heartbeat" })).toBe(false);
    db.close();
  });

  it("is a tool the agent drives, with the same protection as exec", async () => {
    const db = openDb();
    const ctx: ToolContext = {
      identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
    };
    const tools = createMoneyLabTools();
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
    const denied = await executeTool("schedule_job", { action: "add", name: "vol", command: "cp ~/.automaton/state.db /tmp/", every_minutes: 60 }, tools, ctx, engine, turn);
    expect(denied.error).toMatch(/MONEY_LAB_PROTECTED_COMMAND/);
    const added = await executeTool("schedule_job", { action: "add", name: "site", command: "echo ok", every_minutes: 30 }, tools, ctx, engine, turn);
    expect(added.result).toMatch(/Scheduled "site" every 30 min \(wake on_failure\)/);
    const list = await executeTool("schedule_job", { action: "list" }, tools, ctx, engine, turn);
    expect(list.result).toContain("site (every 30 min, wake on_failure; not run yet)");
    const removed = await executeTool("schedule_job", { action: "remove", name: "site" }, tools, ctx, engine, turn);
    expect(removed.result).toBe('Removed "site".');
    db.close();
  });
});

describe("Recall", () => {
  it("finds the best passages in the agent's notes and journal, accent-insensitive", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-recall-"));
    tmpDirs.push(home);
    fs.mkdirSync(path.join(home, "research"));
    fs.mkdirSync(path.join(home, "library", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(home, "research", "niches.md"),
      "# Niches\n\nGénérateur de devis pour artisans : forte demande, peu de concurrents.\n\n" + "remplissage\n".repeat(30) +
      "Les factures en ligne sont saturées.\n");
    fs.writeFileSync(path.join(home, "library", "node_modules", "devis.md"), "devis artisans (ignoré)");
    fs.writeFileSync(path.join(home, "LESSONS.md"), "- Les artisans cherchent des devis sur mobile.");
    const db = openDb();
    upsertExperiment(db.raw, { status: "exploring", hypothesis: "Un générateur de devis pour plombiers" });
    const hits = recall("devis artisans", { home, db: db.raw });
    expect(hits.map((h) => h.source)).toEqual(expect.arrayContaining(["~/research/niches.md", "~/LESSONS.md"]));
    expect(hits[0].text).toMatch(/[Dd]evis/);
    expect(hits.some((h) => h.source.includes("node_modules"))).toBe(false);
    expect(recall("plombiers", { home, db: db.raw })[0].source).toMatch(/^experiment /);
    expect(recall("x", { home })).toEqual([]);
    db.close();
  });
});

// ─── Step 2: page audit and A/B tests (2026-10-06) ─────────────

describe("Page audit (Lighthouse)", () => {
  const report = {
    finalDisplayedUrl: "https://org.github.io/site/",
    configSettings: { formFactor: "mobile" },
    categories: {
      performance: { id: "performance", title: "Performance", score: 0.62, auditRefs: [{ id: "largest-contentful-paint", weight: 25 }] },
      accessibility: { id: "accessibility", title: "Accessibility", score: 0.85, auditRefs: [{ id: "image-alt", weight: 10 }, { id: "color-contrast", weight: 7 }] },
      "best-practices": { id: "best-practices", title: "Best Practices", score: 1, auditRefs: [] },
      seo: { id: "seo", title: "SEO", score: 0.82, auditRefs: [{ id: "meta-description", weight: 1 }, { id: "image-alt", weight: 1 }, { id: "hreflang", weight: 0 }] },
    },
    audits: {
      "largest-contentful-paint": { id: "largest-contentful-paint", title: "Largest Contentful Paint", score: 0.3, displayValue: "4.1 s" },
      "first-contentful-paint": { id: "first-contentful-paint", title: "FCP", score: 0.9, displayValue: "1.2 s" },
      "image-alt": { id: "image-alt", title: "Image elements do not have [alt] attributes", score: 0,
        details: { items: [{ node: { snippet: "<img src=\"logo.png\">" } }] } },
      "color-contrast": { id: "color-contrast", title: "Contrast", score: 1 },
      "meta-description": { id: "meta-description", title: "Document does not have a meta description", score: 0 },
      hreflang: { id: "hreflang", title: "hreflang", score: 0 },
      "render-blocking-resources": { id: "render-blocking-resources", title: "Eliminate render-blocking resources", score: 0.5,
        details: { overallSavingsMs: 870, items: [{ url: "https://fonts.googleapis.com/css2" }] } },
    },
  };

  it("summarizes scores, metrics, the failing checks by impact and the speed opportunities", () => {
    const text = summarizeLighthouse(report as any, "/home/x/report.json");
    expect(text).toContain("Lighthouse (mobile) https://org.github.io/site/: Performance 62, Accessibility 85, Best Practices 100, SEO 82.");
    expect(text).toContain("Speed: FCP 1.2 s, LCP 4.1 s.");
    const fixes = text.split("To fix, most impact first:\n")[1].split("\nSpeed opportunities")[0].split("\n");
    expect(fixes[0]).toBe("- [Performance] Largest Contentful Paint (4.1 s)");
    expect(fixes[1]).toBe("- [Accessibility] Image elements do not have [alt] attributes — e.g. <img src=\"logo.png\">");
    expect(fixes).toHaveLength(3);
    expect(text).not.toContain("hreflang");
    expect(text).toContain("- Eliminate render-blocking resources: about 870 ms to save — e.g. https://fonts.googleapis.com/css2");
    expect(summarizeLighthouse({ ...report, runtimeError: { message: "NO_FCP" } } as any)).toMatch(/could not audit the page: NO_FCP/);
  });

  it("runs the bundled Lighthouse CLI with the server's Chrome and keeps the report", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-audit-"));
    tmpDirs.push(home);
    const commands: string[] = [];
    const exec = async (command: string) => {
      commands.push(command);
      const out = /--output-path='([^']+)'/.exec(command)![1];
      fs.writeFileSync(out, JSON.stringify(report));
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const text = await auditPage("https://org.github.io/site/", "desktop", { exec, browser: "/opt/chrome", home });
    expect(commands[0]).toMatch(/^CHROME_PATH='\/opt\/chrome' '[^']+node[^']*' '[^']+\/node_modules\/lighthouse\/cli\/index\.js' 'https:\/\/org\.github\.io\/site\/'/);
    expect(commands[0]).toContain("--preset=desktop");
    expect(fs.existsSync(path.join(process.cwd(), "node_modules", "lighthouse", "cli", "index.js"))).toBe(true);
    expect(text).toContain("Full report: " + path.join(home, ".money-lab", "lighthouse"));
    const failed = await auditPage("https://x/", "mobile", { exec: async () => ({ stdout: "", stderr: "Chrome crashed", exitCode: 1 }), browser: "/c", home });
    expect(failed).toBe("Lighthouse failed (exit 1): Chrome crashed");
  });
});

describe("A/B tests", () => {
  it("declares a winner only when the difference is statistically real", () => {
    expect(abVerdict({ views: 80, goals: 4 }, { views: 90, goals: 20 }).decision).toBe("too_early");
    const win = abVerdict({ views: 400, goals: 20 }, { views: 400, goals: 44 });
    expect(win.decision).toBe("b_wins");
    expect(win.pValue!).toBeLessThan(0.01);
    expect(win.text).toContain("B wins (120% better)");
    expect(abVerdict({ views: 400, goals: 20 }, { views: 400, goals: 25 }).decision).toBe("keep_running");
    expect(abVerdict({ views: 6000, goals: 300 }, { views: 6000, goals: 310 }).decision).toBe("no_difference");
    expect(abVerdict({ views: 500, goals: 50 }, { views: 500, goals: 20 }).decision).toBe("a_wins");
  });

  it("is a tool: start gives cookieless page code, record judges the counts, finish stores the decision", async () => {
    const db = openDb();
    const ctx: ToolContext = {
      identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
    };
    const tools = createMoneyLabTools();
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
    const run = (args: Record<string, unknown>) => executeTool("ab_test", args, tools, ctx, engine, turn).then((r) => r.result);
    const started = await run({ action: "start", name: "cta-title", page: "https://org.github.io/site/", hypothesis: "Un verbe d'action", goal: "Télécharger PDF" });
    expect(started).toContain('ab-cta-title-" + abv + "-" + kind');
    expect(started).not.toMatch(/localStorage|document\.cookie/);
    expect(await run({ action: "start", name: "cta-title" })).toMatch(/already exists/);
    expect(await run({ action: "record", name: "cta-title", a_views: 400, a_goals: 20, b_views: 400, b_goals: 44 })).toMatch(/B wins/);
    expect(await run({ action: "record", name: "cta-title", a_views: 10, a_goals: 20, b_views: 1, b_goals: 0 })).toMatch(/0 <= goals <= views/);
    expect(await run({ action: "finish", name: "cta-title", winner: "B", note: "verbe d'action" })).toMatch(/finished \(kept B\)/);
    expect(await run({ action: "list" })).toContain("cta-title [finished] on https://org.github.io/site/");
    expect(buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!)).toBeTruthy();
    db.close();
  });
});
