---
name: money-lab-strategy
description: Research opportunities, run a small portfolio of staged experiments, review weekly and compound what works
auto-activate: true
---
# Money Lab strategy

Suggestions are optional hypotheses, not tasks or rankings. Ignore them when evidence points elsewhere.

## Choose: the funnel (wide, cheap, measured)
1. Call `money_lab_status` and `recall` first. Reuse prior evidence before new research.
2. **Universe**: `niche_scan seeds` lists categories of needs (professions, procedures, life moments,
   obligations, data, repetitive tasks) in French and English. Pick categories, then expand each seed
   into 5-10 concrete search intents with `harvest` (free): what people would type.
3. **Scan**: `niche_scan scan` on batches of up to 25 phrases. The score is a fixed formula on counted
   signals (suggestions, commercial intent, audience, discussion, open-source alternatives), not your
   opinion. `niche_scan list` ranks everything scanned. `niche_scan reject` drops a niche with the
   reason so it is never studied twice.
4. **Study** the top 20-30 with `market_signals` and `harvest` (competitors, prices, weaknesses, the
   channel you control). Keep 8; record each as an idea (`idea update`) with scored criteria and
   evidence. The channel is mandatory: search on your domain, your GitHub organization, Bluesky, or
   publication kits the owner posts.
5. **Probe** before building: for the best 3-5 ideas, build one useful page in a day (`scaffold_site`,
   `test_site`, `check_design`), publish it under the Search Console property, add it to the sitemap, and
   register it with `probe add` (2-8 target searches, idea_id). Search Console decides after 14 days
   (50 impressions by default). Probes do not count as experiments; a passing probe becomes evidence
   on its idea; the runtime wakes you when one is decided.
6. **Build** only from a passing probe or an idea Opus approved (`idea decide approve`), through
   `record_experiment` (status `exploring`, then `building`). At most 3 active experiments, each cheap to
   keep alive, each build under five days.

## Research sessions
- Use `free_search` (Tavily, free, when the owner configured it) before `web_search`, and `web_fetch` or
  `harvest` to read, to study demand (what people search for, ask about, complain about), competitors
  (features, prices, weaknesses) and channels. Save findings with sources and dates in `~/research/`;
  your context window forgets, your files do not.
- French market facts come from official data: `france_data companies` (how many businesses in a trade
  and area, Sirene), `france_data law` (what a product or claim must respect, Légifrance),
  `france_data address` (places). Cite them with their date.
- Spend on research in proportion to the decision it informs; declare it with `set_budget_focus`.

## Stages
For each experiment, set numeric criteria and a review window before building:
1. Traffic: real visitors from a permitted channel (e.g. N visits/week from search).
2. Usage: visitors actually use it (e.g. share of visits that complete the main action).
3. Revenue: someone pays, or a monetization source pays out.
Invest more in what passes a stage; kill what stalls after its window and record why in ~/LESSONS.md.

## Build
- Quality is the product: check every page with `view_page` (desktop, mobile, and print for anything
  people print or save as PDF) and compare with the best competitor before shipping.
- Reuse and grow your library (`~/library`: components, templates, scripts) and turn procedures that
  worked into skills, so each product is faster and better than the last.
- Prefer ordinary deterministic software and browser-side processing. Not every user action needs an LLM.
- Do not assume every PDF/Office conversion works reliably in a browser; test it.
- Start free. Do not add payments or ads before a free version shows genuine use.
- Publish static sites in your own GitHub organization when you have credentials (git, gh, GitHub
  Pages). Pay for services only within the owner's price caps; record every cost with `record_experiment`.
- Accounts that need a human (email/phone verification, CAPTCHA, identity, payment/ad accounts): ask with
  `request_help` (exact human action, cost, resume condition), then sleep. Never fake identities or
  bypass platform controls.

## Distribute through the owner (publication kits)
Search takes weeks; the owner can bring the first visitors in days, if you make it effortless.
- One kit = one venue, with `publish_kit draft`: platform, the exact URL where to post, title, the full
  text in the venue's language, your tracked link, an image if the venue shows one, the venue's rules
  (read them first with `harvest`: self-promotion days, flair, format, what gets removed) and what the
  reader gains. The owner pastes, posts in their own name, answers `/publie <id> <link>` or `/passe`.
  When the owner configured dev.to or Mastodon, a kit named for that platform is posted by the runtime
  itself after `/publie <id>` (nothing to paste): dev.to for build stories in English (markdown, up to
  4 tags), Mastodon for short posts (500 characters).
- Value first: a useful answer, a free tool that solves the thread's problem, a data point. Never the
  same text twice, never a bare link, never where the rules forbid it. At most 3 kits a day.
- Where audiences gather: tool directories (Product Hunt, AlternativeTo, SaaSHub, BetaList, Toolify for
  AI tools), subreddits of the trade or the problem (r/vosfinances, r/conseiljuridique, r/entrepreneur,
  r/smallbusiness, r/webdev), French forums (Comment Ça Marche, Les Numériques, forum.hardware.fr,
  JeChange, Compta Online), LinkedIn and Facebook groups by profession, Discord and Slack communities,
  newsletters that accept submissions, Hacker News "Show HN" for developer tools, dev.to and Indie
  Hackers for build stories. Find the specific ones for a niche with `harvest` and `market_signals`.
- Measure: visits from a kit arrive with the referrer `kit-<id>` in your analytics. A venue that brings
  real usage deserves a second, different post later; one that brings nothing is noted and dropped.

## Decisions at fixed points (Opus, on measured numbers)
1. **Shortlist** (`idea shortlist`, once a week, 8+ scored ideas): Opus picks up to 5 ideas to probe
   and rejects the ones not worth it. Build and register those probes first.
2. **Probe → product**: when a probe passes, `idea decide approve`. The owner sees the finalist on
   Telegram for 24 h (`/choisis`, `/ecarte`); then Opus decides on the dossier and the probe numbers.
3. **Continue or stop**: at the weekly review, and whenever you propose to stop an active experiment
   (`record_experiment` with your reason in result); Opus confirms or overrules.

## Observe
- Set a review date that fits the channel: days for direct offers, weeks for organic search or ads.
  The review date does not authorize more spending.
- Record metrics with `record_experiment`. Separate genuine independent usage from your own tests,
  owner traffic and gifts. Zero visitors is an acquisition result, not proof of zero demand.
- Estimated ad income is not cash. Provider-confirmed revenue and money received are reported by the operator.
- No unsolicited automated messages, fabricated engagement, generated clicks or mass low-value SEO pages.

## Stop
Mark the experiment `finished` with a result. Stop active spending; delete sandboxes you no longer need,
keep a low-cost artifact only if it is worth its hosting cost, and record any delivery or refund obligations.
