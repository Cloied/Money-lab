/**
 * Money Lab datasets: what the agent collected, kept for later
 *
 * Each dataset is a JSON Lines file in ~/datasets/<name>.jsonl, one record
 * per line ({at, source, ref, data}). Results of harvest and market_signals
 * can be appended automatically (save_to), so research done once is reused
 * on later days instead of being paid for again. The files are the agent's
 * own: it can also read them with its shell tools, and recall searches them.
 */

import fs from "fs";
import path from "path";

export const DATASETS_DIR = "datasets";
const NAME = /^[a-z0-9][a-z0-9_-]{0,59}$/;
/** Largest dataset file; recall reads files up to this size. */
export const MAX_DATASET_BYTES = 1_000_000;
const MAX_RECORD_CHARS = 60_000;
const MAX_DATASETS = 200;

export interface DatasetRecord {
  at: string;
  source: string;
  ref: string;
  data: unknown;
}

export interface DatasetInfo {
  name: string;
  records: number;
  bytes: number;
  updatedAt: string;
}

function dir(home: string): string {
  return path.join(home, DATASETS_DIR);
}

function file(home: string, name: string): string {
  return path.join(dir(home), `${name}.jsonl`);
}

export function validDatasetName(name: string): boolean {
  return NAME.test(name);
}

function nameError(name: string): string | null {
  return validDatasetName(name)
    ? null
    : "name must be 1-60 lowercase letters, digits, dashes or underscores (e.g. competitors-invoicing).";
}

/** Appends one record; returns an error message, or null. */
export function saveRecord(
  home: string,
  name: string,
  record: { source: string; ref?: string; data: unknown },
  now = new Date(),
): string | null {
  const invalid = nameError(name);
  if (invalid) return invalid;
  if (record.data === undefined || record.data === null || record.data === "") return "data is empty.";
  const line = JSON.stringify({ at: now.toISOString(), source: record.source, ref: record.ref ?? "", data: record.data });
  if (line.length > MAX_RECORD_CHARS) {
    return `This record is ${line.length} characters (max ${MAX_RECORD_CHARS}): keep the useful part only.`;
  }
  fs.mkdirSync(dir(home), { recursive: true });
  const target = file(home, name);
  let size = 0;
  try {
    // A symbolic link could make the runtime append to any file the bot points it at.
    if (fs.lstatSync(target).isSymbolicLink()) return "This dataset is a symbolic link: delete it and save again.";
    size = fs.statSync(target).size;
  } catch {
    if (datasetNames(home).length >= MAX_DATASETS) return `At most ${MAX_DATASETS} datasets: delete old ones first.`;
  }
  if (size + line.length + 1 > MAX_DATASET_BYTES) {
    return `Dataset "${name}" is full (${Math.round(size / 1000)} KB, max ${MAX_DATASET_BYTES / 1000} KB): ` +
      "start a new one (e.g. with a month suffix) or delete old records.";
  }
  fs.appendFileSync(target, `${line}\n`);
  return null;
}

function readLines(target: string): DatasetRecord[] {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return [];
    return fs.readFileSync(target, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record && typeof record === "object" ? [record as DatasetRecord] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function datasetNames(home: string): string[] {
  try {
    return fs.readdirSync(dir(home)).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).filter(validDatasetName);
  } catch {
    return [];
  }
}

/** Datasets, newest first; counting records reads every file, so only when asked. */
export function listDatasets(home: string, options: { countRecords?: boolean } = {}): DatasetInfo[] {
  return datasetNames(home).flatMap((name) => {
    const target = file(home, name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) return [];
      const records = options.countRecords
        ? fs.readFileSync(target, "utf-8").split("\n").filter(Boolean).length
        : -1;
      return [{ name, records, bytes: stat.size, updatedAt: stat.mtime.toISOString() }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readDataset(home: string, name: string, options: { last?: number; contains?: string } = {}): DatasetRecord[] | string {
  const invalid = nameError(name);
  if (invalid) return invalid;
  if (!fs.existsSync(file(home, name))) return `No dataset "${name}".`;
  let records = readLines(file(home, name));
  if (options.contains) {
    const wanted = options.contains.toLowerCase();
    records = records.filter((r) => JSON.stringify(r).toLowerCase().includes(wanted));
  }
  return records.slice(-Math.min(100, Math.max(1, options.last ?? 20)));
}

/** Records of every dataset matching all the query's words (case-insensitive), newest first. */
export function searchDatasets(home: string, query: string, limit = 20): Array<{ dataset: string; record: DatasetRecord }> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  const hits: Array<{ dataset: string; record: DatasetRecord }> = [];
  for (const info of listDatasets(home)) {
    for (const record of readLines(file(home, info.name))) {
      const text = JSON.stringify(record).toLowerCase();
      if (words.every((w) => text.includes(w))) hits.push({ dataset: info.name, record });
    }
  }
  return hits.sort((a, b) => b.record.at.localeCompare(a.record.at)).slice(0, limit);
}

export function deleteDataset(home: string, name: string): boolean {
  if (!validDatasetName(name)) return false;
  const target = file(home, name);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}

/** Compact text of records for the agent (it reads at most 10,000 characters of a result). */
export function formatRecords(records: Array<{ dataset?: string; record: DatasetRecord }>, maxChars = 9000): string {
  const out: string[] = [];
  let used = 0;
  for (const { dataset, record } of records) {
    const data = typeof record.data === "string" ? record.data : JSON.stringify(record.data);
    const line = `- ${dataset ? `[${dataset}] ` : ""}${record.at.slice(0, 16).replace("T", " ")} ${record.source}` +
      `${record.ref ? ` ${record.ref}` : ""}: ${data}`;
    if (used + line.length > maxChars) {
      out.push(`(${records.length - out.length} more records not shown: narrow with contains or last)`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

/** One line for the prompt: names and sizes only (no file is read). */
export function describeDatasets(home: string): string {
  const all = listDatasets(home);
  if (all.length === 0) return "none yet";
  const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return all.slice(0, 12).map((d) => `${d.name} (${kb(d.bytes)})`).join(", ") + (all.length > 12 ? `, +${all.length - 12} more` : "");
}
