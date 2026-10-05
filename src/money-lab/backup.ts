/**
 * Money Lab daily state backup
 *
 * Once a day the runtime copies state.db (journal, ledger, memory) to
 * ~/.automaton/backups/state.db.backup-YYYY-MM-DD with SQLite's online backup
 * and keeps the last 7 copies. The directory is a protected runtime entry.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";

const KEEP = 7;
const PREFIX = "state.db.backup-";

export async function backupStateDaily(
  db: Database.Database,
  home = process.env.HOME || "/root",
  now = new Date(),
): Promise<string | null> {
  const dir = path.join(home, ".automaton", "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${PREFIX}${now.toISOString().slice(0, 10)}`);
  if (fs.existsSync(file)) return null;
  await db.backup(file);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(PREFIX)).sort().slice(0, -KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}
