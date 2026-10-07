/**
 * Money Lab code workshop: repo_scout, vendor_code, scaffold_site, test_site.
 * GitHub is stubbed; vendoring clones a local repository; test_site runs the
 * bundled Chromium against a local server when it is installed.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { licenseVerdict, repoScout, scaffoldSite, testSite, vendorCode } from "../../money-lab/workshop.js";
import { findBrowser, runLocalCommand } from "../../money-lab/selfhosted.js";
import { RUNTIME_ROOT } from "../../money-lab/guard.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { parseSkillMd } from "../../skills/format.js";

const PW_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = findBrowser({ PATH: process.env.PATH, MONEY_LAB_BROWSER: PW_CHROME });

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const run = (c: string, t: number, e: NodeJS.ProcessEnv) => runLocalCommand(c, t, { ...e, PATH: process.env.PATH });

describe("repo_scout", () => {
  it("ranks reusable licences first, reads READMEs, caches a day and saves to a dataset", async () => {
    const home = tmp("money-lab-ws-");
    const calls: string[] = [];
    const fetchFn = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (/search\/repositories/.test(url)) {
        expect(decodeURIComponent(url)).toContain("pdf merge language:javascript stars:>=50 pushed:>=2024-10-07 archived:false");
        return json({ items: [
          { full_name: "x/gpl-tool", html_url: "https://github.com/x/gpl-tool", stargazers_count: 9000, pushed_at: "2026-09-01T00:00:00Z", license: { spdx_id: "GPL-3.0" }, description: "copyleft", topics: [] },
          { full_name: "y/pdf-lib", html_url: "https://github.com/y/pdf-lib", stargazers_count: 7000, pushed_at: "2026-08-01T00:00:00Z", license: { spdx_id: "MIT" }, description: "Create and modify PDFs", topics: ["pdf", "javascript"] },
          { full_name: "z/no-licence", html_url: "https://github.com/z/no-licence", stargazers_count: 100, pushed_at: "2026-01-01T00:00:00Z", license: null, description: "", topics: [] },
        ] });
      }
      if (/repos\/y\/pdf-lib\/readme/.test(url)) return new Response("# pdf-lib\n\nCreate PDFs in <b>any</b> JS environment.\n\n\n\nnpm i pdf-lib");
      return new Response("not found", { status: 404 });
    }) as any;
    const summaries: string[] = [];
    const text = await repoScout({ query: "pdf merge", language: "javascript", saveTo: "repos" }, {
      home, fetchFn, env: { GH_TOKEN: "ghp_x" }, now: new Date("2026-10-07T12:00:00Z"),
      summarize: async (readme, repo) => { summaries.push(repo); expect(readme).not.toContain("<b>"); return `Résumé ${repo}`; },
    });
    expect(text.indexOf("y/pdf-lib")).toBeLessThan(text.indexOf("x/gpl-tool"));
    expect(text).toContain("MIT: reusable with attribution");
    expect(text).toContain("GPL-3.0: not reusable here");
    expect(text).toContain("no licence detected: do not copy");
    expect(text).toContain("README y/pdf-lib:\nRésumé y/pdf-lib");
    expect(summaries).toEqual(["y/pdf-lib"]);
    expect(text).toContain("[saved to dataset repos]");
    const again = await repoScout({ query: "pdf merge", language: "javascript" }, { home, fetchFn, now: new Date("2026-10-07T13:00:00Z") });
    expect(again).toContain("[repo_scout: cached");
    expect(calls.filter((u) => /search/.test(u))).toHaveLength(1);
    expect(licenseVerdict("MPL-2.0").ok).toBe(false);
    expect(licenseVerdict("Apache-2.0").ok).toBe(true);
  });
});

describe("vendor_code", () => {
  it("clones a permissive repository without credentials, copies chosen paths, writes NOTICE and INDEX, refuses GPL", async () => {
    const home = tmp("money-lab-ws-");
    const upstream = path.join(tmp("money-lab-up-"), "lib");
    fs.mkdirSync(path.join(upstream, "src"), { recursive: true });
    fs.mkdirSync(path.join(upstream, "node_modules", "junk"), { recursive: true });
    fs.writeFileSync(path.join(upstream, "src", "merge.js"), "export const merge = () => 1;\n");
    fs.writeFileSync(path.join(upstream, "node_modules", "junk", "index.js"), "junk");
    fs.writeFileSync(path.join(upstream, "LICENSE"), "MIT License");
    fs.writeFileSync(path.join(upstream, "README.md"), "# lib");
    fs.symlinkSync("/etc/passwd", path.join(upstream, "src", "evil"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: upstream, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git(["init", "-q", "-b", "main"]); git(["add", "-A"]); git(["commit", "-q", "-m", "init"]);
    const fetchFn = (async (input: any) => {
      const url = String(input);
      if (/repos\/acme\/lib$/.test(url)) return json({ license: { spdx_id: "MIT" }, size: 12, private: false, description: "Merge things" });
      if (/repos\/acme\/gpl$/.test(url)) return json({ license: { spdx_id: "GPL-3.0" }, size: 12 });
      return new Response("nope", { status: 404 });
    }) as any;
    const seenEnv: NodeJS.ProcessEnv[] = [];
    const spyRun = (c: string, t: number, e: NodeJS.ProcessEnv) => { seenEnv.push(e); return run(c, t, e); };
    const text = await vendorCode({ repo: "https://github.com/acme/lib", paths: ["src", "missing.txt"] }, {
      home, fetchFn, run: spyRun, cloneUrl: () => upstream, env: { GH_TOKEN: "ghp_secret", HOME: home }, now: new Date("2026-10-07T00:00:00Z"),
    });
    expect(text).toMatch(/^Copied 1 files from acme\/lib \(MIT\) into ~\/library\/vendor\/lib/);
    expect(text).toContain("missing.txt (not found)");
    expect(seenEnv.every((e) => !e.GH_TOKEN)).toBe(true);
    const dest = path.join(home, "library", "vendor", "lib");
    expect(fs.readFileSync(path.join(dest, "src", "merge.js"), "utf-8")).toContain("merge");
    expect(fs.existsSync(path.join(dest, "src", "evil"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "LICENSE"))).toBe(true);
    const notice = fs.readFileSync(path.join(dest, "NOTICE.md"), "utf-8");
    expect(notice).toMatch(/Source: https:\/\/github.com\/acme\/lib \(commit [0-9a-f]{40}\)/);
    expect(notice).toContain("Licence: MIT");
    expect(notice).toContain("paths src, missing.txt; 1 files");
    expect(fs.readFileSync(path.join(home, "library", "vendor", "INDEX.md"), "utf-8")).toContain("- lib: acme/lib (MIT, 2026-10-07) — Merge things");
    expect(await vendorCode({ repo: "acme/lib" }, { home, fetchFn, run, cloneUrl: () => upstream })).toContain("exists already");
    expect(await vendorCode({ repo: "acme/gpl" }, { home, fetchFn, run, cloneUrl: () => upstream })).toMatch(/^Not copied: acme\/gpl — GPL-3.0: not reusable/);
    expect(await vendorCode({ repo: "bad name" }, { home, fetchFn, run })).toContain("repo must be owner/name");
  });
});

describe("scaffold_site", () => {
  const kit = path.join(RUNTIME_ROOT, "money-lab", "design-kit");

  it("creates a French site from the kit with texts, metadata, pages, sitemap and a git repository", async () => {
    const home = tmp("money-lab-ws-");
    const text = await scaffoldSite({
      name: "devis-plombier", title: "Devis plombier en 2 minutes", description: "Un devis clair pour vos clients.", h1: "Votre devis en deux minutes",
      lede: "Pour les plombiers indépendants.", brand: "DevisPro", contactEmail: "contact@devispro.fr", theme: "warm",
    }, { home, kitDir: kit, run, env: { HOME: home, GITHUB_ORG: "MoneyLabOrg", GOATCOUNTER_SITE: "moneylab" }, now: new Date("2026-10-07T00:00:00Z") });
    expect(text).toMatch(/^Site ~\/sites\/devis-plombier created \(tool template, theme warm, fr\)/);
    expect(text).toContain("Analytics snippet included.");
    const dir = path.join(home, "sites", "devis-plombier");
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain("<title>Devis plombier en 2 minutes</title>");
    expect(html).toContain('content="Un devis clair pour vos clients."');
    expect(html).toContain("<h1>Votre devis en deux minutes</h1>");
    expect(html).toContain('<p class="lede">Pour les plombiers indépendants.</p>');
    expect(html).toContain('href="design/themes/warm.css"');
    expect(html).toContain("© 2026 DevisPro");
    expect(html).toContain("mailto:contact@devispro.fr");
    expect(html).toContain('https://moneylaborg.github.io/devis-plombier/og.png');
    expect(html).toContain('data-goatcounter="https://moneylab.goatcounter.com/count"');
    expect(html).not.toContain("Marque");
    for (const f of ["site.css", "design/base.css", "design/themes/warm.css", "a-propos/index.html", "404.html", "robots.txt", "sitemap.xml", ".nojekyll", "README.md"]) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, "sitemap.xml"), "utf-8")).toContain("<loc>https://moneylaborg.github.io/devis-plombier/a-propos/</loc>");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf-8")).toContain("gh repo create MoneyLabOrg/devis-plombier --public --source=. --push");
    expect(execFileSync("git", ["-C", dir, "log", "--oneline"]).toString()).toContain("Scaffold devis-plombier");
    expect(await scaffoldSite({ name: "devis-plombier", title: "t", description: "d" }, { home, kitDir: kit, run })).toContain("exists already");
    expect(await scaffoldSite({ name: "Bad Name", title: "t", description: "d" }, { home, kitDir: kit, run })).toContain("name must be lowercase");
  });

  it("translates the template's fixed strings for an English site and declines to publish without credentials", async () => {
    const home = tmp("money-lab-ws-");
    const text = await scaffoldSite({ name: "cron-helper", title: "Cron helper", description: "Read cron lines.", lang: "en", template: "tool", publish: true },
      { home, kitDir: kit, run, env: { HOME: home } });
    const html = fs.readFileSync(path.join(home, "sites", "cron-helper", "index.html"), "utf-8");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("How it works");
    expect(html).toContain("Free · no sign-up");
    expect(html).not.toMatch(/Comment ça marche|Gratuit|Calculer|Nous écrire/);
    expect(html).toContain('href="/about/"');
    expect(fs.existsSync(path.join(home, "sites", "cron-helper", "about", "index.html"))).toBe(true);
    expect(text).toContain("not published: no GitHub organization or token");
    expect(text).toContain("No analytics token: no snippet.");
  });
});

describe("test_site", () => {
  it.skipIf(!browser)("runs a scenario, reports failed steps with a screenshot, console errors and broken links", async () => {
    const home = tmp("money-lab-ws-");
    const server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1>Calc</h1><input id="n"><button id="go" onclick="document.getElementById('out').textContent = 'Résultat ' + (Number(document.getElementById('n').value) * 2)">Go</button>
          <p id="out"></p><a href="/about">About</a><a href="/missing">Missing</a><img src="/nope.png" alt=""><script>console.error("boom")</script></body></html>`);
      } else if (req.url === "/about") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>About</h1><a href='/'>Home</a>");
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      const text = await testSite({
        url: `http://127.0.0.1:${port}/`,
        steps: [
          { action: "fill", selector: "#n", value: "21" }, { action: "click", selector: "#go" },
          { action: "expect_text", selector: "#out", value: "Résultat 42" }, { action: "expect_text", selector: "#out", value: "Résultat 99" },
        ],
      }, { home, env: { PATH: process.env.PATH, MONEY_LAB_BROWSER: browser! }, now: new Date("2026-10-07T00:00:00Z") });
      expect(text).toMatch(/^test_site FAIL \(1 step\)/);
      expect(text).toContain('✓ 4. expect_text #out "Résultat 42"');
      expect(text).toMatch(/✗ 5\. expect_text #out "Résultat 99" — text not found; got "Résultat 42" \(screenshot ~\/\.money-lab\/tests\/2026-10-07T00-00-00-step5\.png\)/);
      expect(fs.existsSync(path.join(home, ".money-lab", "tests", "2026-10-07T00-00-00-step5.png"))).toBe(true);
      expect(text).toMatch(/Crawl: 3 page\(s\) visited; broken links:\n {2}404 http:\/\/127\.0\.0\.1:\d+\/missing/);
      expect(text).toContain("! Broken images: /nope.png");
      expect(text).toContain("! Console errors (1): boom");
      expect(text).toMatch(/! Failed requests \(\d+\): 404/);
      const ok = await testSite({ url: `http://127.0.0.1:${port}/about`, crawl: false, mobile: true }, { home, env: { PATH: process.env.PATH, MONEY_LAB_BROWSER: browser! } });
      expect(ok).toMatch(/^test_site PASS — http:\/\/127\.0\.0\.1:\d+\/about \(mobile 390px\)/);
    } finally {
      server.close();
    }
  }, 60_000);

  it("ships the code skill and exposes the five workshop tools", () => {
    const skill = parseSkillMd(fs.readFileSync(path.join(RUNTIME_ROOT, "money-lab/skills/money-lab-code/SKILL.md"), "utf-8"), "SKILL.md");
    expect(skill?.name).toBe("money-lab-code");
    const names = createMoneyLabTools().map((t) => t.name);
    for (const n of ["repo_scout", "vendor_code", "scaffold_site", "test_site", "code_review"]) expect(names).toContain(n);
  });
});
