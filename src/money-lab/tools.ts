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
  getExperiment,
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
import { formatRecall } from "./recall.js";
import { semanticRecall } from "./embeddings.js";
import { auditPage } from "./audit.js";
import { abSnippet, describeAbTests, finishAbTest, recordAbCounts, startAbTest } from "./abtest.js";
import {
  CRITERIA, IDEA_CRITERIA, IDEA_GATES, approvalBlockers, decideIdea, experimentLaunchBlocker, getIdea, ideaDossier,
  markIdeaLaunched, rankedIdeas, upsertIdea,
} from "./ideas.js";
import { challengeIdea } from "./critic.js";
import { checkDomains } from "./domain.js";
import { IMAGE_PRESETS, playwrightRender, renderImage } from "./image.js";
import { blueskyCredentials, describePosts, draftPost } from "./social.js";
import { configuredFreeProviders, harvest } from "./freeai.js";
import { SIGNAL_SOURCES, type SignalSource, marketSignals } from "./signals.js";
import { deleteDataset, formatRecords, listDatasets, readDataset, saveRecord, searchDatasets } from "./datasets.js";
import { decideIdeaWithOpus, decideStopWithOpus, isStop, shortlistWithOpus, stopDecisionBlocker } from "./decisions.js";
import { addSite, checkSites, describeSites, removeSite } from "./monitor.js";
import { checkDesign, designReview, designReviewFree, firstImpression, formatDesignCheck } from "./design.js";
import { repoScout, scaffoldSite, testSite, vendorCode } from "./workshop.js";
import { MAX_NICHES_PER_SCAN, describeSeeds, listNiches, rejectNiche, scanNiches } from "./funnel.js";
import { addProbeAndPing, checkProbes, formatProbe, listProbes, stopProbe } from "./probes.js";
import { MAX_KITS_PER_DAY, MAX_PENDING_KITS, describeKits, draftKit, kitChannelsConfigured, listKits } from "./kits.js";
import {
  LEGIFRANCE_FONDS, bingQueryStats, bingSubmitUrls, emailOwner, geocode, legifranceSearch, serviceConfigured, sireneCount,
  tavilySearch, uptimeRobotCreate, uptimeRobotStatus,
} from "./services.js";
import { cloudflarePagesConfigured, deploySite } from "./deploy.js";

/** Marker the Anthropic client turns into an image block (recent results only). */
export const SCREENSHOT_MARKER = /\[\[image:([^\]\s]+\.(?:png|jpe?g))\]\]/g;
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

/** A list the model may send as an array or as one string (one item per line). */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.split("\n").map((v) => v.trim()).filter(Boolean);
  if (!Array.isArray(value)) throw new Error("Expected an array of strings");
  return value.map((v) => String(v));
}

/** A list the model may send as an array or as one comma- or newline-separated string. */
function looseList(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.split(/[,\n]+/).map((v) => v.trim()).filter(Boolean);
  return stringList(value);
}

export function createMoneyLabTools(): AutomatonTool[] {
  return [
    {
      name: "record_experiment",
      description:
        "Create or update a Money Lab experiment record. Omit id to create. Evidence is appended (links with dates), " +
        "metrics are merged. Amounts are integer USD cents; use null when unknown. An experiment becomes active " +
        "(building, observing, waiting_for_owner) only with the idea_id of an idea approved through the idea tool. " +
        "Stopping an active one (paused, finished or exploring) is decided by Opus from its dossier: give your reason " +
        "in result; the runtime applies Opus's STOP or CONTINUE.",
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
          idea_id: { type: "string", description: "Approved idea this experiment launches" },
        },
        required: ["status"],
      },
      execute: async (args, ctx) => {
        const ideaId = optionalString(args.idea_id) ?? undefined;
        const existing = typeof args.id === "string" ? getExperiment(ctx.db.raw, args.id) : undefined;
        const blocker = experimentLaunchBlocker(ctx.db.raw, { status: String(args.status), ideaId }, existing);
        if (blocker) return blocker;
        // Owner decision (2026-10-06): stopping an active experiment is decided by Opus.
        let decisionText = "";
        let status = String(args.status) as ExperimentStatus;
        if (existing && isStop(existing, status)) {
          const reason = String(args.result ?? "").trim();
          if (!reason) {
            return "Stopping an active experiment is decided by Opus: give your reason in result (numbers, dates, what you " +
              "tried), then call again.";
          }
          const held = stopDecisionBlocker(ctx.db.raw, existing.id);
          if (held) return held;
          if (!ctx.inferenceRouter) return "Stopping an active experiment needs an Opus decision, which is not available in this runtime.";
          let decision: { verdict: "STOP" | "CONTINUE" | null; text: string; costCents: number };
          try {
            decision = await decideStopWithOpus(ctx.db.raw, existing, { status, reason }, {
              router: ctx.inferenceRouter,
              chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
              sessionId: ctx.db.getKV("session_id") || "default",
              lab: ctx.config.moneyLab,
            });
          } catch (err: any) {
            decision = { verdict: null, text: `Decision failed: ${String(err?.message ?? err).slice(0, 300)}.`, costCents: 0 };
          }
          recordFocusSpend(ctx.db.raw, decision.costCents);
          decisionText = `${decision.text}\n`;
          if (decision.verdict !== "STOP") {
            // Continue (or no decision): keep it active, save the other fields.
            status = existing.status;
            args = { ...args, result: undefined };
            if (decision.verdict === "CONTINUE") {
              const next = /Next\**\s*:\s*([^\n]+)/i.exec(decision.text)?.[1]?.trim() ?? "see the decision";
              args.evidence = [...(stringList(args.evidence) ?? []), `Opus CONTINUE ${new Date().toISOString().slice(0, 10)}: ${next.slice(0, 200)}`];
            }
          }
        }
        // Only an approved idea links to an experiment; idea_id cannot be set through metrics.
        const metrics = args.metrics && typeof args.metrics === "object" && !Array.isArray(args.metrics)
          ? { ...(args.metrics as Record<string, unknown>) }
          : undefined;
        if (metrics) delete metrics.idea_id;
        const linkedIdea = ideaId && getIdea(ctx.db.raw, ideaId)?.status === "approved" ? ideaId : undefined;
        const exp = upsertExperiment(ctx.db.raw, {
          id: optionalString(args.id) ?? undefined,
          status,
          hypothesis: optionalString(args.hypothesis) ?? undefined,
          evidence: stringList(args.evidence),
          artifactRef: optionalString(args.artifact_ref),
          revenueModel: optionalString(args.revenue_model),
          acquisitionChannel: optionalString(args.acquisition_channel),
          spendAllowanceCents: optionalCents(args.spend_allowance_cents),
          consumedCostCents: optionalCents(args.consumed_cost_cents),
          reviewDate: optionalString(args.review_date),
          metrics: linkedIdea ? { ...(metrics ?? {}), idea_id: linkedIdea } : metrics,
          result: optionalString(args.result),
        });
        if (linkedIdea) markIdeaLaunched(ctx.db.raw, linkedIdea, exp.id);
        return `${decisionText}Experiment ${exp.id} recorded with status ${exp.status}.` +
          (decisionText && existing && exp.status === existing.status ? " Status unchanged: Opus did not decide to stop it; other fields saved." : "") +
          (ideaId && !linkedIdea ? ` idea_id "${ideaId}" ignored: only an approved idea can be linked.` : "");
      },
    },
    {
      name: "idea",
      description:
        "Your idea pipeline: think before you build. Record each business idea with its evidence, competitors and a " +
        "0-10 score per criterion, each with the facts behind it: " +
        CRITERIA.map((c) => `${c} (${IDEA_CRITERIA[c].help})`).join("; ") + ". " +
        "Actions: update (create or edit; lists are appended), list (ranked), show, challenge (a stronger model " +
        "critiques the dossier like a sceptical investor, a few cents), decide (reject, or approve: once every gate " +
        "passes, the owner sees the finalist on Telegram for 24 h (/choisis or /ecarte), then Opus reviews the dossier and your note and its " +
        "APPROVE, REJECT or NOT YET is applied, a few cents), shortlist (with 8+ scored ideas: Opus picks up to 5 to probe now and " +
        "rejects the ones not worth it; once a week). " +
        `Approval requires: every criterion scored, ${IDEA_GATES.minEvidence}+ evidence sources, ` +
        `${IDEA_GATES.minCompetitors}+ competitors studied, ${IDEA_GATES.minScoredIdeas}+ scored ideas compared, a top-` +
        `${IDEA_GATES.topRank} rank, a total of ${IDEA_GATES.minTotal}+, a critique that is not NO-GO and your answer to it, ` +
        `kill criteria, and ${IDEA_GATES.reflectionHours} h of reflection since the idea was first recorded.`,
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["update", "list", "show", "challenge", "decide", "shortlist"] },
          id: { type: "string", description: "Short slug, e.g. quote-generator-plumbers" },
          title: { type: "string" },
          problem: { type: "string", description: "The painful problem, in the users' words" },
          audience: { type: "string", description: "Who exactly, and where they gather" },
          solution: { type: "string", description: "What you would ship first" },
          revenue_model: { type: "string" },
          channels: { type: "string", description: "How the first 100 users find it" },
          server_edge: { type: "string", description: "What your own server makes possible here" },
          evidence: { type: "array", items: { type: "string" }, description: "Sources with dates: searches, threads, data" },
          competitors: { type: "array", items: { type: "string" }, description: "Name, URL, price, weakness" },
          risks: { type: "array", items: { type: "string" } },
          kill_criteria: { type: "string", description: "e.g. fewer than 50 visits/week after 4 weeks" },
          scores: {
            type: "object",
            description: "e.g. {\"demand\": {\"score\": 7, \"why\": \"...\"}, ...} for: " + CRITERIA.join(", "),
          },
          response_to_critic: { type: "string", description: "Your answer to the latest critique" },
          decision: { type: "string", enum: ["approve", "reject"], description: "For decide" },
          note: { type: "string", description: "For decide: your reason (reject) or your case for approval, which Opus reads" },
          fresh: { type: "boolean", description: "For shortlist: redo it within the week because the pipeline changed a lot" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        const id = String(args.id ?? "");
        switch (args.action) {
          case "update": {
            const idea = upsertIdea(ctx.db.raw, args);
            if (typeof idea === "string") return idea;
            const blockers = approvalBlockers(ctx.db.raw, idea);
            return `Idea "${idea.id}" saved (total ${idea.total ?? "incomplete"}/100). ` +
              (blockers.length ? `Before approval: ${blockers.join("; ")}.` : "Ready for the decision: decide approve (Opus decides).");
          }
          case "show": {
            const idea = getIdea(ctx.db.raw, id);
            if (!idea) return `No idea "${id}".`;
            const blockers = idea.status === "candidate" ? approvalBlockers(ctx.db.raw, idea) : [];
            return `${ideaDossier(idea)}\nStatus: ${idea.status}${idea.decisionNote ? ` (${idea.decisionNote})` : ""}` +
              (blockers.length ? `\nBefore approval: ${blockers.join("; ")}` : "");
          }
          case "challenge": {
            if (!ctx.inferenceRouter) return "challenge is not available in this runtime.";
            try {
              const result = await challengeIdea(ctx.db.raw, id, {
                router: ctx.inferenceRouter,
                chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
                sessionId: ctx.db.getKV("session_id") || "default",
              });
              recordFocusSpend(ctx.db.raw, result.costCents);
              return result.text;
            } catch (err: any) {
              return `Critique failed: ${String(err?.message ?? err).slice(0, 300)}`;
            }
          }
          case "shortlist": {
            if (!ctx.inferenceRouter) return "shortlist needs an Opus decision, which is not available in this runtime.";
            try {
              const result = await shortlistWithOpus(ctx.db.raw, {
                router: ctx.inferenceRouter, chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
                sessionId: ctx.db.getKV("session_id") || "default", lab: ctx.config.moneyLab,
              }, args.fresh === true);
              recordFocusSpend(ctx.db.raw, result.costCents);
              return result.text;
            } catch (err: any) {
              return `Shortlist failed: ${String(err?.message ?? err).slice(0, 300)}`;
            }
          }
          case "decide": {
            if (args.decision !== "approve" && args.decision !== "reject") return "decision must be approve or reject.";
            if (args.decision === "reject") return decideIdea(ctx.db.raw, id, "reject", String(args.note ?? ""));
            // Owner decision (2026-10-06): Opus decides approvals; the runtime applies its verdict.
            if (!ctx.inferenceRouter) return "Approval needs an Opus decision, which is not available in this runtime.";
            try {
              const result = await decideIdeaWithOpus(ctx.db.raw, id, String(args.note ?? ""), {
                router: ctx.inferenceRouter,
                chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
                sessionId: ctx.db.getKV("session_id") || "default",
                lab: ctx.config.moneyLab,
              });
              recordFocusSpend(ctx.db.raw, result.costCents);
              return result.text;
            } catch (err: any) {
              return `Decision failed: ${String(err?.message ?? err).slice(0, 300)}`;
            }
          }
          default: {
            const ideas = rankedIdeas(ctx.db.raw);
            if (ideas.length === 0) return "No ideas yet. Research several niches, then record each idea with update.";
            return ideas.map((i) =>
              `${i.id} — ${i.title}: ${i.total ?? "?"}/100 [${i.status}]` +
              `${i.critiques.at(-1) ? `, critic ${i.critiques.at(-1)!.verdict ?? "?"}` : ""}`).join("\n");
          }
        }
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
      name: "email_owner",
      description:
        "E-mail the owner (their own address, through the owner's Resend account) a report too long for Telegram: " +
        "a weekly review, a dossier, a full test report. Plain text, 3 a day at most; never include secrets. For short " +
        "news use message_owner.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          text: { type: "string", description: "Plain text, in French" },
        },
        required: ["subject", "text"],
      },
      execute: async (args, ctx) => {
        try {
          return await emailOwner(String(args.subject ?? ""), String(args.text ?? ""), { db: ctx.db.raw });
        } catch (err: any) {
          return `E-mail error: ${String(err?.message ?? err).slice(0, 300)}`;
        }
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
        let result = { exitCode: 0, stdout: "", stderr: "" };
        if (viewport === "print") {
          // Print exactly what a visitor gets, then render the first PDF page.
          result = await ctx.conway.exec(
            `${chrome} --no-pdf-header-footer --print-to-pdf=${shellQuote(`${base}.pdf`)} ${shellQuote(url.toString())} && ` +
            `pdftoppm -png -r 80 -f 1 -l 1 -singlefile ${shellQuote(`${base}.pdf`)} ${shellQuote(base)}`,
            45_000,
          );
          fs.rmSync(`${base}.pdf`, { force: true });
        } else {
          // Exact viewport (Chrome's own --screenshot leaves a blank band at the bottom).
          try {
            await playwrightRender(browser)(url.toString(), file, width, height, "png");
          } catch (err: any) {
            result = { exitCode: 1, stdout: "", stderr: String(err?.message ?? err).split("\n")[0] };
          }
        }
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
      name: "audit_page",
      description:
        "Audit a page with Lighthouse (Google's quality tool): scores out of 100 for performance, accessibility, " +
        "best practices and SEO, speed metrics, and the failing checks with the most impact first. Google ranks " +
        "fast, accessible pages higher: audit before and after each significant change and aim for 90+.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL" },
          device: { type: "string", enum: ["mobile", "desktop"], description: "Default mobile (what Google indexes)" },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "audit_page is only available on a self-hosted server.";
        const browser = findBrowser();
        if (!browser) return "No headless browser on this server. Ask the owner (request_help) to install Google Chrome.";
        let url: URL;
        try {
          url = new URL(String(args.url));
        } catch {
          return "Invalid URL.";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs can be audited.";
        return auditPage(url.toString(), args.device === "desktop" ? "desktop" : "mobile", {
          exec: (command, timeout) => ctx.conway.exec(command, timeout),
          browser,
          home: process.env.HOME || "/root",
        });
      },
    },
    {
      name: "check_design",
      description:
        "Free design and quality check of a page in your server's Chrome, desktop and mobile: accessibility " +
        "violations with axe-core (contrast, labels, landmarks), horizontal overflow on phones, tap targets under " +
        "40px, images without alt or too heavy, font count, missing title/description/viewport/favicon/og:image, " +
        "heading structure, console errors, page weight. Returns the findings and both screenshots. Run it on " +
        "every page before publishing, fix the errors, then first_impression and design_review.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL, yours or a competitor's" } },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "check_design is only available on a self-hosted server.";
        const browser = findBrowser();
        if (!browser) return "No headless browser on this server. Ask the owner (request_help) to install Google Chrome.";
        let url: URL;
        try {
          url = new URL(String(args.url));
        } catch {
          return "Invalid URL.";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs can be checked.";
        const check = await checkDesign(url.toString(), { browser, home: process.env.HOME || "/root" });
        return typeof check === "string" ? check : formatDesignCheck(check);
      },
    },
    {
      name: "first_impression",
      description:
        "The five-second test, free: a reader sees only what your page shows before scrolling and says what the " +
        "site does, for whom, what they would click and what confuses them. If they cannot answer, rewrite your " +
        "headline and lede before anything else.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL" } },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "first_impression is only available on a self-hosted server.";
        const browser = findBrowser();
        if (!browser) return "No headless browser on this server. Ask the owner (request_help) to install Google Chrome.";
        let url: URL;
        try {
          url = new URL(String(args.url));
        } catch {
          return "Invalid URL.";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs.";
        const check = await checkDesign(url.toString(), { browser, home: process.env.HOME || "/root" });
        if (typeof check === "string") return check;
        const result = await firstImpression(check, {
          db: ctx.db.raw, home: process.env.HOME || "/root", router: ctx.inferenceRouter,
          chat: (msgs, opts) => ctx.inference.chat(msgs, opts), sessionId: ctx.db.getKV("session_id") || "default",
        });
        recordFocusSpend(ctx.db.raw, result.costCents);
        return result.text;
      },
    },
    {
      name: "design_review",
      description:
        "A senior-designer review of a page from its desktop and mobile screenshots, its text and the automatic " +
        "checks: scores (hierarchy, typography, spacing, colour, consistency, originality, trust, clarity, mobile), the " +
        "top fixes with exact changes, and a SHIP or FIX FIRST verdict. By default a free vision model (Gemini) reviews, " +
        "so use it as often as you iterate; final: true sends it to Claude Opus (a few cents) once per page before it " +
        "goes live, after check_design is clean.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL" },
          context: { type: "string", description: "What the page must achieve, for whom, and the distinctive element you chose" },
          final: { type: "boolean", description: "Opus review before publishing (default: free Gemini review)" },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "design_review is only available on a self-hosted server.";
        if (!ctx.inferenceRouter) return "design_review is not available in this runtime.";
        const browser = findBrowser();
        if (!browser) return "No headless browser on this server. Ask the owner (request_help) to install Google Chrome.";
        let url: URL;
        try {
          url = new URL(String(args.url));
        } catch {
          return "Invalid URL.";
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs.";
        const check = await checkDesign(url.toString(), { browser, home: process.env.HOME || "/root" });
        if (typeof check === "string") return check;
        if (args.final !== true) {
          const free = await designReviewFree(check, String(args.context ?? "").trim(), { db: ctx.db.raw, home: process.env.HOME || "/root" });
          if (free) return `${free.text}\nScreenshots reviewed:\n[[image:${check.screenshots.desktop}]]\n[[image:${check.screenshots.mobile}]]\n(final: true for the Opus verdict before publishing)`;
        }
        try {
          const result = await designReview(check, String(args.context ?? "").trim(), {
            router: ctx.inferenceRouter, chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
            sessionId: ctx.db.getKV("session_id") || "default",
          });
          recordFocusSpend(ctx.db.raw, result.costCents);
          return `${result.text}\nScreenshots reviewed:\n[[image:${check.screenshots.desktop}]]\n[[image:${check.screenshots.mobile}]]`;
        } catch (err: any) {
          return `Design review failed: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "ab_test",
      description:
        "Run A/B tests: show two versions of an element (title, button, layout) at random and keep the one that " +
        "makes visitors reach the goal more often. start returns the page code (cookieless; counts GoatCounter " +
        "events ab-<name>-a-view, ab-<name>-a-goal, ab-<name>-b-view, ab-<name>-b-goal); read those counts from the " +
        "GoatCounter API and pass them to record, which tells you whether the difference is real or noise. " +
        "finish stores the decision. list shows every test.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "record", "finish", "list"] },
          name: { type: "string", description: "e.g. cta-title" },
          page: { type: "string", description: "For start: page URL" },
          hypothesis: { type: "string", description: "For start: what B changes and why it should win" },
          goal: { type: "string", description: "For start: the goal action, e.g. clicks Download PDF" },
          a_views: { type: "integer" },
          a_goals: { type: "integer" },
          b_views: { type: "integer" },
          b_goals: { type: "integer" },
          winner: { type: "string", enum: ["A", "B"], description: "For finish" },
          note: { type: "string", description: "For finish: what you learned" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        const name = String(args.name ?? "");
        switch (args.action) {
          case "start": {
            const test = startAbTest(ctx.db.raw, args);
            if (typeof test === "string") return test;
            return `Test "${test.name}" started. Add this to ${test.page || "the page"} (after the GoatCounter script), ` +
              `mark the two versions with the classes ab-${name}-a and ab-${name}-b, and call abCount("goal") on the goal:\n` +
              abSnippet(test.name);
          }
          case "record":
            return recordAbCounts(
              ctx.db.raw, name,
              { views: Number(args.a_views), goals: Number(args.a_goals) },
              { views: Number(args.b_views), goals: Number(args.b_goals) },
            );
          case "finish":
            if (args.winner !== "A" && args.winner !== "B") return "winner must be A or B.";
            return finishAbTest(ctx.db.raw, name, args.winner, String(args.note ?? ""));
          default:
            return describeAbTests(ctx.db.raw);
        }
      },
    },
    {
      name: "check_domain",
      description:
        "Check whether domain names are free to buy (public registry data, free). Use it to shortlist names, " +
        "then ask the owner with request_help to buy your favourite, with two alternatives, the price and why.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          domains: { type: "array", items: { type: "string" }, description: "Up to 20 names, e.g. [\"devis-artisan.fr\", \"devisartisan.com\"]" },
        },
        required: ["domains"],
      },
      execute: async (args) => checkDomains(looseList(args.domains) ?? []),
    },
    {
      name: "render_image",
      description:
        "Create an image for social networks or your sites: design it in HTML/CSS (text, colours, layout, inline " +
        "SVG, pictures you copied into ~/images and reference as /name.png) and the server's Chrome renders it to " +
        "~/images/<name>.png (or .jpg) at the right size. " +
        "Presets: " + Object.entries(IMAGE_PRESETS).map(([k, [w, h]]) => `${k} ${w}x${h}`).join(", ") +
        " (og = link preview). You see the result to check it.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "File name without extension, e.g. og-devis-plombier" },
          html: { type: "string", description: "The design (a full page or a body fragment sized to the image)" },
          file: { type: "string", description: "Or an HTML file in your home directory" },
          preset: { type: "string", enum: Object.keys(IMAGE_PRESETS) },
          format: { type: "string", enum: ["png", "jpeg"], description: "Default png; jpeg for photos or heavy images (Bluesky max 950 KB)" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "render_image is only available on a self-hosted server.";
        const browser = findBrowser();
        if (!browser) return "No headless browser on this server. Ask the owner (request_help) to install Google Chrome.";
        return renderImage(
          {
            name: String(args.name ?? ""),
            html: typeof args.html === "string" ? args.html : undefined,
            file: typeof args.file === "string" ? args.file : undefined,
            preset: typeof args.preset === "string" ? args.preset : undefined,
            format: typeof args.format === "string" ? args.format : undefined,
            width: args.width as number | undefined,
            height: args.height as number | undefined,
          },
          { render: playwrightRender(browser), home: process.env.HOME || "/root" },
        );
      },
    },
    {
      name: "post_social",
      description:
        "Share your work on Bluesky (the owner's account for you): draft a post (300 characters max, links become " +
        "clickable, optional image from ~/images with alt text). While the owner requires approval, each draft is " +
        "sent to them and published only once approved. At most 3 posts a day. Post things people find useful " +
        "(a tool, a tip, a result), never spam, never reply to or message strangers. Actions: draft, list.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["draft", "list"] },
          text: { type: "string" },
          image: { type: "string", description: "e.g. ~/images/og-devis.png" },
          alt: { type: "string", description: "Image description, required with an image" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        if (args.action !== "draft") return describePosts(ctx.db.raw);
        if (!blueskyCredentials()) return "No Bluesky account yet. Ask the owner with request_help when you have something worth sharing.";
        const post = draftPost(ctx.db.raw, args, { home: process.env.HOME || "/root" });
        if (typeof post === "string") return post;
        return post.status === "pending"
          ? `Draft ${post.id} sent to the owner for approval; it is published once approved. Do not wait for it.`
          : `Post ${post.id} queued: it is published within a minute.`;
      },
    },
    {
      name: "publish_kit",
      description:
        "Reach people through the owner: you cannot post on directories, forums or groups, but the owner posts for you if " +
        "nothing is left to write. A kit is one ready-to-paste publication for one venue: platform, the exact URL where to " +
        "post, the title, the full text in the venue's language, your page link (it gets ?ref=kit-<id> so visits are " +
        "attributed), an optional image, the venue's rules (read them first with harvest) and what readers gain. The owner " +
        "receives it on Telegram and answers /publie or /passe; you are woken. Value first, never the same text twice, " +
        `at most ${MAX_KITS_PER_DAY} a day and ${MAX_PENDING_KITS} waiting. When the owner configured dev.to or Mastodon, a kit ` +
        "for that platform (name it so) is posted by the runtime itself on /publie: markdown body and up to 4 tags for " +
        "dev.to, 500 characters for Mastodon. Actions: draft, list.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["draft", "list"] },
          platform: { type: "string", description: "e.g. Reddit r/vosfinances, Product Hunt, AlternativeTo, LinkedIn group X" },
          where: { type: "string", description: "URL of the exact place to post" },
          audience: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "The complete text to paste, 120+ characters" },
          link: { type: "string", description: "Your page URL" },
          image: { type: "string", description: "e.g. ~/images/og-devis.png" },
          rules: { type: "string", description: "What this venue allows and forbids (self-promotion days, flair, format)" },
          value: { type: "string", description: "What readers gain from the post" },
          tags: { type: "array", items: { type: "string" }, description: "dev.to tags (4 max), e.g. [\"webdev\", \"opensource\"]" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        if (args.action !== "draft") {
          const channels = kitChannelsConfigured();
          return describeKits(ctx.db.raw) + (channels.length ? `\nPosted by the runtime on /publie: ${channels.join(", ")}.` : "");
        }
        if (!ctx.config.moneyLab?.telegram) return "No owner channel (Telegram): kits cannot be delivered.";
        const kit = draftKit(ctx.db.raw, { ...args, tags: looseList(args.tags) });
        if (typeof kit === "string") return kit;
        return `Kit ${kit.id} sent to the owner (${kit.platform}${kit.channel ? `, posted by the runtime once approved` : ""}). It is posted when the owner answers /publie ${kit.id}; do not wait for it. ` +
          `Visits from it will show as referrer kit-${kit.id} in your analytics. ${listKits(ctx.db.raw).filter((k) => k.status === "pending").length} kit(s) waiting.`;
      },
    },
    {
      name: "free_services",
      description:
        "Find a free service or API for a need (hosting, database, e-mail, forms, maps, data, monitoring, payments, " +
        "search...) from the community lists free-for-dev and public-apis, read through the free models: name, URL, " +
        "free tier limits, catches. find saves what it finds in the free-services dataset; search looks there first " +
        "(free, instant). Check the provider's own pricing page before relying on a limit.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["find", "search"] },
          need: { type: "string", description: "e.g. \"transactional email with a free tier\", \"French company data API\"" },
        },
        required: ["action", "need"],
      },
      execute: async (args, ctx) => {
        const need = String(args.need ?? "").trim();
        if (!need) return "need is required.";
        const home = process.env.HOME || "/root";
        if (args.action === "search") {
          const found = searchDatasets(home, need, 12).filter((r) => r.dataset === "free-services");
          return found.length ? formatRecords(found) : "Nothing saved yet about this: use find.";
        }
        const result = await harvest({
          task: `From these community lists of free developer services and public APIs, list every service that offers a free tier useful for: ${need}. ` +
            "For each: name, URL, what the free tier includes (limits, whether a card is required), and one catch. Prefer services with a permanent free plan over trials. 15 at most, best first.",
          urls: [
            "https://raw.githubusercontent.com/ripienaar/free-for-dev/master/README.md",
            "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md",
          ],
          saveTo: "free-services",
        }, {
          db: ctx.db.raw, home, router: ctx.inferenceRouter, chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
          sessionId: ctx.db.getKV("session_id") || "default",
        });
        recordFocusSpend(ctx.db.raw, result.costCents);
        return result.text;
      },
    },
    {
      name: "free_search",
      description:
        "Search the web for free through the owner's Tavily account (1,000 searches a month, 30 a day here): a short " +
        "answer plus sources with extracts, built for research. Prefer it to the paid web search; use depth advanced " +
        "only for hard questions (costs double), include_domains to stay on chosen sites, days for recent news.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", description: "1-10, default 6" },
          depth: { type: "string", enum: ["basic", "advanced"] },
          include_domains: { type: "array", items: { type: "string" }, description: "e.g. [\"service-public.fr\"]" },
          days: { type: "integer", description: "Only news from the last N days" },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        try {
          return await tavilySearch({
            query: String(args.query ?? ""), maxResults: Number(args.max_results) || undefined,
            depth: args.depth === "advanced" ? "advanced" : "basic", includeDomains: looseList(args.include_domains),
            days: Number(args.days) || undefined,
          }, { db: ctx.db.raw });
        } catch (err: any) {
          return `Search error: ${String(err?.message ?? err).slice(0, 300)}`;
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
      name: "bing_webmaster",
      description:
        "Bing Webmaster Tools (owner's key): which queries and pages Bing shows for your site (queries, pages), or " +
        "submit new URLs so Bing indexes them within hours (submit, up to 50). Bing feeds DuckDuckGo, Ecosia and " +
        "Copilot, so this is a second measurement next to Search Console.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["queries", "pages", "submit"] },
          site: { type: "string", description: "The verified site, e.g. https://brand.fr/" },
          urls: { type: "array", items: { type: "string" }, description: "For submit" },
        },
        required: ["action", "site"],
      },
      execute: async (args, ctx) => {
        const site = String(args.site ?? "").trim();
        if (!/^https?:\/\//.test(site)) return "site must be the verified http(s) site URL.";
        try {
          if (args.action === "submit") return await bingSubmitUrls(site, looseList(args.urls) ?? [], { db: ctx.db.raw });
          return await bingQueryStats(site, { db: ctx.db.raw, dimension: args.action === "pages" ? "page" : "query" });
        } catch (err: any) {
          return `Bing Webmaster error: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "delegate",
      description:
        "Hand a simple task to a cheaper model: summarize long pages, extract or sort data, compare documents, " +
        "draft text. It goes to the free models first (as harvest does) and to Claude Haiku 4.5 (about half your " +
        "price) when none answers; pass quality \"high\" to go straight to Haiku for subtle work. Give it the task " +
        "and the material (text, your own files, up to 5 URLs it downloads itself) instead of reading long content " +
        "yourself. It has no tools and no memory: include everything it needs.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Exactly what to produce, e.g. \"List each competitor's price and free-plan limits as a table\"" },
          text: { type: "string", description: "Material to work on" },
          files: { type: "array", items: { type: "string" }, description: "Your files, e.g. ~/research/niches.md" },
          urls: { type: "array", items: { type: "string" }, description: "Up to 5 http(s) pages to download and read" },
          max_tokens: { type: "integer", description: "Answer length cap, default 2000 (max 2400: you read at most 10,000 characters)" },
          quality: { type: "string", enum: ["normal", "high"], description: "high: Haiku directly (paid) for subtle work; default tries the free models first" },
        },
        required: ["task"],
      },
      execute: async (args, ctx) => {
        if (!ctx.inferenceRouter) return "delegate is not available in this runtime.";
        // Free models first (owner request): Haiku only when they do not answer or for quality "high".
        if (args.quality !== "high" && configuredFreeProviders().length > 0) {
          try {
            const free = await harvest(
              {
                task: String(args.task ?? ""),
                text: typeof args.text === "string" ? args.text : undefined,
                files: looseList(args.files),
                urls: looseList(args.urls)?.slice(0, 5),
                freeOnly: true,
              },
              { db: ctx.db.raw, home: process.env.HOME || "/root", sessionId: ctx.db.getKV("session_id") || "default" },
            );
            if (free.provider !== "none") return `${free.text}\n[delegate: answered by a free model; quality "high" for Haiku]`;
          } catch {
            // fall through to Haiku
          }
        }
        try {
          const result = await delegate(
            {
              task: String(args.task ?? ""),
              text: typeof args.text === "string" ? args.text : undefined,
              files: looseList(args.files),
              urls: looseList(args.urls),
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
      name: "harvest",
      description:
        "Collect information for free: free AI models (online free tiers or a local model, as the owner configured; " +
        "see your rules) read up to 8 web pages, your files or text and extract what you ask: prices, competitors, " +
        "features, complaints, lists. Long material is split and summarised part by part. Falls back to Haiku " +
        "(paid) when no free model answers, unless free_only. Results are cached 3 days (fresh: true to redo) and " +
        "can be appended to a dataset (save_to). Free services may keep what they read: send only public " +
        "material, never secrets or personal data. Free models are weaker: verify key facts, and use delegate or " +
        "your own judgment for anything subtle.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Exactly what to extract, e.g. \"Table: tool, price, free plan limits, main complaint\"" },
          urls: { type: "array", items: { type: "string" }, description: "Up to 8 http(s) pages" },
          files: { type: "array", items: { type: "string" }, description: "Your files, e.g. ~/research/raw.html" },
          text: { type: "string", description: "Material to work on" },
          save_to: { type: "string", description: "Dataset name to append the result to, e.g. competitors-quotes" },
          free_only: { type: "boolean", description: "Never fall back to the paid model" },
          fresh: { type: "boolean", description: "Ignore the 3-day cache" },
        },
        required: ["task"],
      },
      execute: async (args, ctx) => {
        try {
          const result = await harvest(
            {
              task: String(args.task ?? ""),
              text: typeof args.text === "string" ? args.text : undefined,
              files: looseList(args.files),
              urls: looseList(args.urls),
              saveTo: typeof args.save_to === "string" && args.save_to ? args.save_to : undefined,
              freeOnly: args.free_only === true,
              fresh: args.fresh === true,
            },
            {
              db: ctx.db.raw,
              home: process.env.HOME || "/root",
              router: ctx.inferenceRouter,
              chat: (msgs, opts) => ctx.inference.chat(msgs, opts),
              sessionId: ctx.db.getKV("session_id") || "default",
            },
          );
          recordFocusSpend(ctx.db.raw, result.costCents);
          return result.text;
        } catch (err: any) {
          return `Harvest failed: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "repo_scout",
      description:
        "Find GitHub repositories to reuse or learn from before writing code: searches by what the code must do, " +
        "keeps maintained, starred projects, marks the licence (MIT, Apache, BSD, ISC: reusable; GPL, none: not), " +
        "and reads the first READMEs through the free models. Free. Then vendor_code to copy one.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What the code must do, e.g. \"pdf merge browser javascript\"" },
          language: { type: "string", description: "e.g. javascript, typescript, python" },
          min_stars: { type: "integer", description: "Default 50" },
          max_age_days: { type: "integer", description: "Last push at most this old; default 730" },
          readmes: { type: "integer", description: "READMEs to read (0-5, default 3)" },
          save_to: { type: "string", description: "Dataset name to keep the results" },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const home = process.env.HOME || "/root";
        const summarize = async (readme: string, repo: string) => {
          const result = await harvest(
            { task: `Summarize this README for a developer who wants to reuse ${repo}: what it does, how to use it (install or copy), its size and dependencies, limits. 12 lines at most.`, text: readme },
            { db: ctx.db.raw, home, router: ctx.inferenceRouter, chat: (msgs, opts) => ctx.inference.chat(msgs, opts), sessionId: ctx.db.getKV("session_id") || "default" },
          );
          recordFocusSpend(ctx.db.raw, result.costCents);
          return result.text;
        };
        return repoScout({
          query: String(args.query ?? ""),
          language: typeof args.language === "string" ? args.language : undefined,
          minStars: args.min_stars as number | undefined,
          maxAgeDays: args.max_age_days as number | undefined,
          readmes: args.readmes as number | undefined,
          saveTo: typeof args.save_to === "string" && args.save_to ? args.save_to : undefined,
        }, { home, summarize });
      },
    },
    {
      name: "vendor_code",
      description:
        "Copy a permissively licensed public GitHub repository, or only the paths you need, into ~/library/vendor/<name> " +
        "with a NOTICE.md (source, commit, licence) and a line in ~/library/vendor/INDEX.md. Refuses GPL, unlicensed and " +
        "huge repositories. Copies only: never installs or runs anything from it; read the code, then reuse it in your site.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "owner/name" },
          paths: { type: "array", items: { type: "string" }, description: "Files or directories to copy (default: all)" },
          name: { type: "string", description: "Directory name under ~/library/vendor (default: the repository name)" },
          ref: { type: "string", description: "Branch or tag (default: the default branch)" },
        },
        required: ["repo"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "vendor_code is only available on a self-hosted server.";
        return vendorCode({
          repo: String(args.repo ?? ""), paths: looseList(args.paths),
          name: typeof args.name === "string" ? args.name : undefined, ref: typeof args.ref === "string" ? args.ref : undefined,
        }, { home: process.env.HOME || "/root" });
      },
    },
    {
      name: "scaffold_site",
      description:
        "Start a complete site in one call from the design kit: ~/sites/<name> with index.html (your title, description, " +
        "H1 and lede set, theme linked), site.css, an about page, 404, robots.txt, sitemap.xml, the analytics snippet and a git " +
        "repository; French or English. With publish: true and GitHub credentials, creates the repository and enables Pages. " +
        "Then replace the placeholder texts, add favicon.png and og.png (render_image), run check_design, first_impression " +
        "and test_site before design_review.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "lowercase-with-dashes; becomes the repository and URL path" },
          template: { type: "string", enum: ["tool", "landing"] },
          theme: { type: "string", enum: ["sober", "warm", "editorial", "playful", "technical", "retro"] },
          lang: { type: "string", enum: ["fr", "en"] },
          title: { type: "string", description: "Page title, under 60 characters" },
          description: { type: "string", description: "Meta description, under 150 characters" },
          h1: { type: "string" },
          lede: { type: "string" },
          brand: { type: "string" },
          contact_email: { type: "string" },
          publish: { type: "boolean", description: "Create the GitHub repository and enable Pages now" },
        },
        required: ["name", "title", "description"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "scaffold_site is only available on a self-hosted server.";
        return scaffoldSite({
          name: String(args.name ?? ""), template: args.template as "tool" | "landing" | undefined, theme: typeof args.theme === "string" ? args.theme : undefined,
          lang: args.lang as "fr" | "en" | undefined, title: String(args.title ?? ""), description: String(args.description ?? ""),
          h1: typeof args.h1 === "string" ? args.h1 : undefined, lede: typeof args.lede === "string" ? args.lede : undefined,
          brand: typeof args.brand === "string" ? args.brand : undefined, contactEmail: typeof args.contact_email === "string" ? args.contact_email : undefined,
          publish: args.publish === true,
        }, { home: process.env.HOME || "/root" });
      },
    },
    {
      name: "test_site",
      description:
        "Test a site like a visitor, for free: a fresh headless browser runs your scenario (goto, click, fill, select, press, " +
        "expect_text, expect_visible, expect_hidden, expect_url, wait), then crawls the internal links. Reports failed steps " +
        "with a screenshot, console and page errors, failed requests, broken links and images. Run it on localhost before " +
        "publishing (python3 -m http.server in your site directory) and on the live URL after.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          steps: {
            type: "array",
            description: "Scenario after the page loads, e.g. [{action:'fill', selector:'#champ-1', value:'12'}, {action:'click', selector:'button[type=submit]'}, {action:'expect_text', selector:'#resultat', value:'Résultat'}]",
            items: { type: "object", properties: { action: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, required: ["action"] },
          },
          crawl: { type: "boolean", description: "Follow internal links (default true)" },
          max_pages: { type: "integer", description: "Pages to crawl, default 20" },
          mobile: { type: "boolean", description: "390px phone viewport" },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "test_site is only available on a self-hosted server.";
        try {
          return await testSite({
            url: String(args.url ?? ""), steps: Array.isArray(args.steps) ? (args.steps as any[]) : undefined,
            crawl: args.crawl !== false, maxPages: args.max_pages as number | undefined, mobile: args.mobile === true,
          }, { home: process.env.HOME || "/root" });
        } catch (err: any) {
          return `test_site failed: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "deploy_site",
      description:
        "Publish a finished static site to Cloudflare Pages for free (https://<name>.pages.dev, unlimited bandwidth, " +
        "500 deployments a month) with the owner's token: the project is created if needed and ~/sites/<name> (or dir) " +
        "is uploaded. Only after check_design, test_site and design_review; redeploy the same name to update it. " +
        "GitHub Pages through scaffold_site publish stays available; use one host per site.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name, lowercase letters, digits and dashes" },
          dir: { type: "string", description: "Default ~/sites/<name>" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        if (ctx.identity.sandboxId) return "deploy_site is only available on a self-hosted server.";
        if (!cloudflarePagesConfigured()) return "Cloudflare Pages is not configured: publish with scaffold_site (GitHub Pages) or ask the owner with request_help (guide, Cloudflare Pages).";
        const today = new Date().toISOString().slice(0, 10);
        const key = `money_lab.deploys.${today}`;
        const count = Number(ctx.db.getKV(key) ?? "0");
        if (count >= 10) return "At most 10 deployments a day: test locally with test_site first.";
        ctx.db.setKV(key, String(count + 1));
        const result = await deploySite({ name: String(args.name ?? ""), dir: args.dir ? String(args.dir) : undefined }, { home: process.env.HOME || "/root" });
        if (/^Deployed /.test(result)) queueOwnerNotification(ctx.db.raw, `🚀 Site déployé sur Cloudflare Pages : ${result.split("\n")[1] ?? ""}`);
        return result;
      },
    },
    {
      name: "code_review",
      description:
        "Have your code reviewed before you ship it: the free models (then Haiku if none answers) read the files and list " +
        "bugs, security issues (injection, unsafe HTML, secrets), accessibility and performance problems, with the line and a " +
        "fix each. Pass the files of one page or module at a time (up to 8).",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Paths in your home, e.g. ~/sites/devis/index.html" },
          focus: { type: "string", description: "What to look at first (optional)" },
        },
        required: ["files"],
      },
      execute: async (args, ctx) => {
        const files = (looseList(args.files) ?? []).slice(0, 8);
        if (!files.length) return "files is required.";
        const task = "Review this code as a senior web developer. List every real problem, most serious first, as " +
          "\"file:line — problem — fix\": bugs and wrong results, security (injection, unsafe innerHTML, secrets in code, " +
          "external scripts), accessibility (labels, contrast, keyboard, focus), mobile layout, performance (heavy assets, " +
          "blocking scripts), wrong or placeholder text left in. Then 3 things done well. Do not rewrite the files." +
          (typeof args.focus === "string" && args.focus ? ` Focus first on: ${args.focus}.` : "");
        const result = await harvest({ task, files, fresh: true }, {
          db: ctx.db.raw, home: process.env.HOME || "/root", router: ctx.inferenceRouter,
          chat: (msgs, opts) => ctx.inference.chat(msgs, opts), sessionId: ctx.db.getKV("session_id") || "default",
        });
        recordFocusSpend(ctx.db.raw, result.costCents);
        return result.text;
      },
    },
    {
      name: "niche_scan",
      description:
        "Discover niches wide and cheap (free, no inference). seeds: the categories of needs and their starting phrases " +
        "(expand each into 5-10 concrete search intents with harvest first). scan: for up to " + MAX_NICHES_PER_SCAN + " phrases, counts " +
        "demand signals from public sources (Google suggestions by intent, commercial intent, Wikipedia audience, Hacker News " +
        "discussion, open-source alternatives) and scores them with a fixed formula; results are kept and listed. " +
        "list: the ranking. reject: drop a niche with the reason so it is never studied again. " +
        "Then study the top ones with market_signals and harvest, and record the best as ideas.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["seeds", "scan", "list", "reject"] },
          category: { type: "string", description: "For seeds: a category name (partial match)" },
          niches: { type: "array", items: { type: "string" }, description: "For scan: short search phrases, 3-6 words each" },
          lang: { type: "string", enum: ["fr", "en"], description: "Market language (default fr)" },
          niche: { type: "string", description: "For reject" },
          reason: { type: "string", description: "For reject" },
          limit: { type: "integer", description: "For list, default 30" },
          fresh: { type: "boolean", description: "For scan: redo niches scanned within a week" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        const lang = args.lang === "en" ? "en" : "fr";
        switch (args.action) {
          case "seeds": return describeSeeds(typeof args.category === "string" ? args.category : undefined, args.lang === "en" || args.lang === "fr" ? args.lang : undefined);
          case "scan":
            try {
              return await scanNiches(ctx.db.raw, looseList(args.niches) ?? [], lang, {
                home: process.env.HOME || "/root", githubToken: process.env.GH_TOKEN || undefined, fresh: args.fresh === true,
              });
            } catch (err: any) {
              return `niche_scan failed: ${String(err?.message ?? err).slice(0, 300)}`;
            }
          case "reject": return rejectNiche(ctx.db.raw, String(args.niche ?? ""), String(args.reason ?? ""));
          default: return listNiches(ctx.db.raw, { limit: args.limit as number | undefined, lang: args.lang === "en" || args.lang === "fr" ? args.lang : undefined });
        }
      },
    },
    {
      name: "probe",
      description:
        "Measure demand before building: a probe is one useful page (built in a day with scaffold_site), published under your " +
        "Search Console property, aimed at 2-8 searches. add registers it; the runtime reads Search Console daily and, after the " +
        "window (14 days by default), the probe passes at the impressions threshold (50) or fails; the owner is told, you are " +
        "woken, and a probe linked to an idea adds its numbers to that idea's evidence. Probes do not count as experiments. " +
        "Actions: add, list, check (read Search Console now), stop.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "list", "check", "stop"] },
          id: { type: "string" },
          url: { type: "string", description: "For add: the page's public URL" },
          queries: { type: "array", items: { type: "string" }, description: "For add: 2-8 searches the page targets" },
          idea_id: { type: "string", description: "For add: the idea this probe tests" },
          window_days: { type: "integer", description: "7-45, default 14" },
          min_impressions: { type: "integer", description: "Default 50" },
          note: { type: "string", description: "For stop" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        switch (args.action) {
          case "add":
            return addProbeAndPing(ctx.db.raw, {
              id: String(args.id ?? ""), url: String(args.url ?? ""), queries: looseList(args.queries) ?? [],
              ideaId: typeof args.idea_id === "string" && args.idea_id ? args.idea_id : undefined,
              windowDays: args.window_days as number | undefined, minImpressions: args.min_impressions as number | undefined,
            });
          case "check": {
            const report = await checkProbes(ctx.db.raw);
            return report.length ? report.join("\n") : "No live probe.";
          }
          case "stop": return stopProbe(ctx.db.raw, String(args.id ?? ""), String(args.note ?? ""));
          default: {
            const probes = listProbes(ctx.db.raw);
            return probes.length ? probes.map((p) => formatProbe(p)).join("\n") : "No probe yet. Build one page with scaffold_site, publish it, then probe add.";
          }
        }
      },
    },
    {
      name: "market_signals",
      description:
        "Measure demand for free, with dated numbers you can cite as evidence: Hacker News stories (total and last " +
        "12 months), Reddit posts of the last year, Google search suggestions (what people actually type), " +
        "Wikipedia audience and trend, GitHub open-source alternatives, Stack Exchange questions. No account, no " +
        "cost; cached a day. Use the words your audience would type, in their language. Default sources: " +
        "hackernews, reddit, google_suggest, wikipedia.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "e.g. \"devis plombier\" or \"invoice generator\"" },
          sources: { type: "array", items: { type: "string", enum: [...SIGNAL_SOURCES] } },
          lang: { type: "string", description: "Two-letter language for Google suggestions and Wikipedia, default fr" },
          site: { type: "string", description: "Stack Exchange site, default stackoverflow (e.g. superuser, webapps)" },
          save_to: { type: "string", description: "Dataset name to append the result to" },
          fresh: { type: "boolean", description: "Ignore the 1-day cache" },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const sources = (looseList(args.sources) ?? []).filter((s): s is SignalSource => (SIGNAL_SOURCES as readonly string[]).includes(s));
        try {
          return await marketSignals(String(args.query ?? ""), sources, {
            home: process.env.HOME || "/root",
            lang: typeof args.lang === "string" ? args.lang.toLowerCase() : undefined,
            site: typeof args.site === "string" ? args.site.toLowerCase() : undefined,
            saveTo: typeof args.save_to === "string" && args.save_to ? args.save_to : undefined,
            fresh: args.fresh === true,
            githubToken: process.env.GH_TOKEN || undefined,
          });
        } catch (err: any) {
          return `market_signals failed: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "france_data",
      description:
        "Official French data, free: companies counts how many active businesses exist for a trade (NAF code, e.g. " +
        "43.22A plumbers, 56.10A restaurants, 69.10Z lawyers; 2 digits for a division) in a postcode prefix or " +
        "department, with a sample of names (INSEE Sirene, owner's key): the size of a local market and its competition. " +
        "address geocodes a place or lists towns (API Adresse, no key). law searches Légifrance (codes, laws, decrees, " +
        "case law; owner's PISTE account) to check what a product or claim must respect. Cite the numbers with their date.",
      category: "survival",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["companies", "address", "law"] },
          naf: { type: "string", description: "companies: NAF/APE code" },
          postcode: { type: "string", description: "companies: full or prefix, e.g. 75 or 33000" },
          department: { type: "string", description: "companies: e.g. 69, 2A, 974" },
          keyword: { type: "string", description: "companies: word in the business name" },
          query: { type: "string", description: "address or law: what to look up" },
          fond: { type: "string", enum: [...LEGIFRANCE_FONDS], description: "law: default ALL" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        try {
          switch (args.action) {
            case "companies":
              return await sireneCount({
                naf: args.naf ? String(args.naf) : undefined, postcode: args.postcode ? String(args.postcode) : undefined,
                department: args.department ? String(args.department) : undefined, keyword: args.keyword ? String(args.keyword) : undefined,
              }, { db: ctx.db.raw });
            case "address":
              return await geocode(String(args.query ?? ""), { db: ctx.db.raw });
            case "law":
              return await legifranceSearch(String(args.query ?? ""), { db: ctx.db.raw, fond: args.fond ? String(args.fond) : undefined });
            default:
              return "action: companies, address or law.";
          }
        } catch (err: any) {
          return `France data error: ${String(err?.message ?? err).slice(0, 300)}`;
        }
      },
    },
    {
      name: "dataset",
      description:
        "Your research data, kept between sessions so you never pay twice for the same facts: append records " +
        "(competitor prices, signals, lists) to named datasets in ~/datasets/<name>.jsonl, then read or search " +
        "them. harvest and market_signals can save directly with save_to; recall also searches datasets. " +
        "Actions: save, list, read, search, delete.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["save", "list", "read", "search", "delete"] },
          name: { type: "string", description: "e.g. competitors-quotes" },
          data: { type: "string", description: "For save: the record, as text or JSON" },
          ref: { type: "string", description: "For save: source URL or query, with its date if known" },
          last: { type: "integer", description: "For read: number of latest records, default 20" },
          contains: { type: "string", description: "For read: keep records containing this text" },
          query: { type: "string", description: "For search: words that must all appear" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const home = process.env.HOME || "/root";
        const name = String(args.name ?? "");
        switch (args.action) {
          case "save": {
            // JSON text is stored as JSON, so later reads can filter its fields.
            let data: unknown = args.data;
            if (typeof data === "string" && /^\s*[[{]/.test(data)) {
              try {
                data = JSON.parse(data);
              } catch {
                // plain text
              }
            }
            const error = saveRecord(home, name, { source: "agent", ref: typeof args.ref === "string" ? args.ref : "", data });
            return error ?? `Saved to dataset ${name}.`;
          }
          case "read": {
            const records = readDataset(home, name, {
              last: Number.isInteger(args.last) ? (args.last as number) : undefined,
              contains: typeof args.contains === "string" ? args.contains : undefined,
            });
            if (typeof records === "string") return records;
            return records.length ? formatRecords(records.map((record) => ({ record }))) : "No matching record.";
          }
          case "search": {
            const hits = searchDatasets(home, String(args.query ?? ""));
            return hits.length ? formatRecords(hits) : `Nothing found for "${String(args.query ?? "")}" in your datasets.`;
          }
          case "delete":
            return deleteDataset(home, name) ? `Deleted dataset ${name}.` : `No dataset "${name}".`;
          default: {
            const all = listDatasets(home, { countRecords: true });
            return all.length
              ? all.map((d) => `${d.name}: ${d.records} records, ${Math.round(d.bytes / 1000)} KB, updated ${d.updatedAt.slice(0, 16).replace("T", " ")}`).join("\n")
              : "No datasets yet. Save research results with save_to or action save.";
          }
        }
      },
    },
    {
      name: "monitor_site",
      description:
        "Watch your sites for free: the runtime checks every monitored URL every 30 minutes (active experiments' " +
        "artifact URLs are watched automatically), tells the owner and wakes you if one goes down (two failed " +
        "checks in a row), and tells you when it is back. With the owner's UptimeRobot account, add also creates an " +
        "external check every 5 minutes. Actions: add, remove, list, check (all now).",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "remove", "list", "check"] },
          url: { type: "string", description: "For add and remove: http(s) URL" },
        },
        required: ["action"],
      },
      execute: async (args, ctx) => {
        switch (args.action) {
          case "add": {
            const added = addSite(ctx.db.raw, String(args.url ?? ""));
            if (!/^Monitoring/.test(added)) return added;
            const external = await uptimeRobotCreate(added.replace(/^Monitoring (\S+) .*$/, "$1"), { db: ctx.db.raw });
            const report = await checkSites(ctx.db.raw);
            return `${added}${external ? ` ${external}` : ""}\nFirst check:\n${report.join("\n")}`;
          }
          case "remove":
            return removeSite(ctx.db.raw, String(args.url ?? ""));
          case "check": {
            const report = await checkSites(ctx.db.raw);
            const external = await uptimeRobotStatus({ db: ctx.db.raw });
            return (report.length ? report.join("\n") : "No site to check: add one, or set an active experiment's artifact_ref to its URL.") + (external ? `\n${external}` : "");
          }
          default: {
            const external = await uptimeRobotStatus({ db: ctx.db.raw });
            return `Monitored sites: ${describeSites(ctx.db.raw)}.${external ? `\n${external}` : ""}`;
          }
        }
      },
    },
    {
      name: "schedule_job",
      description:
        "Schedule a shell command the runtime runs on its own, for free (no inference): check that a site " +
        "answers, collect stats, watch a ranking or a competitor page. You are woken only when it matters: " +
        "wake on_failure (default: when the command starts failing), on_change (when its output changes: print only " +
        "stable values, no timestamps) or " +
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
        "Search your own memory for free, by words and by meaning (free embedding model): your notes (~/research, " +
        "~/notes), library (~/library), datasets (~/datasets), skills, LESSONS.md, WORKLOG.md, your ideas and the " +
        "experiment journal. Use it before researching something again.",
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
        const result = await semanticRecall(query, { home: process.env.HOME || "/root", db: ctx.db.raw, limit });
        const note = result.mode === "semantic"
          ? `\n[recall: meaning and words, ${result.provider}, ${result.cached} passages indexed${result.embedded ? `, ${result.embedded} new` : ""}]`
          : "\n[recall: words only; a free embedding model (Gemini, Mistral, Cloudflare) would add search by meaning]";
        return formatRecall(query, result.hits) + note;
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
