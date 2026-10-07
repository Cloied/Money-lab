/**
 * Money Lab work modes
 *
 * Owner decision (2026-10-07): the bot was spending the same amount whether
 * it researched, built or waited. The runtime now derives a mode from the
 * journal and applies a budget to it:
 * - build: an experiment is being built (status building, updated within a
 *   week); the owner's caps from automaton.json apply, sleep at most 6 h;
 * - discovery: anything else; a small cap (1 $ per day, 0.40 $ per hour by
 *   default) because research runs on the free models; sleep at most 6 h,
 *   3 h while fewer than five ideas are scored;
 * - observe: discovery with nothing left to research right now; the agent
 *   may sleep up to 24 h and free checks (scheduled jobs, site monitor, the
 *   owner) wake it earlier.
 * The agent cannot change the mode directly: it changes by recording work.
 */

import type Database from "better-sqlite3";
import type { MoneyLabConfig } from "./profile.js";
import { listExperiments } from "./journal.js";
import { discoveryIncomplete } from "./ideas.js";
import { inferenceGetDailyCost, inferenceGetHourlyCost } from "../state/database.js";

export type WorkMode = "discovery" | "build" | "observe";

export const DEFAULT_DISCOVERY_DAILY_CENTS = 100;
export const DEFAULT_DISCOVERY_HOURLY_CENTS = 40;
/** A build that saw no update for this long is not being built. */
const BUILD_STALE_MS = 7 * 86_400_000;

export const MODE_SLEEP_SECONDS: Record<WorkMode, number> = {
  build: 6 * 3600,
  discovery: 6 * 3600,
  observe: 24 * 3600,
};
export const DISCOVERY_INCOMPLETE_SLEEP_SECONDS = 3 * 3600;

export interface ModeBudget {
  dailyCents: number | null;
  hourlyCents: number | null;
}

function envCents(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The discovery caps, never above the owner's caps. */
export function discoveryBudget(lab: MoneyLabConfig, env: NodeJS.ProcessEnv = process.env): ModeBudget {
  const daily = envCents(env, "MONEY_LAB_DISCOVERY_DAILY_CENTS", DEFAULT_DISCOVERY_DAILY_CENTS);
  const hourly = envCents(env, "MONEY_LAB_DISCOVERY_HOURLY_CENTS", DEFAULT_DISCOVERY_HOURLY_CENTS);
  return {
    dailyCents: lab.inference.dailyCents === null ? daily : Math.min(daily, lab.inference.dailyCents),
    hourlyCents: lab.inference.hourlyCents === null ? hourly : Math.min(hourly, lab.inference.hourlyCents),
  };
}

export function currentMode(db: Database.Database, now = new Date()): WorkMode {
  const building = listExperiments(db).some((e) =>
    e.status === "building" && now.getTime() - Date.parse(e.updatedAt) < BUILD_STALE_MS);
  if (building) return "build";
  return discoveryIncomplete(db) ? "discovery" : "observe";
}

export function modeBudget(mode: WorkMode, lab: MoneyLabConfig, env: NodeJS.ProcessEnv = process.env): ModeBudget {
  return mode === "build"
    ? { dailyCents: lab.inference.dailyCents, hourlyCents: lab.inference.hourlyCents }
    : discoveryBudget(lab, env);
}

/** Longest sleep the agent may ask for in this mode. */
export function maxSleepSeconds(db: Database.Database, mode: WorkMode): number {
  if (mode !== "build" && discoveryIncomplete(db)) return DISCOVERY_INCOMPLETE_SLEEP_SECONDS;
  return MODE_SLEEP_SECONDS[mode];
}

export interface ModeBlock {
  limit: "daily" | "hourly";
  until: Date;
  reason: string;
}

/**
 * Before a paid turn: is the mode's cap reached? The owner's caps are
 * enforced by the router; this covers the tighter discovery caps. Returns
 * when to sleep until, or null.
 */
export function modeBudgetBlock(
  db: Database.Database,
  lab: MoneyLabConfig,
  estimatedCents: number,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): ModeBlock | null {
  const mode = currentMode(db, now);
  if (mode === "build") return null;
  const budget = discoveryBudget(lab, env);
  // A cap equal to the owner's is the router's job (its message names the owner cap).
  const tighter = (cap: number | null, owner: number | null) => cap !== null && (owner === null || cap < owner);
  const daily = inferenceGetDailyCost(db, now.toISOString().slice(0, 10));
  if (tighter(budget.dailyCents, lab.inference.dailyCents) && daily + estimatedCents > budget.dailyCents!) {
    const until = new Date(now);
    until.setUTCHours(24, 0, 0, 0);
    return { limit: "daily", until, reason: `plafond du mode ${mode} atteint (${(daily / 100).toFixed(2)} $ sur ${(budget.dailyCents! / 100).toFixed(2)} $ par jour)` };
  }
  const hourly = inferenceGetHourlyCost(db);
  if (tighter(budget.hourlyCents, lab.inference.hourlyCents) && hourly + estimatedCents > budget.hourlyCents!) {
    const until = new Date(now);
    until.setUTCHours(until.getUTCHours() + 1, 0, 0, 0);
    return { limit: "hourly", until, reason: `plafond horaire du mode ${mode} atteint (${(hourly / 100).toFixed(2)} $ sur ${(budget.hourlyCents! / 100).toFixed(2)} $)` };
  }
  return null;
}

const MODE_LABELS: Record<WorkMode, string> = {
  discovery: "DISCOVERY: research runs on the free models (harvest, market_signals, delegate); your own paid turns are capped",
  build: "BUILD: an experiment is being built; the owner's caps apply; keep each build under 5 days",
  observe: "OBSERVE: nothing to build and the pipeline is scored; sleep up to 24 h, free checks wake you; keep researching cheaply",
};

/** One line for the prompt: mode, caps, spent today. */
export function describeMode(db: Database.Database, lab: MoneyLabConfig, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const mode = currentMode(db, now);
  const budget = modeBudget(mode, lab, env);
  const spent = inferenceGetDailyCost(db, now.toISOString().slice(0, 10));
  const usd = (c: number | null) => (c === null ? "no cap" : `$${(c / 100).toFixed(2)}`);
  return `Mode ${MODE_LABELS[mode]}. Caps: ${usd(budget.dailyCents)} per UTC day, ${usd(budget.hourlyCents)} per hour; ` +
    `spent today $${(spent / 100).toFixed(2)}. Build mode starts when an experiment has status building (through an approved idea).`;
}

/** French label for the owner's reports. */
export function modeLabelFr(mode: WorkMode): string {
  return mode === "build" ? "construction" : mode === "observe" ? "observation" : "découverte";
}
