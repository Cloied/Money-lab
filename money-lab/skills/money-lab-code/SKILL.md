---
name: money-lab-code
description: Build web tools fast and soundly; reuse permissively licensed code, scaffold from the kit, test in a real browser, review before publishing; a catalogue of proven libraries
auto-activate: false
---
# Money Lab code workshop

Every product should be faster and better than the last. The order is always the same:
**reuse, scaffold, build, test, review, publish.** Writing from scratch is the last resort.

## 1. Reuse before writing (free)
- `recall` first (by words and by meaning): your own library (`~/library`, `~/library/vendor/INDEX.md`)
  may already have it.
- `free_services find <need>`: a free service or API for hosting, data, e-mail, forms, maps, monitoring,
  payments or search, from free-for-dev and public-apis; `free_services search` looks in what you saved.
- `repo_scout`: search GitHub by what the code must do ("pdf merge browser", "invoice generator
  javascript", "cron expression parser"). Keep repositories that are maintained (pushed within two
  years), used (stars) and **permissively licensed** (MIT, Apache-2.0, BSD, ISC). GPL/AGPL and
  unlicensed code is for reading only, never for copying.
- `vendor_code owner/name [paths]`: copies the repository, or only the files you need, into
  `~/library/vendor/<name>` with a NOTICE.md (source, commit, licence). Keep that notice and the
  LICENSE file with anything you derive from it. Never run install scripts or binaries from a copy:
  read it, understand it, reuse it.
- Prefer small, dependency-free pieces you can read in an hour over frameworks.

## 2. Scaffold (one call)
`scaffold_site name title description [template theme lang h1 lede brand contact_email publish]`
creates `~/sites/<name>` from the design kit: index.html with your texts and metadata, local
design files, site.css, an about page, 404, robots.txt, sitemap.xml, analytics snippet, README
with the publishing commands, and a git repository. Then:
1. Replace every placeholder (fields, FAQ answers, "Exemple") with real content; one main action.
2. `render_image` presets `favicon` and `og` into the site directory.
3. Put the tool's logic in a small `app.js`: plain JavaScript, no framework for a static page,
   processing in the browser when the data is personal (nothing leaves the visitor's machine).

## 2b. When a page needs a server: a Worker (free)
A static page cannot save a form, count votes, keep a waitlist or answer an API call. When the
owner configured Cloudflare, `deploy_worker` publishes a small JavaScript server for free
(100,000 requests a day) at `https://<name>.<account>.workers.dev`, with `kv: true` (key-value
store, `env.KV`) or `d1: true` (SQLite, `env.DB`, `schema: "schema.sql"`). Nothing to open on
your VPS: the Pages site calls the Worker URL.
- Write `~/workers/<name>/worker.js` in module syntax:
  ```js
  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const cors = { "access-control-allow-origin": "https://<your-site>.pages.dev",
        "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
      if (request.method === "OPTIONS") return new Response(null, { headers: cors });
      if (url.pathname === "/count" && request.method === "POST") {
        const n = Number(await env.KV.get("count")) + 1;
        await env.KV.put("count", String(n));
        return Response.json({ count: n }, { headers: cors });
      }
      if (url.pathname === "/waitlist" && request.method === "POST") {
        const { email } = await request.json().catch(() => ({}));
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return Response.json({ error: "email" }, { status: 400, headers: cors });
        await env.KV.put(`wait:${email.toLowerCase()}`, new Date().toISOString());
        return Response.json({ ok: true }, { headers: cors });
      }
      return new Response("ok", { headers: cors });
    },
  };
  ```
- Rules: validate every input, cap sizes (`request.headers.get("content-length")`), rate-limit by
  IP with KV when a route writes, never store more than the product needs (privacy: an e-mail is
  personal data, say what you do with it on the page), no model calls, no secrets (the runtime
  refuses them). Test with `curl -X POST <url>/count` after deploying, then `test_site` on the page.
- Reading the data back: `curl <url>/export` guarded by a token you generate? No: the Worker has no
  secrets. Instead write an admin route that only lists aggregates (counts), and keep raw data
  reads for `wrangler kv key list` through `deploy_worker list` plus the owner's dashboard.

## 3. Build well
- Deterministic code first: a calculator, a converter or a generator does not need an LLM.
- Validate inputs, show clear states (loading, success, error with what to do), keep the keyboard
  working, never use `innerHTML` with user data.
- Heavy work (PDF, images, spreadsheets) runs in the browser with the libraries below; test the
  real file types people will bring.
- Record reusable pieces (a result card, a form pattern, a formula) in `~/library/` with a short
  README so `recall` finds them next time.

## 4. Test (free)
- Serve the site locally: `cd ~/sites/<name> && nohup python3 -m http.server 8765 > /dev/null 2>&1 &`
- `test_site http://127.0.0.1:8765/ steps:[...]`: your scenario (fill, click, expect_text), then the
  crawl. Fix every failed step, console error and broken link. Run it again on mobile (`mobile: true`).
- `check_design` (accessibility, overflow, tap targets), `first_impression`, `audit_page` 90+.

## 5. Review, then publish
- `code_review files:[index.html, app.js]`: the free models list bugs, security and accessibility
  problems with a fix each. Fix what is real; note what you leave and why.
- `design_review` once per page before it goes live. Then publish: GitHub Pages (README commands or
  `scaffold_site publish`) or `deploy_site name` to Cloudflare Pages (`<name>.pages.dev`, when the
  owner configured it; one host per site, redeploy the same name to update). Run `test_site` on the
  live URL, add it to `monitor_site`, tell Bing with `bing_webmaster submit` when configured, and
  read visits later with `web_analytics` (Cloudflare) or GoatCounter.

## Catalogue: proven libraries to start from (check the licence page once)
All run in the browser unless noted; licences as of 2026, verify before copying.
- **PDF**: pdf-lib (MIT: create, merge, fill forms), pdf.js / pdfjs-dist (Apache-2.0: render, extract
  text), jsPDF (MIT: generate from HTML or data), pdfmake (MIT: documents from a JSON layout).
- **Images**: browser-image-compression (MIT), Squoosh codecs (Apache-2.0), html2canvas (MIT:
  screenshot of an element), Cropper.js (MIT), heic2any (MIT: iPhone photos).
- **Spreadsheets and CSV**: SheetJS community edition (Apache-2.0: read and write xlsx), Papa Parse
  (MIT: CSV), ExcelJS (MIT: write xlsx with styles).
- **Documents and text**: docx (MIT: generate Word files), marked (MIT: Markdown), DOMPurify
  (Apache-2.0/MPL-2.0 dual: sanitize HTML), diff (BSD-3: text differences), Fuse.js (Apache-2.0: fuzzy search).
- **Numbers, dates, money**: decimal.js (MIT: exact money arithmetic), Day.js and Luxon (MIT: dates),
  mathjs (Apache-2.0: formulas and units), currency.js (MIT).
- **Codes and files**: qrcode / node-qrcode (MIT: QR codes), JsBarcode (MIT), JSZip (MIT or GPLv3
  dual: zip in the browser), FileSaver.js (MIT: download a generated file), Tesseract.js (Apache-2.0: OCR, heavy).
- **Charts and maps**: Chart.js (MIT), uPlot (MIT, tiny), Leaflet (BSD-2 : maps with OpenStreetMap tiles,
  respect the tile policy), Plotly.js (MIT, heavy).
- **UI without a framework**: Pico CSS (MIT: classless), Open Props (MIT: design tokens), Alpine.js (MIT:
  small interactivity), htmx (0BSD), Shoelace / Web Awesome (MIT: web components), Tabulator (MIT: tables).
- **Static site generators** when a site has many pages: Eleventy (MIT), Astro (MIT); plain HTML is
  enough for a tool page.
- **Icons and illustration**: Lucide (ISC), Tabler Icons (MIT), Heroicons (MIT), unDraw (own free
  licence, recolour), Simple Icons (CC0, brand marks: respect each brand's rules).
- **Server-side (your VPS)**: Python standard library first; FastAPI (MIT) when you need an API;
  SQLite (public domain) for data; Playwright (Apache-2.0) for rendering and PDFs; APScheduler (MIT) or
  `schedule_job` for timers. Nothing is reachable from the internet until the owner opens a port.
- **Data sources**: open data portals (data.gouv.fr, INSEE, Eurostat, data.gov), Wikidata (CC0),
  Open-Meteo (CC BY 4.0, weather without a key), Nominatim (ODbL, usage policy), exchange rates from
  the ECB (free). Cite the source and its date on the page.

Record what you learn about a library (what it does well, its traps) in `~/library/notes.md`.
