/**
 * Money Lab design tools
 *
 * A site must look trustworthy to be used and to rank; the agent gets
 * three ways to judge its pages without a designer:
 * - check_design: free, mechanical checks in the server's Chrome: axe-core
 *   accessibility violations (contrast included), horizontal overflow on
 *   mobile, small tap targets, heavy or alt-less images, font count, missing
 *   viewport or title, heading structure, console errors, page weight; with
 *   desktop and mobile screenshots the agent sees;
 * - design_review: Claude Opus looks at both screenshots and the page text
 *   like a demanding client and returns scores, precise fixes and a
 *   SHIP / FIX FIRST verdict (a few cents, budgeted router);
 * - first_impression: a free model reads what a visitor sees above the fold
 *   for five seconds and says what it understood (the message test).
 */

import fs from "fs";
import path from "path";
import { chromium, type Page } from "playwright-core";
import type Database from "better-sqlite3";
import type { DelegateRouter } from "./delegate.js";
import { RUNTIME_ROOT } from "./guard.js";
import { REVIEW_MODEL } from "./review.js";
import { scrubbedEnv } from "./selfhosted.js";
import { harvest } from "./freeai.js";

const VIEWPORTS = { desktop: { width: 1280, height: 1600 }, mobile: { width: 390, height: 844 } } as const;
const KEEP_SHOTS = 30;
const HEAVY_IMAGE_BYTES = 300_000;
const HEAVY_PAGE_BYTES = 1_500_000;
const MIN_TAP_PX = 40;

export interface DesignFinding {
  severity: "error" | "warning" | "info";
  text: string;
}

export interface DesignCheck {
  url: string;
  title: string;
  findings: DesignFinding[];
  screenshots: { desktop: string; mobile: string };
  /** Visible text near the top of the page, for the first-impression test and the review. */
  aboveFold: string;
  fonts: string[];
  weightBytes: number;
}

function axeSource(): string | null {
  const candidates = [
    path.join(RUNTIME_ROOT, "node_modules", "axe-core", "axe.min.js"),
  ];
  for (const file of candidates) if (fs.existsSync(file)) return fs.readFileSync(file, "utf-8");
  return null;
}

function shotsDir(home: string): string {
  return path.join(home, ".money-lab", "screenshots");
}

/** Mechanical facts about the rendered page, collected inside the browser. */
async function pageFacts(page: Page): Promise<any> {
  return page.evaluate(() => {
    const doc = document;
    const vw = doc.documentElement.clientWidth;
    const overflow = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0) - vw;
    const interactive = Array.from(doc.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [role=button]"));
    const small = interactive.filter((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && (r.width < 40 || r.height < 40) && r.top < 3000;
    }).slice(0, 6).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`);
    const images = Array.from(doc.images).map((img) => ({
      src: img.currentSrc || img.src, alt: img.getAttribute("alt"), w: img.naturalWidth, h: img.naturalHeight, dw: img.clientWidth,
    }));
    const fonts = new Set<string>();
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("body, body *")).slice(0, 1500)) {
      const f = getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      if (f && getComputedStyle(el).display !== "none") fonts.add(f);
    }
    const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) => h.tagName.toLowerCase());
    const texts: string[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && texts.join(" ").length < 1500) {
      const parent = (node as Text).parentElement;
      if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
      const r = parent.getBoundingClientRect();
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (t && r.top < 900 && r.bottom > 0 && getComputedStyle(parent).visibility !== "hidden") texts.push(t);
    }
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const weight = resources.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0) +
      ((performance.getEntriesByType("navigation")[0] as PerformanceResourceTiming | undefined)?.transferSize ?? 0);
    const main = doc.querySelector("main, [role=main]");
    const cta = doc.querySelectorAll("a.button, a.btn, button, [class*=cta], [class*=button]").length;
    return {
      title: doc.title, lang: doc.documentElement.lang, viewport: !!doc.querySelector('meta[name="viewport"]'),
      description: doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      ogImage: !!doc.querySelector('meta[property="og:image"]'), favicon: !!doc.querySelector('link[rel~="icon"]'),
      overflow, small, images, fonts: [...fonts], headings, aboveFold: texts.join(" | ").slice(0, 1500), weight, hasMain: !!main, cta,
      bodyBg: getComputedStyle(doc.body).backgroundColor,
    };
  });
}

export async function checkDesign(
  url: string,
  options: { browser: string; home: string; now?: Date },
): Promise<DesignCheck | string> {
  const now = options.now ?? new Date();
  const dir = shotsDir(options.home);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${now.getTime()}-design`);
  const shots = { desktop: `${base}-desktop.png`, mobile: `${base}-mobile.png` };
  const findings: DesignFinding[] = [];
  const axe = axeSource();
  let title = "";
  let aboveFold = "";
  let fonts: string[] = [];
  let weightBytes = 0;
  const consoleErrors: string[] = [];
  const instance = await chromium.launch({
    executablePath: options.browser, headless: true, args: ["--no-sandbox", "--disable-gpu"], env: scrubbedEnv() as Record<string, string>,
  });
  try {
    for (const [name, viewport] of Object.entries(VIEWPORTS) as Array<[keyof typeof VIEWPORTS, { width: number; height: number }]>) {
      const page = await instance.newPage({ viewport, deviceScaleFactor: 1, ...(name === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
      page.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < 5) consoleErrors.push(m.text().slice(0, 120)); });
      page.on("pageerror", (e) => { if (consoleErrors.length < 5) consoleErrors.push(String(e.message).slice(0, 120)); });
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch((e) => { throw new Error(`page did not load: ${String(e?.message ?? e).split("\n")[0]}`); });
      if (resp && resp.status() >= 400) return `The page answers HTTP ${resp.status()}.`;
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await page.evaluate(() => (document.fonts?.ready ?? Promise.resolve())).catch(() => undefined);
      const facts = await pageFacts(page);
      await page.screenshot({ path: shots[name], clip: { x: 0, y: 0, ...viewport }, type: "png" });
      if (name === "desktop") {
        title = facts.title;
        aboveFold = facts.aboveFold;
        fonts = facts.fonts;
        weightBytes = facts.weight;
        if (!facts.title) findings.push({ severity: "error", text: "No <title>: search results and browser tabs show nothing." });
        if (!facts.description) findings.push({ severity: "warning", text: "No meta description (Google writes its own, usually worse)." });
        if (!facts.viewport) findings.push({ severity: "error", text: "No viewport meta tag: the page renders as a desktop page on phones." });
        if (!facts.lang) findings.push({ severity: "warning", text: "No lang attribute on <html>: screen readers and Google cannot tell the language." });
        if (!facts.favicon) findings.push({ severity: "warning", text: "No favicon: render one (render_image preset favicon) and link it." });
        if (!facts.ogImage) findings.push({ severity: "warning", text: "No og:image: links shared on social networks show no preview (render_image preset og)." });
        const h1 = facts.headings.filter((h: string) => h === "h1").length;
        if (h1 !== 1) findings.push({ severity: "warning", text: `${h1} <h1> headings (exactly one expected).` });
        if (facts.fonts.length > 3) findings.push({ severity: "warning", text: `${facts.fonts.length} font families in use (${facts.fonts.slice(0, 5).join(", ")}): two is the rule.` });
        if (facts.weight > HEAVY_PAGE_BYTES) findings.push({ severity: "warning", text: `Page weight ${Math.round(facts.weight / 1000)} KB: aim under 1,000 KB (compress images, drop unused scripts).` });
        if (facts.cta === 0) findings.push({ severity: "info", text: "No visible button or call to action found: a page needs one clear main action." });
        for (const img of facts.images.slice(0, 40)) {
          if (img.alt === null) findings.push({ severity: "warning", text: `Image without alt: ${String(img.src).slice(-60)}` });
          if (img.w && img.dw && img.w > img.dw * 2 && img.w > 800) findings.push({ severity: "info", text: `Image ${String(img.src).slice(-50)} is ${img.w}px wide but shown at ${img.dw}px: resize it.` });
        }
        // Heavy images: sizes from the resource timings.
        const sizes = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
          .filter((r) => r.initiatorType === "img" || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(r.name))
          .map((r) => ({ name: r.name, size: r.transferSize || r.encodedBodySize || 0 })));
        for (const r of sizes) if (r.size > HEAVY_IMAGE_BYTES) findings.push({ severity: "warning", text: `Heavy image (${Math.round(r.size / 1000)} KB): ${r.name.slice(-60)}. Convert to WebP or resize.` });
      } else {
        if (facts.overflow > 2) findings.push({ severity: "error", text: `Horizontal overflow on mobile: content is ${facts.overflow}px wider than the screen (visitors must scroll sideways).` });
        if (facts.small.length) findings.push({ severity: "warning", text: `Tap targets under ${MIN_TAP_PX}px on mobile: ${facts.small.join("; ")}.` });
      }
      if (axe) {
        try {
          await page.addScriptTag({ content: axe });
          const result: any = await page.evaluate(() => (window as any).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] }, resultTypes: ["violations"],
          }));
          for (const v of (result?.violations ?? []) as any[]) {
            const nodes = (v.nodes ?? []).slice(0, 2).map((n: any) => String(n.target?.[0] ?? "").slice(0, 60)).join(", ");
            findings.push({
              severity: ["critical", "serious"].includes(v.impact) ? "error" : "warning",
              text: `[${name}] ${v.help} (${v.impact}, ${v.nodes?.length ?? 0} element${(v.nodes?.length ?? 0) > 1 ? "s" : ""}: ${nodes}). ${v.helpUrl}`,
            });
          }
        } catch (err: any) {
          findings.push({ severity: "info", text: `axe-core did not run on ${name}: ${String(err?.message ?? err).slice(0, 100)}` });
        }
      }
      await page.close();
    }
  } catch (err: any) {
    return `check_design failed: ${String(err?.message ?? err).slice(0, 300)}`;
  } finally {
    await instance.close();
  }
  for (const e of consoleErrors) findings.push({ severity: "warning", text: `Console error: ${e}` });
  const old = fs.readdirSync(shotsDir(options.home)).filter((f) => f.endsWith(".png")).sort().slice(0, -KEEP_SHOTS);
  for (const f of old) fs.rmSync(path.join(shotsDir(options.home), f), { force: true });
  // The same text twice (desktop and mobile axe runs) reads as one finding.
  const seen = new Set<string>();
  const unique = findings.filter((f) => { const key = f.text.replace(/^\[(desktop|mobile)\] /, ""); if (seen.has(key)) return false; seen.add(key); return true; });
  return { url, title, findings: unique, screenshots: shots, aboveFold, fonts, weightBytes };
}

export function formatDesignCheck(check: DesignCheck): string {
  const by = (s: DesignFinding["severity"]) => check.findings.filter((f) => f.severity === s);
  const lines = [
    `Design check of ${check.url} ("${check.title || "no title"}"): ${by("error").length} errors, ${by("warning").length} warnings, ${by("info").length} notes. ` +
      `Fonts: ${check.fonts.slice(0, 4).join(", ") || "?"}. Weight: ${Math.round(check.weightBytes / 1000)} KB.`,
    ...by("error").map((f) => `- ERROR: ${f.text}`),
    ...by("warning").map((f) => `- warning: ${f.text}`),
    ...by("info").map((f) => `- note: ${f.text}`),
    check.findings.length === 0 ? "No mechanical issue found. Now judge the design itself (design_review) and the message (first_impression)." : "",
    `Desktop and mobile screenshots attached below: look at hierarchy, spacing, alignment and what shows above the fold.`,
    `[[image:${check.screenshots.desktop}]]`,
    `[[image:${check.screenshots.mobile}]]`,
  ].filter(Boolean);
  return lines.join("\n").slice(0, 9500);
}

// ─── Opus design review ─────────────────────────────────────────

const REVIEW_SYSTEM = `You are a senior product designer reviewing a web page built by an autonomous agent with no
designer. The agent's pages must look trustworthy and professional while staying simple, fast and
original (not a clone of common templates). You see a desktop screenshot, a mobile screenshot, the
page's visible text and automatic check results. Be concrete: name the element, say what to change
and to what (sizes, spacing, colours, wording). Praise only what is genuinely good.

Answer in under 450 words, in this exact structure:
Verdict: SHIP | FIX FIRST
Scores (0-10): hierarchy, typography, spacing, colour, consistency, originality, trust, clarity of message, mobile
Top fixes: (numbered, most impact first, 3-7 items, each with the exact change)
Keep: (what works, 1-3 bullets)
Distinctive element: (what makes this page recognisable, or "none: add one")`;

export async function designReview(
  check: DesignCheck,
  context: string,
  options: { router: DelegateRouter; chat: (messages: any[], options: any) => Promise<any>; sessionId: string },
): Promise<{ text: string; costCents: number }> {
  const findings = check.findings.slice(0, 15).map((f) => `- ${f.severity}: ${f.text.slice(0, 200)}`).join("\n") || "- none";
  const user = [
    `Page: ${check.url}`,
    `Title: ${check.title || "none"}`,
    context ? `What the agent wants to achieve with this page: ${context}` : "",
    `Visible text near the top: ${check.aboveFold || "(none)"}`,
    `Fonts: ${check.fonts.join(", ") || "?"}; weight ${Math.round(check.weightBytes / 1000)} KB.`,
    `Automatic check results:\n${findings}`,
    "Desktop screenshot:",
    `[[image:${check.screenshots.desktop}]]`,
    "Mobile screenshot:",
    `[[image:${check.screenshots.mobile}]]`,
  ].filter(Boolean).join("\n");
  const result = await options.router.route(
    {
      messages: [{ role: "system", content: REVIEW_SYSTEM }, { role: "user", content: user }],
      taskType: "planning",
      tier: "normal",
      sessionId: options.sessionId,
      maxTokens: 1800,
      model: REVIEW_MODEL,
    },
    options.chat,
  );
  if (!["stop", "length", "end_turn"].includes(result.finishReason) || !result.content.trim()) {
    return { text: `Design review not done (${result.finishReason}): ${result.content.slice(0, 200)}`, costCents: result.costCents };
  }
  return { text: `${result.content.trim()}\n[design review: ${result.model}, ${result.costCents}c]`, costCents: result.costCents };
}

// ─── First impression (free model) ──────────────────────────────

export async function firstImpression(
  check: DesignCheck,
  options: { db: Database.Database; home: string; router?: DelegateRouter; chat?: (messages: any[], options: any) => Promise<any>; sessionId: string },
): Promise<{ text: string; costCents: number }> {
  if (!check.aboveFold) return { text: "No visible text above the fold: the page shows nothing before scrolling.", costCents: 0 };
  const task = "You are a first-time visitor who sees only this text for five seconds. Answer in 4 short lines: " +
    "1) What does this site do? 2) Who is it for? 3) What would you click first, and why? 4) One thing that confuses " +
    "you or makes you distrust it. If you cannot answer 1 or 2 from the text, say so plainly.";
  const result = await harvest(
    { task, text: `Page title: ${check.title}\n\nText a visitor sees first:\n${check.aboveFold}`, fresh: true },
    { db: options.db, home: options.home, router: options.router, chat: options.chat, sessionId: options.sessionId },
  );
  return { text: `First impression (five-second test):\n${result.text}`, costCents: result.costCents };
}
