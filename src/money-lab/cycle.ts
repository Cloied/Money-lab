/**
 * No-progress handling between wake cycles.
 *
 * A wake cycle that leaves the journal unchanged counts as no progress.
 * After `noProgressCycles` such cycles the runtime sleeps for
 * `noProgressSleepMinutes`; each further unchanged cycle repeats the long
 * sleep until the journal changes or the operator resumes. Experiment
 * context is kept in the database, so nothing is lost while sleeping.
 */

import type Database from "better-sqlite3";
import type { MoneyLabConfig } from "./profile.js";
import { getKV, getNoProgressCycles, journalFingerprint, setKV, setNoProgressCycles } from "./journal.js";

/** During a Money Lab sleep only operator actions (resume, help resolution) and scheduled-job alerts wake the agent. */
export function isOperatorWake(event: { source: string }): boolean {
  return event.source === "money_lab_operator" || event.source === "money_lab_job";
}

export interface CycleOutcome {
  progressed: boolean;
  noProgressCycles: number;
  longSleepUntil: string | null;
}

export function afterWakeCycle(
  db: Database.Database,
  lab: MoneyLabConfig,
  fingerprintBefore: string,
  nowMs: number = Date.now(),
): CycleOutcome {
  if (journalFingerprint(db) !== fingerprintBefore) {
    setNoProgressCycles(db, 0);
    return { progressed: true, noProgressCycles: 0, longSleepUntil: null };
  }

  const cycles = getNoProgressCycles(db) + 1;
  setNoProgressCycles(db, cycles);
  if (lab.noProgressCycles === null || cycles < lab.noProgressCycles) {
    return { progressed: false, noProgressCycles: cycles, longSleepUntil: null };
  }

  const until = new Date(nowMs + lab.noProgressSleepMinutes * 60_000).toISOString();
  const existing = getKV(db, "sleep_until");
  if (!existing || existing < until) {
    setKV(db, "sleep_until", until);
    setKV(db, "sleep_reason", `${cycles} cycles sans progrès du journal`);
  }
  return { progressed: false, noProgressCycles: cycles, longSleepUntil: until };
}
