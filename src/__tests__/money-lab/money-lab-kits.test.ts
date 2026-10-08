/**
 * Money Lab publication kits, owner window on finalists, Opus shortlist and
 * the Telegram commands that drive them.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonConfig, AutomatonDatabase } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import { ensureMoneyLabSchema, pendingOwnerNotifications } from "../../money-lab/journal.js";
import { createTestConfig } from "../mocks.js";
import { decideKit, describeKits, describeKitsForPrompt, draftKit, expireKits, formatKitForOwner, listKits, trackingLink } from "../../money-lab/kits.js";
import { currentShortlist, decideIdeaWithOpus, listDecisions, ownerDismissesIdea, ownerPicksIdea, pendingFinalists, shortlistBlocker, shortlistWithOpus } from "../../money-lab/decisions.js";
import { CRITERIA, getIdea, recordCritique, upsertIdea } from "../../money-lab/ideas.js";
import { TelegramChannel } from "../../money-lab/telegram.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";
import { buildHealthReport } from "../../money-lab/health.js";

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
  const db = createDatabase(path.join(tmp("money-lab-kits-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
  vi.restoreAllMocks();
});

const kitInput = (over: Record<string, unknown> = {}) => ({
  platform: "Reddit r/vosfinances", where: "https://www.reddit.com/r/vosfinances/", audience: "Particuliers qui gèrent leur budget",
  title: "Un simulateur gratuit de frais de notaire, sans inscription",
  body: "Bonjour, j'ai fait un petit simulateur de frais de notaire qui détaille chaque ligne (émoluments, droits, débours) et explique les règles 2026. Il tourne dans le navigateur, rien n'est envoyé. Vos retours sont bienvenus : https://lab.github.io/notaire/",
  link: "https://lab.github.io/notaire/", rules: "Auto-promotion acceptée le dimanche, flair Outil, pas de lien nu", value: "Un calcul détaillé et expliqué, gratuit",
  ...over,
});

describe("Publication kits", () => {
  it("drafts a tracked kit for the owner, enforces the rules and caps, records the owner's answer", () => {
    const db = openDb();
    const t0 = new Date("2026-10-07T10:00:00Z");
    expect(draftKit(db.raw, kitInput({ rules: "" }), t0)).toContain("A kit needs platform");
    expect(draftKit(db.raw, kitInput({ where: "reddit" }), t0)).toContain("where must be the URL");
    expect(draftKit(db.raw, kitInput({ body: "trop court" }), t0)).toContain("body is too short");
    expect(draftKit(db.raw, kitInput({ link: "ftp://x" }), t0)).toContain("link must be an http(s) URL");
    const kit = draftKit(db.raw, kitInput(), t0);
    expect(typeof kit).not.toBe("string");
    if (typeof kit === "string") throw new Error(kit);
    expect(kit.link).toBe(`https://lab.github.io/notaire/?ref=kit-${kit.id}`);
    expect(kit.body).toContain(`https://lab.github.io/notaire/?ref=kit-${kit.id}`);
    expect(kit.body).not.toContain("notaire/ ");
    const notice = pendingOwnerNotifications(db.raw).map((n) => n.text).find((t) => t.startsWith("📣 Kit de publication"))!;
    expect(notice).toContain(`📣 Kit de publication ${kit.id} — Reddit r/vosfinances`);
    expect(notice).toContain("— Texte à coller —");
    expect(notice).toContain(`Quand c'est publié : /publie ${kit.id} <lien du post>`);
    expect(formatKitForOwner(kit)).not.toContain("\nLien :");
    // Same text twice is spam.
    expect(draftKit(db.raw, kitInput({ platform: "Autre" }), new Date("2026-10-07T11:00:00Z"))).toContain(`already used in kit ${kit.id}`);
    // Daily cap.
    for (let i = 0; i < 2; i++) {
      const k = draftKit(db.raw, kitInput({ body: `Variante numéro ${i}, écrite pour ce lieu avec un angle différent : ${kitInput().body}` }), new Date(`2026-10-07T1${i + 2}:00:00Z`));
      expect(typeof k).not.toBe("string");
    }
    expect(draftKit(db.raw, kitInput({ body: `Quatrième variante, encore un autre angle : ${kitInput().body}` }), new Date("2026-10-07T15:00:00Z"))).toContain("At most 3 kits a day");
    // Owner answers.
    expect(decideKit(db.raw, kit.id, true, "https://www.reddit.com/r/vosfinances/comments/abc/", t0)).toContain(`marqué publié (https://www.reddit.com/r/vosfinances/comments/abc/)`);
    expect(listKits(db.raw)[0].postedUrl).toBe("https://www.reddit.com/r/vosfinances/comments/abc/");
    expect(decideKit(db.raw, kit.id, true, "", t0)).toContain("déjà traité (posted)");
    const second = listKits(db.raw)[1];
    expect(decideKit(db.raw, second.id, false, "pas le bon public", t0)).toContain("passé (pas le bon public)");
    expect(describeKits(db.raw, { pendingOnly: true })).toMatch(/^k[a-z0-9]+ \[pending\]/);
    expect(describeKitsForPrompt(db.raw)).toMatch(/^1 waiting for the owner, 1 posted \(k[a-z0-9]+ Reddit r\/vosfinances \(ref=kit-k[a-z0-9]+\)\), 1 skipped, 0 expired$/);
    expireKits(db.raw, new Date("2026-10-25T00:00:00Z"));
    expect(listKits(db.raw)[2].status).toBe("expired");
    expect(trackingLink("https://a.b/c?x=1", "k1")).toBe("https://a.b/c?x=1&ref=kit-k1");
    expect(trackingLink("mailto:x", "k1")).toBeNull();
    db.close();
  });
});

describe("Owner window and shortlist", () => {
  function readyIdea(db: AutomatonDatabase, id: string, at: Date, total = 7) {
    const scores = Object.fromEntries(CRITERIA.map((c) => [c, { score: total, why: "fait vérifié et sourcé avec lien" }]));
    upsertIdea(db.raw, {
      id, title: `Idée ${id}`, problem: "p", audience: "a", solution: "s", revenue_model: "r", channels: "search on our domain",
      evidence: ["e1 2026", "e2 2026", "e3 2026"], competitors: ["c1", "c2"], kill_criteria: "50 visits/week", scores,
    }, at);
    recordCritique(db.raw, id, { at: at.toISOString(), model: "m", verdict: "GO", text: "Verdict: GO" });
    upsertIdea(db.raw, { id, response_to_critic: "answered" }, at);
  }

  it("tells the owner about a finalist, waits 24 h, then lets Opus decide; the owner can pick or dismiss", async () => {
    const db = openDb();
    const lab = vpsConfig().moneyLab!;
    const t0 = new Date("2026-10-01T00:00:00Z");
    for (const id of ["a", "b", "c", "d", "e"]) readyIdea(db, id, t0, id === "a" ? 8 : 6);
    const route = vi.fn(async () => ({ content: "Decision: APPROVE\nReasons:\n- ok", model: "claude-opus-5-5", costCents: 3, finishReason: "stop", inputTokens: 1, outputTokens: 1 }));
    const options = { router: { route } as any, chat: async () => ({}), sessionId: "s", lab, now: new Date("2026-10-02T00:00:00Z") };
    const first = await decideIdeaWithOpus(db.raw, "a", "Probe passed with 60 impressions", options);
    expect(first.text).toContain("The owner has been told about this finalist and has 24 h");
    expect(route).not.toHaveBeenCalled();
    const notice = pendingOwnerNotifications(db.raw).map((n) => n.text).find((t) => t.startsWith("🏁 Finaliste"))!;
    expect(notice).toContain("🏁 Finaliste : Idée a (a).");
    expect(notice).toContain("/choisis a pour la construire, /ecarte a [raison]");
    expect(pendingFinalists(db.raw, new Date("2026-10-02T01:00:00Z"))).toEqual(["a"]);
    const again = await decideIdeaWithOpus(db.raw, "a", "still", { ...options, now: new Date("2026-10-02T12:00:00Z") });
    expect(again.text).toContain("open for 12 more hour(s)");
    // After the window, Opus decides.
    const later = await decideIdeaWithOpus(db.raw, "a", "still", { ...options, now: new Date("2026-10-03T01:00:00Z") });
    expect(route).toHaveBeenCalledTimes(1);
    expect(later.text).toContain("binding");
    expect(getIdea(db.raw, "a")!.status).toBe("approved");
    // The owner picks another finalist before the window ends.
    expect(ownerPicksIdea(db.raw, "b")).toContain("n'est pas une finaliste proposée");
    await decideIdeaWithOpus(db.raw, "b", "case", { ...options, now: new Date("2026-10-03T02:00:00Z") });
    expect(ownerPicksIdea(db.raw, "b", new Date("2026-10-03T03:00:00Z"))).toBe("Idée b choisie : le bot peut la construire (statut approuvé).");
    expect(getIdea(db.raw, "b")!.status).toBe("approved");
    expect(listDecisions(db.raw).at(-1)).toMatchObject({ kind: "approve_idea", target: "b", verdict: "APPROVE", model: "owner" });
    expect(ownerDismissesIdea(db.raw, "c", "trop proche de a")).toBe("Idée c écartée (trop proche de a). Le bot ne la reprendra pas.");
    expect(getIdea(db.raw, "c")!.status).toBe("rejected");
    expect(ownerDismissesIdea(db.raw, "zz", "")).toContain("introuvable");
    db.close();
  });

  it("asks Opus for a shortlist with enough ideas, records picks and rejections, holds a week", async () => {
    const db = openDb();
    const lab = vpsConfig().moneyLab!;
    const t0 = new Date("2026-10-01T00:00:00Z");
    expect(shortlistBlocker(db.raw, t0)).toContain("at least 8 scored candidate ideas (have 0)");
    for (let i = 0; i < 9; i++) readyIdea(db, `idea-${i}`, t0, 5 + (i % 4));
    const route = vi.fn(async (req: any) => {
      expect(String(req.messages[1].content)).toContain("Scored ideas (best first):");
      return {
        content: "Decision: SHORTLIST\nProbe now:\n- idea-3: strong intent — \"a\", \"b\", \"c\"\n- **idea-7**: narrow niche\n- idea-3: duplicate\nReject:\n- idea-0: crowded, no angle\n- nope: unknown\nAdvice:\n- scan more",
        model: "claude-opus-5-5", costCents: 4, finishReason: "stop", inputTokens: 1, outputTokens: 1,
      };
    });
    const options = { router: { route } as any, chat: async () => ({}), sessionId: "s", lab, now: t0 };
    const result = await shortlistWithOpus(db.raw, options);
    expect(result.text).toContain("Recorded: probe idea-3, idea-7; rejected idea-0");
    expect(currentShortlist(db.raw)).toMatchObject({ at: t0.toISOString(), picks: ["idea-3", "idea-7"] });
    expect(getIdea(db.raw, "idea-0")!.status).toBe("rejected");
    expect(getIdea(db.raw, "idea-3")!.status).toBe("candidate");
    expect(listDecisions(db.raw).at(-1)).toMatchObject({ kind: "shortlist", verdict: "SHORTLIST", target: "idea-3,idea-7" });
    const held = await shortlistWithOpus(db.raw, { ...options, now: new Date("2026-10-04T00:00:00Z") });
    expect(held.text).toContain("Opus shortlisted on 2026-10-01: idea-3, idea-7");
    expect(route).toHaveBeenCalledTimes(1);
    const block = buildMoneyLabPromptBlock(db.raw, lab);
    // 2026-10-08: the prompt carries the week's proposals and the memory instead of shortlists and finalists.
    expect(block).not.toContain("Decisions: shortlist");
    expect(block).toMatch(/THIS WEEK: 0\/3 accepted proposals[\s\S]*Memory \(ideas set aside/);
    db.close();
  });
});

describe("Telegram commands for kits and finalists", () => {
  it("lists, shows, marks posted or skipped, picks or dismisses, and wakes the agent", async () => {
    const db = openDb();
    const t0 = new Date("2026-10-07T10:00:00Z");
    const kit = draftKit(db.raw, kitInput(), t0);
    if (typeof kit === "string") throw new Error(kit);
    const channel = new TelegramChannel("TOKEN", 42, db, vpsConfig(), (async () => new Response("{}")) as any);
    expect(channel.handleOwnerText("/kits", 1)).toMatch(new RegExp(`^${kit.id} \\[pending\\] 2026-10-07 Reddit r/vosfinances: Un simulateur gratuit`));
    expect(channel.handleOwnerText(`/kit ${kit.id}`, 2)).toContain("— Texte à coller —");
    expect(channel.handleOwnerText("/kit nope", 3)).toContain("introuvable");
    expect(channel.handleOwnerText("/publie", 4)).toContain("Usage : /publie <id> [lien du post]");
    expect(channel.handleOwnerText(`/publie ${kit.id} https://www.reddit.com/r/vosfinances/comments/x/`, 5)).toContain("marqué publié");
    const wakes = () => (db.raw.prepare("SELECT reason FROM wake_events ORDER BY id").all() as { reason: string }[]).map((w) => w.reason);
    expect(wakes()).toContain(`Kit ${kit.id} publié par le propriétaire`);
    expect(channel.handleOwnerText(`/passe ${kit.id}`, 6)).toContain("déjà traité");
    const scores = Object.fromEntries(CRITERIA.map((c) => [c, { score: 6, why: "fait vérifié et sourcé" }]));
    upsertIdea(db.raw, { id: "fin", title: "Finaliste", problem: "p", scores }, t0);
    expect(channel.handleOwnerText("/choisis fin", 7)).toContain("n'est pas une finaliste proposée");
    expect(channel.handleOwnerText("/ecarte fin trop risqué", 8)).toBe("Idée fin écartée (trop risqué). Le bot ne la reprendra pas.");
    expect(wakes()).toContain("Idée fin écartée par le propriétaire");
    expect(channel.handleOwnerText("/aide", 9)).toContain("/go <n>");
    expect(channel.handleOwnerText("/aide plus", 10)).toContain("/publie <id> [lien]");
    const health = buildHealthReport(db.raw, vpsConfig().moneyLab!, { now: t0, home: tmp("h-") }).text;
    expect(health).not.toContain("kit(s) à publier");
    draftKit(db.raw, kitInput({ body: `Autre angle pour un autre lieu : ${kitInput().body}` }), new Date("2026-10-07T11:00:00Z"));
    expect(buildHealthReport(db.raw, vpsConfig().moneyLab!, { now: t0, home: tmp("h-") }).text).toContain("1 kit(s) à publier (/kits)");
    db.close();
  });
});
