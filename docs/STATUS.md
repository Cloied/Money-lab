# Working status
- Updated: 2026-10-08
- Branch / commit: claude/money-lab-first-run-bezu7x (packs 5a and 5b on main a8b75bc, Likma adoption merged), on upstream Automaton d8f816881fd24b6f5e3d616e59edec387a447667 (0.2.1)
- Security hardening (2026-10-08, Likma 0.12.0): removed the unused direct dependency simple-git (critical
  advisories fixed only in 4.x; nothing in the repository imports it); new `deps` check (`pnpm audit --prod
  --audit-level critical`: 0 critical, 9 high and 17 moderate remain, all transitive via lighthouse/puppeteer and
  @solana/web3.js); TruffleHog secret scan in CI (.github/workflows/secrets.yml, pinned v3.97.0); Claude Code deny
  rules for .claude/, .git/hooks/, .mcp.json, .env*; `agent_isolation` records that the Claude Code sandbox cannot
  run in cloud containers (no bubblewrap, tested) or on Windows. Checks after the change: deps, types, build pass;
  money-lab suite and upstream suite pass (likma project check); feature evidence unaffected (no scope changed).
- Current goal: self-hosted VPS runtime (Claude Sonnet 5.5, Telegram, Stripe, survival goal); development only, no launch.
- Accepted decisions:
  - Thin extension under src/money-lab/ plus narrow upstream patches; inert without a moneyLab block.
  - Owner decision 2026-10-04: maximum freedom, only replication forbidden; optional price caps
    (inference per call/hour/day, payments per payment/day); payments allowed or disabled by the owner.
  - Journal in the existing state.db; operator CLI and Telegram with French output.
  - Owner decision 2026-10-04: Conway Cloud closed; run self-hosted on a VPS; Claude Sonnet 5.5; Stripe revenue sync; survival as the bot's ultimate goal.
  - No start command configured: starting runs the agent and requires owner approval.
- Completed behaviour: profile, spend guards, experiment/help journal, operator ledger, pause/resume,
  status/summary, no-progress sleep, integration note, Conway checklist; 23 of 24 features verified on
  2026-10-07 (docs/FEATURES.md), privilege-drop built without a test.
- Checks run (command, result, date):
  - 2026-10-07, migration to Likma 0.8.1 (Node 22.22.0, pnpm 10.28.1 via corepack), no network or payment:
    - `corepack enable pnpm && pnpm install --frozen-lockfile`: done.
    - `likma project check` (all six labels, report .likma/checks/77b5d83c19344ffaa0b6058c4a80aa7e.json): PASS
      - types `pnpm run typecheck`: pass (7 s)
      - money-lab `pnpm exec vitest run src/__tests__/money-lab`: 4 files, 145/145 pass (69 s)
      - build `pnpm run build`: pass (16 s)
      - e2e `node money-lab/e2e/run.mjs harness` (build, then harness.mjs): PASS, no findings (183 s);
        history cache 9/13 consecutive requests reuse the previous history
      - chaos `node money-lab/e2e/run.mjs chaos` (build, then chaos.mjs): PASS, no findings (73 s)
      - upstream `pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts`: 67 files, 1761/1761 pass (80 s)
    - `likma project feature verify` for 20 of 21 features (before the merge) (each re-ran its mapped checks: money-lab 145/145
      every time, build, e2e PASS, chaos PASS): all verified with fingerprint v3 evidence (docs/FEATURES.md).
    - `likma project audit`: PASS, 0 failures (bot_guards map every guard to a test).
  - 2026-10-07, after merging main 8d0b2de (code workshop) into the branch:
    - `likma project check` (report .likma/checks/714cf45d525b4046ada25b57b591182a.json): PASS; types pass,
      money-lab 5 files 151/151, build pass, e2e PASS (183 s), chaos PASS (71 s), upstream 68 files 1767/1767.
    - The 11 features whose scope the merge changed, and code-workshop, re-verified with `feature verify`.
  - 2026-10-07, after merging main 2405b06 (niche funnel, PR #32) with the Likma merge driver (no conflicts;
    niche-funnel-probes kept and its scope extended to money-lab-funnel.test.ts):
    - `likma project feature reverify` (Likma 0.9.0 branch, report .likma/checks/07c39790bcfa4e31bc7becd5be7cb486.json):
      one run of money-lab (pass, 64 s), build (pass), e2e (PASS, 181 s) and chaos (PASS, 71 s) re-verified the
      15 features made stale by the merge.
    - `likma project check --only types`: pass; `--only upstream`: 69 files, 1772/1772 pass (79 s).
    - `likma project audit`: 0 failures; then `likma project upgrade` to Likma 0.9.0 (f30f038): audit 0 failures, 0 warnings.
  - 2026-10-07, after merging main 5919534 (publication kits, PR #33) with the merge driver (no conflicts;
    publish-kits-decisions kept, scope extended to money-lab-kits.test.ts):
    - `likma project feature reverify` (Likma 0.9.0, report .likma/checks/910f19686f074f17b269e78bc9d04a39.json): one run of
      money-lab (160/160), build, e2e (PASS, 182 s) and chaos (PASS, 71 s) re-verified all 23 stale features.
    - `likma project check --only types`: pass; `--only upstream`: 1776/1776 pass.
  - Earlier: 1754/1754 upstream suite and E2E/chaos PASS on 2026-10-06/07 (before this branch).
- Likma migration (2026-10-07): profile `bot`; checks e2e, chaos and upstream added (object form, 900 s);
  `start_disabled` replaces the empty start; setup `install`; `money-lab/e2e/run.mjs` builds before each
  end-to-end scenario so a check never runs a stale dist/; feature scopes now name source, upstream patches
  and tests; 11 features recorded for capabilities added since 2026-10-04; `bot_guards` in
  likma.project.json; Likma audit workflow (.github/workflows/likma-audit.yml, needs a LIKMA_REPO_TOKEN
  secret) and Claude Code hooks (.claude/settings.json, need the `likma` command on PATH).
- Evidence gaps (not claimed):
  - privilege-drop stays built: no automated test starts dist/launch.js as root and checks the switch to
    MONEY_LAB_USER (checked once by hand with a test user, 2026-10-06); the unit test only asserts that an
    unprotected process reports itself as unprotected.
  - view_page, browse, render_image (real files) and check_design tests are skipped when no Chrome is found;
    here Chrome was at /opt/pw-browsers/chromium-1194, so they ran.
  - Live behaviour (real Anthropic, Telegram, Stripe, Bluesky, free providers) is not covered by any check.
- First supervised run (owner-approved, 2026-10-04, OVH VPS, $15 funding): Telegram works; the agent
  spent about $0.52 in 30 s re-checking a falsely "exposed" port until the hourly cap slept it; the owner
  paused it. Fixes: prompt caching with cache-aware cost, expose_port removed on self-hosted, VPS prompt
  wording, pause message. Second run (22:00 UTC): about $0.02-0.03 per turn instead of $0.05, but the
  agent still repeated the same check: turns with tool calls and no text were dropped from the history
  (src/agent/context.ts), so it never saw its own results. Fixed 2026-10-05. Third run: with the history
  restored, every request failed (400, tool_use without tool_result) because the router flattened tool
  results into user text for Anthropic; the router now keeps tool messages. End-to-end audit (owner
  request): a harness running the real process against a strict fake API found and fixed end_turn
  re-calls, owner messages unread on wake and blocked by the injection filter, write_file confined to
  /root, blocking execSync, name-based repetition on exec, 2-minute inference timeout, servers lost
  on restart (autostart.sh). Not yet measured live.
- Owner decision 2026-10-05 (full autonomy): web search/fetch, view_page screenshots (incl. print/PDF),
  own GitHub organization and analytics tokens readable by the bot, budget split by purpose, 24 h sleep
  cap, weekly review with ~/LESSONS.md, portfolio of up to 3 experiments. Not yet measured live.
- Owner decision 2026-10-05 (improvements 1-5): history prompt caching (chunked 20-29 turn window,
  live state in a trailing system message), Telegram alert on repeated errors and daily state.db
  backup, revenue levers in the prompt (accounts stay the owner's), read-only Search Console tool,
  Opus 5.5 for the first 4 turns of the weekly review. Measured live 2026-10-05: Search Console answers.
- Owner decision 2026-10-06 (plan steps 1-2): delegate to Haiku 4.5, scheduled jobs without inference,
  recall over the agent's notes, Lighthouse page audits, A/B tests. Next: step 3 (domain chosen by the
  agent, bought by the owner; Bluesky account by the owner; image generation), step 4 (e-mail once a
  domain exists), step 5 (revenue) last. Not yet measured live.
- Owner decision 2026-10-06 (plan step 1 bis, money-lab/PLAN.fr.md): the agent copied a common invoice
  tool; it must now research, score ideas on 9 criteria, have them challenged by Opus and wait 6 h
  before an experiment can become active (runtime-enforced). Not yet measured live.
- Plan step 3 code (2026-10-06): check_domain, render_image, Bluesky post_social with owner approval on
  Telegram; view_page blank-band fix. Owner still to buy the domain and create the Bluesky account.
- Live 2026-10-06 02:08 UTC (727338d): the agent recorded its experiment and slept 24 h "for indexing"
  without discovery, and dated evidence in the future. Fixed: current date in the prompt, 3 h sleep cap
  while fewer than 5 ideas are scored, idea work counted as progress.
- Bug audit 2026-10-06 (owner request): fixed false "free" domains and Cloudflare 403 on RDAP, a
  local-file leak path in render_image, forged idea_id, uncounted failed critiques, unbounded page
  downloads, Bluesky login retries every minute, budget-blocked review model, fake image markers
  breaking every request, partial backups. See INTEGRATION.md "Bug audit".
- Deep audit 2026-10-06: read_file leaked every key through /proc/self/environ (fixed); the bot's shell
  could read the runtime's environment (fixed by the root-start launcher, owner must install the new
  unit once); install_mcp_server could brick inference; switch_model/update_genesis_prompt could freeze
  budgets; Telegram replies could be lost (double /fonds); Stripe disputes ignored. Remaining by design:
  the bot owns its config and state files, so shell tricks can still alter limits; the Anthropic spending
  limit is the backstop.
- Sealed secrets 2026-10-06: keys leave process.env at startup, so no child process (which, git, curl)
  inherits them; 1719/1719 tests, E2E PASS.
- Fourth audit 2026-10-06: owner messages lost when a wake was budget-blocked (stuck in_progress), lost
  input and silently skipped weekly review after an API error, unbounded WORKLOG.md in every prompt,
  unbounded command timeouts. New chaos run (money-lab/e2e/chaos.mjs): PASS.
- Live 2026-10-06 06:31 UTC: the agent slept 24 h right after scoring its fifth idea; sleep is now capped
  at 6 h. Daily Telegram health report (/sante): the first live report raised a false spend alarm (a
  rolling 24 h window spans two capped UTC days); it now compares each UTC day with the cap. The 6.11 $
  spent on 2026-10-05 matched the cap then in force (6.30 $/day, from the logs).
- Owner decision 2026-10-06 (free models collect, the best model decides): harvest on free services
  (Groq, Gemini, OpenRouter free models, local Ollama) with sealed keys and Haiku fallback; binding Opus
  decisions for idea approval and for stopping an active experiment; market_signals (free public
  sources); datasets in ~/datasets; site monitoring every 30 min. Owner to create the free API keys.
  Not yet measured live.
- Owner request 2026-10-07 (design): design kit (base CSS, six themes, templates) installed into
  ~/library/design, `money-lab-design` skill (method, free resources, checklist), `check_design`
  (axe-core + mechanical checks + screenshots), `first_impression` (free model), `design_review`
  (Opus with screenshots). Not yet measured live.
- Live 2026-10-07 03:48 UTC: the agent used the design method (brief, og image, favicon, check_design 0
  errors, first_impression) but each turn read about 80k tokens and the 1 $/hour cap stopped it after a
  few turns. Older tool results are now shortened in the history, delegate goes to the free models
  first, web_fetch pages are capped at 8k tokens. That change moved the shortened part every turn and
  broke prompt caching (cost rose); fixed 2026-10-07: shortened results stay fixed until the window
  moves every 10 turns (test checks each request is a prefix of the next). Owner can change the
  inference caps from Telegram with /plafond (writes automaton.json, restarts). Not yet measured live.
- First live report after the cache fix (07:39 Paris) still read 85k tokens per turn, but that average
  counted cached tokens and turns before the update. /sante now shows the last 10 turns: tokens read,
  cost per turn and cache use.
- Free-first web tools (2026-10-08): first live /sante after the update showed paid web_search still used
  and no free call; the paid web_search and web_fetch are now removed from requests when Tavily and
  free models are configured (override MONEY_LAB_WEB_TOOLS). Observe-mode cap reached again at 00:17 UTC.
- Owner meeting (2026-10-08, after live /sante and /statut: 16.86 $ spent, 0 revenue, 60 % on research,
  no proposal, observe mode sleeping on a 1 $/day cap): the bot is reoriented. Job: find profitable,
  testable ideas and propose them; the owner chooses on Telegram (/idees, /go, /non, /stop, /memoire,
  /point); Opus reviews the week plan and every dossier; 3 accepted proposals a week or a pause; 48 h of
  spending without progress pauses too; memory of every idea set aside; publication only for a chosen
  proposal after test_site, an Opus design review and the owner's /go, under a neutral name; tools by
  phase, shorter mission and history (static part per turn 85k → 40k characters); frictions finder.
  Evening report replaces the morning push. Owner actions: stop the invoice test (/tests, /stop 1),
  optionally remove GH_TOKEN so publishing goes only through the gated Cloudflare tools. Not yet used live.
- PR 6 done (Workers): deploy_worker publishes small free servers (Cloudflare Workers with KV or D1,
  code rules, no secrets, storage ids remembered), probes count Bing impressions next to Google when
  Bing Webmaster is configured, web_analytics reads Cloudflare Web Analytics. Owner's Cloudflare token
  needs the six permissions listed in the guide. Not yet used live.
- Repository moved to the owner's organization moneylab-djib (2026-10-07); old URLs redirect.
- PR 5b done (same branch and PR as 5a, rebuilt on main a8b75bc after the Likma adoption merge): free
  services with owner accounts, each env-keyed and capped per day (Tavily free_search, Bing Webmaster,
  INSEE Sirene and Légifrance through france_data, API Adresse without account, UptimeRobot on
  monitor_site, Resend email_owner), deploy_site to Cloudflare Pages through wrangler, kits for dev.to
  and Mastodon posted by the runtime after /publie. Guide section "Comptes gratuits" walks the owner
  through each account. Not yet used live.
- Owner plan (2026-10-07, validated): 4 PRs, then a free capability pack (5a without owner accounts,
  5b with). PR 5a done: Jina Reader page reading, semantic recall on free embeddings, free design
  review (Gemini) with Opus on final, IndexNow pings, free_services finder, Cloudflare Web Analytics
  snippet. Not yet used live.
- PR 4 done: publication kits the owner posts (/kits, /publie, /passe), owner window on
  finalists (/choisis, /ecarte), Opus shortlist. Not yet used live.
- PR 3 done: niche funnel (seed universe, niche_scan with a fixed
  formula on free signals, rejected memory) and probes measured by Search Console with a daily check
  that feeds ideas and wakes the agent. Not yet used live; Search Console must be configured for probes.
- PR 2 done: code workshop (repo_scout, vendor_code,
  scaffold_site, test_site, code_review, money-lab-code skill with a library catalogue). Not yet used live.
- PR 1 done: work modes with budgets (discovery ~1 $/day,
  build = owner caps, observe sleeps 24 h), nine free providers in rotation with daily quotas, mission
  rewritten (channel first, probes before products). Next: PR 2 code workshop (repo_scout, vendor_code,
  scaffold_site, test_site, code_review), PR 3 niche funnel and probes, PR 4 publish kits and dated
  Opus decisions. Owner commits ~100 $ over 60 days and publishes prepared kits; markets FR + EN.
- Blockers and known regressions:
  - Upstream context-hardening.test.ts hangs on unmodified upstream; upstream CI masks it as a warning.
  - In-process limits are bypassable through exec; supervised run only.
  - GitHub Actions may be disabled on this fork until enabled by the owner.
  - Example caps ($3/day inference, $10/day payments) not checked against real Conway prices.
  - With payments allowed, prompt injection can trigger payments within the caps.
- Next concrete action: owner merges and updates the VPS (guide, "Mettre à jour le bot"), adds one or
  more free model keys (guide, "IA gratuites pour la récolte"), then reads the next /sante report.
- Files to read first: AGENTS.md, money-lab/INTEGRATION.md, money-lab/GUIDE-VPS.fr.md, docs/CODEMAP.md.
Never store secrets or report planned work as complete.
