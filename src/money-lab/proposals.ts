/**
 * Money Lab proposals: the bot's job since the owner meeting of 2026-10-08
 *
 * The bot finds frustrations and frictions, turns the best into testable,
 * profitable ideas and proposes them; the owner chooses on Telegram. Each
 * proposal is a full dossier (the frustration with dated evidence, the
 * competition and our angle, why this one rather than the others, who pays
 * and how much, precise acquisition channels, prospects, the smallest test
 * with its threshold, what would kill it). The runtime checks completeness,
 * then Opus reviews it like an editor: ACCEPT sends it to the owner as a
 * numbered card, REWORK sends it back with the fixes, DROP closes it.
 *
 * Every idea set aside keeps its reason in a memory the bot must consult: a
 * proposal close to a rejected one must say what changed. Three accepted
 * proposals a week are expected; a week below that pauses the bot (it dies
 * unless the owner revives it), and so do 48 hours of spending without any
 * progress. Nothing is published without a chosen proposal, a passing
 * browser test, an Opus design review and the owner's /go.
 */

import type Database from "better-sqlite3";
import type { DelegateRouter } from "./delegate.js";
import type { MoneyLabConfig } from "./profile.js";
import {
  getKV, getPauseState, listExperiments, pause, PROGRESS_KEY, queueOwnerNotification, setKV, upsertExperiment,
  type Experiment,
} from "./journal.js";
import { approveIdeaForProposal } from "./ideas.js";
import { REVIEW_MODEL } from "./review.js";
import { survivalBalance } from "./selfhosted.js";
import { inferenceGetDailyCost } from "../state/database.js";

const PROPOSALS_KEY = "money_lab.proposals";
const REVIEWS_KEY = "money_lab.proposal_reviews";
const MEMORY_KEY = "money_lab.memory";
const PLAN_KEY = "money_lab.week_plan";
const WINDOW_KEY = "money_lab.quota_window";
const CHECKS_KEY = "money_lab.publish_checks";
const FRICTIONS_DAY_KEY = "money_lab.frictions_day";

export const WEEKLY_QUOTA = 3;
export const WEEK_MS = 7 * 86_400_000;
export const OWNER_DECISION_MS = 48 * 3_600_000;
export const STALL_MS = 48 * 3_600_000;
/** Opus reviews per UTC day (each a few cents) and per proposal slug. */
export const MAX_REVIEWS_PER_DAY = 6;
export const MAX_REVIEWS_PER_SLUG = 3;
const MAX_PLANS_PER_WEEK = 2;
const CHECK_VALID_MS = 48 * 3_600_000;
/** Spending below this over two days is idling, not looping. */
const STALL_MIN_SPEND_CENTS = 30;

export type ProposalStatus = "pending" | "chosen" | "publish_pending" | "live" | "rejected" | "stopped";

export interface Proposal {
  n: number;
  slug: string;
  title: string;
  status: ProposalStatus;
  frustration: string;
  audience: string;
  evidence: string[];
  competitors: string[];
  angle: string;
  whyThis: string;
  revenue: string;
  acquisition: string[];
  prospects: string;
  test: string;
  killers: string;
  whatChanged?: string;
  opusNote: string;
  createdAt: string;
  deliveredAt: string;
  updatedAt: string;
  decidedBy?: "owner" | "opus";
  decision?: string;
  decidedAt?: string;
  experimentId?: string;
  publication?: { name: string; previewUrl: string; requestedAt: string; checks: string; feedback?: string; approvedAt?: string };
}

export interface Review {
  at: string;
  slug: string;
  title: string;
  verdict: "ACCEPT" | "REWORK" | "DROP";
  note: string;
  fixes: string;
  costCents: number;
}

export interface MemoryEntry {
  at: string;
  title: string;
  slug?: string;
  reason: string;
  by: "owner" | "opus" | "bot" | "test";
  words: string[];
}

export interface WeekPlan {
  windowStart: string;
  at: string;
  themes: string[];
  why: string;
  opus: string;
  count: number;
}

// ─── Storage ────────────────────────────────────────────────────

function readJson<T>(db: Database.Database, key: string, fallback: T): T {
  try {
    const raw = getKV(db, key);
    return raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function loadStore(db: Database.Database): { seq: number; items: Proposal[] } {
  const store = readJson(db, PROPOSALS_KEY, { seq: 0, items: [] as Proposal[] });
  return { seq: Number(store.seq) || 0, items: Array.isArray(store.items) ? store.items : [] };
}

function saveStore(db: Database.Database, store: { seq: number; items: Proposal[] }): void {
  setKV(db, PROPOSALS_KEY, JSON.stringify({ seq: store.seq, items: store.items.slice(-200) }));
}

export function listProposals(db: Database.Database): Proposal[] {
  return loadStore(db).items;
}

export function getProposal(db: Database.Database, n: number): Proposal | undefined {
  return listProposals(db).find((p) => p.n === n);
}

function updateProposal(db: Database.Database, n: number, patch: (p: Proposal) => void, now: Date): Proposal | undefined {
  const store = loadStore(db);
  const p = store.items.find((x) => x.n === n);
  if (!p) return undefined;
  patch(p);
  p.updatedAt = now.toISOString();
  saveStore(db, store);
  return p;
}

export function listReviews(db: Database.Database): Review[] {
  const all = readJson<Review[]>(db, REVIEWS_KEY, []);
  return Array.isArray(all) ? all : [];
}

function recordReview(db: Database.Database, review: Review): void {
  setKV(db, REVIEWS_KEY, JSON.stringify([...listReviews(db), review].slice(-300)));
}

export function listMemory(db: Database.Database): MemoryEntry[] {
  const all = readJson<MemoryEntry[]>(db, MEMORY_KEY, []);
  return Array.isArray(all) ? all : [];
}

const STOP_WORDS = new Set(("the and for with that this from your their they them have what when where which while about into over " +
  "than then there these those would could should will just more most some such only also very much many each other " +
  "pour avec dans sans sont nous vous leur leurs elle elles mais plus tout tous toute toutes comme cette cela entre " +
  "aussi être avoir fait faire quand dont chez sous ainsi alors très bien peut doit leur notre votre outil outils tool tools " +
  "people gens personnes idée idea free gratuit gratuite online ligne").split(" "));

/** Content words (4+ letters, accents folded) used to compare ideas. */
export function contentWords(text: string): string[] {
  const folded = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return [...new Set(folded.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w)))];
}

export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter((w) => setB.has(w)).length;
  return inter / (new Set([...a, ...b]).size);
}

/** Every idea set aside goes here with its reason and who decided. */
export function addMemory(db: Database.Database, entry: Omit<MemoryEntry, "at" | "words"> & { text?: string }, now = new Date()): void {
  const words = contentWords(`${entry.title} ${entry.text ?? ""}`).slice(0, 60);
  const item: MemoryEntry = { at: now.toISOString(), title: entry.title.slice(0, 160), slug: entry.slug, reason: entry.reason.trim().slice(0, 400) || "no reason given", by: entry.by, words };
  setKV(db, MEMORY_KEY, JSON.stringify([...listMemory(db), item].slice(-300)));
}

export function markProgress(db: Database.Database, now = new Date()): void {
  setKV(db, PROGRESS_KEY, now.toISOString());
}

// ─── The week ───────────────────────────────────────────────────

/** The current 7-day window (it starts the first time the runtime runs this code). */
export function weekWindow(db: Database.Database, now = new Date()): { start: Date; end: Date } {
  let raw = getKV(db, WINDOW_KEY);
  if (!raw || Number.isNaN(Date.parse(raw))) {
    raw = now.toISOString();
    setKV(db, WINDOW_KEY, raw);
  }
  const start = new Date(raw);
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

export function acceptedThisWeek(db: Database.Database, now = new Date()): Proposal[] {
  const { start, end } = weekWindow(db, now);
  return listProposals(db).filter((p) => {
    const t = Date.parse(p.deliveredAt);
    return t >= start.getTime() && t < end.getTime();
  });
}

export function quotaMet(db: Database.Database, now = new Date()): boolean {
  return acceptedThisWeek(db, now).length >= WEEKLY_QUOTA;
}

export function currentPlan(db: Database.Database, now = new Date()): WeekPlan | null {
  const plan = readJson<WeekPlan | null>(db, PLAN_KEY, null);
  if (!plan) return null;
  return plan.windowStart === weekWindow(db, now).start.toISOString() ? plan : null;
}

// ─── Opus ───────────────────────────────────────────────────────

export interface OpusOptions {
  router: DelegateRouter;
  chat: (messages: any[], options: any) => Promise<any>;
  sessionId: string;
  lab?: MoneyLabConfig;
}

export type Ask = (system: string, user: string, maxTokens: number) => Promise<{ ok: boolean; content: string; model: string; costCents: number }>;

export function opusAsker(options: OpusOptions): Ask {
  return async (system, user, maxTokens) => {
    const result = await options.router.route({
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      taskType: "planning", tier: "normal", sessionId: options.sessionId, maxTokens, model: REVIEW_MODEL,
    }, options.chat);
    const ok = ["stop", "length", "end_turn"].includes(result.finishReason) && !!result.content.trim();
    return { ok, content: result.content.trim(), model: result.model, costCents: result.costCents };
  };
}

const EDITOR = `You review the work of an autonomous AI agent whose job is to find profitable ideas that can be tested
cheaply: real frustrations people have, a small product or service that relieves them, and a way to reach
those people without ads, spam or cold contact. Its owner reads only what you accept, on a phone, and
chooses what gets tested. Be demanding and concrete: you protect the owner's time and money.`;

const REVIEW_RULES = `Review the proposal below. ACCEPT only if all of this holds:
- the frustration is real and specific, backed by at least three dated sources that show people living it (not
  articles about a market), and the audience is precise;
- the competition was really looked at, and the angle is a reason someone would switch, not a slogan;
- it is better than the other options the agent considered (why_this compares them with facts);
- someone plausibly pays: who, how much, by which model, and the monthly estimate is reasoned, not wished;
- the acquisition channels are precise places where these people already are (a named community, a search
  query with its volume, a directory), reachable without ads or prospecting, with a first message;
- prospects are communities or profile types, never named private people;
- the test is small (a few days of work), has a numeric threshold and a deadline, and the killers are numeric;
- it is not a variant of an idea already set aside (memory below) unless what_changed answers that reason.
REWORK when it can become acceptable with more work: list the precise fixes. DROP when it cannot: say why.

Answer in this exact structure, nothing else:
Decision: ACCEPT | REWORK | DROP
Owner note: (one sentence in French for the owner: why this deserves a test, or why not)
Fixes: (bullets, only for REWORK)
Reason: (one or two sentences, only for DROP)`;

const PLAN_RULES = `The agent sends its exploration plan for the week: the themes where it will look for frustrations
and why. Judge whether the themes are likely to yield testable, profitable ideas it can reach without ads,
and whether they avoid what the memory already rules out. Suggest at most two changes.

Answer in this exact structure:
Decision: APPROVE | ADJUST
Plan: (the final 3-6 themes, one per line, each with the first place to look)
Advice: (one or two sentences)`;

const DECIDE_RULES = `The owner did not answer this proposal within 48 hours. Decide in their place whether it gets tested now.
TEST: the agent starts the smallest test described. DROP: it is set aside with your reason.

Answer in this exact structure:
Decision: TEST | DROP
Reason: (one or two sentences in French, for the owner)`;

function verdictOf<T extends string>(text: string, allowed: T[]): T | null {
  const m = /Decision\**\s*:\s*\**\s*([A-Z]+)/i.exec(text);
  const v = m ? (m[1].toUpperCase() as T) : null;
  return v && allowed.includes(v) ? v : null;
}

function field(text: string, name: string): string {
  const m = new RegExp(`${name}\\**\\s*:\\s*\\**\\s*([\\s\\S]*?)(?=\\n\\s*(?:Decision|Owner note|Fixes|Reason|Plan|Advice)\\**\\s*:|$)`, "i").exec(text);
  return m ? m[1].trim() : "";
}

function memoryDigest(db: Database.Database, limit = 12): string {
  const memory = listMemory(db).slice(-limit);
  return memory.length
    ? memory.map((m) => `- ${m.title} (${m.by}, ${m.at.slice(0, 10)}): ${m.reason}`).join("\n")
    : "- nothing set aside yet";
}

// ─── Week plan ──────────────────────────────────────────────────

export async function submitPlan(
  db: Database.Database,
  input: { themes?: unknown; why?: unknown },
  ask: Ask,
  now = new Date(),
): Promise<{ text: string; costCents: number }> {
  const themes = (Array.isArray(input.themes) ? input.themes : String(input.themes ?? "").split(/\n|;/))
    .map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
  const why = String(input.why ?? "").trim();
  if (themes.length < 3) return { text: "plan needs 3 to 6 themes (where you will look for frustrations this week).", costCents: 0 };
  if (why.length < 40) return { text: "why: say in a few sentences why these themes can yield profitable, testable ideas.", costCents: 0 };
  const windowStart = weekWindow(db, now).start.toISOString();
  const previous = readJson<WeekPlan | null>(db, PLAN_KEY, null);
  const count = previous?.windowStart === windowStart ? previous.count : 0;
  if (count >= MAX_PLANS_PER_WEEK) return { text: `The week plan was already reviewed ${count} times: work with it.`, costCents: 0 };
  const answer = await ask(`${EDITOR}\n\n${PLAN_RULES}`,
    `Themes:\n${themes.map((t) => `- ${t}`).join("\n")}\nWhy: ${why}\n\nIdeas already set aside (do not repeat them):\n${memoryDigest(db)}`, 600);
  if (!answer.ok) return { text: `Plan not reviewed (${answer.content.slice(0, 120)}); try again later.`, costCents: answer.costCents };
  const plan: WeekPlan = { windowStart, at: now.toISOString(), themes, why, opus: answer.content.slice(0, 2000), count: count + 1 };
  setKV(db, PLAN_KEY, JSON.stringify(plan));
  markProgress(db, now);
  return { text: `${answer.content}\n[plan saved for the week; Opus ${answer.costCents}c]`, costCents: answer.costCents };
}

// ─── Proposals ──────────────────────────────────────────────────

export interface ProposalInput {
  slug?: unknown; title?: unknown; frustration?: unknown; audience?: unknown; evidence?: unknown; competitors?: unknown;
  angle?: unknown; why_this?: unknown; revenue?: unknown; acquisition?: unknown; prospects?: unknown; test?: unknown;
  killers?: unknown; what_changed?: unknown;
}

function str(v: unknown, max = 1500): string {
  return String(v ?? "").trim().slice(0, max);
}

function strList(v: unknown, max = 8): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [];
  return items.map((x) => String(x).replace(/^\s*[-*•]\s*/, "").trim().slice(0, 600)).filter(Boolean).slice(0, max);
}

/** Every missing or thin part of a dossier, all at once. */
export function dossierProblems(p: ReturnType<typeof normalize>): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(p.slug)) problems.push("slug: 3-40 lowercase letters, digits or dashes");
  if (p.title.length < 8) problems.push("title: a clear name for the idea");
  if (p.frustration.length < 80) problems.push("frustration: who suffers, what exactly goes wrong, how often (80+ characters)");
  if (p.audience.length < 20) problems.push("audience: the precise people (profession, situation, country)");
  const sourced = p.evidence.filter((e) => /https?:\/\//.test(e) && /\b20\d\d\b/.test(e));
  if (sourced.length < 3) problems.push(`evidence: at least 3 sources, each with its URL and date (year at least) and what it shows (have ${sourced.length})`);
  if (p.competitors.filter((c) => c.length >= 15).length < 2) problems.push("competitors: at least 2, each with its weakness");
  if (p.angle.length < 40) problems.push("angle: why people would choose ours over the competitors");
  if (p.whyThis.length < 80) problems.push("why_this: compare with the other options you considered this week (facts, numbers)");
  if (p.revenue.length < 60 || !/\d/.test(p.revenue)) problems.push("revenue: who pays, the price, the model and a reasoned monthly estimate (with numbers)");
  if (p.acquisition.filter((a) => a.length >= 25).length < 2) problems.push("acquisition: at least 2 precise channels (named community, search with volume, directory) with the first message");
  if (p.prospects.length < 40) problems.push("prospects: the communities and profile types to reach (never named private people)");
  if (p.test.length < 40 || !/\d/.test(p.test)) problems.push("test: the smallest test, its numeric success threshold and its deadline");
  if (p.killers.length < 30 || !/\d/.test(p.killers)) problems.push("killers: the numbers that would kill the idea");
  return problems;
}

function normalize(input: ProposalInput) {
  return {
    slug: str(input.slug, 40).toLowerCase(),
    title: str(input.title, 120),
    frustration: str(input.frustration),
    audience: str(input.audience, 600),
    evidence: strList(input.evidence),
    competitors: strList(input.competitors),
    angle: str(input.angle, 800),
    whyThis: str(input.why_this),
    revenue: str(input.revenue, 900),
    acquisition: strList(input.acquisition, 5),
    prospects: str(input.prospects, 900),
    test: str(input.test, 900),
    killers: str(input.killers, 600),
    whatChanged: str(input.what_changed, 800),
  };
}

function dossierText(p: ReturnType<typeof normalize>): string {
  return [
    `Title: ${p.title} (${p.slug})`,
    `Frustration: ${p.frustration}`,
    `Audience: ${p.audience}`,
    `Evidence:\n${p.evidence.map((e) => `- ${e}`).join("\n")}`,
    `Competitors:\n${p.competitors.map((e) => `- ${e}`).join("\n")}`,
    `Angle: ${p.angle}`,
    `Why this one rather than the others: ${p.whyThis}`,
    `Revenue: ${p.revenue}`,
    `Acquisition:\n${p.acquisition.map((e) => `- ${e}`).join("\n")}`,
    `Prospects: ${p.prospects}`,
    `Smallest test: ${p.test}`,
    `Killers: ${p.killers}`,
    p.whatChanged ? `What changed since a similar idea was set aside: ${p.whatChanged}` : "",
  ].filter(Boolean).join("\n");
}

function reviewsToday(db: Database.Database, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return listReviews(db).filter((r) => r.at.slice(0, 10) === day).length;
}

const ACTIVE: ProposalStatus[] = ["pending", "chosen", "publish_pending", "live"];

/**
 * The bot submits a dossier: completeness, memory and duplicate checks, then
 * the Opus review. ACCEPT numbers it and sends it to the owner.
 */
export async function submitProposal(
  db: Database.Database,
  input: ProposalInput,
  ask: Ask,
  now = new Date(),
): Promise<{ text: string; costCents: number; proposal?: Proposal }> {
  if (!currentPlan(db, now)) return { text: "First send this week's exploration plan (proposal action plan): Opus checks it once a week.", costCents: 0 };
  const p = normalize(input);
  const problems = dossierProblems(p);
  if (problems.length) return { text: `Dossier incomplete; fix all of this, then submit again:\n- ${problems.join("\n- ")}`, costCents: 0 };
  const words = contentWords(`${p.title} ${p.frustration} ${p.audience}`);
  // Memory: a close idea already set aside must say what changed.
  const close = listMemory(db).map((m) => ({ m, s: similarity(words, m.words) })).filter((x) => x.s >= 0.3).sort((a, b) => b.s - a.s)[0];
  if (close && p.whatChanged.length < 60) {
    return {
      text: `This looks like "${close.m.title}", set aside on ${close.m.at.slice(0, 10)} by ${close.m.by}: ${close.m.reason}\n` +
        "Either drop it, or explain in what_changed (60+ characters, with facts) why that reason no longer holds.",
      costCents: 0,
    };
  }
  const store = loadStore(db);
  const duplicate = store.items.filter((x) => ACTIVE.includes(x.status))
    .find((x) => x.slug === p.slug || similarity(words, contentWords(`${x.title} ${x.frustration} ${x.audience}`)) >= 0.5);
  if (duplicate) return { text: `Already proposed as #${duplicate.n} "${duplicate.title}" (${duplicate.status}). Propose something else.`, costCents: 0 };
  const slugReviews = listReviews(db).filter((r) => r.slug === p.slug).length;
  if (slugReviews >= MAX_REVIEWS_PER_SLUG) return { text: `"${p.slug}" was reviewed ${slugReviews} times: move on to another idea.`, costCents: 0 };
  if (reviewsToday(db, now) >= MAX_REVIEWS_PER_DAY) return { text: `At most ${MAX_REVIEWS_PER_DAY} Opus reviews a day: polish your next dossiers and submit them tomorrow.`, costCents: 0 };

  const others = store.items.filter((x) => ACTIVE.includes(x.status)).slice(-6).map((x) => `- #${x.n} ${x.title} [${x.status}]`);
  const answer = await ask(`${EDITOR}\n\n${REVIEW_RULES}`,
    `Today: ${now.toISOString().slice(0, 10)}.\n\n${dossierText(p)}\n\nOther live proposals:\n${others.join("\n") || "- none"}\n\n` +
    `Ideas already set aside (memory):\n${memoryDigest(db)}`, 900);
  markProgress(db, now);
  if (!answer.ok) return { text: `Review not done (${answer.content.slice(0, 160)}); nothing recorded, submit again later.`, costCents: answer.costCents };
  const verdict = verdictOf(answer.content, ["ACCEPT", "REWORK", "DROP"] as const);
  if (!verdict) return { text: `${answer.content}\nNo decision line: nothing recorded, submit again.`, costCents: answer.costCents };
  const note = field(answer.content, "Owner note").split("\n")[0].slice(0, 400);
  recordReview(db, { at: now.toISOString(), slug: p.slug, title: p.title, verdict, note, fixes: verdict === "REWORK" ? field(answer.content, "Fixes").slice(0, 1500) : field(answer.content, "Reason").slice(0, 600), costCents: answer.costCents });
  if (verdict === "REWORK") {
    return { text: `Opus: REWORK. ${answer.content}\n[${answer.costCents}c] Fix every point, then submit the same slug again (${MAX_REVIEWS_PER_SLUG - slugReviews - 1} review(s) left for it).`, costCents: answer.costCents };
  }
  if (verdict === "DROP") {
    addMemory(db, { title: p.title, slug: p.slug, reason: `Opus: ${field(answer.content, "Reason") || note}`, by: "opus", text: `${p.frustration} ${p.audience}` }, now);
    return { text: `Opus: DROP. ${answer.content}\n[${answer.costCents}c] Set aside and kept in memory with this reason.`, costCents: answer.costCents };
  }
  store.seq += 1;
  const proposal: Proposal = {
    n: store.seq, slug: p.slug, title: p.title, status: "pending", frustration: p.frustration, audience: p.audience,
    evidence: p.evidence, competitors: p.competitors, angle: p.angle, whyThis: p.whyThis, revenue: p.revenue,
    acquisition: p.acquisition, prospects: p.prospects, test: p.test, killers: p.killers,
    whatChanged: p.whatChanged || undefined, opusNote: note, createdAt: now.toISOString(), deliveredAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  store.items.push(proposal);
  saveStore(db, store);
  queueOwnerNotification(db, formatCard(proposal));
  const week = acceptedThisWeek(db, now).length;
  return {
    text: `Opus: ACCEPT. Proposal #${proposal.n} sent to the owner (${week}/${WEEKLY_QUOTA} this week). Do not build anything for it ` +
      `until the owner answers /go (or Opus decides after 48 h with proposal action decide). Keep exploring.\n[${answer.costCents}c]`,
    costCents: answer.costCents, proposal,
  };
}

/** After 48 h without the owner's answer, Opus decides in their place. */
export async function decideForOwner(db: Database.Database, n: number, ask: Ask, now = new Date()): Promise<{ text: string; costCents: number }> {
  const p = getProposal(db, n);
  if (!p) return { text: `No proposal #${n}.`, costCents: 0 };
  if (p.status !== "pending") return { text: `Proposal #${n} is ${p.status}.`, costCents: 0 };
  const left = Date.parse(p.deliveredAt) + OWNER_DECISION_MS - now.getTime();
  if (left > 0) return { text: `The owner has ${Math.ceil(left / 3_600_000)} more hour(s) to answer #${n}; keep exploring meanwhile.`, costCents: 0 };
  const answer = await ask(`${EDITOR}\n\n${DECIDE_RULES}`, `${proposalDossier(p)}\n\nIdeas already set aside:\n${memoryDigest(db)}`, 400);
  if (!answer.ok) return { text: "Decision not made; ask again later.", costCents: answer.costCents };
  const verdict = verdictOf(answer.content, ["TEST", "DROP"] as const);
  if (!verdict) return { text: `${answer.content}\nNo decision line: ask again.`, costCents: answer.costCents };
  const reason = field(answer.content, "Reason").slice(0, 400);
  markProgress(db, now);
  if (verdict === "TEST") {
    choose(db, p, "opus", reason, now);
    queueOwnerNotification(db, `⏱️ Pas de réponse depuis 48 h sur #${n} « ${p.title} » : Opus a décidé de la tester. ${reason}\n/stop pour l'arrêter si tu n'es pas d'accord (/tests).`);
    return { text: `Opus: TEST. Proposal #${n} is chosen: build its smallest test now (record_experiment with idea_id "${p.slug}", status building).\n[${answer.costCents}c]`, costCents: answer.costCents };
  }
  reject(db, p, "opus", reason, now);
  queueOwnerNotification(db, `⏱️ Pas de réponse depuis 48 h sur #${n} « ${p.title} » : Opus l'a écartée. ${reason}`);
  return { text: `Opus: DROP. Proposal #${n} set aside and kept in memory.\n[${answer.costCents}c]`, costCents: answer.costCents };
}

function choose(db: Database.Database, p: Proposal, by: "owner" | "opus", note: string, now: Date): void {
  updateProposal(db, p.n, (x) => { x.status = "chosen"; x.decidedBy = by; x.decision = note; x.decidedAt = now.toISOString(); }, now);
  approveIdeaForProposal(db, {
    slug: p.slug, title: p.title, problem: p.frustration, audience: p.audience, revenue: p.revenue,
    channels: p.acquisition.join(" | "), evidence: p.evidence, competitors: p.competitors, killCriteria: p.killers,
    solution: `${p.angle} — test: ${p.test}`,
  }, `${by === "owner" ? "Owner" : "Opus"} chose proposal #${p.n}${note ? `: ${note}` : ""}`, now);
}

function reject(db: Database.Database, p: Proposal, by: "owner" | "opus", reason: string, now: Date): void {
  updateProposal(db, p.n, (x) => { x.status = "rejected"; x.decidedBy = by; x.decision = reason; x.decidedAt = now.toISOString(); }, now);
  addMemory(db, { title: p.title, slug: p.slug, reason: reason || "écartée sans raison", by, text: `${p.frustration} ${p.audience}` }, now);
}

function wake(db: Database.Database, reason: string): void {
  db.prepare("INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', ?, '{}')").run(reason);
}

// ─── Owner actions (Telegram, French) ───────────────────────────

export function ownerGo(db: Database.Database, n: number, now = new Date()): string {
  const p = getProposal(db, n);
  if (!p) return `Proposition #${n} introuvable (/idees).`;
  if (p.status === "pending") {
    choose(db, p, "owner", "", now);
    wake(db, `Proposition #${n} choisie par le propriétaire : construis son plus petit test (record_experiment idea_id "${p.slug}", statut building).`);
    return `✅ #${n} « ${p.title} » choisie. Le bot prépare le test ; il te demandera ton accord avant toute mise en ligne.`;
  }
  if (p.status === "publish_pending" && p.publication) {
    updateProposal(db, n, (x) => { x.status = "live"; x.publication!.approvedAt = now.toISOString(); }, now);
    wake(db, `Publication #${n} approuvée par le propriétaire : publie « ${p.publication.name} » maintenant.`);
    return `🌐 Publication de #${n} approuvée sous le nom « ${p.publication.name} ». Le bot la met en ligne.`;
  }
  return `#${n} est ${statusFr(p.status)} : rien à valider.`;
}

export function ownerNo(db: Database.Database, n: number, reason: string, now = new Date()): string {
  const p = getProposal(db, n);
  if (!p) return `Proposition #${n} introuvable (/idees).`;
  const why = reason.trim();
  if (p.status === "pending") {
    reject(db, p, "owner", why, now);
    wake(db, `Proposition #${n} écartée par le propriétaire : ${why || "sans raison"}.`);
    return `🗑️ #${n} écartée${why ? ` (${why})` : ""}. Le bot la garde en mémoire et ne la reproposera pas sans raison nouvelle.`;
  }
  if (p.status === "publish_pending") {
    updateProposal(db, n, (x) => { x.status = "chosen"; if (x.publication) x.publication.feedback = why || "refusée sans raison"; }, now);
    wake(db, `Publication #${n} refusée par le propriétaire : ${why || "sans raison"}. Corrige puis redemande.`);
    return `↩️ Publication de #${n} refusée${why ? ` (${why})` : ""}. Le bot corrige et redemandera.`;
  }
  return `#${n} est ${statusFr(p.status)} : pour arrêter un test, /tests puis /stop.`;
}

export interface Stoppable {
  label: string;
  experiment?: Experiment;
  proposal?: Proposal;
}

const ACTIVE_EXPERIMENT = new Set(["building", "observing", "waiting_for_owner"]);

/** Tests the owner can stop, numbered in this order (/tests, /stop n). */
export function listStoppable(db: Database.Database): Stoppable[] {
  const proposals = listProposals(db);
  const out: Stoppable[] = [];
  for (const e of listExperiments(db).filter((x) => ACTIVE_EXPERIMENT.has(x.status))) {
    const p = proposals.find((x) => x.experimentId === e.id);
    out.push({ label: p ? `#${p.n} ${p.title}` : e.hypothesis.slice(0, 90), experiment: e, proposal: p });
  }
  for (const p of proposals.filter((x) => (x.status === "chosen" || x.status === "publish_pending" || x.status === "live") && !out.some((o) => o.proposal?.n === x.n))) {
    out.push({ label: `#${p.n} ${p.title} (pas encore construit)`, proposal: p });
  }
  return out;
}

export function describeTestsFr(db: Database.Database): string {
  const items = listStoppable(db);
  if (!items.length) return "Aucun test en cours.";
  return ["Tests en cours :", ...items.map((t, i) => {
    const e = t.experiment;
    const visits = e ? Number((e.metrics as any).visits_total ?? (e.metrics as any).visits ?? NaN) : NaN;
    return `${i + 1}. ${t.label}${e ? ` — ${statusFr(e.status as any)}${Number.isFinite(visits) ? `, ${visits} visites` : ""}` : ""}`;
  }), "Pour arrêter : /stop <numéro> <raison>"].join("\n");
}

export function ownerStop(db: Database.Database, index: number, reason: string, now = new Date()): string {
  const items = listStoppable(db);
  const item = items[index - 1];
  if (!item) return items.length ? `Pas de test n°${index}.\n${describeTestsFr(db)}` : "Aucun test en cours.";
  const why = reason.trim() || "arrêté par le propriétaire";
  const title = item.proposal?.title ?? item.experiment!.hypothesis.slice(0, 160);
  if (item.experiment) {
    upsertExperiment(db, { id: item.experiment.id, status: "finished", result: `Arrêté par le propriétaire le ${now.toISOString().slice(0, 10)} : ${why}` });
  }
  if (item.proposal) updateProposal(db, item.proposal.n, (x) => { x.status = "stopped"; x.decision = why; x.decidedAt = now.toISOString(); }, now);
  addMemory(db, { title, slug: item.proposal?.slug, reason: `Test arrêté par le propriétaire : ${why}`, by: "owner", text: item.proposal?.frustration ?? item.experiment?.hypothesis }, now);
  wake(db, `Test « ${title.slice(0, 80)} » arrêté par le propriétaire : ${why}. Ne le reprends pas ; retiens la raison.`);
  return `⏹️ Test arrêté : ${item.proposal ? `#${item.proposal.n} ` : ""}${title.slice(0, 100)}. Raison gardée en mémoire : ${why}.`;
}

// ─── Publication gate ───────────────────────────────────────────

const BAD_NAME = /money[-_ ]?lab|moneylab|moneybot|money[-_ ]?bot|(^|[-_])bot($|[-_])|(^|[-_])test($|[-_])|demo/i;

export function nameProblem(name: string): string | null {
  return BAD_NAME.test(name)
    ? `"${name}" is not a neutral name: no "money lab", "bot", "test" or "demo" in what visitors see. Pick a name about what it does for them.`
    : null;
}

/** One spelling per URL: "http://localhost:8080" and ".../" are the same preview. */
export function normalizeUrl(url: string): string {
  try {
    return new URL(url.trim()).toString();
  } catch {
    return url.trim();
  }
}

export function recordTestCheck(db: Database.Database, rawUrl: string, verdict: string, now = new Date()): void {
  const url = normalizeUrl(rawUrl);
  const checks = readJson<Record<string, any>>(db, CHECKS_KEY, {});
  checks[url] = { ...(checks[url] ?? {}), testAt: now.toISOString(), testVerdict: verdict };
  setKV(db, CHECKS_KEY, JSON.stringify(Object.fromEntries(Object.entries(checks).slice(-40))));
}

export function recordReviewCheck(db: Database.Database, rawUrl: string, note: string, now = new Date()): void {
  const url = normalizeUrl(rawUrl);
  const checks = readJson<Record<string, any>>(db, CHECKS_KEY, {});
  checks[url] = { ...(checks[url] ?? {}), reviewAt: now.toISOString(), reviewNote: note.slice(0, 600) };
  setKV(db, CHECKS_KEY, JSON.stringify(Object.fromEntries(Object.entries(checks).slice(-40))));
}

/** The bot asks to publish a chosen proposal; the owner answers /go or /non. */
export function requestPublication(db: Database.Database, n: number, name: string, previewUrl: string, now = new Date()): string {
  const p = getProposal(db, n);
  if (!p) return `No proposal #${n}.`;
  if (p.status !== "chosen") return `Proposal #${n} is ${p.status}: only a chosen proposal can be published.`;
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,56}[a-z0-9]$/.test(clean)) return "name: the public project name, lowercase letters, digits and dashes.";
  const bad = nameProblem(clean);
  if (bad) return bad;
  const checks = readJson<Record<string, any>>(db, CHECKS_KEY, {})[normalizeUrl(previewUrl)] ?? {};
  const fresh = (at?: string) => !!at && now.getTime() - Date.parse(at) < CHECK_VALID_MS;
  const missing: string[] = [];
  if (!fresh(checks.testAt) || !/^PASS/.test(checks.testVerdict ?? "")) missing.push(`test_site on ${previewUrl} must PASS (last: ${checks.testVerdict ?? "never"})`);
  if (!fresh(checks.reviewAt)) missing.push(`design_review with final: true on ${previewUrl} (Opus) within 48 h`);
  if (missing.length) return `Before asking the owner:\n- ${missing.join("\n- ")}\nServe the site locally (e.g. python3 -m http.server) and run them on that URL.`;
  const summary = `test ${checks.testVerdict} (${String(checks.testAt).slice(0, 10)}); revue Opus : ${String(checks.reviewNote ?? "").replace(/\s+/g, " ").slice(0, 280)}`;
  updateProposal(db, n, (x) => { x.status = "publish_pending"; x.publication = { name: clean, previewUrl: previewUrl.trim(), requestedAt: now.toISOString(), checks: summary }; }, now);
  queueOwnerNotification(db,
    `🌐 #${n} « ${p.title} » est prêt à être mis en ligne sous le nom « ${clean} ».\nVérifications : ${summary}\n` +
    `👉 /go ${n} pour publier · /non ${n} raison pour faire corriger`);
  markProgress(db, now);
  return `Publication of #${n} as "${clean}" requested; wait for the owner's /go before deploying.`;
}

/** Deploy tools ask this: null when the owner approved this public name. */
export function publishBlocker(db: Database.Database, name: string): string | null {
  const clean = name.trim().toLowerCase();
  const bad = nameProblem(clean);
  if (bad) return bad;
  const ok = listProposals(db).some((p) => p.status === "live" && p.publication?.name === clean && p.publication.approvedAt);
  return ok ? null
    : `Publishing "${clean}" needs the owner's approval: proposal action publish_request (a chosen proposal, a passing test_site and an Opus design_review on the local preview), then the owner's /go.`;
}

/** A test that ends (finished by the bot, Opus or the numbers) closes its proposal. */
export function closeProposalForExperiment(db: Database.Database, experimentId: string, result: string, now = new Date()): void {
  const p = listProposals(db).find((x) => x.experimentId === experimentId && ["chosen", "publish_pending", "live"].includes(x.status));
  if (p) updateProposal(db, p.n, (x) => { x.status = "stopped"; x.decision = result.slice(0, 400); x.decidedAt = now.toISOString(); }, now);
}

export function linkExperiment(db: Database.Database, slug: string, experimentId: string, now = new Date()): void {
  const p = listProposals(db).find((x) => x.slug === slug && ["chosen", "publish_pending", "live"].includes(x.status));
  if (p && !p.experimentId) updateProposal(db, p.n, (x) => { x.experimentId = experimentId; }, now);
}

// ─── Texts ──────────────────────────────────────────────────────

const STATUS_FR: Record<string, string> = {
  pending: "en attente de ton choix", chosen: "choisie, en préparation", publish_pending: "prête à publier, attend ton accord",
  live: "en ligne", rejected: "écartée", stopped: "arrêtée", building: "en construction", observing: "en observation",
  waiting_for_owner: "attend ton action",
};

function statusFr(s: string): string {
  return STATUS_FR[s] ?? s;
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The Telegram card: readable in thirty seconds. */
export function formatCard(p: Proposal): string {
  return [
    `💡 Proposition #${p.n} — ${p.title}`,
    `Le problème : ${cut(p.frustration, 260)}`,
    `Pour qui : ${cut(p.audience, 140)}`,
    `Ce qui rapporte : ${cut(p.revenue, 200)}`,
    `Comment on les touche : ${cut(p.acquisition[0] ?? "", 160)}${p.acquisition.length > 1 ? ` (+${p.acquisition.length - 1} autre${p.acquisition.length > 2 ? "s" : ""})` : ""}`,
    `Le test : ${cut(p.test, 200)}`,
    `L'avis d'Opus : ${cut(p.opusNote, 220)}`,
    `👉 /go ${p.n} pour tester · /non ${p.n} raison pour écarter · /idee ${p.n} pour tout lire`,
  ].join("\n");
}

/** The full dossier (/idee n). */
export function proposalDossier(p: Proposal): string {
  return [
    `💡 Proposition #${p.n} — ${p.title} (${statusFr(p.status)})`,
    `Le problème : ${p.frustration}`,
    `Pour qui : ${p.audience}`,
    `Preuves :\n${p.evidence.map((e) => `• ${e}`).join("\n")}`,
    `Concurrence :\n${p.competitors.map((e) => `• ${e}`).join("\n")}`,
    `Notre angle : ${p.angle}`,
    `Pourquoi celle-là plutôt qu'une autre : ${p.whyThis}`,
    `Ce qui rapporte : ${p.revenue}`,
    `Comment on les touche :\n${p.acquisition.map((e) => `• ${e}`).join("\n")}`,
    `Prospects : ${p.prospects}`,
    `Le test : ${p.test}`,
    `Ce qui tuerait l'idée : ${p.killers}`,
    p.whatChanged ? `Ce qui a changé depuis une idée proche écartée : ${p.whatChanged}` : "",
    `L'avis d'Opus : ${p.opusNote}`,
    p.decision ? `Décision (${p.decidedBy ?? "?"}) : ${p.decision}` : "",
    p.publication ? `Publication : « ${p.publication.name} » — ${p.publication.checks}${p.publication.feedback ? ` — ta remarque : ${p.publication.feedback}` : ""}` : "",
    p.status === "pending" ? `👉 /go ${p.n} pour tester · /non ${p.n} raison pour écarter` : "",
  ].filter(Boolean).join("\n");
}

export function describeProposalsFr(db: Database.Database, now = new Date()): string {
  const items = listProposals(db).filter((p) => ACTIVE.includes(p.status));
  const week = acceptedThisWeek(db, now).length;
  const head = `Objectif de la semaine : ${week}/${WEEKLY_QUOTA} propositions.`;
  if (!items.length) return `${head}\nAucune proposition en attente pour l'instant.`;
  return [head, ...items.map((p) => {
    const age = Math.floor((now.getTime() - Date.parse(p.deliveredAt)) / 3_600_000);
    return `#${p.n} ${p.title} — ${statusFr(p.status)}${p.status === "pending" ? ` (depuis ${age} h)` : ""}`;
  }), "Lire : /idee <numéro> · Choisir : /go <numéro> · Écarter : /non <numéro> raison"].join("\n");
}

export function describeMemoryFr(db: Database.Database, limit = 15): string {
  const memory = listMemory(db).slice(-limit).reverse();
  if (!memory.length) return "Mémoire vide : aucune idée écartée pour l'instant.";
  const who: Record<string, string> = { owner: "toi", opus: "Opus", bot: "le bot", test: "les chiffres" };
  return ["Idées écartées (les plus récentes d'abord) :", ...memory.map((m) => `• ${m.at.slice(0, 10)} — ${cut(m.title, 70)} — par ${who[m.by] ?? m.by} : ${cut(m.reason, 160)}`)].join("\n");
}

/** For the bot's prompt: the job's state in a few lines. */
export function describeProposalsForPrompt(db: Database.Database, now = new Date()): string {
  const { end } = weekWindow(db, now);
  const week = acceptedThisWeek(db, now).length;
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
  const plan = currentPlan(db, now);
  const items = listProposals(db);
  const line = (p: Proposal) => `#${p.n} ${p.title} (slug ${p.slug}) [${p.status}${p.status === "pending" ? `, ${Math.floor((now.getTime() - Date.parse(p.deliveredAt)) / 3_600_000)} h` : ""}]` +
    (p.status === "chosen" ? ` → build its test: record_experiment idea_id "${p.slug}"${p.publication?.feedback ? `; the owner refused the publication: ${cut(p.publication.feedback, 160)}` : ""}` : "") +
    (p.status === "live" && p.publication?.approvedAt ? ` → publish as "${p.publication.name}" if not done yet` : "");
  const reviews = listReviews(db).slice(-4).map((r) => `${r.at.slice(0, 10)} ${r.slug} ${r.verdict}${r.verdict !== "ACCEPT" ? `: ${cut(r.fixes || r.note, 200)}` : ""}`);
  return [
    `THIS WEEK: ${week}/${WEEKLY_QUOTA} accepted proposals, ${daysLeft} day(s) left (window ends ${end.toISOString().slice(0, 16)} UTC). ` +
      `Missing the quota pauses you: you die unless the owner revives you. Opus reviews today: ${reviewsToday(db, now)}/${MAX_REVIEWS_PER_DAY}.`,
    plan ? `Week plan (Opus-checked): ${plan.themes.join("; ")}.` : "Week plan: NONE YET. Send it first (proposal action plan): 3-6 themes and why.",
    `Proposals: ${items.filter((p) => ACTIVE.includes(p.status)).map(line).join("; ") || "none in progress"}.`,
    reviews.length ? `Latest Opus reviews: ${reviews.join(" | ")}.` : "",
    `Memory (ideas set aside, do not re-propose without what_changed):\n${memoryDigest(db, 10)}`,
  ].filter(Boolean).join("\n");
}

// ─── Reports and discipline ─────────────────────────────────────

export function countFrictions(db: Database.Database, count: number, now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  const cur = readJson<{ day: string; count: number }>(db, FRICTIONS_DAY_KEY, { day, count: 0 });
  setKV(db, FRICTIONS_DAY_KEY, JSON.stringify({ day, count: (cur.day === day ? cur.count : 0) + count }));
}

function usd(c: number): string {
  return `${(c / 100).toFixed(2).replace(".", ",")} $`;
}

/** The evening report and /point: done, learned, next, the week, what waits for the owner, money. */
export function dailyReport(db: Database.Database, lab: MoneyLabConfig, now = new Date(), kind: "soir" | "point" = "soir"): string {
  const day = now.toISOString().slice(0, 10);
  const reviews = listReviews(db).filter((r) => r.at.slice(0, 10) === day);
  const accepted = listProposals(db).filter((p) => p.deliveredAt.slice(0, 10) === day);
  const frictions = readJson<{ day: string; count: number }>(db, FRICTIONS_DAY_KEY, { day: "", count: 0 });
  const tests = listExperiments(db).filter((e) => e.updatedAt.slice(0, 10) === day && ACTIVE_EXPERIMENT.has(e.status)).length;
  const plan = currentPlan(db, now);
  const done: string[] = [];
  if (plan && plan.at.slice(0, 10) === day) done.push("plan de la semaine validé par Opus");
  if (frictions.day === day && frictions.count) done.push(`${frictions.count} frustration(s) relevée(s)`);
  if (reviews.length) {
    const rework = reviews.filter((r) => r.verdict === "REWORK").length;
    const drop = reviews.filter((r) => r.verdict === "DROP").length;
    done.push(`${reviews.length} dossier(s) relu(s) par Opus : ${accepted.length} accepté(s)${accepted.length ? ` (${accepted.map((p) => `#${p.n}`).join(", ")})` : ""}` +
      `${rework ? `, ${rework} à retravailler` : ""}${drop ? `, ${drop} abandonné(s)` : ""}`);
  }
  if (tests) done.push(`${tests} test(s) mis à jour`);
  const learnedMemory = listMemory(db).filter((m) => m.at.slice(0, 10) === day).slice(-2).map((m) => `${cut(m.title, 50)} écartée : ${cut(m.reason, 110)}`);
  const learnedReview = reviews.filter((r) => r.verdict === "REWORK").slice(-1).map((r) => `Opus demande sur « ${cut(r.title, 40)} » : ${cut(r.fixes.split("\n")[0] ?? "", 120)}`);
  const sleepReason = String(getKV(db, "sleep_reason") ?? "").trim();
  const next = sleepReason && !/^plafond|^No reason/i.test(sleepReason) ? cut(sleepReason, 180) : "non précisé (il doit l'écrire en s'endormant)";
  const { end } = weekWindow(db, now);
  const week = acceptedThisWeek(db, now).length;
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
  const waiting = listProposals(db).filter((p) => p.status === "pending" || p.status === "publish_pending")
    .map((p) => `#${p.n}${p.status === "publish_pending" ? " (publication)" : ""}`);
  const spent = inferenceGetDailyCost(db, day);
  const s = lab.runtime === "self-hosted" ? survivalBalance(db, lab, now) : null;
  const paused = getPauseState(db);
  return [
    kind === "soir" ? "🌙 Compte rendu du jour" : "📍 Point",
    paused ? `⏸️ En pause : ${cut(paused.reason, 160)} (/reprendre)` : "",
    `Fait : ${done.join(" ; ") || "rien de concret"}.`,
    `Appris : ${[...learnedMemory, ...learnedReview].join(" ; ") || "rien de nouveau"}.`,
    `Demain : ${next}.`,
    `Semaine : ${week}/${WEEKLY_QUOTA} propositions${week >= WEEKLY_QUOTA ? " ✅" : ` — encore ${daysLeft} jour(s)`}.`,
    `En attente de toi : ${waiting.length ? `${waiting.join(", ")} (/idees)` : "rien"}.`,
    `Argent : ${usd(spent)} aujourd'hui${s ? ` · solde ${usd(s.balanceCents)}${s.daysLeft !== null ? ` (≈ ${Math.floor(s.daysLeft)} jours)` : ""}` : ""}.`,
  ].filter(Boolean).join("\n");
}

/**
 * Hourly, no inference: the weekly verdict (quota missed: pause, the owner
 * revives or not) and the stall rule (48 h of spending without progress).
 */
export function disciplineTick(db: Database.Database, now = new Date()): string[] {
  const events: string[] = [];
  if (!getKV(db, PROGRESS_KEY)) markProgress(db, now);
  const { start, end } = weekWindow(db, now);
  if (now.getTime() >= end.getTime()) {
    const delivered = acceptedThisWeek(db, start);
    const paused = getPauseState(db);
    const dead = String(getKV(db, "agent_state") ?? "") === "dead";
    // Roll the window forward to the current week.
    let next = end.getTime();
    while (next + WEEK_MS <= now.getTime()) next += WEEK_MS;
    setKV(db, WINDOW_KEY, new Date(next).toISOString());
    if (!paused && !dead) {
      if (delivered.length >= WEEKLY_QUOTA) {
        queueOwnerNotification(db, `✅ Semaine réussie : ${delivered.length} propositions (${delivered.map((p) => `#${p.n}`).join(", ")}). Nouvelle semaine, nouvel objectif : ${WEEKLY_QUOTA}.`);
        events.push("week passed");
      } else {
        const reviews = listReviews(db).filter((r) => Date.parse(r.at) >= start.getTime() && Date.parse(r.at) < end.getTime());
        const tried = reviews.filter((r) => r.verdict !== "ACCEPT").slice(-4).map((r) => `« ${cut(r.title, 50)} » ${r.verdict === "DROP" ? "abandonnée" : "à retravailler"} : ${cut(r.fixes || r.note, 120)}`);
        pause(db, `objectif de la semaine manqué : ${delivered.length}/${WEEKLY_QUOTA} propositions acceptées. ` +
          `Ce qu'il a essayé : ${tried.join(" ; ") || "aucun dossier envoyé à Opus"}. Sans /reprendre, il reste arrêté.`, "runtime");
        events.push("week missed");
      }
    }
  }
  const last = Date.parse(getKV(db, PROGRESS_KEY) ?? now.toISOString());
  if (!getPauseState(db) && now.getTime() - last > STALL_MS) {
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const spent = inferenceGetDailyCost(db, today) + inferenceGetDailyCost(db, yesterday);
    if (spent >= STALL_MIN_SPEND_CENTS) {
      pause(db, `il tourne en rond : ${usd(spent)} dépensés en 48 h sans plan, sans dossier envoyé et sans test mis à jour. ` +
        "Dis-lui quoi faire en message, puis /reprendre.", "runtime");
      events.push("stall");
    }
  }
  return events;
}

/** Tool phases: what the bot sees depends on what it is doing. */
const NEVER_FOR_MONEY_LAB = [
  "idea", "register_erc8004", "update_agent_card", "discover_agents", "give_feedback", "check_reputation", "send_message",
  "distress_signal", "enter_low_compute", "heartbeat_ping", "modify_heartbeat", "update_soul", "reflect_on_soul", "view_soul",
  "view_soul_history", "note_about_agent", "set_goal", "complete_goal", "check_usdc_balance", "review_upstream_changes",
  "update_genesis_prompt", "list_models",
];
const BUILD_TOOLS = [
  "scaffold_site", "vendor_code", "repo_scout", "test_site", "check_design", "first_impression", "design_review", "code_review",
  "deploy_site", "deploy_worker", "ab_test", "audit_page", "render_image", "check_domain", "probe", "view_page", "browse",
];
const MARKETING_TOOLS = ["publish_kit", "post_social"];

export function hiddenTools(db: Database.Database): Set<string> {
  const hidden = new Set(NEVER_FOR_MONEY_LAB);
  const items = listProposals(db);
  const now = Date.now();
  // A publication the owner just approved still has to be deployed: the
  // building tools stay for three days after the /go.
  const deploying = (p: Proposal) => p.status === "live" && !!p.publication?.approvedAt && now - Date.parse(p.publication.approvedAt) < 3 * 86_400_000;
  const building = items.some((p) => p.status === "chosen" || p.status === "publish_pending" || deploying(p))
    || listExperiments(db).some((e) => e.status === "building");
  const live = items.some((p) => p.status === "live") || listExperiments(db).some((e) => e.status === "observing");
  if (!building) for (const t of BUILD_TOOLS) hidden.add(t);
  if (!building && !live) for (const t of MARKETING_TOOLS) hidden.add(t);
  return hidden;
}
