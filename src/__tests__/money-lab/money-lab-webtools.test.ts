/**
 * Money Lab free-first web tools: the paid Anthropic web_search and
 * web_fetch are removed from requests once Tavily and free models exist.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createInferenceClient } from "../../conway/inference.js";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, setKV } from "../../money-lab/journal.js";
import { describeWebTools, webToolsPolicy } from "../../money-lab/webtools.js";
import { SERVICE_DAILY_CAPS, markServiceDown, serviceAvailable, takeServiceQuota, tavilySearch } from "../../money-lab/services.js";

let tmpDirs: string[] = [];
function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-webtools-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  return db;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("Web tools policy", () => {
  it("keeps both paid tools without free alternatives, drops each one as its free replacement appears, honours the override", () => {
    expect(webToolsPolicy({})).toMatchObject({ search: true, fetch: true });
    expect(webToolsPolicy({ TAVILY_API_KEY: "tvly-x" })).toMatchObject({ search: false, fetch: true });
    const both = webToolsPolicy({ TAVILY_API_KEY: "tvly-x", GROQ_API_KEY: "gsk_x" });
    expect(both).toMatchObject({ search: false, fetch: false });
    expect(both.reason).toContain("Tavily");
    expect(both.reason).toContain("free models");
    expect(webToolsPolicy({ GEMINI_API_KEY: "AIza" })).toMatchObject({ search: true, fetch: false });
    expect(webToolsPolicy({ TAVILY_API_KEY: "tvly-x", GROQ_API_KEY: "gsk_x", MONEY_LAB_WEB_TOOLS: "anthropic" })).toMatchObject({ search: true, fetch: true });
    expect(webToolsPolicy({ MONEY_LAB_WEB_TOOLS: "off" })).toMatchObject({ search: false, fetch: false });
    expect(describeWebTools({ search: true, fetch: true, reason: "" })).toContain("web_search and web_fetch tools");
    const text = describeWebTools({ search: false, fetch: false, reason: "" });
    expect(text).toContain("free_search (Tavily) searches the web for free; the paid web_search is off");
    expect(text).toContain("harvest and delegate read pages for free");
  });

  it("brings the paid tools back while the free equivalent is unavailable: quota, refusal, resting models", async () => {
    const db = openDb();
    const env = { TAVILY_API_KEY: "tvly-x", GROQ_API_KEY: "gsk_x" };
    const now = new Date("2026-10-08T10:00:00Z");
    expect(webToolsPolicy({ env, db: db.raw, now })).toMatchObject({ search: false, fetch: false });
    // Tavily's daily cap used up: web_search is back until the next UTC day.
    for (let i = 0; i < SERVICE_DAILY_CAPS.tavily; i++) takeServiceQuota(db.raw, "tavily", now);
    const capped = webToolsPolicy({ env, db: db.raw, now });
    expect(capped).toMatchObject({ search: true, fetch: false });
    expect(capped.reason).toContain("Tavily is out of quota or refused");
    expect(webToolsPolicy({ env, db: db.raw, now: new Date("2026-10-09T00:01:00Z") })).toMatchObject({ search: false });
    // A refused key marks Tavily down until midnight UTC; a rate limit for an hour.
    const db2 = openDb();
    const refused = (async () => new Response('{"detail":"Unauthorized"}', { status: 401 })) as any;
    await expect(tavilySearch({ query: "x" }, { env, fetchFn: refused, db: db2.raw, now })).rejects.toThrow("Tavily HTTP 401");
    expect(serviceAvailable(db2.raw, "tavily", env, now)).toBe(false);
    expect(serviceAvailable(db2.raw, "tavily", env, new Date("2026-10-08T23:59:00Z"))).toBe(false);
    expect(serviceAvailable(db2.raw, "tavily", env, new Date("2026-10-09T00:00:01Z"))).toBe(true);
    expect(webToolsPolicy({ env, db: db2.raw, now })).toMatchObject({ search: true, fetch: false });
    const db3 = openDb();
    markServiceDown(db3.raw, "tavily", now.getTime() + 3_600_000, "rate limit");
    expect(serviceAvailable(db3.raw, "tavily", env, new Date(now.getTime() + 3_500_000))).toBe(false);
    expect(serviceAvailable(db3.raw, "tavily", env, new Date(now.getTime() + 3_700_000))).toBe(true);
    // Every free model resting: web_fetch is back until the cooldown ends.
    setKV(db3.raw, "money_lab.freeai", JSON.stringify({ providers: { groq: { cooldownUntil: now.getTime() + 600_000, lastError: "rate limit" } }, usage: {} }));
    const resting = webToolsPolicy({ env, db: db3.raw, now });
    expect(resting).toMatchObject({ search: true, fetch: true });
    expect(resting.reason).toContain("every free model is resting or out of quota");
    expect(describeWebTools(resting)).toContain("while the free models are unavailable");
    expect(webToolsPolicy({ env, db: db3.raw, now: new Date(now.getTime() + 601_000) })).toMatchObject({ fetch: false });
    // A second configured provider keeps web_fetch off while the first rests.
    expect(webToolsPolicy({ env: { ...env, GEMINI_API_KEY: "AIza" }, db: db3.raw, now })).toMatchObject({ fetch: false });
  });

  it("attaches only the wanted server tools to Anthropic requests, resolving a function per request", async () => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => reply({
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
    }));
    const tools = [{ type: "function", function: { name: "exec", description: "run", parameters: { type: "object", properties: {} } } }] as any;
    const bodyOf = (i: number) => JSON.parse(String((fetchSpy.mock.calls[i] as [string, RequestInit])[1].body));
    const client = (webTools: any) => createInferenceClient({
      apiUrl: "https://api.conway.tech", apiKey: "", defaultModel: "claude-sonnet-5-5", maxTokens: 1000,
      anthropicApiKey: "sk-ant-test", getModelProvider: () => "anthropic", anthropicWebTools: webTools,
    });
    await client({ search: false, fetch: false }).chat([{ role: "user", content: "x" }], { tools } as any);
    expect(bodyOf(0).tools.map((t: any) => t.type ?? t.name)).toEqual(["exec"]);
    await client({ search: false, fetch: true }).chat([{ role: "user", content: "x" }], { tools } as any);
    expect(bodyOf(1).tools.map((t: any) => t.type ?? t.name)).toEqual(["web_fetch_20260209", "exec"]);
    await client(true).chat([{ role: "user", content: "x" }], { tools } as any);
    expect(bodyOf(2).tools.map((t: any) => t.type ?? t.name)).toEqual(["web_search_20260209", "web_fetch_20260209", "exec"]);
    await client(undefined).chat([{ role: "user", content: "x" }], { tools } as any);
    expect(bodyOf(3).tools.map((t: any) => t.type ?? t.name)).toEqual(["exec"]);
    let searchOn = false;
    const dynamic = client(() => ({ search: searchOn, fetch: false }));
    await dynamic.chat([{ role: "user", content: "x" }], { tools } as any);
    expect(bodyOf(4).tools.map((t: any) => t.type ?? t.name)).toEqual(["exec"]);
    searchOn = true;
    await dynamic.chat([{ role: "user", content: "x" }], { tools } as any);
    expect(bodyOf(5).tools.map((t: any) => t.type ?? t.name)).toEqual(["web_search_20260209", "exec"]);
  });
});
