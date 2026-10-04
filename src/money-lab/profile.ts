/**
 * Money Lab profile
 *
 * Validation of the `moneyLab` block in automaton.json and the derived
 * runtime overrides. The agent gets maximum freedom: every tool is
 * available except replication (and what would let it undo that ban),
 * and every budget limit is an optional owner setting. An invalid block
 * still prevents startup instead of silently falling back to defaults.
 *
 * In-process controls are not tamper-proof; see money-lab/INTEGRATION.md.
 */

import type { AutomatonConfig, ModelStrategyConfig } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_TREASURY_POLICY } from "../types.js";

export interface MoneyLabResource {
  id: string;
  kind: string;
  description: string;
  /** Expected cost per day in USD cents; null means unknown (never free). */
  expectedDailyCostCents: number | null;
}

/** null means "no limit set by the owner" for that dimension. */
export interface MoneyLabInference {
  model: string | null;
  perCallCents: number | null;
  hourlyCents: number | null;
  dailyCents: number | null;
  maxOutputTokens: number | null;
}

export interface MoneyLabConfig {
  enabled: true;
  profile: "first-run";
  inference: MoneyLabInference;
  /** "allowed": credit top-ups, transfers and x402 payments work as upstream. */
  payments: "allowed" | "disabled";
  /** Price caps on agent payments (top-ups, transfers, x402); null = no cap. */
  paymentLimits: {
    perPaymentCents: number | null;
    dailyCents: number | null;
  };
  /** Extra tools the owner chooses to deny, on top of replication. */
  deniedTools: string[];
  maxTurnsPerCycle: number | null;
  /** null disables the no-progress long sleep. */
  noProgressCycles: number | null;
  noProgressSleepMinutes: number;
  resources: MoneyLabResource[];
  funding: {
    currency: "USD";
    provisionedCents: number;
    heldBackCents: number;
  };
}

/**
 * Always denied. Replication: children, funding children, and the
 * orchestrator (which spawns child sandboxes or local workers). Runtime
 * code self-modification is also denied, because editing or replacing the
 * runtime code would let the agent remove the replication ban itself.
 */
export const MONEY_LAB_ALWAYS_DENIED_TOOLS: ReadonlySet<string> = new Set([
  // Replication
  "spawn_child",
  "start_child",
  "fund_child",
  "message_child",
  "list_children",
  "check_child_status",
  "verify_child_constitution",
  "prune_dead_children",
  // Orchestration (spawns workers / child sandboxes)
  "create_goal",
  "list_goals",
  "cancel_goal",
  "get_plan",
  "complete_task",
  "orchestrator_status",
  // Runtime code self-modification (would allow removing the ban)
  "edit_own_file",
  "revert_last_edit",
  "pull_upstream",
  "reset_to_upstream",
]);

/** Denied only when the owner sets `payments: "disabled"`. */
export const MONEY_LAB_PAYMENT_TOOLS: ReadonlySet<string> = new Set([
  "topup_credits",
  "transfer_credits",
  "x402_fetch",
]);

/** Effective denied set for a validated profile. */
export function moneyLabDeniedTools(lab: MoneyLabConfig): Set<string> {
  const denied = new Set([...MONEY_LAB_ALWAYS_DENIED_TOOLS, ...lab.deniedTools]);
  if (lab.payments === "disabled") for (const t of MONEY_LAB_PAYMENT_TOOLS) denied.add(t);
  return denied;
}

/**
 * Upstream automatic top-ups (startup, inline, heartbeat) bypass tool
 * policy, so they run only when payments are allowed without price caps.
 * With caps, the agent can still buy credits through topup_credits.
 */
export function automaticTopupsAllowed(lab: MoneyLabConfig | undefined): boolean {
  if (!lab) return true;
  return lab.payments === "allowed"
    && lab.paymentLimits.perPaymentCents === null
    && lab.paymentLimits.dailyCents === null;
}

/** True when the owner configured at least one inference spending limit. */
export function hasInferenceLimits(lab: MoneyLabConfig): boolean {
  const i = lab.inference;
  return i.perCallCents !== null || i.hourlyCents !== null || i.dailyCents !== null;
}

export class MoneyLabConfigError extends Error {
  constructor(message: string) {
    super(`Profil moneyLab invalide : ${message}`);
    this.name = "MoneyLabConfigError";
  }
}

const TOP_LEVEL_KEYS = [
  "enabled", "profile", "inference", "payments", "paymentLimits", "deniedTools", "maxTurnsPerCycle",
  "noProgressCycles", "noProgressSleepMinutes", "resources", "funding",
];
const INFERENCE_KEYS = ["model", "perCallCents", "hourlyCents", "dailyCents", "maxOutputTokens"];
const PAYMENT_LIMIT_KEYS = ["perPaymentCents", "dailyCents"];
const RESOURCE_KEYS = ["id", "kind", "description", "expectedDailyCostCents"];
const FUNDING_KEYS = ["currency", "provisionedCents", "heldBackCents"];

const MAX_INT = 100_000_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new MoneyLabConfigError(`clé inconnue ${where}.${key}`);
  }
  for (const key of allowed) {
    if (!(key in obj)) throw new MoneyLabConfigError(`clé manquante ${where}.${key}`);
  }
}

/** Positive integer. Zero is rejected; use null for "no limit". */
function positiveInt(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_INT) {
    throw new MoneyLabConfigError(`${where} doit être un entier positif (ou null pour aucune limite)`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, where: string): number | null {
  return value === null ? null : positiveInt(value, where);
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MoneyLabConfigError(`${where} doit être une chaîne non vide`);
  }
  return value.trim();
}

/**
 * Validate a raw moneyLab block. Returns null when the block is absent,
 * so upstream behaviour is unchanged for non-Money Lab installations.
 */
export function parseMoneyLabConfig(raw: unknown): MoneyLabConfig | null {
  if (raw === undefined) return null;
  if (!isObject(raw)) throw new MoneyLabConfigError("moneyLab doit être un objet");
  checkKeys(raw, TOP_LEVEL_KEYS, "moneyLab");

  if (raw.enabled !== true) {
    throw new MoneyLabConfigError("enabled doit valoir true ; retirer le bloc pour lancer Automaton standard");
  }
  if (raw.profile !== "first-run") {
    throw new MoneyLabConfigError('profile doit valoir "first-run"');
  }

  if (!isObject(raw.inference)) throw new MoneyLabConfigError("inference doit être un objet");
  checkKeys(raw.inference, INFERENCE_KEYS, "moneyLab.inference");
  const inference: MoneyLabInference = {
    model: raw.inference.model === null ? null : nonEmptyString(raw.inference.model, "inference.model"),
    perCallCents: optionalPositiveInt(raw.inference.perCallCents, "inference.perCallCents"),
    hourlyCents: optionalPositiveInt(raw.inference.hourlyCents, "inference.hourlyCents"),
    dailyCents: optionalPositiveInt(raw.inference.dailyCents, "inference.dailyCents"),
    maxOutputTokens: optionalPositiveInt(raw.inference.maxOutputTokens, "inference.maxOutputTokens"),
  };
  const ordered = [inference.perCallCents, inference.hourlyCents, inference.dailyCents].filter(
    (v): v is number => v !== null,
  );
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1] > ordered[i]) {
      throw new MoneyLabConfigError("les limites définies doivent respecter perCallCents <= hourlyCents <= dailyCents");
    }
  }

  if (raw.payments !== "allowed" && raw.payments !== "disabled") {
    throw new MoneyLabConfigError('payments doit valoir "allowed" ou "disabled"');
  }

  if (!isObject(raw.paymentLimits)) throw new MoneyLabConfigError("paymentLimits doit être un objet");
  checkKeys(raw.paymentLimits, PAYMENT_LIMIT_KEYS, "moneyLab.paymentLimits");
  const paymentLimits = {
    perPaymentCents: optionalPositiveInt(raw.paymentLimits.perPaymentCents, "paymentLimits.perPaymentCents"),
    dailyCents: optionalPositiveInt(raw.paymentLimits.dailyCents, "paymentLimits.dailyCents"),
  };
  if (paymentLimits.perPaymentCents !== null && paymentLimits.dailyCents !== null
    && paymentLimits.perPaymentCents > paymentLimits.dailyCents) {
    throw new MoneyLabConfigError("paymentLimits doit respecter perPaymentCents <= dailyCents");
  }

  if (!Array.isArray(raw.deniedTools) || raw.deniedTools.some((t) => typeof t !== "string" || t.trim() === "")) {
    throw new MoneyLabConfigError("deniedTools doit être un tableau de noms d'outils");
  }

  if (!Array.isArray(raw.resources)) throw new MoneyLabConfigError("resources doit être un tableau");
  const resources = raw.resources.map((entry, i): MoneyLabResource => {
    if (!isObject(entry)) throw new MoneyLabConfigError(`resources[${i}] doit être un objet`);
    checkKeys(entry, RESOURCE_KEYS, `moneyLab.resources[${i}]`);
    const cost = entry.expectedDailyCostCents;
    if (cost !== null && (typeof cost !== "number" || !Number.isInteger(cost) || cost < 0)) {
      throw new MoneyLabConfigError(`resources[${i}].expectedDailyCostCents doit être un entier positif ou nul, ou null`);
    }
    return {
      id: nonEmptyString(entry.id, `resources[${i}].id`),
      kind: nonEmptyString(entry.kind, `resources[${i}].kind`),
      description: nonEmptyString(entry.description, `resources[${i}].description`),
      expectedDailyCostCents: cost as number | null,
    };
  });

  if (!isObject(raw.funding)) throw new MoneyLabConfigError("funding doit être un objet");
  checkKeys(raw.funding, FUNDING_KEYS, "moneyLab.funding");
  if (raw.funding.currency !== "USD") throw new MoneyLabConfigError('funding.currency doit valoir "USD"');
  const heldBack = raw.funding.heldBackCents;
  if (typeof heldBack !== "number" || !Number.isInteger(heldBack) || heldBack < 0) {
    throw new MoneyLabConfigError("funding.heldBackCents doit être un entier positif ou nul");
  }

  return {
    enabled: true,
    profile: "first-run",
    inference,
    payments: raw.payments,
    paymentLimits,
    deniedTools: (raw.deniedTools as string[]).map((t) => t.trim()),
    maxTurnsPerCycle: optionalPositiveInt(raw.maxTurnsPerCycle, "maxTurnsPerCycle"),
    noProgressCycles: optionalPositiveInt(raw.noProgressCycles, "noProgressCycles"),
    noProgressSleepMinutes: positiveInt(raw.noProgressSleepMinutes, "noProgressSleepMinutes"),
    resources,
    funding: {
      currency: "USD",
      provisionedCents: positiveInt(raw.funding.provisionedCents, "funding.provisionedCents"),
      heldBackCents: heldBack,
    },
  };
}

/** True when the configuration runs under the Money Lab profile. */
export function isMoneyLab(config: Pick<AutomatonConfig, "moneyLab">): boolean {
  return config.moneyLab?.enabled === true;
}

/**
 * Apply the profile to a loaded configuration. Owner-set limits override
 * looser upstream settings and never loosen a stricter one; unset limits
 * leave upstream behaviour. Replication is always off (maxChildren 0).
 */
export function applyMoneyLabProfile(config: AutomatonConfig): AutomatonConfig {
  const lab = parseMoneyLabConfig((config as any).moneyLab);
  if (!lab) return config;

  const base: ModelStrategyConfig = { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...(config.modelStrategy ?? {}) };
  const tighter = (current: number | undefined, limit: number | null) => {
    if (limit === null) return current ?? 0;
    return current && current > 0 ? Math.min(current, limit) : limit;
  };
  const model = lab.inference.model;
  const maxOut = lab.inference.maxOutputTokens;

  const modelStrategy: ModelStrategyConfig = {
    ...base,
    ...(model ? { inferenceModel: model, lowComputeModel: model, criticalModel: model, pinnedModel: model } : {}),
    maxTokensPerTurn: maxOut ? Math.min(base.maxTokensPerTurn, maxOut) : base.maxTokensPerTurn,
    perCallCeilingCents: tighter(base.perCallCeilingCents, lab.inference.perCallCents),
    hourlyBudgetCents: tighter(base.hourlyBudgetCents, lab.inference.hourlyCents),
    dailyBudgetCents: tighter(base.dailyBudgetCents, lab.inference.dailyCents),
    strictCostAccounting: true,
  };

  // Payment price caps also tighten upstream's treasury rules.
  const per = lab.paymentLimits.perPaymentCents;
  const daily = lab.paymentLimits.dailyCents;
  const treasury = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const treasuryPolicy = {
      ...treasury,
      ...(per !== null ? {
        maxSingleTransferCents: Math.min(treasury.maxSingleTransferCents, per),
        maxX402PaymentCents: Math.min(treasury.maxX402PaymentCents, per),
      } : {}),
      ...(daily !== null ? {
        maxHourlyTransferCents: Math.min(treasury.maxHourlyTransferCents, daily),
        maxDailyTransferCents: Math.min(treasury.maxDailyTransferCents, daily),
      } : {}),
    };

  return {
    ...config,
    moneyLab: lab,
    treasuryPolicy,
    ...(model ? { inferenceModel: model } : {}),
    maxTokensPerTurn: maxOut ? Math.min(config.maxTokensPerTurn, maxOut) : config.maxTokensPerTurn,
    ...(lab.maxTurnsPerCycle ? { maxTurnsPerCycle: lab.maxTurnsPerCycle } : {}),
    maxChildren: 0,
    modelStrategy,
  };
}
