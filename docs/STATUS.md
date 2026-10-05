# Working status
- Updated: 2026-10-04
- Branch / commit: claude/money-lab-first-run-bezu7x on upstream Automaton d8f816881fd24b6f5e3d616e59edec387a447667 (0.2.1)
- Current goal: self-hosted VPS runtime (Claude Sonnet 5.5, Telegram, Stripe, survival goal); development only, no launch.
- Accepted decisions:
  - Thin extension under src/money-lab/ plus narrow upstream patches; inert without a moneyLab block.
  - Owner decision 2026-10-04: maximum freedom, only replication forbidden; optional price caps
    (inference per call/hour/day, payments per payment/day); payments allowed or disabled by the owner.
  - Journal in the existing state.db; operator CLI and Telegram with French output.
  - Owner decision 2026-10-04: Conway Cloud closed; run self-hosted on a VPS; Claude Sonnet 5.5; Stripe revenue sync; survival as the bot's ultimate goal.
  - No start command configured: starting runs the agent and requires owner approval.
- Completed behaviour: profile, spend guards, experiment/help journal, operator ledger, pause/resume,
  status/summary, no-progress sleep, integration note, Conway checklist (features verified in docs/FEATURES.md).
- Checks run (command, result, date):
  - likma project feature verify (types/money-lab/build): pass, 2026-10-03
  - pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts: 1675/1675 pass (end-to-end audit fixes), 2026-10-05
  - node money-lab/e2e/harness.mjs (real process, strict fake Anthropic/Telegram/Stripe): PASS, 2026-10-05
    (upstream d8f8168 baseline: 1614/1614)
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
- Blockers and known regressions:
  - Upstream context-hardening.test.ts hangs on unmodified upstream; upstream CI masks it as a warning.
  - In-process limits are bypassable through exec; supervised run only.
  - GitHub Actions may be disabled on this fork until enabled by the owner.
  - Example caps ($3/day inference, $10/day payments) not checked against real Conway prices.
  - With payments allowed, prompt injection can trigger payments within the caps.
- Next concrete action: owner updates the VPS (guide, "Mettre à jour le bot"), resumes with /reprendre
  and checks cache reads and spend per turn in the logs.
- Files to read first: AGENTS.md, money-lab/INTEGRATION.md, money-lab/GUIDE-VPS.fr.md, docs/CODEMAP.md.
Never store secrets or report planned work as complete.
