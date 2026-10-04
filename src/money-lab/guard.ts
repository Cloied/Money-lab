/**
 * Money Lab guards
 *
 * - A policy rule that allows only the first-run tool allowlist, keeps
 *   publishing on the configured sandbox, protects runtime state from
 *   file/shell tools and denies every tool while paused.
 * - A process-wide x402 payment gate: no credit purchases or x402
 *   payments from inside the agent process during the first run.
 *
 * These checks are in-process. The shell tool runs arbitrary commands,
 * so the runtime-path checks are a heuristic that catches direct edits,
 * not a sandbox boundary. Isolation and finite funding limit exposure.
 */

import os from "os";
import path from "path";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../types.js";
import { setX402PaymentGuard } from "../conway/x402.js";
import { MONEY_LAB_ALLOWED_TOOLS } from "./profile.js";
import { getPauseState } from "./journal.js";

export const PAYMENTS_DISABLED_REASON =
  "credit purchases and x402 payments are disabled by the Money Lab first-run profile; the operator provisions credits outside the agent";

/** Install the process-wide payment gate. Call once at startup. */
export function installMoneyLabPaymentGuard(): void {
  setX402PaymentGuard(() => PAYMENTS_DISABLED_REASON);
}

/**
 * Runtime files the agent must not touch: configuration, wallet, state
 * database, heartbeat schedule, installed skills, constitution and provider
 * settings. The rest of ~/.automaton (WORKLOG.md, notes, workspace/) is the
 * agent's own working area and stays writable.
 */
const PROTECTED_RUNTIME_ENTRIES = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "state.db",
  "heartbeat.yml",
  "skills",
  "constitution.md",
  "inference-providers.json",
];

/** Shell fragments that indicate an attempt to touch runtime secrets/state or pay. */
const PROTECTED_SHELL_PATTERNS: RegExp[] = [
  /\bautomaton\.json\b/,
  /\bwallet\.json\b/,
  /\bstate\.db\b/,
  /\bheartbeat\.yml\b/,
  /\binference-providers\.json\b/,
  /\.automaton\/(config\.json|skills|constitution\.md)/,
  /\bCONWAY_API_KEY\b/,
  /\/pay\/\d/,
];

function runtimeDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".automaton");
}

/** True for protected runtime entries (and anything inside them). */
export function isRuntimePath(filePath: string): boolean {
  const expanded = filePath.startsWith("~")
    ? path.join(process.env.HOME || os.homedir(), filePath.slice(1))
    : filePath;
  const resolved = path.resolve(expanded);
  const dir = runtimeDir();
  if (!resolved.startsWith(dir + path.sep)) return false;
  const first = resolved.slice(dir.length + 1).split(path.sep)[0];
  return PROTECTED_RUNTIME_ENTRIES.some((entry) => first === entry || first.startsWith(`${entry}-`));
}

function deny(reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule: "money_lab.first_run", action: "deny", reasonCode, humanMessage };
}

export function createMoneyLabRules(): PolicyRule[] {
  return [
    {
      id: "money_lab.first_run",
      description: "Money Lab first-run envelope: allowlist, pause, runtime protection",
      priority: 1,
      appliesTo: { by: "all" },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        const lab = request.context.config.moneyLab;
        if (!lab?.enabled) return null;
        const name = request.tool.name;

        const paused = getPauseState(request.context.db.raw);
        if (paused) {
          return deny("MONEY_LAB_PAUSED", `Money Lab is paused (${paused.reason}); no tool may run`);
        }

        if (!MONEY_LAB_ALLOWED_TOOLS.has(name)) {
          return deny(
            "MONEY_LAB_TOOL_DISABLED",
            `${name} is disabled in the first-run profile. Use request_help if the experiment needs it.`,
          );
        }

        if ((name === "expose_port" || name === "remove_port") && !lab.publishSandboxId) {
          return deny("MONEY_LAB_NO_PUBLISH_TARGET", "No publish sandbox is approved for this run");
        }

        if (name === "write_file" && isRuntimePath(String(request.args.path ?? ""))) {
          return deny("MONEY_LAB_RUNTIME_PATH", "Writing runtime configuration, wallet, state or skills is disabled");
        }

        if (name === "exec") {
          const command = String(request.args.command ?? "");
          if (PROTECTED_SHELL_PATTERNS.some((p) => p.test(command))) {
            return deny(
              "MONEY_LAB_PROTECTED_COMMAND",
              "Shell commands touching runtime configuration, wallet, state, API key or payment endpoints are disabled",
            );
          }
        }

        return null;
      },
    },
  ];
}

/**
 * Reason the next paid inference call must not run, or null.
 * Checked by the agent loop before every routed inference call.
 */
export function paidCallBlockReason(db: Parameters<typeof getPauseState>[0]): string | null {
  const paused = getPauseState(db);
  return paused ? `paused: ${paused.reason}` : null;
}
