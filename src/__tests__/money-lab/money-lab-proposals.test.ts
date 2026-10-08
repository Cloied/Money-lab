/**
 * Money Lab reorientation (owner meeting 2026-10-08): proposals reviewed by
 * Opus, the memory of ideas set aside, the owner's Telegram commands, the
 * weekly quota and stall rules, the publication gate, tools by phase and the
 * frustration finder. Opus and every network call are stubbed.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import {
  addLedgerEntry, createHelpRequest, ensureMoneyLabSchema, getExperiment, getHelpRequest, getKV, getPauseState, pendingOwnerNotifications,
  resume, setKV, upsertExperiment, PROGRESS_KEY,
} from "../../money-lab/journal.js";
import {
  MAX_REVIEWS_PER_DAY, WEEKLY_QUOTA, acceptedThisWeek, contentWords, dailyReport, decideForOwner, describeMemoryFr,
  describeProposalsForPrompt, disciplineTick, dossierProblems, getProposal, hiddenTools, listMemory, listProposals, listReviews,
  listStoppable, nameProblem, ownerGo, ownerNo, ownerStop, publishBlocker, recordReviewCheck, recordTestCheck, requestPublication,
  similarity, submitPlan, submitProposal, weekWindow, type Ask,
} from "../../money-lab/proposals.js";
import { scanFrictions } from "../../money-lab/frictions.js";
import { getIdea } from "../../money-lab/ideas.js";
import { TelegramChannel, TELEGRAM_HELP } from "../../money-lab/telegram.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity } from "../mocks.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";

function vpsConfig(): AutomatonConfig {
  return applyMoneyLabProfile(createTestConfig({
    moneyLab: {
      enabled: true, profile: "first-run", runtime: "self-hosted",
      telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", ownerChatId: 42 }, stripe: null,
      inference: { model: "claude-sonnet-5-5", effort: "medium", perCallCents: null, hourlyCents: null, dailyCents: 300, maxOutputTokens: 16000 },
      payments: "disabled", paymentLimits: { perPaymentCents: null, dailyCents: null }, deniedTools: [],
      maxTurnsPerCycle: null, noProgressCycles: 5, noProgressSleepMinutes: 120,
      resources: [{ id: "vps", kind: "server", description: "VPS", expectedDailyCostCents: 20 }],
      funding: { currency: "USD", provisionedCents: 2000, heldBackCents: 0 },
    } as any,
    sandboxId: "", logLevel: "error",
  }));
}

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp("money-lab-proposals-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const t0 = new Date("2026-10-08T09:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);

/** Opus stub: answers in order; records what it was asked. */
function opus(...answers: string[]): Ask & { asked: Array<{ system: string; user: string }> } {
  const asked: Array<{ system: string; user: string }> = [];
  const fn = (async (system: string, user: string) => {
    asked.push({ system, user });
    return { ok: true, content: answers.shift() ?? "Decision: ACCEPT\nOwner note: ok", model: "claude-opus-5-5", costCents: 5 };
  }) as Ask & { asked: typeof asked };
  fn.asked = asked;
  return fn;
}

const dossier = (over: Record<string, unknown> = {}) => ({
  slug: "devis-plombiers", title: "Devis express pour plombiers",
  frustration: "Les plombiers indépendants passent leurs soirées à rédiger des devis à la main ; ils le disent chaque semaine sur les forums du métier.",
  audience: "Plombiers et chauffagistes indépendants en France",
  evidence: [
    "https://forum.example/fil1 — 2026-09-12 — « 2 h par soir sur les devis »",
    "https://reddit.com/r/plomberie/x — 2026-08-30 — 120 votes pour un outil simple",
    "https://avis.example/app — 2026-07-02 — avis 1 étoile : « trop cher pour un artisan seul »",
  ],
  competitors: ["Obat — 39 €/mois, trop complet pour un indépendant", "Tolteck — 25 €/mois, pas de mode mobile hors ligne"],
  angle: "Un devis en 3 minutes depuis le téléphone, avec les prix du métier déjà remplis",
  why_this: "Comparé aux deux autres pistes de la semaine (agenda coiffeurs, inventaire caves), c'est la seule où les gens paient déjà 25 à 39 € par mois et se plaignent.",
  revenue: "Abonnement 9 € par mois ; 40 artisans au bout de 3 mois = 360 € par mois, réaliste vu 12 000 plombiers indépendants.",
  acquisition: [
    "Groupe Facebook « Plombiers indépendants France » (18 000 membres) : un post qui offre un modèle de devis gratuit",
    "Recherche « modèle devis plombier » : 2 400 recherches par mois, une page outil gratuite",
  ],
  prospects: "Groupes de plombiers, forum Plombiers.com, artisans qui se plaignent du prix des logiciels",
  test: "Une page qui génère un devis PDF gratuit ; réussi si 30 devis générés en 14 jours",
  killers: "Moins de 10 devis en 14 jours, ou 0 inscription à la liste payante sur 100 visiteurs",
  ...over,
});

describe("Proposals reviewed by Opus", () => {
  it("needs the week plan first, lists every missing part at once, then sends an accepted dossier to the owner as card #1", async () => {
    const db = openDb();
    const o = opus("Decision: APPROVE\nPlan:\n- plombiers\nAdvice: bien", "Decision: ACCEPT\nOwner note: Vraie douleur, des gens paient déjà.");
    expect((await submitProposal(db.raw, dossier(), o, t0)).text).toMatch(/First send this week's exploration plan/);
    expect((await submitPlan(db.raw, { themes: ["plombiers"], why: "x" }, o, t0)).text).toMatch(/3 to 6 themes/);
    expect((await submitPlan(db.raw, { themes: ["devis artisans", "obligations 2026", "petits commerces"], why: "Des métiers qui paient déjà des logiciels chers et se plaignent." }, o, t0)).text)
      .toMatch(/plan saved for the week/);
    expect(o.asked[0].system).toMatch(/exploration plan/);
    const incomplete = await submitProposal(db.raw, { slug: "x", title: "court" }, o, t0);
    expect(incomplete.text).toMatch(/Dossier incomplete/);
    for (const part of ["slug:", "frustration:", "evidence:", "competitors:", "why_this:", "revenue:", "acquisition:", "prospects:", "test:", "killers:"]) {
      expect(incomplete.text).toContain(part);
    }
    expect(o.asked).toHaveLength(1);
    const r = await submitProposal(db.raw, dossier(), o, t0);
    expect(r.text).toMatch(/Opus: ACCEPT\. Proposal #1 sent to the owner \(1\/3 this week\)/);
    expect(o.asked[1].system).toMatch(/ACCEPT only if[\s\S]*never named private people/);
    expect(o.asked[1].user).toContain("Why this one rather than the others");
    const card = pendingOwnerNotifications(db.raw).map((n) => n.text).find((t) => t.startsWith("💡 Proposition #1"))!;
    expect(card).toMatch(/Le problème : [\s\S]*Ce qui rapporte : [\s\S]*Comment on les touche : [\s\S]*Le test : [\s\S]*L'avis d'Opus : Vraie douleur[\s\S]*\/go 1 pour tester · \/non 1 raison pour écarter/);
    expect(acceptedThisWeek(db.raw, t0)).toHaveLength(1);
    expect(listReviews(db.raw)).toMatchObject([{ slug: "devis-plombiers", verdict: "ACCEPT" }]);
    expect(describeProposalsForPrompt(db.raw, t0)).toMatch(/THIS WEEK: 1\/3 accepted proposals[\s\S]*Week plan \(Opus-checked\): devis artisans[\s\S]*#1 Devis express pour plombiers \(slug devis-plombiers\) \[pending, 0 h\]/);
    // The same idea again is a duplicate.
    expect((await submitProposal(db.raw, dossier({ slug: "devis-plombiers-2" }), o, t0)).text).toMatch(/Already proposed as #1/);
    db.close();
  });

  it("returns REWORK with the fixes, keeps DROP in memory, caps reviews per day and per slug", async () => {
    const db = openDb();
    const o = opus("Decision: APPROVE\nPlan: ok",
      "Decision: REWORK\nOwner note: Pas encore.\nFixes:\n- les sources sont des articles de marché\n- prix non justifié",
      "Decision: DROP\nOwner note: Non.\nReason: marché saturé par des outils gratuits");
    await submitPlan(db.raw, { themes: ["a", "b", "c"], why: "Trois métiers qui se plaignent souvent de leurs logiciels." }, o, t0);
    const rework = await submitProposal(db.raw, dossier(), o, t0);
    expect(rework.text).toMatch(/Opus: REWORK[\s\S]*les sources sont des articles de marché[\s\S]*2 review\(s\) left/);
    expect(listProposals(db.raw)).toHaveLength(0);
    const drop = await submitProposal(db.raw, dossier(), o, t0);
    expect(drop.text).toMatch(/Opus: DROP[\s\S]*kept in memory/);
    expect(listMemory(db.raw)).toMatchObject([{ title: "Devis express pour plombiers", by: "opus", reason: "Opus: marché saturé par des outils gratuits" }]);
    // Per slug: the third review is the last one.
    setKV(db.raw, "money_lab.memory", "[]");
    await submitProposal(db.raw, dossier(), opus("Decision: REWORK\nOwner note: non\nFixes:\n- x"), t0);
    expect((await submitProposal(db.raw, dossier(), opus(), t0)).text).toMatch(/reviewed 3 times: move on/);
    // Per day.
    for (let i = listReviews(db.raw).length; i < MAX_REVIEWS_PER_DAY; i++) {
      await submitProposal(db.raw, dossier({ slug: `autre-${i}`, title: `Idée totalement différente ${i} ${"xyz".repeat(i)}`, frustration: `Frustration unique numéro ${i} : ${"abc ".repeat(30)}` }), opus("Decision: REWORK\nOwner note: n\nFixes:\n- y"), t0);
    }
    expect((await submitProposal(db.raw, dossier({ slug: "encore-une" }), opus(), t0)).text).toMatch(/At most 6 Opus reviews a day/);
    db.close();
  });

  it("refuses an idea close to one set aside unless what_changed answers the reason", async () => {
    const db = openDb();
    const o = opus("Decision: APPROVE\nPlan: ok", "Decision: ACCEPT\nOwner note: nouvelle donne");
    await submitPlan(db.raw, { themes: ["a", "b", "c"], why: "Trois métiers qui se plaignent souvent de leurs logiciels." }, o, t0);
    setKV(db.raw, "money_lab.memory", JSON.stringify([{ at: t0.toISOString(), title: "Devis pour plombiers indépendants", reason: "Le propriétaire : marché déjà couvert", by: "owner",
      words: contentWords("Devis pour plombiers indépendants passent soirées rédiger devis forums métier plombiers chauffagistes") }]));
    expect(similarity(contentWords("Devis express pour plombiers"), contentWords("Devis pour plombiers indépendants"))).toBeGreaterThan(0.3);
    const refused = await submitProposal(db.raw, dossier(), o, t0);
    expect(refused.text).toMatch(/This looks like "Devis pour plombiers indépendants", set aside on 2026-10-08 by owner: Le propriétaire : marché déjà couvert/);
    expect(o.asked).toHaveLength(1);
    const ok = await submitProposal(db.raw, dossier({ what_changed: "Depuis septembre 2026 la facture électronique devient obligatoire : les outils actuels ne la gèrent pas." }), o, t0);
    expect(ok.text).toMatch(/Proposal #1 sent/);
    expect(o.asked[1].user).toContain("What changed since a similar idea was set aside");
    db.close();
  });
});

describe("The owner on Telegram", () => {
  async function withProposal() {
    const db = openDb();
    const o = opus("Decision: APPROVE\nPlan: ok", "Decision: ACCEPT\nOwner note: À tester.");
    await submitPlan(db.raw, { themes: ["a", "b", "c"], why: "Trois métiers qui se plaignent souvent de leurs logiciels." }, o, t0);
    await submitProposal(db.raw, dossier(), o, t0);
    const channel = new TelegramChannel("TOKEN", 42, db, vpsConfig(), (async () => new Response("{}")) as any);
    const wakes = () => (db.raw.prepare("SELECT reason FROM wake_events ORDER BY id").all() as { reason: string }[]).map((w) => w.reason);
    return { db, channel, wakes };
  }

  it("shows a short help, lists and reads proposals, and /go turns the choice into an approved idea the bot can build", async () => {
    const { db, channel, wakes } = await withProposal();
    expect(TELEGRAM_HELP.length).toBeLessThan(1100);
    expect(TELEGRAM_HELP).toMatch(/\/idees[\s\S]*\/go <n>[\s\S]*\/non <n> raison[\s\S]*\/stop <n> raison[\s\S]*\/point[\s\S]*\/aide plus/);
    expect(channel.handleOwnerText("/aide plus", 1)).toMatch(/\/kits[\s\S]*\/publications/);
    expect(channel.handleOwnerText("/idees", 2)).toMatch(/Objectif de la semaine : 1\/3 propositions\.\n#1 Devis express pour plombiers — en attente de ton choix/);
    expect(channel.handleOwnerText("/idee 1", 3)).toMatch(/Preuves :\n• https:\/\/forum\.example[\s\S]*Ce qui tuerait l'idée : Moins de 10 devis/);
    expect(channel.handleOwnerText("/idee 9", 4)).toContain("Usage : /idee");
    expect(channel.handleOwnerText("/go 1", 5)).toMatch(/✅ #1 « Devis express pour plombiers » choisie/);
    expect(getProposal(db.raw, 1)).toMatchObject({ status: "chosen", decidedBy: "owner" });
    expect(getIdea(db.raw, "devis-plombiers")).toMatchObject({ status: "approved" });
    expect(describeProposalsForPrompt(db.raw)).toContain('[chosen] → build its test: record_experiment idea_id "devis-plombiers"');
    expect(wakes().at(-1)).toMatch(/Proposition #1 choisie par le propriétaire/);
    expect(channel.handleOwnerText("/go 1", 6)).toMatch(/choisie, en préparation : rien à valider/);
    // The bot launches the test through the approved idea; the proposal knows its experiment.
    const ctx: ToolContext = { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const r = await executeTool("record_experiment", { status: "building", hypothesis: "Devis plombiers", idea_id: "devis-plombiers" }, createMoneyLabTools(), ctx,
      new PolicyEngine(db.raw, createDefaultRules()), { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });
    expect(r.result).toMatch(/recorded with status building/);
    const expId = getProposal(db.raw, 1)!.experimentId!;
    expect(expId).toMatch(/^exp_/);
    expect(getKV(db.raw, PROGRESS_KEY)).toBeTruthy();
    // The test ends with its numbers: the proposal closes and the lesson goes to memory.
    db.raw.prepare("UPDATE money_lab_experiments SET status = 'observing' WHERE id = ?").run(expId);
    const ended = await executeTool("record_experiment", { id: expId, status: "finished", result: "8 devis en 14 jours, seuil 30 non atteint" }, createMoneyLabTools(),
      { ...ctx, inferenceRouter: { route: async (req: any) => ({ content: "Decision: STOP\nReasons:\n- seuil manqué", model: req.model, provider: "anthropic", inputTokens: 1, outputTokens: 1, costCents: 3, latencyMs: 1, finishReason: "stop" }) } as any },
      new PolicyEngine(db.raw, createDefaultRules()), { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });
    expect(ended.result).toMatch(/recorded with status finished/);
    expect(getProposal(db.raw, 1)).toMatchObject({ status: "stopped", decision: "8 devis en 14 jours, seuil 30 non atteint" });
    expect(listMemory(db.raw).at(-1)).toMatchObject({ by: "test", reason: "Test terminé : 8 devis en 14 jours, seuil 30 non atteint" });
    expect(listStoppable(db.raw)).toHaveLength(0);
    db.close();
  });

  it("/non with a number sets a proposal aside in memory; with an id it still answers a help request", async () => {
    const { db, channel, wakes } = await withProposal();
    const help = createHelpRequest(db.raw, { reason: "compte", humanAction: "créer le compte", resumeCondition: "compte créé" } as any);
    expect(channel.handleOwnerText("/non 1 trop de concurrence locale", 1)).toMatch(/🗑️ #1 écartée \(trop de concurrence locale\)/);
    expect(getProposal(db.raw, 1)).toMatchObject({ status: "rejected", decidedBy: "owner" });
    expect(listMemory(db.raw).at(-1)).toMatchObject({ by: "owner", reason: "trop de concurrence locale" });
    expect(wakes().at(-1)).toMatch(/Proposition #1 écartée par le propriétaire : trop de concurrence locale/);
    expect(channel.handleOwnerText(`/non ${help.id} pas maintenant`, 2)).not.toMatch(/Proposition/);
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("rejected");
    expect(channel.handleOwnerText("/memoire", 3)).toMatch(/Idées écartées[\s\S]*Devis express pour plombiers — par toi : trop de concurrence locale/);
    expect(describeMemoryFr(db.raw)).toContain("par toi");
    db.close();
  });

  it("/tests and /stop end any test without Opus, the old invoice experiment included, and the reason stays in memory", async () => {
    const { db, channel, wakes } = await withProposal();
    db.raw.prepare("INSERT INTO money_lab_experiments (id, status, hypothesis, evidence, metrics, created_at, updated_at) VALUES (?, 'observing', ?, '[]', ?, ?, ?)")
      .run("exp_factures", "Générateur de factures gratuit pour freelances", JSON.stringify({ visits_total: 29 }), "2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z");
    channel.handleOwnerText("/go 1", 1);
    expect(channel.handleOwnerText("/tests", 2)).toMatch(/1\. Générateur de factures gratuit pour freelances — en observation, 29 visites\n2\. #1 Devis express pour plombiers \(pas encore construit\)/);
    expect(channel.handleOwnerText("/stop", 3)).toMatch(/Usage : \/stop <numéro> raison/);
    expect(channel.handleOwnerText("/stop 1 outil trop banal, nom douteux", 4)).toMatch(/⏹️ Test arrêté : Générateur de factures[\s\S]*outil trop banal, nom douteux/);
    expect(getExperiment(db.raw, "exp_factures")).toMatchObject({ status: "finished" });
    expect(getExperiment(db.raw, "exp_factures")!.result).toMatch(/Arrêté par le propriétaire le \d{4}-\d\d-\d\d : outil trop banal, nom douteux/);
    expect(listMemory(db.raw).at(-1)).toMatchObject({ by: "owner", reason: "Test arrêté par le propriétaire : outil trop banal, nom douteux" });
    expect(wakes().at(-1)).toMatch(/arrêté par le propriétaire/);
    expect(listStoppable(db.raw)).toHaveLength(1);
    expect(channel.handleOwnerText("/stop 1 finalement non", 5)).toMatch(/Test arrêté : #1 Devis express/);
    expect(getProposal(db.raw, 1)).toMatchObject({ status: "stopped" });
    expect(channel.handleOwnerText("/tests", 6)).toBe("Aucun test en cours.");
    db.close();
  });

  it("lets Opus decide after 48 h without an answer, and tells the owner", async () => {
    const { db } = await withProposal();
    expect((await decideForOwner(db.raw, 1, opus(), at(10))).text).toMatch(/The owner has 38 more hour\(s\)/);
    const o = opus("Decision: TEST\nReason: La douleur est forte et le test est petit.");
    expect((await decideForOwner(db.raw, 1, o, at(49))).text).toMatch(/Opus: TEST\. Proposal #1 is chosen/);
    expect(getProposal(db.raw, 1)).toMatchObject({ status: "chosen", decidedBy: "opus" });
    expect(pendingOwnerNotifications(db.raw).map((n) => n.text).join("\n")).toMatch(/Pas de réponse depuis 48 h sur #1[\s\S]*Opus a décidé de la tester/);
    db.close();
  });

  it("writes the evening report and /point: done, learned, next, the week, waiting, money", async () => {
    const { db, channel } = await withProposal();
    setKV(db.raw, "sleep_reason", "Demain : fouiller les avis négatifs des logiciels de caisse");
    const report = dailyReport(db.raw, vpsConfig().moneyLab!, at(10), "soir");
    expect(report).toMatch(/^🌙 Compte rendu du jour\nFait : plan de la semaine validé par Opus ; 1 dossier\(s\) relu\(s\) par Opus : 1 accepté\(s\) \(#1\)\.\nAppris : rien de nouveau\.\nDemain : Demain : fouiller les avis négatifs des logiciels de caisse\.\nSemaine : 1\/3 propositions — encore 7 jour\(s\)\.\nEn attente de toi : #1 \(\/idees\)\.\nArgent : 0,00 \$ aujourd'hui · solde /);
    expect(channel.handleOwnerText("/point", 1)).toMatch(/^📍 Point\nFait : /);
    db.close();
  });
});

describe("Discipline", () => {
  it("pauses the bot at the end of a week under the quota and says what it tried; a full week is congratulated", async () => {
    const db = openDb();
    weekWindow(db.raw, t0);
    const o = opus("Decision: APPROVE\nPlan: ok", "Decision: REWORK\nOwner note: non\nFixes:\n- sources trop faibles");
    await submitPlan(db.raw, { themes: ["a", "b", "c"], why: "Trois métiers qui se plaignent souvent de leurs logiciels." }, o, at(1));
    await submitProposal(db.raw, dossier(), o, at(2));
    expect(disciplineTick(db.raw, at(100))).toEqual([]);
    expect(disciplineTick(db.raw, at(169))).toContain("week missed");
    const paused = getPauseState(db.raw)!;
    expect(paused.by).toBe("runtime");
    expect(paused.reason).toMatch(/objectif de la semaine manqué : 0\/3 propositions acceptées\. Ce qu'il a essayé : « Devis express pour plombiers » à retravailler : - sources trop faibles\. Sans \/reprendre, il reste arrêté\./);
    expect(weekWindow(db.raw, at(169)).start.toISOString()).toBe(at(168).toISOString());
    // A new week while paused: the window rolls, no second verdict.
    expect(disciplineTick(db.raw, at(340))).toEqual([]);
    resume(db.raw);
    // A full week.
    const items = [1, 2, 3].map((n) => ({ n, slug: `p${n}`, title: `P${n}`, status: "pending", deliveredAt: at(340 + n).toISOString(), createdAt: at(340).toISOString(), updatedAt: at(340).toISOString() }));
    setKV(db.raw, "money_lab.proposals", JSON.stringify({ seq: 3, items }));
    setKV(db.raw, PROGRESS_KEY, at(500).toISOString());
    expect(disciplineTick(db.raw, at(505))).toContain("week passed");
    expect(getPauseState(db.raw)).toBeNull();
    expect(pendingOwnerNotifications(db.raw).map((n) => n.text).join("\n")).toMatch(/✅ Semaine réussie : 3 propositions \(#1, #2, #3\)/);
    db.close();
  });

  it("pauses after 48 h of spending without progress, not when idle, and /reprendre gives a fresh 48 h", () => {
    const db = openDb();
    const spend = (cents: number, when: Date) => db.raw.prepare(
      "INSERT INTO inference_costs (id, session_id, model, provider, input_tokens, cost_cents, tier, task_type, created_at) VALUES (?, 's', 'm', 'anthropic', 1, ?, 'normal', 'agent_turn', ?)",
    ).run(`c${Math.random()}`, cents, when.toISOString().replace("T", " ").slice(0, 19));
    setKV(db.raw, PROGRESS_KEY, t0.toISOString());
    weekWindow(db.raw, t0);
    expect(disciplineTick(db.raw, at(50))).toEqual([]); // no spending: idle, not looping
    spend(80, at(49));
    expect(disciplineTick(db.raw, at(50))).toContain("stall");
    expect(getPauseState(db.raw)!.reason).toMatch(/il tourne en rond : 0,80 \$ dépensés en 48 h sans plan, sans dossier envoyé et sans test mis à jour/);
    resume(db.raw);
    expect(Date.parse(getKV(db.raw, PROGRESS_KEY)!)).toBeGreaterThan(Date.now() - 60_000);
    db.close();
  });
});

describe("Publication gate", () => {
  it("publishes only a chosen proposal, under a neutral name, after a passing test and an Opus review, with the owner's /go", async () => {
    const db = openDb();
    const o = opus("Decision: APPROVE\nPlan: ok", "Decision: ACCEPT\nOwner note: ok");
    await submitPlan(db.raw, { themes: ["a", "b", "c"], why: "Trois métiers qui se plaignent souvent de leurs logiciels." }, o, t0);
    await submitProposal(db.raw, dossier(), o, t0);
    const preview = "http://localhost:8080";
    expect(requestPublication(db.raw, 1, "devis-rapide", preview, at(1))).toMatch(/only a chosen proposal/);
    ownerGo(db.raw, 1, at(1));
    expect(nameProblem("moneylab-devis")).toMatch(/not a neutral name/);
    expect(requestPublication(db.raw, 1, "money-lab-devis", preview, at(2))).toMatch(/not a neutral name/);
    expect(requestPublication(db.raw, 1, "devis-rapide", preview, at(2))).toMatch(/test_site on http:\/\/localhost:8080 must PASS \(last: never\)[\s\S]*design_review with final: true/);
    recordTestCheck(db.raw, preview, "FAIL (1 step)", at(2));
    recordReviewCheck(db.raw, `${preview}/`, "Lisible, sérieux.", at(2));
    expect(requestPublication(db.raw, 1, "devis-rapide", preview, at(3))).toMatch(/must PASS \(last: FAIL \(1 step\)\)/);
    recordTestCheck(db.raw, `${preview}/`, "PASS", at(3));
    expect(publishBlocker(db.raw, "devis-rapide")).toMatch(/needs the owner's approval/);
    expect(requestPublication(db.raw, 1, "devis-rapide", preview, at(4))).toMatch(/requested; wait for the owner's \/go/);
    expect(pendingOwnerNotifications(db.raw).map((n) => n.text).join("\n")).toMatch(/🌐 #1 « Devis express pour plombiers » est prêt à être mis en ligne sous le nom « devis-rapide »[\s\S]*test PASS[\s\S]*Lisible, sérieux\.[\s\S]*\/go 1 pour publier · \/non 1 raison/);
    expect(ownerNo(db.raw, 1, "le titre est flou", at(5))).toMatch(/Publication de #1 refusée \(le titre est flou\)/);
    expect(getProposal(db.raw, 1)).toMatchObject({ status: "chosen", publication: { feedback: "le titre est flou" } });
    requestPublication(db.raw, 1, "devis-rapide", preview, at(6));
    expect(ownerGo(db.raw, 1, at(7))).toMatch(/Publication de #1 approuvée sous le nom « devis-rapide »/);
    expect(publishBlocker(db.raw, "devis-rapide")).toBeNull();
    expect(publishBlocker(db.raw, "autre-nom")).toMatch(/needs the owner's approval/);
    // The deploy tools ask the gate before anything runs.
    const ctx: ToolContext = { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const prev = { token: process.env.CLOUDFLARE_PAGES_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
    process.env.CLOUDFLARE_PAGES_TOKEN = "t";
    process.env.CLOUDFLARE_ACCOUNT_ID = "a";
    try {
      const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
      const engine = new PolicyEngine(db.raw, createDefaultRules());
      for (const tool of ["deploy_site", "deploy_worker"]) {
        const r = await executeTool(tool, { action: "deploy", name: "autre-nom" }, createMoneyLabTools(), ctx, engine, turn);
        expect(r.result ?? r.error).toMatch(/Publishing "autre-nom" needs the owner's approval/);
      }
      const s = await executeTool("scaffold_site", { name: "autre-nom", title: "t", description: "d", publish: true }, createMoneyLabTools(), ctx, engine, turn);
      expect(s.result ?? s.error).toMatch(/needs the owner's approval[\s\S]*Scaffold without publish/);
    } finally {
      if (prev.token === undefined) delete process.env.CLOUDFLARE_PAGES_TOKEN; else process.env.CLOUDFLARE_PAGES_TOKEN = prev.token;
      if (prev.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = prev.account;
    }
    db.close();
  });
});

describe("Tools by phase and a lighter prompt", () => {
  it("hides building and marketing tools until the owner chooses, and agent-economy tools always", () => {
    const db = openDb();
    const discovery = hiddenTools(db.raw);
    for (const t of ["scaffold_site", "deploy_site", "deploy_worker", "design_review", "test_site", "publish_kit", "post_social", "idea", "register_erc8004", "update_soul", "discover_agents"]) {
      expect(discovery.has(t), t).toBe(true);
    }
    for (const t of ["proposal", "frictions", "free_search", "harvest", "market_signals", "france_data", "record_experiment", "recall"]) expect(discovery.has(t), t).toBe(false);
    const now = new Date().toISOString();
    const item = (status: string) => ({ n: 1, slug: "p1", title: "P1", status, deliveredAt: now, createdAt: now, updatedAt: now });
    setKV(db.raw, "money_lab.proposals", JSON.stringify({ seq: 1, items: [item("chosen")] }));
    const building = hiddenTools(db.raw);
    for (const t of ["scaffold_site", "deploy_site", "design_review", "test_site", "publish_kit"]) expect(building.has(t), t).toBe(false);
    expect(building.has("idea")).toBe(true);
    setKV(db.raw, "money_lab.proposals", JSON.stringify({ seq: 1, items: [item("live")] }));
    const live = hiddenTools(db.raw);
    expect(live.has("publish_kit")).toBe(false);
    expect(live.has("scaffold_site")).toBe(true);
    // Just approved for publication: the deploy tools stay for three days.
    setKV(db.raw, "money_lab.proposals", JSON.stringify({ seq: 1, items: [{ ...item("live"), publication: { name: "devis-rapide", previewUrl: "x", requestedAt: now, checks: "", approvedAt: now } }] }));
    expect(hiddenTools(db.raw).has("deploy_site")).toBe(false);
    setKV(db.raw, "money_lab.proposals", JSON.stringify({ seq: 1, items: [{ ...item("live"), publication: { name: "devis-rapide", previewUrl: "x", requestedAt: now, checks: "", approvedAt: "2026-01-01T00:00:00.000Z" } }] }));
    expect(hiddenTools(db.raw).has("deploy_site")).toBe(true);
    db.close();
  });

  it("keeps the discovery request small: tools, mission and rules measured", async () => {
    const db = openDb();
    const { createBuiltinTools } = await import("../../agent/tools.js");
    const { moneyLabDeniedTools } = await import("../../money-lab/profile.js");
    const { MONEY_LAB_GENESIS_PROMPT } = await import("../../money-lab/prompt.js");
    const lab = vpsConfig().moneyLab!;
    const denied = moneyLabDeniedTools(lab);
    const size = (hidden: Set<string>) => JSON.stringify([...createBuiltinTools(""), ...createMoneyLabTools()]
      .filter((t) => !denied.has(t.name) && !hidden.has(t.name)).map((t) => ({ n: t.name, d: t.description, p: t.parameters }))).length;
    const before = size(new Set());
    const discovery = size(hiddenTools(db.raw));
    // Measured 2026-10-08: 85 tools and about 52 000 characters were sent on every turn.
    expect(before).toBeGreaterThan(50_000);
    expect(discovery).toBeLessThan(before * 0.6);
    expect(MONEY_LAB_GENESIS_PROMPT.length).toBeLessThan(4_500);
    expect(buildMoneyLabPromptBlock(db.raw, lab).length).toBeLessThan(6_000);
    db.close();
  });
});

describe("Frictions", () => {
  it("gathers posts from Reddit and Ask HN, has the free models extract the frustrations, and counts them", async () => {
    const db = openDb();
    const fetchFn = (async (url: any) => {
      const u = String(url);
      if (/reddit\.com\/search\.json/.test(u)) {
        return new Response(JSON.stringify({ data: { children: [{ data: { subreddit: "plomberie", permalink: `/r/plomberie/${encodeURIComponent(u).length}`, created_utc: 1757000000, score: 42, num_comments: 17, title: "Les devis me prennent mes soirées", selftext: "Je passe 2 h par soir à faire mes devis à la main." } }] } }), { status: 200 });
      }
      if (/hn\.algolia\.com/.test(u)) {
        return new Response(JSON.stringify({ hits: [{ objectID: "1", created_at: "2026-09-01T00:00:00Z", points: 30, num_comments: 12, title: "Ask HN: tool for tradesmen quotes?", story_text: "Nothing simple exists." }] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as any;
    let corpus = "";
    const out = await scanFrictions({ theme: "devis plombier", lang: "fr" }, {
      db: db.raw, fetchFn, env: {}, now: t0,
      extract: async (task, text) => {
        corpus = text;
        expect(task).toMatch(/Only what the posts say; no invented/);
        return { provider: "groq", text: "Devis à la main le soir | plombiers indépendants | « 2 h par soir » | https://www.reddit.com/r/plomberie/1 | 2025-09-04 | 42 votes | unknown" };
      },
    });
    expect(corpus).toMatch(/SOURCE: https:\/\/www\.reddit\.com\/r\/plomberie\/[\s\S]*Les devis me prennent mes soirées[\s\S]*SOURCE: https:\/\/news\.ycombinator\.com\/item\?id=1/);
    expect(out).toMatch(/^Frictions for "devis plombier" \(5 posts, read by groq\):\nDevis à la main le soir/);
    expect(getKV(db.raw, "money_lab.frictions_day")).toBe(JSON.stringify({ day: "2026-10-08", count: 1 }));
    expect(await scanFrictions({ theme: "x" }, { extract: async () => ({ text: "", provider: "" }) })).toMatch(/theme:/);
    const blocked = (async () => new Response("{}", { status: 403 })) as any;
    expect(await scanFrictions({ theme: "obscure" }, { fetchFn: blocked, env: {}, extract: async () => ({ text: "", provider: "" }) })).toMatch(/Too few posts for "obscure" \(0\)[\s\S]*reddit "obscure galère": 403/);
    db.close();
  });

  it("registers the proposal and frictions tools first", () => {
    const names = createMoneyLabTools().map((t) => t.name);
    expect(names.slice(0, 3)).toEqual(["proposal", "frictions", "record_experiment"]);
    expect(WEEKLY_QUOTA).toBe(3);
  });
});

describe("Owner funding still works alongside", () => {
  it("keeps the ledger untouched by the new commands", () => {
    const db = openDb();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 500, source: "operator", reference: "r" });
    expect(dossierProblems({ slug: "ok-slug", title: "Un titre clair", frustration: "x".repeat(80), audience: "x".repeat(20),
      evidence: ["https://a 2026 x", "https://b 2026 y", "https://c 2026 z"], competitors: ["x".repeat(15), "y".repeat(15)], angle: "x".repeat(40),
      whyThis: "x".repeat(80), revenue: `${"x".repeat(60)} 9 €`, acquisition: ["x".repeat(25), "y".repeat(25)], prospects: "x".repeat(40),
      test: `${"x".repeat(40)} 30`, killers: `${"x".repeat(30)} 10`, whatChanged: "" })).toEqual([]);
    db.close();
  });
});
