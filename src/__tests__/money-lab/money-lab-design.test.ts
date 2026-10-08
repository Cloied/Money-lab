/**
 * Money Lab design toolkit (owner request 2026-10-07): the bundled kit and
 * skill, check_design in a real headless Chrome, the Opus design review
 * with screenshots, the free first-impression test. Network access is
 * stubbed; the browser only opens pages served from this test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import { ensureMoneyLabSchema, setKV } from "../../money-lab/journal.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity } from "../mocks.js";
import { findBrowser } from "../../money-lab/selfhosted.js";
import { checkDesign, designReview, firstImpression, formatDesignCheck } from "../../money-lab/design.js";
import { DESIGN_KIT_DIR, installBundledAssets, syncBundle } from "../../money-lab/assets.js";
import { IMAGE_PRESETS } from "../../money-lab/image.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";
import { parseSkillMd } from "../../skills/format.js";
import { createInferenceClient } from "../../conway/inference.js";
import { RUNTIME_ROOT } from "../../money-lab/guard.js";

const PW_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = findBrowser({ PATH: process.env.PATH, MONEY_LAB_BROWSER: PW_CHROME });

function vpsConfig(): AutomatonConfig {
  return applyMoneyLabProfile(createTestConfig({
    moneyLab: {
      enabled: true, profile: "first-run", runtime: "self-hosted",
      telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", ownerChatId: 42 }, stripe: null,
      inference: { model: "claude-sonnet-5-5", effort: "medium", perCallCents: null, hourlyCents: null, dailyCents: 300, maxOutputTokens: 16000 },
      payments: "disabled", paymentLimits: { perPaymentCents: null, dailyCents: null }, deniedTools: [],
      maxTurnsPerCycle: null, noProgressCycles: 5, noProgressSleepMinutes: 120,
      resources: [], funding: { currency: "USD", provisionedCents: 2000, heldBackCents: 0 },
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
  const db = createDatabase(path.join(tmp("money-lab-design-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}

/** Serves one HTML page; images are 1x1 PNGs or a heavy blob. */
async function servePage(html: string): Promise<{ url: string; close: () => void }> {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/heavy.png")) {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(400_000) });
      res.end(Buffer.concat([png, Buffer.alloc(400_000 - png.length)]));
      return;
    }
    if (req.url?.endsWith(".png")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

const BAD_PAGE = `<html><head><title></title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:Arial}.wide{width:600px}.tiny{display:inline-block;width:20px;height:20px}p{color:#aaa;background:#fff}</style></head>
<body><div class="wide"><h1>Factures</h1><h1>Encore</h1><p>Texte gris clair peu lisible sur blanc.</p>
<a class="tiny" href="#">x</a><img src="/heavy.png"><img src="/a.png"><input type="text"></div><script>console.error("boom")</script></body></html>`;

const GOOD_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Devis plombier gratuit</title><meta name="description" content="Faites un devis de plomberie clair en 2 minutes."><link rel="icon" href="/favicon.png">
<meta property="og:image" content="/og.png"><style>body{margin:0;font-family:system-ui;color:#15181e;background:#fff}main{padding:2rem;max-width:40rem}a.button{display:inline-block;padding:1rem 2rem;background:#1f4fd6;color:#fff;border-radius:.5rem;text-decoration:none}</style></head>
<body><header><a href="/">Devizo</a></header><main><h1>Un devis de plomberie clair en 2 minutes</h1><p>Pour les artisans plombiers qui perdent des soirées sur Excel.</p><a class="button" href="#outil">Créer mon devis</a><img src="/a.png" alt="Exemple de devis"></main></body></html>`;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network access in a mocked test"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("Design kit and skill", () => {
  it("ships a valid skill, a base stylesheet, six themes and templates", () => {
    const skill = parseSkillMd(fs.readFileSync(path.join(RUNTIME_ROOT, "money-lab/skills/money-lab-design/SKILL.md"), "utf-8"), "SKILL.md");
    expect(skill?.name).toBe("money-lab-design");
    expect(skill?.instructions).toMatch(/check_design[\s\S]*first_impression[\s\S]*design_review/);
    const kit = path.join(RUNTIME_ROOT, "money-lab/design-kit");
    expect(fs.readdirSync(path.join(kit, "themes")).filter((f) => f.endsWith(".css"))).toHaveLength(6);
    const base = fs.readFileSync(path.join(kit, "base.css"), "utf-8");
    expect(base).toMatch(/--space-7/);
    expect(base).toMatch(/prefers-color-scheme: dark/);
    expect(base).toMatch(/@media print/);
    for (const t of ["tool.html", "landing.html"]) {
      const html = fs.readFileSync(path.join(kit, "templates", t), "utf-8");
      expect(html).toMatch(/<meta name="viewport"/);
      expect(html).toMatch(/base\.css/);
    }
    expect(IMAGE_PRESETS.favicon).toEqual([512, 512]);
  });

  it("installs the kit and skills into the agent's home, refreshes changed bundled files only", () => {
    const home = tmp("money-lab-home-");
    const skills = path.join(home, ".automaton", "skills");
    const first = installBundledAssets(home, skills);
    expect(first.skills).toEqual(expect.arrayContaining(["money-lab-strategy", "money-lab-design"]));
    expect(first.kit).toEqual(expect.arrayContaining(["base.css", "themes/sober.css", "templates/tool.html"]));
    expect(fs.existsSync(path.join(skills, "money-lab-design", "SKILL.md"))).toBe(true);
    // The agent edits a kit file and adds its own: an unchanged bundle leaves both alone.
    const own = path.join(home, DESIGN_KIT_DIR, "notes.md");
    fs.writeFileSync(own, "ma palette");
    const base = path.join(home, DESIGN_KIT_DIR, "base.css");
    fs.appendFileSync(base, "\n/* mine */");
    const second = installBundledAssets(home, skills);
    expect(second.kit).toEqual([]);
    expect(fs.readFileSync(base, "utf-8")).toMatch(/mine/);
    expect(fs.existsSync(own)).toBe(true);
    // A changed bundled file is refreshed; a symbolic link at the target is replaced, not followed.
    const src = tmp("bundle-src-");
    fs.writeFileSync(path.join(src, "x.css"), "v1");
    const dst = tmp("bundle-dst-");
    expect(syncBundle(src, dst)).toEqual(["x.css"]);
    fs.writeFileSync(path.join(src, "x.css"), "v2");
    const victim = path.join(tmp("victim-"), "secret");
    fs.writeFileSync(victim, "keep");
    fs.rmSync(path.join(dst, "x.css"));
    fs.symlinkSync(victim, path.join(dst, "x.css"));
    expect(syncBundle(src, dst)).toEqual(["x.css"]);
    expect(fs.readFileSync(victim, "utf-8")).toBe("keep");
    expect(fs.lstatSync(path.join(dst, "x.css")).isSymbolicLink()).toBe(false);
  });

  it("tells the agent about the kit and the three checks", () => {
    const db = openDb();
    const previous = process.env.MONEY_LAB_BROWSER;
    process.env.MONEY_LAB_BROWSER = browser ?? process.execPath;
    try {
      // 2026-10-08: the building half of the rules appears once the owner chose a proposal.
      expect(buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!)).toMatch(/Building, design and publishing tools are hidden until the owner chooses/);
      const at = new Date().toISOString();
      setKV(db.raw, "money_lab.proposals", JSON.stringify({ seq: 1, items: [{ n: 1, slug: "p1", title: "P1", status: "chosen", deliveredAt: at, createdAt: at, updatedAt: at }] }));
      expect(buildMoneyLabPromptBlock(db.raw, vpsConfig().moneyLab!)).toMatch(/money-lab-design\/SKILL\.md[\s\S]*~\/library\/design[\s\S]*check_design[\s\S]*design_review final: true/);
    } finally {
      if (previous === undefined) delete process.env.MONEY_LAB_BROWSER; else process.env.MONEY_LAB_BROWSER = previous;
      db.close();
    }
  });
});

describe.skipIf(!browser)("check_design in a real browser", () => {
  it("finds the classic mistakes and returns both screenshots", async () => {
    const home = tmp("money-lab-home-");
    const page = await servePage(BAD_PAGE);
    try {
      const check = await checkDesign(page.url, { browser: browser!, home });
      expect(typeof check).toBe("object");
      const c = check as Exclude<typeof check, string>;
      const text = formatDesignCheck(c);
      expect(text).toMatch(/ERROR: No <title>/);
      expect(text).toMatch(/ERROR: Horizontal overflow on mobile/);
      expect(text).toMatch(/2 <h1> headings/);
      expect(text).toMatch(/Tap targets under 40px/);
      expect(text).toMatch(/Image without alt/);
      expect(text).toMatch(/Heavy image \(\d{3} KB\)/);
      expect(text).toMatch(/Console error: boom/);
      expect(text).toMatch(/No lang attribute/);
      // axe-core ran: the light grey text fails contrast, the input has no label.
      expect(text).toMatch(/contrast/i);
      expect(text).toMatch(/label/i);
      expect(text).toMatch(/\[\[image:.*-desktop\.png\]\]\n\[\[image:.*-mobile\.png\]\]$/);
      for (const shot of Object.values(c.screenshots)) expect(fs.statSync(shot).size).toBeGreaterThan(1000);
      expect(c.aboveFold).toContain("Factures");
    } finally {
      page.close();
    }
  }, 60_000);

  it("passes a well-built page and feeds Opus the screenshots as images", async () => {
    const home = tmp("money-lab-home-");
    const page = await servePage(GOOD_PAGE);
    try {
      const check = await checkDesign(page.url, { browser: browser!, home });
      const c = check as Exclude<typeof check, string>;
      expect(c.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(c.title).toBe("Devis plombier gratuit");
      expect(c.aboveFold).toContain("Un devis de plomberie clair en 2 minutes");

      // The review request carries two image blocks, built by the Anthropic client from the markers.
      const bodies: any[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5",
          content: [{ type: "text", text: "Verdict: FIX FIRST\nScores (0-10): hierarchy 6\nTop fixes:\n1. Agrandir le titre" }],
          stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 80 } }), { status: 200, headers: { "content-type": "application/json" } });
      }));
      const client = createInferenceClient({
        apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-opus-5-5", maxTokens: 2000,
        anthropicApiKey: "sk-ant-test", getModelProvider: () => "anthropic",
      });
      const router = {
        route: async (request: any, chat: any) => {
          const response = await chat(request.messages, { model: request.model, maxTokens: request.maxTokens });
          return { content: response.message.content, model: request.model, provider: "anthropic", inputTokens: 3000, outputTokens: 80, costCents: 7, latencyMs: 1, finishReason: "stop" };
        },
      };
      const review = await designReview(c, "page outil pour plombiers", { router, chat: (m, o) => client.chat(m, o), sessionId: "s" });
      expect(review.text).toMatch(/^Verdict: FIX FIRST[\s\S]*\[design review: claude-opus-5-5, 7c\]$/);
      const images = bodies[0].messages[0].content.filter((b: any) => b.type === "image");
      expect(images).toHaveLength(2);
      expect(images[0].source.media_type).toBe("image/png");
      expect(JSON.stringify(bodies[0].messages)).not.toContain("[[image:");
      expect(JSON.stringify(bodies[0].system)).toMatch(/senior product designer/);
      expect(bodies[0].messages[0].content[0].text).toMatch(/^Page: http/);
    } finally {
      page.close();
    }
  }, 60_000);

  it("runs the first-impression test on the above-the-fold text through harvest", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    const page = await servePage(GOOD_PAGE);
    try {
      const check = await checkDesign(page.url, { browser: browser!, home });
      const routed: any[] = [];
      const router = { route: async (request: any) => { routed.push(request); return { content: "1) Des devis de plomberie. 2) Plombiers.", model: request.model, provider: "anthropic", inputTokens: 1, outputTokens: 1, costCents: 1, latencyMs: 1, finishReason: "stop" }; } };
      const result = await firstImpression(check as any, { db: db.raw, home, router, chat: async () => ({}), sessionId: "s" });
      expect(result.text).toMatch(/^First impression \(five-second test\):\n1\) Des devis de plomberie/);
      // No free model configured here: Haiku fallback, with the page text only.
      expect(routed[0].model).toBe("claude-haiku-4-5");
      expect(routed[0].messages[1].content).toContain("Un devis de plomberie clair en 2 minutes");
    } finally {
      page.close();
      db.close();
    }
  }, 60_000);

  it("is offered as tools that refuse bad URLs", async () => {
    const db = openDb();
    const ctx: ToolContext = { identity: { ...createTestIdentity(), sandboxId: "" }, config: vpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const call = (name: string, args: Record<string, unknown>) => executeTool(name, args, createMoneyLabTools(), ctx, new PolicyEngine(db.raw, createDefaultRules()),
      { inputSource: "agent", turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) }).then((r) => r.result || r.error || "");
    const previous = process.env.MONEY_LAB_BROWSER;
    process.env.MONEY_LAB_BROWSER = browser!;
    try {
      expect(await call("check_design", { url: "ftp://x" })).toMatch(/Only http\(s\)/);
      expect(await call("design_review", { url: "https://example.org" })).toMatch(/not available in this runtime/);
      expect(await call("first_impression", { url: "nope" })).toMatch(/Invalid URL/);
    } finally {
      if (previous === undefined) delete process.env.MONEY_LAB_BROWSER; else process.env.MONEY_LAB_BROWSER = previous;
      db.close();
    }
  });
});
