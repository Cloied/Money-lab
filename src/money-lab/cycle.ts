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
import { getNoProgressCycles, journalFingerprint, setNoProgressCycles } from "./journal.js";

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
  if (cycles < lab.noProgressCycles) {
    return { progressed: false, noProgressCycles: cycles, longSleepUntil: null };
  }

  const until = new Date(nowMs + lab.noProgressSleepMinutes * 60_000).toISOString();
  const existing = (db.prepare("SELECT value FROM kv WHERE key = 'sleep_until'").get() as { value: string } | undefined)?.value;
  if (!existing || existing < until) {
    db.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES ('sleep_until', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(until);
  }
  return { progressed: false, noProgressCycles: cycles, longSleepUntil: until };
}
