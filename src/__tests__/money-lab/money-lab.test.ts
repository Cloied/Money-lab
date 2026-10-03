/**
 * Money Lab first-run tests.
 *
 * Fully mocked: global fetch is replaced by a spy that fails the test if
 * any HTTP request is attempted, and USDC balance reads are mocked.
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
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { InferenceRouter } from "../../inference/router.js";
import { x402Fetch, setX402PaymentGuard } from "../../conway/x402.js";
import { topupCredits, topupForSandbox } from "../../conway/topup.js";
import { BUILTIN_TASKS } from "../../heartbeat/tasks.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../types.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import {
  applyMoneyLabProfile,
  parseMoneyLabConfig,
  MoneyLabConfigError,
  MONEY_LAB_ALLOWED_TOOLS,
} from "../../money-lab/profile.js";
import { installMoneyLabPaymentGuard } from "../../money-lab/guard.js";
import {
  ensureMoneyLabSchema,
  upsertExperiment,
  createHelpRequest,
  getHelpRequest,
  resolveHelpRequest,
  addLedgerEntry,
  summarizeFinances,
  pause,
  resume,
  getPauseState,
  getExperiment,
  journalFingerprint,
  getNoProgressCycles,
} from "../../money-lab/journal.js";
import { afterWakeCycle } from "../../money-lab/cycle.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";
import { runMoneyLabCommand } from "../../money-lab/cli.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "../mocks.js";

const SANDBOX = "test-sandbox-id";

function rawProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    profile: "first-run",
    inference: { model: "gpt-5-mini", perCallCents: 5, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 },
    maxTurnsPerCycle: 8,
    noProgressCycles: 3,
    noProgressSleepMinutes: 360,
    publishSandboxId: SANDBOX,
    resources: [
      { id: SANDBOX, kind: "sandbox", description: "Existing Conway sandbox", expectedDailyCostCents: null },
    ],
    funding: { currency: "USD", provisionedCents: 1500, heldBackCents: 500 },
    ...overrides,
  };
}

function labConfig(overrides: Record<string, unknown> = {}): AutomatonConfig {
  return applyMoneyLabProfile(
    createTestConfig({ moneyLab: rawProfile(overrides) as any, logLevel: "error" }),
  );
}

let tmpDirs: string[] = [];
function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "state.db");
}

function openDb(file = dbPath()): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  return db;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access attempted in a mocked Money Lab test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setX402PaymentGuard(null);
  vi.unstubAllGlobals();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── Profile ────────────────────────────────────────────────────

describe("Money Lab profile", () => {
  it("returns null when the block is absent (upstream behaviour unchanged)", () => {
    expect(parseMoneyLabConfig(undefined, SANDBOX)).toBeNull();
    const config = createTestConfig();
    expect(applyMoneyLabProfile(config)).toBe(config);
  });

  it("rejects unknown keys, missing keys and zero limits", () => {
    expect(() => parseMoneyLabConfig(rawProfile({ extra: 1 }), SANDBOX)).toThrow(MoneyLabConfigError);
    const missing = rawProfile();
    delete missing.funding;
    expect(() => parseMoneyLabConfig(missing, SANDBOX)).toThrow(/missing moneyLab.funding/);
    expect(() =>
      parseMoneyLabConfig(
        rawProfile({ inference: { model: "gpt-5-mini", perCallCents: 0, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 } }),
        SANDBOX,
      ),
    ).toThrow(/perCallCents/);
    expect(() => parseMoneyLabConfig(rawProfile({ enabled: false }), SANDBOX)).toThrow(/enabled/);
  });

  it("rejects inconsistent limits and a foreign publish sandbox", () => {
    expect(() =>
      parseMoneyLabConfig(
        rawProfile({ inference: { model: "m", perCallCents: 20, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 } }),
        SANDBOX,
      ),
    ).toThrow(/perCallCents <= hourlyCents/);
    expect(() => parseMoneyLabConfig(rawProfile({ publishSandboxId: "other" }), SANDBOX)).toThrow(/publishSandboxId/);
  });

  it("applies strict runtime overrides and never loosens tighter settings", () => {
    const config = applyMoneyLabProfile(
      createTestConfig({
        moneyLab: rawProfile() as any,
        maxChildren: 3,
        modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, perCallCeilingCents: 2 },
      }),
    );
    expect(config.maxChildren).toBe(0);
    expect(config.maxTurnsPerCycle).toBe(8);
    expect(config.maxTokensPerTurn).toBe(1024);
    expect(config.modelStrategy?.pinnedModel).toBe("gpt-5-mini");
    expect(config.modelStrategy?.perCallCeilingCents).toBe(2);
    expect(config.modelStrategy?.hourlyBudgetCents).toBe(10);
    expect(config.modelStrategy?.dailyBudgetCents).toBe(30);
  });
});

// ─── Tool policy ────────────────────────────────────────────────

describe("Money Lab tool policy", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let ctx: ToolContext;
  let engine: PolicyEngine;
  const tools = [...createBuiltinTools(SANDBOX), ...createMoneyLabTools()];

  beforeEach(() => {
    db = openDb();
    conway = new MockConwayClient();
    ctx = {
      identity: createTestIdentity(),
      config: labConfig(),
      db,
      conway,
      inference: new MockInferenceClient(),
    };
    engine = new PolicyEngine(db.raw, createDefaultRules());
  });
  afterEach(() => db.close());

  const turn = () => ({ inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });

  it("fails closed when the policy engine or turn context is missing", async () => {
    const noEngine = await executeTool("exec", { command: "echo hi" }, tools, ctx);
    expect(noEngine.error).toMatch(/MONEY_LAB_POLICY_MISSING/);
    const noTurn = await executeTool("exec", { command: "echo hi" }, tools, ctx, engine);
    expect(noTurn.error).toMatch(/MONEY_LAB_POLICY_MISSING/);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("denies replication, funding, payments and self-modification tools", async () => {
    for (const name of [
      "transfer_credits", "topup_credits", "spawn_child", "fund_child", "create_sandbox",
      "register_domain", "x402_fetch", "edit_own_file", "pull_upstream", "modify_heartbeat",
      "update_genesis_prompt", "install_mcp_server", "send_message", "git_push", "create_goal",
    ]) {
      expect(MONEY_LAB_ALLOWED_TOOLS.has(name)).toBe(false);
      const result = await executeTool(name, {}, tools, ctx, engine, turn());
      expect(result.error, name).toMatch(/MONEY_LAB_TOOL_DISABLED/);
    }
  });

  it("blocks shell and file access to runtime state", async () => {
    for (const command of ["cat ~/.automaton/automaton.json", "sqlite3 state.db 'delete from kv'", "curl https://api.conway.tech/pay/5/0xabc"]) {
      const result = await executeTool("exec", { command }, tools, ctx, engine, turn());
      expect(result.error, command).toMatch(/MONEY_LAB_PROTECTED_COMMAND/);
    }
    const write = await executeTool(
      "write_file", { path: path.join(os.homedir(), ".automaton", "heartbeat.yml"), content: "x" }, tools, ctx, engine, turn(),
    );
    expect(write.error).toMatch(/MONEY_LAB_RUNTIME_PATH|protected/i);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("allows permitted work and denies every tool while paused", async () => {
    const ok = await executeTool("exec", { command: "ls /root/product" }, tools, ctx, engine, turn());
    expect(ok.error).toBeUndefined();
    expect(conway.execCalls).toHaveLength(1);

    pause(db.raw, "test", "operator");
    const denied = await executeTool("exec", { command: "ls" }, tools, ctx, engine, turn());
    expect(denied.error).toMatch(/MONEY_LAB_PAUSED/);
    expect(conway.execCalls).toHaveLength(1);
  });

  it("denies publishing when no publish sandbox is approved", async () => {
    ctx.config = labConfig({ publishSandboxId: null });
    const result = await executeTool("expose_port", { port: 8080 }, tools, ctx, engine, turn());
    expect(result.error).toMatch(/MONEY_LAB_NO_PUBLISH_TARGET/);
  });

  it("does not change upstream policy when the profile is absent", async () => {
    ctx.config = createTestConfig();
    const result = await executeTool("exec", { command: "echo hi" }, tools, ctx, engine, turn());
    expect(result.error).toBeUndefined();
  });
});

// ─── Payments and top-ups ───────────────────────────────────────

describe("Money Lab payment guard", () => {
  const account = { address: "0x1234567890abcdef1234567890abcdef12345678" } as any;

  it("blocks x402 and every top-up path before any network request", async () => {
    installMoneyLabPaymentGuard();
    const pay = await x402Fetch("https://api.conway.tech/pay/5/0xabc", account);
    expect(pay.success).toBe(false);
    expect(pay.error).toMatch(/blocked/);

    const topup = await topupCredits("https://api.conway.tech", account, 5);
    expect(topup.success).toBe(false);

    const sandboxError = Object.assign(new Error("INSUFFICIENT_CREDITS"), { status: 402 });
    const { getUsdcBalance } = await import("../../conway/x402.js");
    vi.mocked(getUsdcBalance).mockResolvedValueOnce(100);
    const sandboxTopup = await topupForSandbox({ apiUrl: "https://api.conway.tech", account, error: sandboxError });
    expect(sandboxTopup?.success).toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("heartbeat USDC task neither buys credits nor wakes the agent", async () => {
    const db = openDb();
    const result = await BUILTIN_TASKS.check_usdc_balance(
      { usdcBalance: 100, creditBalance: 0, survivalTier: "critical" } as any,
      { db, config: labConfig(), identity: createTestIdentity() } as any,
    );
    expect(result.shouldWake).toBe(false);
    expect(db.getKV("last_auto_topup_attempt")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});

// ─── Inference limits and units ─────────────────────────────────

describe("Money Lab inference limits", () => {
  function router(db: AutomatonDatabase, config = labConfig()) {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, config.modelStrategy!);
    return { router: new InferenceRouter(db.raw, registry, budget), budget };
  }

  const request = (maxTokens = 1024) => ({
    messages: [{ role: "user" as const, content: "hello" }],
    taskType: "agent_turn" as const,
    tier: "normal" as const,
    sessionId: "s1",
    maxTokens,
  });

  it("converts token usage to cents using the registry fixture (hundredths of a cent per 1k)", async () => {
    const db = openDb();
    const { router: r } = router(db);
    // gpt-5-mini: input $0.80/M (8), output $3.20/M (32).
    // 10k in = 0.8c, 1k out = 0.32c -> 1.12c, rounded up to 2c.
    const result = await r.route(request(), async () => ({
      message: { content: "ok" },
      usage: { promptTokens: 10_000, completionTokens: 1_000 },
      finishReason: "stop",
    }));
    expect(result.model).toBe("gpt-5-mini");
    expect(result.costCents).toBe(2);
    db.close();
  });

  it("uses only the pinned model, ignoring the routing matrix", () => {
    const db = openDb();
    const { router: r } = router(db);
    expect(r.selectModel("high", "agent_turn")?.modelId).toBe("gpt-5-mini");
    db.close();
  });

  it("enforces the per-call ceiling against bounded output tokens", async () => {
    const db = openDb();
    const { router: r } = router(db);
    const chat = vi.fn();
    // 16k output tokens on gpt-5-mini = 5.12c > 5c ceiling.
    const result = await r.route(request(16_000), chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("enforces the daily limit from persisted costs, surviving a restart", async () => {
    const file = dbPath();
    let db = openDb(file);
    const config = labConfig({
      inference: { model: "gpt-5-mini", perCallCents: 5, hourlyCents: 30, dailyCents: 30, maxOutputTokens: 1024 },
    });
    router(db, config).budget.recordCost({
      sessionId: "s1", turnId: null, model: "gpt-5-mini", provider: "openai", inputTokens: 0,
      outputTokens: 0, costCents: 30, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });
    db.close();

    db = openDb(file); // simulated restart
    const chat = vi.fn();
    const result = await router(db, config).router.route(request(), chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();

    // The daily check alone (no hourly limit) also reads persisted costs.
    const dailyOnly = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, dailyBudgetCents: 30 });
    expect(dailyOnly.checkBudget(1, "gpt-5-mini")).toEqual({
      allowed: false,
      reason: "Daily budget exhausted: 30c spent + 1c estimated > 30c limit",
    });
    // Upstream default (absent/0) keeps its "no limit" meaning.
    expect(new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG).checkBudget(1, "m").allowed).toBe(true);
    db.close();
  });

  it("counts tool schemas in the estimate", async () => {
    const db = openDb();
    const { router: r } = router(db);
    const bigTools = [{ type: "function", function: { name: "x", description: "y".repeat(400_000), parameters: {} } }];
    const chat = vi.fn();
    const result = await r.route({ ...request(), tools: bigTools }, chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("records an estimate instead of zero when usage is missing", async () => {
    const db = openDb();
    const { router: r, budget } = router(db);
    const result = await r.route(request(), async () => ({ message: { content: "ok" }, finishReason: "stop" }));
    expect(result.costEstimated).toBe(true);
    expect(result.costCents).toBeGreaterThan(0);
    expect(budget.getDailyCost()).toBe(result.costCents);
    db.close();
  });
});

// ─── Agent loop ─────────────────────────────────────────────────

describe("Money Lab agent loop", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => db.close());

  const run = (inference: MockInferenceClient, config = labConfig()) =>
    runAgentLoop({
      identity: createTestIdentity(),
      config,
      db,
      conway: new MockConwayClient(),
      inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
      spendTracker: new SpendTracker(db.raw),
    });

  it("makes no inference call while paused", async () => {
    pause(db.raw, "operator test", "operator");
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await run(inference);
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("offers only allowlisted tools with bounded output tokens", async () => {
    const inference = new MockInferenceClient([noToolResponse("done")]);
    await run(inference);
    expect(inference.calls).toHaveLength(1);
    const offered = (inference.calls[0].options?.tools ?? []).map((t: any) => t.function.name);
    expect(offered).toContain("request_help");
    expect(offered).toContain("record_experiment");
    expect(offered.every((n: string) => MONEY_LAB_ALLOWED_TOOLS.has(n))).toBe(true);
    expect(inference.calls[0].options?.maxTokens).toBe(1024);
    expect(inference.calls[0].options?.model).toBe("gpt-5-mini");
  });

  it("sleeps without a paid turn when the budget is exhausted", async () => {
    new InferenceBudgetTracker(db.raw, labConfig().modelStrategy!).recordCost({
      sessionId: "x", turnId: null, model: "gpt-5-mini", provider: "openai", inputTokens: 0,
      outputTokens: 0, costCents: 30, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await run(inference);
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(new Date(db.getKV("sleep_until")!).getTime()).toBeGreaterThan(Date.now());
  });

  it("pauses when the provider returns no usage (unknown cost)", async () => {
    const inference = new MockInferenceClient([{ ...noToolResponse("x"), usage: undefined as any }]);
    await run(inference);
    expect(getPauseState(db.raw)?.reason).toMatch(/unknown/);
    expect(inference.calls).toHaveLength(1);
  });

  it("records experiments and help requests through agent tools", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "record_experiment", arguments: { status: "exploring", hypothesis: "CSV cleanup for small shops" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    const block = buildMoneyLabPromptBlock(db.raw, labConfig().moneyLab!);
    expect(block).toMatch(/CSV cleanup for small shops/);
  });
});

// ─── Journal: experiments, help, ledger, no-progress ───────────

describe("Money Lab journal", () => {
  it("allows only one active build", () => {
    const db = openDb();
    const a = upsertExperiment(db.raw, { status: "building", hypothesis: "A" });
    const b = upsertExperiment(db.raw, { status: "exploring", hypothesis: "B" });
    expect(() => upsertExperiment(db.raw, { id: b.id, status: "building" })).toThrow(/only one active build/);
    upsertExperiment(db.raw, { id: a.id, status: "observing" });
    expect(upsertExperiment(db.raw, { id: b.id, status: "building" }).status).toBe("building");
    db.close();
  });

  it("help requests survive restart; repeated and unrelated resolutions are harmless", () => {
    const file = dbPath();
    let db = openDb(file);
    const exp = upsertExperiment(db.raw, { status: "building", hypothesis: "H" });
    const help = createHelpRequest(db.raw, {
      experimentId: exp.id, reason: "Need an ad account", humanAction: "Create the account",
      resumeCondition: "Account verified", expectedCostCents: null,
    });
    expect(getExperiment(db.raw, exp.id)?.status).toBe("waiting_for_owner");
    db.close();

    db = openDb(file);
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("open");

    expect(resolveHelpRequest(db.raw, "help_unknown", "resolved", "x").outcome).toBe("not_found");
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("open");

    const wakeCount = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM wake_events").get() as any).n;
    const before = wakeCount();
    expect(resolveHelpRequest(db.raw, help.id, "resolved", "done").outcome).toBe("updated");
    expect(resolveHelpRequest(db.raw, help.id, "rejected", "again").outcome).toBe("already_closed");
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("resolved");
    expect(wakeCount()).toBe(before + 1);
    db.close();
  });

  it("agent tools cannot resolve help or write the ledger", () => {
    const names = createMoneyLabTools().map((t) => t.name);
    expect(names).toEqual(["record_experiment", "request_help", "money_lab_status"]);
  });

  it("separates funding, purchases, usage, estimated revenue and cash", () => {
    const db = openDb();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 2000, source: "operator", reference: "fund-1" });
    addLedgerEntry(db.raw, { kind: "credit_purchase", amountCents: 1500, source: "operator", reference: "buy-1" });
    addLedgerEntry(db.raw, { kind: "estimated_revenue", amountCents: 300, source: "provider_import", reference: "ads-est-1" });
    addLedgerEntry(db.raw, { kind: "confirmed_revenue", amountCents: 100, source: "provider_import", reference: "sale-1" });
    expect(addLedgerEntry(db.raw, { kind: "confirmed_revenue", amountCents: 100, source: "provider_import", reference: "sale-1" })).toBe(false);
    new InferenceBudgetTracker(db.raw, labConfig().modelStrategy!).recordCost({
      sessionId: "x", turnId: null, model: "gpt-5-mini", provider: "openai", inputTokens: 0,
      outputTokens: 0, costCents: 40, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });

    const f = summarizeFinances(db.raw);
    expect(f.confirmedRevenueCents).toBe(100);
    expect(f.cashReceivedCents).toBe(0);
    expect(f.estimatedRevenueCents).toBe(300);
    expect(f.inferenceConsumedCents).toBe(40);
    // Funding and the credit purchase are neither revenue nor expense.
    expect(f.profitCents).toBe(100 - 40);

    addLedgerEntry(db.raw, { kind: "hosting", amountCents: null, source: "operator", reference: "host-oct" });
    expect(summarizeFinances(db.raw).unknownAmountEntries).toBe(1);
    db.close();
  });

  it("sleeps after repeated no-progress cycles and keeps experiment context", () => {
    const db = openDb();
    const lab = labConfig().moneyLab!;
    const exp = upsertExperiment(db.raw, { status: "observing", hypothesis: "Kept context" });
    const t0 = Date.parse("2026-10-03T00:00:00Z");

    for (let i = 1; i <= 2; i++) {
      const outcome = afterWakeCycle(db.raw, lab, journalFingerprint(db.raw), t0);
      expect(outcome.longSleepUntil).toBeNull();
      expect(outcome.noProgressCycles).toBe(i);
    }
    const third = afterWakeCycle(db.raw, lab, journalFingerprint(db.raw), t0);
    expect(third.longSleepUntil).toBe(new Date(t0 + 360 * 60_000).toISOString());

    const before = journalFingerprint(db.raw);
    upsertExperiment(db.raw, { id: exp.id, status: "observing", metrics: { visits: 3 } });
    expect(afterWakeCycle(db.raw, lab, before, t0).progressed).toBe(true);
    expect(getNoProgressCycles(db.raw)).toBe(0);
    expect(buildMoneyLabPromptBlock(db.raw, lab)).toMatch(/Kept context/);
    db.close();
  });
});

// ─── Operator CLI ───────────────────────────────────────────────

describe("Money Lab operator CLI", () => {
  it("pauses, reports billing separately, and resumes", () => {
    const db = openDb();
    const config = labConfig();
    const out: string[] = [];
    const write = (t: string) => out.push(t);

    expect(runMoneyLabCommand(["pause", "fin", "du", "test"], db.raw, config, write)).toBe(0);
    expect(getPauseState(db.raw)?.by).toBe("operator");
    expect(out.join("\n")).toMatch(/n'arrête PAS la facturation/);

    out.length = 0;
    runMoneyLabCommand(["status"], db.raw, config, write);
    expect(out.join("\n")).toMatch(/Pause : OUI/);
    expect(out.join("\n")).toMatch(/facturées MÊME EN PAUSE/);

    runMoneyLabCommand(["resume"], db.raw, config, write);
    expect(getPauseState(db.raw)).toBeNull();
    expect(resume(db.raw)).toBe(false);
    db.close();
  });

  it("rejects malformed ledger input", () => {
    const db = openDb();
    const out: string[] = [];
    expect(runMoneyLabCommand(["ledger-add", "revenue", "10", "r1"], db.raw, labConfig(), (t) => out.push(t))).toBe(2);
    expect(runMoneyLabCommand(["ledger-add", "cash_received", "1.5", "r1"], db.raw, labConfig(), (t) => out.push(t))).toBe(2);
    expect(runMoneyLabCommand(["ledger-add", "cash_received", "150", "r1"], db.raw, labConfig(), (t) => out.push(t))).toBe(0);
    db.close();
  });
});
