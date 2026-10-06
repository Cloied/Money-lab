/**
 * Money Lab binding decisions (Claude Opus)
 *
 * Owner decision (2026-10-06): the cheaper models collect and work, the best
 * model decides. Two decisions commit the bot's money and time, and the
 * runtime hands both to Opus with a prepared dossier, then applies its
 * verdict:
 * - approving an idea (it becomes an experiment): APPROVE, REJECT or NOT YET;
 * - stopping an active experiment (paused, finished or back to exploring):
 *   STOP or CONTINUE.
 * The agent cannot approve an idea or stop an active experiment by itself.
 * Each decision costs a few cents through the budgeted router.
 */

import type Database from "better-sqlite3";
import type { DelegateRouter } from "./delegate.js";
import type { MoneyLabConfig } from "./profile.js";
import { type Experiment, getKV, listExperiments, setKV } from "./journal.js";
import { approvalBlockers, decideIdea, getIdea, ideaDossier, rankedIdeas } from "./ideas.js";
import { REVIEW_MODEL } from "./review.js";
import { survivalBalance } from "./selfhosted.js";

export const DECISION_MODEL = REVIEW_MODEL;
const DECISIONS_KEY = "money_lab.decisions";
const MAX_STORED = 200;
export const MAX_IDEA_DECISIONS = 3;
const CONTINUE_HOLD_MS = 24 * 3_600_000;

export type DecisionKind = "approve_idea" | "stop_experiment";
export type DecisionVerdict = "APPROVE" | "REJECT" | "NOT YET" | "STOP" | "CONTINUE";

export interface Decision {
  at: string;
  kind: DecisionKind;
  target: string;
  verdict: DecisionVerdict;
  model: string;
  costCents: number;
  text: string;
}

export interface DecisionOptions {
  router: DelegateRouter;
  chat: (messages: any[], options: any) => Promise<any>;
  sessionId: string;
  lab?: MoneyLabConfig;
  now?: Date;
}

const COMMITTEE = `You are the investment committee of an autonomous AI agent that runs tiny web businesses on a
few dollars a day. It has no money for ads, cannot create accounts, publishes static sites and small
services from its own Linux server, and must earn real revenue to survive. Cheaper models do its research
and work; you make the decisions that commit its money and time. Your decision is binding: the runtime
applies it. Judge the evidence, not the agent's enthusiasm, and be decisive.`;

const IDEA_RULES = `The agent asks to approve the idea below and start building it now.
APPROVE: it starts building today. REJECT: the idea is closed. NOT YET: it stays in research; list the
specific, obtainable evidence that would change your answer. Approve only with proven demand, an audience
the agent can reach without ads or spam, a real angle against free competitors, a credible revenue path
at this scale and numeric kill criteria. Prefer the best idea of the pipeline: compare with the others.

Answer in under 350 words, in this exact structure:
Decision: APPROVE | REJECT | NOT YET
Reasons: (3-5 bullets)
Conditions or missing evidence: (bullets)
Kill criteria: (numbers and deadline)`;

const STOP_RULES = `The agent asks to stop the active experiment below (its proposal and reason follow).
STOP: the runtime applies the agent's proposal. CONTINUE: the experiment stays active; give the one change
to try next and the date of the next check. Stop what has no credible path after a fair window; keep what
shows real signals (search impressions or visits, genuine usage, revenue) and only needs time: organic
search takes weeks to months.

Answer in under 300 words, in this exact structure:
Decision: STOP | CONTINUE
Reasons: (2-4 bullets)
Next: (if CONTINUE: the one change to try and the next check date; if STOP: what to keep or reuse)`;

export function listDecisions(db: Database.Database): Decision[] {
  try {
    const all = JSON.parse(getKV(db, DECISIONS_KEY) ?? "[]");
    return Array.isArray(all) ? (all as Decision[]) : [];
  } catch {
    return [];
  }
}

function recordDecision(db: Database.Database, decision: Decision): void {
  setKV(db, DECISIONS_KEY, JSON.stringify([...listDecisions(db), decision].slice(-MAX_STORED)));
}

export function parseDecision(text: string, allowed: DecisionVerdict[]): DecisionVerdict | null {
  const m = /Decision\**\s*:\s*\**\s*(APPROVE|REJECT|NOT YET|STOP|CONTINUE)\b/i.exec(text);
  const verdict = m ? (m[1].toUpperCase().replace(/\s+/, " ") as DecisionVerdict) : null;
  return verdict && allowed.includes(verdict) ? verdict : null;
}

function runway(db: Database.Database, lab: MoneyLabConfig | undefined, now: Date): string {
  if (!lab || lab.runtime !== "self-hosted") return "Runway: unknown.";
  const s = survivalBalance(db, lab, now);
  return `Runway: balance $${(s.balanceCents / 100).toFixed(2)}, burn about $${(s.burnPerDayCents / 100).toFixed(2)}/day` +
    (s.daysLeft !== null ? `, about ${s.daysLeft.toFixed(1)} days left` : "") + "; confirmed revenue so far " +
    `$${(s.confirmedRevenueCents / 100).toFixed(2)}.`;
}

async function askOpus(
  rules: string,
  dossier: string,
  options: DecisionOptions,
): Promise<{ ok: boolean; content: string; model: string; costCents: number; finishReason: string }> {
  const result = await options.router.route(
    {
      messages: [
        { role: "system", content: `${COMMITTEE}\n\n${rules}` },
        { role: "user", content: dossier },
      ],
      taskType: "planning",
      tier: "normal",
      sessionId: options.sessionId,
      maxTokens: 1500,
      model: DECISION_MODEL,
    },
    options.chat,
  );
  const ok = ["stop", "length", "end_turn"].includes(result.finishReason) && !!result.content.trim();
  return { ok, content: result.content.trim(), model: result.model, costCents: result.costCents, finishReason: result.finishReason };
}

// ─── Idea approval ──────────────────────────────────────────────

function ideaDecisionDossier(db: Database.Database, id: string, agentCase: string, lab: MoneyLabConfig | undefined, now: Date): string {
  const idea = getIdea(db, id)!;
  const critiques = idea.critiques.map((c, i) =>
    `Critique ${i + 1} (${c.at.slice(0, 10)}, ${c.verdict ?? "no verdict"}):\n${c.text.slice(0, 1200)}`).join("\n\n");
  const pipeline = rankedIdeas(db)
    .filter((i) => i.id !== id && i.total !== null && (i.status === "candidate" || i.status === "approved"))
    .slice(0, 5)
    .map((i) => `- ${i.title} (${i.id}): ${i.total}/100, ${i.status}`);
  const active = listExperiments(db).filter((e) => ["building", "observing", "waiting_for_owner"].includes(e.status));
  const previous = listDecisions(db).filter((d) => d.kind === "approve_idea" && d.target === id)
    .map((d) => `${d.at.slice(0, 10)} ${d.verdict}: ${d.text.slice(0, 600)}`);
  return [
    `Today: ${now.toISOString().slice(0, 10)}.`,
    ideaDossier(idea),
    critiques ? `All critiques:\n${critiques}` : "",
    `The agent's answer to the critiques: ${idea.response || "none"}`,
    previous.length ? `Your previous decisions on this idea:\n${previous.join("\n")}` : "",
    `The agent's case for approval now: ${agentCase}`,
    `Other ideas in the pipeline:\n${pipeline.join("\n") || "- none scored"}`,
    `Active experiments: ${active.length ? active.map((e) => `${e.id} [${e.status}] ${e.hypothesis.slice(0, 100)}`).join("; ") : "none"}.`,
    runway(db, lab, now),
  ].filter(Boolean).join("\n\n");
}

/**
 * The agent asks to approve an idea: every gate must pass first, then Opus
 * decides and the runtime applies the verdict.
 */
export async function decideIdeaWithOpus(
  db: Database.Database,
  id: string,
  agentCase: string,
  options: DecisionOptions,
): Promise<{ text: string; costCents: number }> {
  const now = options.now ?? new Date();
  const idea = getIdea(db, id);
  if (!idea) return { text: `No idea "${id}".`, costCents: 0 };
  if (idea.status !== "candidate") return { text: `Idea "${id}" is already ${idea.status}.`, costCents: 0 };
  if (!agentCase.trim()) return { text: "Give your case for approval in note: Opus reads it with the dossier.", costCents: 0 };
  const blockers = approvalBlockers(db, idea, now);
  if (blockers.length) return { text: `Not ready for a decision yet. Still needed:\n- ${blockers.join("\n- ")}`, costCents: 0 };
  const previous = listDecisions(db).filter((d) => d.kind === "approve_idea" && d.target === id);
  if (previous.length >= MAX_IDEA_DECISIONS) {
    return {
      text: `Opus has already decided on "${id}" ${previous.length} times: reject it, or record an improved variant under a new id.`,
      costCents: 0,
    };
  }
  const last = previous.at(-1);
  if (last && Date.parse(idea.updatedAt) <= Date.parse(last.at)) {
    return { text: `Nothing changed since Opus said ${last.verdict} on ${last.at.slice(0, 16)}: gather what it asked for and update the idea first.`, costCents: 0 };
  }

  const answer = await askOpus(IDEA_RULES, ideaDecisionDossier(db, id, agentCase.trim(), options.lab, now), options);
  if (!answer.ok) {
    return { text: `Decision not made (${answer.finishReason}): ${answer.content.slice(0, 200)}. The idea is unchanged; ask again later.`, costCents: answer.costCents };
  }
  const verdict = parseDecision(answer.content, ["APPROVE", "REJECT", "NOT YET"]);
  if (!verdict) {
    return { text: `${answer.content}\n[decision: ${answer.model}, ${answer.costCents}c] No decision line: nothing applied, ask again.`, costCents: answer.costCents };
  }
  recordDecision(db, { at: now.toISOString(), kind: "approve_idea", target: id, verdict, model: answer.model, costCents: answer.costCents, text: answer.content.slice(0, 4000) });
  const trailer = `\n[decision: ${answer.model}, ${answer.costCents}c, binding]`;
  if (verdict === "APPROVE") {
    const applied = decideIdea(db, id, "approve", `Opus APPROVE (${now.toISOString().slice(0, 10)}): ${agentCase.trim()}`, now);
    return { text: `${answer.content}${trailer}\n${applied}`, costCents: answer.costCents };
  }
  if (verdict === "REJECT") {
    decideIdea(db, id, "reject", `Opus REJECT (${now.toISOString().slice(0, 10)}): ${answer.content.split("\n").slice(1, 4).join(" ").slice(0, 300)}`, now);
    return {
      text: `${answer.content}${trailer}\nIdea "${id}" rejected by Opus. If the critique shows a sharper angle, record it as a new idea.`,
      costCents: answer.costCents,
    };
  }
  return {
    text: `${answer.content}${trailer}\nNot yet: get the missing evidence, update the idea, then ask again (decide approve). ` +
      `${MAX_IDEA_DECISIONS - previous.length - 1} decision(s) left for this idea.`,
    costCents: answer.costCents,
  };
}

// ─── Stopping an experiment ─────────────────────────────────────

export const ACTIVE_EXPERIMENT_STATUSES = new Set(["building", "observing", "waiting_for_owner"]);

/** True when this status change takes an active experiment out of the portfolio. */
export function isStop(existing: Pick<Experiment, "status"> | undefined, nextStatus: string): boolean {
  return !!existing && ACTIVE_EXPERIMENT_STATUSES.has(existing.status) && !ACTIVE_EXPERIMENT_STATUSES.has(nextStatus);
}

function experimentDossier(db: Database.Database, e: Experiment, proposal: { status: string; reason: string }, lab: MoneyLabConfig | undefined, now: Date): string {
  const ideaId = typeof e.metrics.idea_id === "string" ? e.metrics.idea_id : null;
  const idea = ideaId ? getIdea(db, ideaId) : undefined;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(e.createdAt)) / 86_400_000);
  const previous = listDecisions(db).filter((d) => d.kind === "stop_experiment" && d.target === e.id)
    .map((d) => `${d.at.slice(0, 10)} ${d.verdict}: ${d.text.slice(0, 400)}`);
  return [
    `Today: ${now.toISOString().slice(0, 10)}.`,
    `Experiment ${e.id}, ${e.status}, started ${e.createdAt.slice(0, 10)} (${ageDays.toFixed(0)} days ago), last update ${e.updatedAt.slice(0, 10)}.`,
    `Hypothesis: ${e.hypothesis}`,
    `Artifact: ${e.artifactRef ?? "none"} | revenue model: ${e.revenueModel ?? "none"} | channel: ${e.acquisitionChannel ?? "none"}`,
    `Review date: ${e.reviewDate ?? "none"} | cost so far: ${e.consumedCostCents === null ? "unknown" : `$${(e.consumedCostCents / 100).toFixed(2)}`}`,
    `Metrics: ${JSON.stringify(e.metrics).slice(0, 1500)}`,
    `Evidence (latest):\n${e.evidence.slice(-10).map((x) => `- ${x}`).join("\n") || "- none"}`,
    idea ? `Original idea: ${idea.title}, ${idea.total ?? "?"}/100; kill criteria: ${idea.killCriteria || "none"}` : "",
    previous.length ? `Your previous decisions on it:\n${previous.join("\n")}` : "",
    `The agent proposes: status ${proposal.status}. Reason: ${proposal.reason}`,
    runway(db, lab, now),
  ].filter(Boolean).join("\n");
}

/** Why the agent may not ask for a stop decision now, or null. */
export function stopDecisionBlocker(db: Database.Database, experimentId: string, now = new Date()): string | null {
  const last = listDecisions(db).filter((d) => d.kind === "stop_experiment" && d.target === experimentId).at(-1);
  if (last?.verdict === "CONTINUE" && now.getTime() - Date.parse(last.at) < CONTINUE_HOLD_MS) {
    const next = new Date(Date.parse(last.at) + CONTINUE_HOLD_MS).toISOString().slice(0, 16).replace("T", " ");
    return `Opus decided on ${last.at.slice(0, 16).replace("T", " ")} UTC to continue this experiment; ` +
      `apply its advice and ask again after ${next} UTC.`;
  }
  return null;
}

export async function decideStopWithOpus(
  db: Database.Database,
  experiment: Experiment,
  proposal: { status: string; reason: string },
  options: DecisionOptions,
): Promise<{ verdict: "STOP" | "CONTINUE" | null; text: string; costCents: number }> {
  const now = options.now ?? new Date();
  const answer = await askOpus(STOP_RULES, experimentDossier(db, experiment, proposal, options.lab, now), options);
  if (!answer.ok) {
    return { verdict: null, text: `Decision not made (${answer.finishReason}): ${answer.content.slice(0, 200)}.`, costCents: answer.costCents };
  }
  const verdict = parseDecision(answer.content, ["STOP", "CONTINUE"]) as "STOP" | "CONTINUE" | null;
  if (!verdict) return { verdict: null, text: `${answer.content}\nNo decision line.`, costCents: answer.costCents };
  recordDecision(db, {
    at: now.toISOString(), kind: "stop_experiment", target: experiment.id, verdict,
    model: answer.model, costCents: answer.costCents, text: answer.content.slice(0, 4000),
  });
  return { verdict, text: `${answer.content}\n[decision: ${answer.model}, ${answer.costCents}c, binding]`, costCents: answer.costCents };
}

/** Recent decisions, for the health report and the prompt. */
export function recentDecisions(db: Database.Database, sinceMs: number): Decision[] {
  return listDecisions(db).filter((d) => Date.parse(d.at) >= sinceMs);
}
