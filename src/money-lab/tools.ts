/**
 * Money Lab agent tools: record_experiment, request_help, money_lab_status.
 *
 * The agent can create and update experiments and open help requests.
 * It cannot resolve help requests, write the ledger, resume a pause or
 * change limits; those are operator CLI actions.
 */

import type { AutomatonTool } from "../types.js";
import {
  EXPERIMENT_STATUSES,
  upsertExperiment,
  createHelpRequest,
  ownerNotificationsToday,
  queueOwnerNotification,
  type ExperimentStatus,
} from "./journal.js";
import { formatStatus } from "./status.js";
import fs from "fs";
import path from "path";
import { findBrowser, shellQuote } from "./selfhosted.js";
import { browse } from "./browser.js";
import { searchAnalytics, searchConsoleSite } from "./searchconsole.js";
import { BUDGET_CATEGORIES, allocationSummary, isBudgetCategory, recordFocusSpend, setBudgetPlan, setFocus } from "./allocation.js";
import { delegate } from "./delegate.js";
import { JOB_TIMEOUT_MS, JOB_WAKE_MODES, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, describeJobs, jobLogFile, listJobs, removeJob, upsertJob } from "./jobs.js";
import { formatRecall, recall } from "./recall.js";

/** Marker the Anthropic client turns into an image block (recent results only). */
export const SCREENSHOT_MARKER = /\[\[image:([^\]\s]+\.png)\]\]/g;
const VIEWPORTS: Record<string, [number, number]> = { desktop: [1280, 1600], mobile: [390, 844] };
const KEEP_SCREENSHOTS = 20;

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value);
}

function optionalCents(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  return Number(value);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected an array of strings");
  return value.map((v) => String(v));
}

export function createMoneyLabTools(): AutomatonTool[] {
  return [
    {
      name: "record_experiment",
      description:
        "Create or update a Money Lab experiment record. Omit id to create. Evidence is appended (links with dates), " +
        "metrics are merged. Amounts are integer USD cents; use null when unknown.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing experiment id to update" },
          status: { type: "string", enum: [...EXPERIMENT_STATUSES] },
          hypothesis: { type: "string", description: "User problem and what the test should show" },
          evidence: { type: "array", items: { type: "string" }, description: "Evidence references to append" },
          artifact_ref: { type: "string", description: "Artifact or deployment reference" },
          revenue_model: { type: "string", description: "Chosen revenue hypothesis, or none" },
          acquisition_channel: { type: "string", description: "Permitted acquisition channel" },
          spend_allowance_cents: { type: "integer" },
          consumed_cost_cents: { type: "integer" },
          review_date: { type: "string", description: "Planned review date (ISO 8601)" },
          metrics: { type: "object", description: "Observed metrics, e.g. visits, genuine uses" },
          result: { type: "string" },
        },
        required: ["status"],
      },
      execute: async (args, ctx) => {
        const exp = upsertExperiment(ctx.db.raw, {
          id: optionalString(args.id) ?? undefined,
          status: String(args.status) as ExperimentStatus,
          hypothesis: optionalString(args.hypothesis) ?? undefined,
          evidence: stringList(args.evidence),
          artifactRef: optionalString(args.artifact_ref),
          revenueModel: optionalString(args.revenue_model),
          acquisitionChannel: optionalString(args.acquisition_channel),
          spendAllowanceCents: optionalCents(args.spend_allowance_cents),
          consumedCostCents: optionalCents(args.consumed_cost_cents),
          reviewDate: optionalString(args.review_date),
          metrics: (args.metrics as Record<string, unknown> | undefined) ?? undefined,
          result: optionalString(args.result),
        });
        return `Experiment ${exp.id} recorded with status ${exp.status}.`;
      },
    },
    {
      name: "request_help",
      description:
        "Ask the owner for a manual action outside your envelope (account, verification, CAPTCHA, purchase approval, " +
        "tool access). Persisted and shown to the operator. Never include secrets. Then sleep; do not poll for a reply.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          experiment_id: { type: "string" },
          reason: { type: "string" },
          human_action: { type: "string", description: "Exact action the owner must perform" },
          link: { type: "string" },
          expected_cost_cents: { type: "integer", description: "Expected cost in USD cents; omit if unknown" },
          permissions_requested: { type: "array", items: { type: "string" } },
          resume_condition: { type: "string", description: "Verifiable condition that must hold before resuming" },
        },
        required: ["reason", "human_action", "resume_condition"],
      },
      execute: async (args, ctx) => {
        const help = createHelpRequest(ctx.db.raw, {
          experimentId: optionalString(args.experiment_id) ?? null,
          reason: String(args.reason ?? ""),
          humanAction: String(args.human_action ?? ""),
          link: optionalString(args.link) ?? null,
          expectedCostCents: optionalCents(args.expected_cost_cents) ?? null,
          permissionsRequested: stringList(args.permissions_requested) ?? [],
          resumeCondition: String(args.resume_condition ?? ""),
        });
        return `Help request ${help.id} recorded for the owner. Sleep or continue unrelated permitted work; ` +
          "you will be woken when the owner resolves it.";
      },
    },
    {
      name: "message_owner",
      description:
        "Send a short message to the owner (Telegram): a result, a milestone, a question that does not block you. " +
        "For anything that needs a human action, use request_help instead. Max 30 messages per day; never include secrets.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Message, in French" } },
        required: ["text"],
      },
      execute: async (args, ctx) => {
        const text = String(args.text ?? "").trim();
        if (!text) return "Empty message not sent.";
        if (ownerNotificationsToday(ctx.db.raw) >= 30) {
          return "Daily message limit reached (30). Group your updates into the daily summary instead.";
        }
        queueOwnerNotification(ctx.db.raw, `🤖 ${text.slice(0, 3500)}`);
        return "Message queued for the owner.";
      },
    },
    {
      name: "view_page",
      description:
        "Take a screenshot of a web page (yours or a competitor's) and look at it: layout, design, readability, " +
        "mobile rendering. Use it before and after changing a page.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL, e.g. https://org.github.io/site/ or http://localhost:8080" },
          viewport: {
            type: "string",
            enum: ["desktop", "mobile", "print"],
            description: "desktop (1280x1600, default), mobile (390x844) or print: the first page of the printed PDF",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "view_page is only available on a self-hosted server.";
        const browser = findBrowser();
        if (!browser) {
          return "No headless browser on this server. Ask the owner (request_help) to install Google Chrome.";
        }
        let url: URL;
        try {
          url = new URL(String(args.url));
        } catch {
          return "Invalid URL.";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs can be viewed.";
        const viewport = args.viewport === "mobile" || args.viewport === "print" ? args.viewport : "desktop";
        const [width, height] = VIEWPORTS[viewport === "print" ? "desktop" : viewport];
        const dir = path.join(process.env.HOME || "/root", ".money-lab", "screenshots");
        fs.mkdirSync(dir, { recursive: true });
        const base = path.join(dir, `${Date.now()}-${viewport}`);
        const file = `${base}.png`;
        const chrome = `${shellQuote(browser)} --headless=new --no-sandbox --disable-gpu --hide-scrollbars ` +
          `--window-size=${width},${height} --virtual-time-budget=5000`;
        const command = viewport === "print"
          // Print exactly what a visitor gets, then render the first PDF page.
          ? `${chrome} --no-pdf-header-footer --print-to-pdf=${shellQuote(`${base}.pdf`)} ${shellQuote(url.toString())} && ` +
            `pdftoppm -png -r 80 -f 1 -l 1 -singlefile ${shellQuote(`${base}.pdf`)} ${shellQuote(base)}`
          : `${chrome} --screenshot=${shellQuote(file)} ${shellQuote(url.toString())}`;
        const result = await ctx.conway.exec(command, 45_000);
        fs.rmSync(`${base}.pdf`, { force: true });
        if (!fs.existsSync(file)) {
          const hint = viewport === "print" && /pdftoppm/.test(result.stderr)
            ? " (pdftoppm missing: ask the owner to install poppler-utils)"
            : "";
          return `Screenshot failed (exit ${result.exitCode})${hint}: ${(result.stderr || result.stdout).slice(-500)}`;
        }
        const old = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().slice(0, -KEEP_SCREENSHOTS);
        for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
        return `Screenshot of ${url} (${viewport}, ${width}x${height}) attached below.\n[[image:${file}]]`;
      },
    },
    {
      name: "browse",
      description:
        "Drive a real headless browser step by step on your server, with its own profile (no owner accounts): " +
        "goto a URL, list interactive elements, click, fill, select, press a key, read text, screenshot, close. " +
        "Use it to test your sites like a user (fill an invoice, check totals, print) and to research pages that " +
        "need JavaScript. Never create accounts, solve CAPTCHAs or submit forms on third-party sites; ask the owner.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["goto", "elements", "click", "fill", "select", "press", "text", "screenshot", "close"] },
          url: { type: "string", description: "For goto" },
          selector: { type: "string", description: "CSS or Playwright selector, e.g. #email, input[name=\"qty\"], button:has-text(\"Print\")" },
          value: { type: "string", description: "For fill and select" },
          key: { type: "string", description: "For press, e.g. Enter, Tab" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "browse is only available on a self-hosted server.";
        try {
          return await browse(args as any);
        } catch (err: any) {
          return `Browser error: ${String(err?.message ?? err).split("\n")[0].slice(0, 400)}`;
        }
      },
    },
    {
      name: "search_console",
      description:
        "Read Google Search Console analytics (read-only) for your sites: which search queries, pages, " +
        "countries or devices bring impressions and clicks. Data lags about 2 days.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: ["query", "page", "date", "country", "device"], description: "Default query" },
          days: { type: "integer", description: "1-90, default 28" },
          site: { type: "string", description: "Property, e.g. https://org.github.io/site/ (default: the owner's setting)" },
        },
      },
      execute: async (args) => {
        const site = (typeof args.site === "string" && args.site) || searchConsoleSite();
        if (!site) return "Search Console is not set up (no key or property). Ask the owner.";
        const dimension = ["query", "page", "date", "country", "device"].includes(String(args.dimension))
          ? (args.dimension as "query") : "query";
        const days = Math.min(90, Math.max(1, Number.isInteger(args.days) ? (args.days as number) : 28));
        try {
          return await searchAnalytics({ site, dimension, days });
        } catch (err: any) {
          return `Search Console error: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "delegate",
      description:
        "Hand a simple task to a cheaper model (Claude Haiku 4.5, about half the price of your model): summarize " +
        "long pages, extract or sort data, compare documents, draft text. Give it the task and the material " +
        "(text, your own files, up to 5 URLs it downloads itself) instead of reading long content yourself. " +
        "It has no tools and no memory: include everything it needs. Its cost counts toward your budget.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Exactly what to produce, e.g. \"List each competitor's price and free-plan limits as a table\"" },
          text: { type: "string", description: "Material to work on" },
          files: { type: "array", items: { type: "string" }, description: "Your files, e.g. ~/research/niches.md" },
          urls: { type: "array", items: { type: "string" }, description: "Up to 5 http(s) pages to download and read" },
          max_tokens: { type: "integer", description: "Answer length cap, default 4000 (max 8000)" },
        },
        required: ["task"],
      },
      execute: async (args, ctx) => {
        if (!ctx.inferenceRouter) return "delegate is not available in this runtime.";
        try {
          const result = await delegate(
            {
              task: String(args.task ?? ""),
              text: typeof args.text === "string" ? args.text : undefined,
              files: stringList(args.files),
              urls: stringList(args.urls),
              maxTokens: Number.isInteger(args.max_tokens) ? (args.max_tokens as number) : undefined,
            },
            {
              router: ctx.inferenceRouter,
              chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
              home: process.env.HOME || "/root",
              sessionId: ctx.db.getKV("session_id") || "default",
            },
          );
          recordFocusSpend(ctx.db.raw, result.costCents);
          return result.text;
        } catch (err: any) {
          return `Delegation failed: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "schedule_job",
      description:
        "Schedule a shell command the runtime runs on its own, for free (no inference): check that a site " +
        "answers, collect stats, watch a ranking or a competitor page. You are woken only when it matters: " +
        "wake on_failure (default: when the command starts failing), on_change (when its output changes) or " +
        "never (read the log yourself). Output is logged in ~/.money-lab/jobs/<name>.log. Wakes are limited to " +
        `one per hour. Actions: add (replaces a job with the same name), remove, list, run (once now, to test). ` +
        `Commands run ${JOB_TIMEOUT_MS / 1000}s at most, without secrets in their environment.`,
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "remove", "list", "run"] },
          name: { type: "string", description: "e.g. site-check" },
          command: { type: "string", description: "For add, e.g. curl -fsS -o /dev/null -w '%{http_code}' https://org.github.io/site/" },
          every_minutes: { type: "integer", description: `For add, ${MIN_EVERY_MINUTES}-${MAX_EVERY_MINUTES}` },
          wake: { type: "string", enum: [...JOB_WAKE_MODES] },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "schedule_job is only available on a self-hosted server.";
        const name = String(args.name ?? "");
        switch (args.action) {
          case "add": {
            const job = upsertJob(ctx.db.raw, { name, command: args.command, everyMinutes: args.every_minutes, wake: args.wake });
            if (typeof job === "string") return job;
            return `Scheduled "${job.name}" every ${job.everyMinutes} min (wake ${job.wake}); first run within a minute. ` +
              "Test it now with action run.";
          }
          case "remove":
            return removeJob(ctx.db.raw, name) ? `Removed "${name}".` : `No job named "${name}".`;
          case "run": {
            const job = listJobs(ctx.db.raw).find((j) => j.name === name);
            if (!job) return `No job named "${name}".`;
            const result = await ctx.conway.exec(job.command, JOB_TIMEOUT_MS);
            return `exit ${result.exitCode}\n${`${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.slice(-2000)}`;
          }
          default:
            return `Jobs: ${describeJobs(ctx.db.raw)}. Logs: ${path.dirname(jobLogFile("x"))}/`;
        }
      },
    },
    {
      name: "recall",
      description:
        "Search your own memory for free: your notes (~/research, ~/notes), library (~/library), skills, " +
        "LESSONS.md, WORKLOG.md and the experiment journal. Use it before researching something again.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords, e.g. \"competitor pricing invoice\"" },
          limit: { type: "integer", description: "Passages to return, default 8 (max 20)" },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const query = String(args.query ?? "");
        const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : 8));
        return formatRecall(query, recall(query, { home: process.env.HOME || "/root", db: ctx.db.raw, limit }));
      },
    },
    {
      name: "set_budget_focus",
      description:
        "Declare what you are spending on now (research, build, marketing, learning, operations) and optionally " +
        "set your budget plan as integer percentages per category (total at most 100). Every paid turn is " +
        "attributed to the current focus; compare plan and actual spend at each review.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", enum: [...BUDGET_CATEGORIES] },
          plan: {
            type: "object",
            description: "e.g. {\"research\": 25, \"build\": 40, \"marketing\": 15, \"learning\": 10, \"operations\": 10}",
          },
        },
        required: ["focus"],
      },
      execute: async (args, ctx) => {
        if (!isBudgetCategory(args.focus)) return `Unknown focus. Use one of: ${BUDGET_CATEGORIES.join(", ")}.`;
        if (args.plan !== undefined) {
          if (!args.plan || typeof args.plan !== "object" || Array.isArray(args.plan)) return "plan must be an object.";
          const error = setBudgetPlan(ctx.db.raw, args.plan as Record<string, unknown>);
          if (error) return error;
        }
        setFocus(ctx.db.raw, args.focus);
        return `Budget ${allocationSummary(ctx.db.raw)}`;
      },
    },
    {
      name: "money_lab_status",
      description: "Show Money Lab experiments, open help requests, budgets and recorded finances.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => formatStatus(ctx.db.raw, ctx.config),
    },
  ];
}
