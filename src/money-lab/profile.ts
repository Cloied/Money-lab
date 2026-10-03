/**
 * Money Lab first-run profile
 *
 * Strict validation of the `moneyLab` block in automaton.json and the
 * derived runtime overrides. The profile is fail-closed: an invalid or
 * incomplete block prevents startup instead of falling back to defaults.
 *
 * In-process limits are not tamper-proof. The shell tool can still reach
 * the runtime directory; see money-lab/INTEGRATION.md.
 */

import type { AutomatonConfig, ModelStrategyConfig } from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";

export interface MoneyLabResource {
  id: string;
  kind: string;
  description: string;
  /** Expected cost per day in USD cents; null means unknown (never free). */
  expectedDailyCostCents: number | null;
}

export interface MoneyLabConfig {
  enabled: true;
  profile: "first-run";
  inference: {
    model: string;
    perCallCents: number;
    hourlyCents: number;
    dailyCents: number;
    maxOutputTokens: number;
  };
  maxTurnsPerCycle: number;
  noProgressCycles: number;
  noProgressSleepMinutes: number;
  /** The single existing sandbox the agent may publish from (expose_port). */
  publishSandboxId: string | null;
  resources: MoneyLabResource[];
  funding: {
    currency: "USD";
    provisionedCents: number;
    heldBackCents: number;
  };
}

/**
 * Builtin tools the agent may use in the first run. Everything else,
 * including tools installed at runtime, is denied by policy and hidden
 * from the model. Replication, transfers, top-ups, sandbox creation,
 * domains, x402 payments, outbound messaging, git push, self-modification
 * and heartbeat/config edits are intentionally absent.
 */
export const MONEY_LAB_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "exec",
  "write_file",
  "read_file",
  "expose_port",
  "remove_port",
  "check_credits",
  "check_usdc_balance",
  "list_sandboxes",
  "sleep",
  "system_synopsis",
  "heartbeat_ping",
  "list_skills",
  "git_status",
  "git_diff",
  "git_commit",
  "git_log",
  "git_branch",
  "list_models",
  "check_inference_spending",
  "remember_fact",
  "recall_facts",
  "set_goal",
  "complete_goal",
  "save_procedure",
  "recall_procedure",
  "review_memory",
  "forget",
  "enter_low_compute",
  "view_soul",
  // Money Lab journal tools
  "record_experiment",
  "request_help",
  "money_lab_status",
]);

export class MoneyLabConfigError extends Error {
  constructor(message: string) {
    super(`Profil moneyLab invalide : ${message}`);
    this.name = "MoneyLabConfigError";
  }
}

const TOP_LEVEL_KEYS = [
  "enabled", "profile", "inference", "maxTurnsPerCycle", "noProgressCycles",
  "noProgressSleepMinutes", "publishSandboxId", "resources", "funding",
];
const INFERENCE_KEYS = ["model", "perCallCents", "hourlyCents", "dailyCents", "maxOutputTokens"];
const RESOURCE_KEYS = ["id", "kind", "description", "expectedDailyCostCents"];
const FUNDING_KEYS = ["currency", "provisionedCents", "heldBackCents"];

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

/** Positive integer. Zero is rejected so it can never mean "unlimited". */
function positiveInt(value: unknown, where: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new MoneyLabConfigError(`${where} doit être un entier entre 1 et ${max}`);
  }
  return value;
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
export function parseMoneyLabConfig(raw: unknown, sandboxId: string): MoneyLabConfig | null {
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
  const inference = {
    model: nonEmptyString(raw.inference.model, "inference.model"),
    perCallCents: positiveInt(raw.inference.perCallCents, "inference.perCallCents", 100),
    hourlyCents: positiveInt(raw.inference.hourlyCents, "inference.hourlyCents", 1000),
    dailyCents: positiveInt(raw.inference.dailyCents, "inference.dailyCents", 1000),
    maxOutputTokens: positiveInt(raw.inference.maxOutputTokens, "inference.maxOutputTokens", 8192),
  };
  if (inference.perCallCents > inference.hourlyCents || inference.hourlyCents > inference.dailyCents) {
    throw new MoneyLabConfigError("les limites doivent respecter perCallCents <= hourlyCents <= dailyCents");
  }

  let publishSandboxId: string | null = null;
  if (raw.publishSandboxId !== null) {
    publishSandboxId = nonEmptyString(raw.publishSandboxId, "publishSandboxId");
    if (publishSandboxId !== sandboxId) {
      throw new MoneyLabConfigError("publishSandboxId doit être égal au sandboxId configuré ou null");
    }
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
    maxTurnsPerCycle: positiveInt(raw.maxTurnsPerCycle, "maxTurnsPerCycle", 25),
    noProgressCycles: positiveInt(raw.noProgressCycles, "noProgressCycles", 10),
    noProgressSleepMinutes: positiveInt(raw.noProgressSleepMinutes, "noProgressSleepMinutes", 7 * 24 * 60),
    publishSandboxId,
    resources,
    funding: {
      currency: "USD",
      provisionedCents: positiveInt(raw.funding.provisionedCents, "funding.provisionedCents", 1_000_000),
      heldBackCents: heldBack,
    },
  };
}

/** True when the configuration runs under the Money Lab profile. */
export function isMoneyLab(config: Pick<AutomatonConfig, "moneyLab">): boolean {
  return config.moneyLab?.enabled === true;
}

/**
 * Apply the profile to a loaded configuration. Profile limits override
 * any looser upstream settings; they never loosen a stricter one.
 */
export function applyMoneyLabProfile(config: AutomatonConfig): AutomatonConfig {
  const lab = parseMoneyLabConfig((config as any).moneyLab, config.sandboxId);
  if (!lab) return config;

  const base: ModelStrategyConfig = { ...DEFAULT_MODEL_STRATEGY_CONFIG, ...(config.modelStrategy ?? {}) };
  const tighter = (current: number | undefined, limit: number) =>
    current && current > 0 ? Math.min(current, limit) : limit;

  const modelStrategy: ModelStrategyConfig = {
    ...base,
    inferenceModel: lab.inference.model,
    lowComputeModel: lab.inference.model,
    criticalModel: lab.inference.model,
    pinnedModel: lab.inference.model,
    maxTokensPerTurn: Math.min(base.maxTokensPerTurn, lab.inference.maxOutputTokens),
    perCallCeilingCents: tighter(base.perCallCeilingCents, lab.inference.perCallCents),
    hourlyBudgetCents: tighter(base.hourlyBudgetCents, lab.inference.hourlyCents),
    dailyBudgetCents: tighter(base.dailyBudgetCents, lab.inference.dailyCents),
    enableModelFallback: false,
    strictCostAccounting: true,
  };

  return {
    ...config,
    moneyLab: lab,
    inferenceModel: lab.inference.model,
    maxTokensPerTurn: Math.min(config.maxTokensPerTurn, lab.inference.maxOutputTokens),
    maxTurnsPerCycle: Math.min(config.maxTurnsPerCycle ?? 25, lab.maxTurnsPerCycle),
    maxChildren: 0,
    modelStrategy,
  };
}
