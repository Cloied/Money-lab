# Working status
- Updated: 2026-10-03
- Branch / commit: claude/money-lab-first-run-bezu7x on upstream Automaton d8f816881fd24b6f5e3d616e59edec387a447667 (0.2.1)
- Current goal: lean first-run scope of MONEY_LAB_CORE_SPEC_v0.1 (development only; no launch).
- Accepted decisions:
  - Thin extension under src/money-lab/ plus narrow upstream patches; inert without a moneyLab block.
  - Strict first-run profile; zero limits rejected; no automatic credit purchases or x402 payments.
  - Journal in the existing state.db; operator CLI with French output; no Telegram in v0.1.
  - No start command configured: starting runs the agent and requires owner approval.
- Completed behaviour: profile, spend guards, experiment/help journal, operator ledger, pause/resume,
  status/summary, no-progress sleep, integration note, Conway checklist (features verified in docs/FEATURES.md).
- Checks run (command, result, date):
  - likma project feature verify (types/money-lab/build): pass, 2026-10-03
  - pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts: 1649/1649 pass after review fixes, 2026-10-03
    (upstream d8f8168 baseline: 1614/1614)
- Blockers and known regressions:
  - Upstream context-hardening.test.ts hangs on unmodified upstream; upstream CI masks it as a warning.
  - In-process limits are bypassable through exec; supervised run only.
  - GitHub Actions may be disabled on this fork until enabled by the owner.
  - 30 c/day inference cap may be too small; real Conway prices not verified.
- Next concrete action: owner approves budget, existing sandbox id and checklist steps 0–2; then a
  supervised smoke run per money-lab/CONWAY-CHECKLIST.md.
- Files to read first: AGENTS.md, money-lab/INTEGRATION.md, money-lab/CONWAY-CHECKLIST.md, docs/CODEMAP.md.
Never store secrets or report planned work as complete.
