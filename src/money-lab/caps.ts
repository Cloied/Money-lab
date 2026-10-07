/**
 * Owner-set inference caps (/plafond on Telegram).
 *
 * The router derives its budgets from automaton.json at startup, so a new
 * cap is written to the file and takes effect after a restart (systemd
 * restarts the service). Only moneyLab.inference.dailyCents and hourlyCents
 * change; the whole block is validated before the file is replaced.
 */

import fs from "fs";
import { parseMoneyLabConfig, MoneyLabConfigError } from "./profile.js";

/** Above this, a typo ("/plafond 500") is more likely than a real choice. */
export const MAX_DAILY_CAP_CENTS = 10_000;

export interface CapsChange {
  before: { dailyCents: number | null; hourlyCents: number | null };
  after: { dailyCents: number; hourlyCents: number };
}

/**
 * Writes the new caps. Without an hourly cap, the current one is kept when
 * it still fits under the daily cap, else it becomes the daily cap.
 * Throws MoneyLabConfigError with a French message the owner can read.
 */
export function setInferenceCaps(file: string, dailyCents: number, hourlyCents?: number): CapsChange {
  if (!Number.isInteger(dailyCents) || dailyCents <= 0) {
    throw new MoneyLabConfigError("le plafond par jour doit être un montant positif");
  }
  if (dailyCents > MAX_DAILY_CAP_CENTS) {
    throw new MoneyLabConfigError(`plafond par jour limité à ${MAX_DAILY_CAP_CENTS / 100} $ depuis Telegram`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const inference = raw?.moneyLab?.inference;
  if (!inference || typeof inference !== "object") {
    throw new MoneyLabConfigError("bloc moneyLab.inference absent de automaton.json");
  }
  const before = { dailyCents: inference.dailyCents ?? null, hourlyCents: inference.hourlyCents ?? null };
  const hourly = hourlyCents
    ?? (before.hourlyCents !== null && before.hourlyCents <= dailyCents ? before.hourlyCents : dailyCents);
  if (hourly > dailyCents) {
    throw new MoneyLabConfigError("le plafond par heure ne peut pas dépasser le plafond par jour");
  }
  if (inference.perCallCents !== null && inference.perCallCents !== undefined && hourly < inference.perCallCents) {
    throw new MoneyLabConfigError(
      `le plafond par heure doit être au moins ${(inference.perCallCents / 100).toFixed(2)} $ (le coût maximal d'un appel)`,
    );
  }
  inference.dailyCents = dailyCents;
  inference.hourlyCents = hourly;
  parseMoneyLabConfig(raw.moneyLab);

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { before, after: { dailyCents, hourlyCents: hourly } };
}
