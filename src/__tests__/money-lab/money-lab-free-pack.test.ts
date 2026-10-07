/**
 * Money Lab free capability pack (step 5a): embeddings and semantic recall,
 * free vision review, Jina Reader page reading, IndexNow, scaffold extras.
 * Every network call is stubbed.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AutomatonDatabase } from "../../types.js";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema } from "../../money-lab/journal.js";
import { embeddingProviders, freeEmbeddings, freeImageChat, freeAiUsageToday } from "../../money-lab/freeai.js";
import { cosine, semanticRecall } from "../../money-lab/embeddings.js";
import { fetchPage } from "../../money-lab/delegate.js";
import { indexNowKey, indexNowKeyLocation, submitIndexNow } from "../../money-lab/indexnow.js";
import { scaffoldSite } from "../../money-lab/workshop.js";
import { designReviewFree } from "../../money-lab/design.js";
import { runLocalCommand } from "../../money-lab/selfhosted.js";
import { RUNTIME_ROOT } from "../../money-lab/guard.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp("money-lab-pack-"), "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Toy embedding: a direction per topic word, so similar texts point the same way. */
function toyVector(text: string): number[] {
  const t = text.toLowerCase();
  return [Number(/plomb|devis|artisan/.test(t)), Number(/cuisine|recette|crêpe/.test(t)), Number(/impôt|fiscal|tax/.test(t)), 0.1];
}

describe("Free embeddings and semantic recall", () => {
  it("embeds through Gemini's OpenAI-style endpoint, caches passages and blends meaning with words", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    fs.mkdirSync(path.join(home, "research"), { recursive: true });
    fs.writeFileSync(path.join(home, "research", "artisans.md"), "Les artisans du bâtiment cherchent un outil de devis simple.\nLe prix moyen d'une intervention est 80 €.\n");
    fs.writeFileSync(path.join(home, "research", "cuisine.md"), "Recette de crêpes: farine, lait, oeufs.\nTemps de cuisson 2 minutes.\n");
    const embedCalls: any[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      const u = String(url);
      if (/generativelanguage.*\/embeddings$/.test(u)) {
        const body = JSON.parse(String(init?.body));
        embedCalls.push(body);
        expect(body.model).toBe("gemini-embedding-001");
        return json({ data: body.input.map((text: string, index: number) => ({ index, embedding: toyVector(text) })) });
      }
      return new Response("?", { status: 404 });
    }) as any;
    const env = { GEMINI_API_KEY: "AIza-test", GH_TOKEN: "ghp_secret0123456789abcdefghijklmnopqrs" };
    expect(embeddingProviders(env)).toEqual(["gemini"]);
    const direct = await freeEmbeddings(["devis plombier", "recette crêpes"], { db: db.raw, env, fetchFn });
    expect(direct).toMatchObject({ provider: "gemini", model: "gemini-embedding-001" });
    expect(direct!.vectors).toHaveLength(2);
    expect(cosine(direct!.vectors[0], toyVector("artisan devis"))).toBeGreaterThan(0.9);

    // A query about plumbers' quotes finds the artisans note first, by meaning and words.
    const first = await semanticRecall("outil pour plombiers", { home, db: db.raw, env, fetchFn, limit: 3 });
    expect(first.mode).toBe("semantic");
    expect(first.provider).toBe("gemini gemini-embedding-001");
    expect(first.embedded).toBeGreaterThan(0);
    expect(first.hits[0].source).toBe("~/research/artisans.md");
    const indexed = (db.raw.prepare("SELECT COUNT(*) AS n FROM money_lab_embeddings").get() as { n: number }).n;
    expect(indexed).toBe(first.embedded);
    // Second search: the passages are cached, only the query is embedded.
    const before = embedCalls.length;
    const second = await semanticRecall("crêpes", { home, db: db.raw, env, fetchFn, limit: 3 });
    expect(second.embedded).toBe(0);
    expect(embedCalls.length).toBe(before + 1);
    expect(embedCalls.at(-1).input).toEqual(["crêpes"]);
    expect(second.hits[0].source).toBe("~/research/cuisine.md");
    expect(freeAiUsageToday(db.raw).calls).toBeGreaterThan(2);
    // No provider: lexical only.
    const lexical = await semanticRecall("devis", { home, db: db.raw, env: {}, fetchFn, limit: 3 });
    expect(lexical.mode).toBe("lexical");
    expect(lexical.hits[0].source).toBe("~/research/artisans.md");
    db.close();
  });
});

describe("Free vision review", () => {
  it("sends the screenshots as data URLs to Gemini and labels the free review", async () => {
    const db = openDb();
    const home = tmp("money-lab-home-");
    fs.mkdirSync(path.join(home, ".money-lab", "screenshots"), { recursive: true });
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    fs.writeFileSync(path.join(home, ".money-lab", "screenshots", "d.png"), png);
    fs.writeFileSync(path.join(home, ".money-lab", "screenshots", "m.png"), png);
    let sent: any = null;
    const fetchFn = (async (url: any, init?: RequestInit) => {
      const u = String(url);
      if (/generativelanguage.*\/models$/.test(u)) return json({ data: [{ id: "models/gemini-2.5-flash" }] });
      if (/generativelanguage.*chat\/completions$/.test(u)) {
        sent = JSON.parse(String(init?.body));
        return json({ choices: [{ message: { role: "assistant", content: "Scores: hierarchy 7/10\nVerdict: FIX FIRST" } }] });
      }
      return new Response("?", { status: 404 });
    }) as any;
    const check = {
      url: "https://lab.github.io/x/", title: "X", findings: [{ severity: "warning", text: "low contrast" }] as any, aboveFold: "Un outil",
      fonts: ["Inter"], weightBytes: 120_000, screenshots: { desktop: path.join(home, ".money-lab", "screenshots", "d.png"), mobile: "~/.money-lab/screenshots/m.png" },
    };
    const review = await designReviewFree(check as any, "simple et sobre", { db: db.raw, home, env: { GEMINI_API_KEY: "AIza" }, fetchFn });
    expect(review).toMatchObject({ provider: "gemini gemini-2.5-flash" });
    expect(review!.text).toContain("Verdict: FIX FIRST\n[design review: gemini gemini-2.5-flash, free]");
    const content = sent.messages[1].content;
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[0].text).toContain("simple et sobre");
    expect(content).toHaveLength(3);
    expect(content[1].image_url.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    // No vision provider configured: the caller falls back to Opus.
    expect(await designReviewFree(check as any, "", { db: db.raw, home, env: { GROQ_API_KEY: "gsk" }, fetchFn })).toBeNull();
    expect(await freeImageChat("s", "u", ["/etc/passwd"], { db: db.raw, home, env: { GEMINI_API_KEY: "AIza" }, fetchFn })).toBeNull();
    db.close();
  });
});

describe("Jina Reader", () => {
  it("reads pages through r.jina.ai with the optional key, falls back to a direct fetch, skips local and raw files", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
      if (u.startsWith("https://r.jina.ai/https://site.example/ok")) return new Response("Title: Ok\n\nMarkdown text of the page that is long enough to count as content.");
      if (u.startsWith("https://r.jina.ai/")) return new Response("slow down", { status: 429 });
      return new Response("<html><body><h1>Direct</h1><p>Fallback body text</p></body></html>", { headers: { "content-type": "text/html" } });
    }) as any;
    const viaReader = await fetchPage("https://site.example/ok", fetchFn, { JINA_API_KEY: "jina_test" });
    expect(viaReader).toContain("Markdown text of the page");
    expect(calls[0].url).toBe("https://r.jina.ai/https://site.example/ok");
    expect(calls[0].headers.authorization).toBe("Bearer jina_test");
    expect(calls[0].headers["x-return-format"]).toBe("markdown");
    const fallback = await fetchPage("https://site.example/limited", fetchFn, {});
    expect(fallback).toBe("Direct\nFallback body text");
    expect(calls.filter((c) => /limited/.test(c.url)).map((c) => c.url)).toEqual(["https://r.jina.ai/https://site.example/limited", "https://site.example/limited"]);
    const n = calls.length;
    await fetchPage("http://127.0.0.1:8765/", fetchFn, {});
    await fetchPage("https://site.example/data.json", fetchFn, {});
    await fetchPage("https://site.example/direct", fetchFn, { MONEY_LAB_READER: "direct" });
    expect(calls.slice(n).every((c) => !c.url.startsWith("https://r.jina.ai/"))).toBe(true);
  });
});

describe("IndexNow and scaffold extras", () => {
  it("derives a stable key, places the key file under the site folder, submits URLs and reports the status", async () => {
    const key = indexNowKey("MoneyLabOrg.github.io", {});
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(indexNowKey("moneylaborg.github.io", {})).toBe(key);
    expect(indexNowKey("x", { MONEY_LAB_INDEXNOW_KEY: "my-fixed-key-123" })).toBe("my-fixed-key-123");
    expect(indexNowKeyLocation(new URL("https://moneylaborg.github.io/devis/page.html"), {})).toBe(`https://moneylaborg.github.io/devis/${key}.txt`);
    const bodies: any[] = [];
    const fetchFn = (async (_url: any, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response("", { status: bodies.length === 1 ? 202 : 422 }); }) as any;
    expect(await submitIndexNow(["https://moneylaborg.github.io/devis/", "https://other.example/x", "https://moneylaborg.github.io/devis/faq/"], { fetchFn, env: {} }))
      .toBe("IndexNow: 2 URL(s) submitted to Bing, Yandex and partners (HTTP 202).");
    expect(bodies[0]).toEqual({ host: "moneylaborg.github.io", key, keyLocation: `https://moneylaborg.github.io/devis/${key}.txt`, urlList: ["https://moneylaborg.github.io/devis/", "https://moneylaborg.github.io/devis/faq/"] });
    expect(await submitIndexNow(["https://moneylaborg.github.io/devis/"], { fetchFn, env: {} })).toContain("key file not found");
    expect(await submitIndexNow([], { fetchFn })).toContain("nothing to submit");
  });

  it("scaffold_site writes the IndexNow key file and the Cloudflare Web Analytics snippet", async () => {
    const home = tmp("money-lab-home-");
    const kit = path.join(RUNTIME_ROOT, "money-lab", "design-kit");
    const run = (c: string, t: number, e: NodeJS.ProcessEnv) => runLocalCommand(c, t, { ...e, PATH: process.env.PATH });
    const text = await scaffoldSite({ name: "notaire", title: "Frais de notaire", description: "Calcul détaillé." },
      { home, kitDir: kit, run, env: { HOME: home, GITHUB_ORG: "MoneyLabOrg", CF_WEB_ANALYTICS_TOKEN: "abc123def" } });
    const key = indexNowKey("moneylaborg.github.io", {});
    expect(text).toContain(`${key}.txt (IndexNow key)`);
    expect(text).toContain("Analytics snippet included (Cloudflare Web Analytics).");
    expect(fs.readFileSync(path.join(home, "sites", "notaire", `${key}.txt`), "utf-8")).toBe(key);
    const html = fs.readFileSync(path.join(home, "sites", "notaire", "index.html"), "utf-8");
    expect(html).toContain(`data-cf-beacon='{"token": "abc123def"}'`);
    expect(createMoneyLabTools().map((t) => t.name)).toContain("free_services");
  });
});
