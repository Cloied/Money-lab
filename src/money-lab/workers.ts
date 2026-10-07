/**
 * Money Lab Cloudflare Workers deployment (PR 6)
 *
 * A static site cannot take a form, count anything or answer an API call.
 * Cloudflare Workers run small JavaScript servers for free (100,000 requests
 * a day, reachable at https://<name>.<account>.workers.dev) with KV (key
 * value storage) or D1 (SQLite) bindings. The agent writes the Worker code
 * in ~/workers/<name>/worker.js; the runtime generates wrangler.toml,
 * creates the storage once, deploys with the owner's Cloudflare token
 * (confined to that command) and checks the URL answers.
 *
 * A Worker is a product endpoint, never a copy of the agent: the runtime
 * sets no secrets on it and refuses code that calls model APIs, so nothing
 * deployed there can think or spend.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getKV, setKV } from "./journal.js";
import { runLocalCommand, shellQuote, withSecrets } from "./selfhosted.js";
import type { ExecResult } from "../types.js";
import { cloudflarePagesConfigured, wranglerCommand, wranglerEnv } from "./deploy.js";

const WORKERS_KEY = "money_lab.workers";
const NAME = /^[a-z0-9][a-z0-9-]{0,52}[a-z0-9]$/;
const MAX_CODE_BYTES = 1_000_000;
export const COMPATIBILITY_DATE = "2026-09-01";

/** Model and inference endpoints: a Worker that calls them would be a second agent. */
const FORBIDDEN_IN_WORKERS: Array<[RegExp, string]> = [
  [/api\.anthropic\.com|anthropic-version|x-api-key/i, "Anthropic API"],
  [/api\.openai\.com|openrouter\.ai|api\.groq\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|integrate\.api\.nvidia\.com|api\.sambanova\.ai|models\.github\.ai|run\.ai\.workers\.dev|\/ai\/run\//i, "a model API"],
  [/\bAI\.run\s*\(|env\.AI\b/i, "Workers AI binding"],
  [/api\.telegram\.org/i, "the owner's Telegram channel"],
];

export interface WorkerRecord {
  name: string;
  url: string;
  kvId?: string;
  d1Id?: string;
  deployedAt: string;
  deployments: number;
}

export function listWorkers(db: Database.Database): WorkerRecord[] {
  try {
    const raw = JSON.parse(getKV(db, WORKERS_KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as WorkerRecord[]) : [];
  } catch {
    return [];
  }
}

function saveWorkers(db: Database.Database, workers: WorkerRecord[]): void {
  setKV(db, WORKERS_KEY, JSON.stringify(workers));
}

export function describeWorkers(db: Database.Database): string {
  const workers = listWorkers(db);
  if (workers.length === 0) return "No Worker deployed yet.";
  return workers.map((w) => `- ${w.name}: ${w.url}${w.kvId ? " (KV)" : ""}${w.d1Id ? " (D1)" : ""}, ${w.deployments} deployment(s), last ${w.deployedAt.slice(0, 16).replace("T", " ")}`).join("\n");
}

/** Returns the reason the code is refused, or null. */
export function workerCodeProblem(code: string): string | null {
  if (!code.trim()) return "worker.js is empty.";
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) return "worker.js is over 1 MB: Workers are small servers, move assets to Pages.";
  if (!/export\s+default|addEventListener\s*\(\s*["']fetch["']/.test(code)) return "worker.js must export default { fetch(request, env) { ... } } (module syntax).";
  for (const [pattern, what] of FORBIDDEN_IN_WORKERS) {
    if (pattern.test(code)) return `worker.js calls ${what}: a Worker serves visitors, it never calls models or your owner channel. Keep that logic on your server.`;
  }
  return null;
}

/** The wrangler.toml the runtime writes next to the code (the agent's own copy is replaced). */
export function wranglerToml(name: string, bindings: { kvId?: string; d1Id?: string; d1Name?: string }): string {
  const lines = [
    `name = "${name}"`,
    `main = "worker.js"`,
    `compatibility_date = "${COMPATIBILITY_DATE}"`,
    `workers_dev = true`,
    ``,
    `[observability]`,
    `enabled = true`,
  ];
  if (bindings.kvId) lines.push(``, `[[kv_namespaces]]`, `binding = "KV"`, `id = "${bindings.kvId}"`);
  if (bindings.d1Id) lines.push(``, `[[d1_databases]]`, `binding = "DB"`, `database_name = "${bindings.d1Name ?? name}"`, `database_id = "${bindings.d1Id}"`);
  return lines.join("\n") + "\n";
}

export interface DeployWorkerArgs {
  name: string;
  dir?: string;
  kv?: boolean;
  d1?: boolean;
  schema?: string;
}

export interface DeployWorkerOptions {
  home: string;
  db: Database.Database;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<ExecResult>;
  fetchFn?: typeof fetch;
  now?: Date;
}

function parseId(out: string, key: "id" | "database_id"): string | null {
  const m = new RegExp(`${key}\\s*=\\s*"([a-f0-9-]{8,})"`, "i").exec(out) ?? new RegExp(`"${key}"\\s*:\\s*"([a-f0-9-]{8,})"`, "i").exec(out);
  return m ? m[1] : null;
}

/**
 * Deploys ~/workers/<name>/worker.js as the Worker <name>. Creates the KV
 * namespace or D1 database the first time (ids remembered), applies an
 * optional SQL schema file to D1, deploys, and checks the URL answers.
 */
export async function deployWorker(args: DeployWorkerArgs, options: DeployWorkerOptions): Promise<string> {
  const env = options.env ?? withSecrets();
  if (!cloudflarePagesConfigured(env)) {
    return "Cloudflare is not configured (CLOUDFLARE_PAGES_TOKEN with Workers permissions and CLOUDFLARE_ACCOUNT_ID): ask the owner (guide, Cloudflare).";
  }
  const name = String(args.name ?? "").trim().toLowerCase();
  if (!NAME.test(name)) return "name: 2-54 lowercase letters, digits or dashes (it becomes <name>.<account>.workers.dev).";
  const home = fs.realpathSync(options.home);
  const dir = path.resolve(home, (args.dir ?? `~/workers/${name}`).replace(/^~(?=$|\/)/, home));
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return `${dir} does not exist: create it with worker.js (export default { async fetch(request, env) { ... } }).`;
  }
  if (!real.startsWith(home + path.sep)) return "dir must be inside your home directory.";
  const codeFile = path.join(real, "worker.js");
  if (!fs.existsSync(codeFile)) return `${real} has no worker.js.`;
  const problem = workerCodeProblem(fs.readFileSync(codeFile, "utf-8"));
  if (problem) return problem;
  if (args.schema) {
    const schemaPath = path.resolve(real, args.schema);
    if (!schemaPath.startsWith(real + path.sep) || !fs.existsSync(schemaPath)) return "schema must be a .sql file inside the Worker folder.";
  }

  const run = options.run ?? runLocalCommand;
  const cmdEnv = wranglerEnv(env);
  const wrangler = wranglerCommand(env);
  const workers = listWorkers(options.db);
  const record: WorkerRecord = workers.find((w) => w.name === name) ?? { name, url: "", deployedAt: "", deployments: 0 };
  const notes: string[] = [];

  if (args.kv && !record.kvId) {
    const created = await run(`cd ${shellQuote(real)} && ${wrangler} kv namespace create ${shellQuote(`${name}-kv`)} 2>&1`, 180_000, cmdEnv);
    const id = parseId(`${created.stdout}\n${created.stderr}`, "id");
    if (created.exitCode !== 0 || !id) return `Cloudflare: could not create the KV namespace (exit ${created.exitCode}): ${`${created.stdout}\n${created.stderr}`.trim().slice(-400)}`;
    record.kvId = id;
    notes.push("KV namespace created");
  }
  if (args.d1 && !record.d1Id) {
    const created = await run(`cd ${shellQuote(real)} && ${wrangler} d1 create ${shellQuote(name)} 2>&1`, 180_000, cmdEnv);
    const id = parseId(`${created.stdout}\n${created.stderr}`, "database_id");
    if (created.exitCode !== 0 || !id) return `Cloudflare: could not create the D1 database (exit ${created.exitCode}): ${`${created.stdout}\n${created.stderr}`.trim().slice(-400)}`;
    record.d1Id = id;
    notes.push("D1 database created");
  }
  // Remember storage ids before deploying: a failed deploy must not recreate them.
  saveWorkers(options.db, [...workers.filter((w) => w.name !== name), record]);

  fs.writeFileSync(path.join(real, "wrangler.toml"), wranglerToml(name, { kvId: record.kvId, d1Id: record.d1Id, d1Name: name }));
  if (args.schema && record.d1Id) {
    const applied = await run(`cd ${shellQuote(real)} && ${wrangler} d1 execute ${shellQuote(name)} --remote --file ${shellQuote(args.schema)} 2>&1`, 300_000, cmdEnv);
    if (applied.exitCode !== 0) return `Cloudflare: the D1 schema failed (exit ${applied.exitCode}): ${`${applied.stdout}\n${applied.stderr}`.trim().slice(-400)}`;
    notes.push(`schema ${args.schema} applied`);
  }
  const deploy = await run(`cd ${shellQuote(real)} && ${wrangler} deploy 2>&1`, 600_000, cmdEnv);
  const out = `${deploy.stdout}\n${deploy.stderr}`;
  if (deploy.exitCode !== 0) return `Cloudflare: Worker deployment failed (exit ${deploy.exitCode}): ${out.trim().slice(-600)}`;
  const url = (out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) ?? [])[0] ?? record.url;
  const now = options.now ?? new Date();
  Object.assign(record, { url, deployedAt: now.toISOString(), deployments: record.deployments + 1 });
  saveWorkers(options.db, [...listWorkers(options.db).filter((w) => w.name !== name), record]);

  let check = "";
  if (url) {
    try {
      const resp = await (options.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "MoneyLabBot/1.0 (deploy check)" } });
      check = `GET ${url} answers ${resp.status}.`;
    } catch (err: any) {
      check = `GET ${url} did not answer yet (${String(err?.message ?? err).slice(0, 80)}); it can take a minute.`;
    }
  }
  return [
    `Deployed Worker ${name}${notes.length ? ` (${notes.join(", ")})` : ""}.`,
    url ? `URL: ${url}` : "URL not shown by wrangler; see the Cloudflare dashboard.",
    record.kvId ? "Binding: env.KV (get, put, list, delete)." : "",
    record.d1Id ? "Binding: env.DB (prepare(sql).bind(...).all()/run())." : "",
    check,
    "Next: test it with curl or test_site, call it from your Pages site, add the URL to monitor_site.",
  ].filter(Boolean).join("\n");
}
