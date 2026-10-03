# Money Lab — project operating rules
Money Lab is a thin extension of Conway Automaton for a small, supervised economic experiment.
Read money-lab/INTEGRATION.md, money-lab/CONWAY-CHECKLIST.md and docs/STATUS.md first.
Shared methods come from Likma Dev System (https://github.com/Cloied/likma-dev-system); this project's
identity, scope and constraints are defined here and in the Money Lab specification.

## Scope
- Lean first-run scope only. Do not build deferred architecture: SaaS/dashboard, multi-tenant engine,
  marketplace, model framework, vector database, ROI engines, concurrent experiments, payment server,
  comprehensive ledger/broker, unrestricted self-modification.
- Keep upstream Automaton code and its MIT LICENSE. Prefer small patches under src/money-lab/ over
  edits to upstream modules; behaviour must stay unchanged when no moneyLab block is configured.
- Code, comments and repository documentation: English. Operator-facing output: French.

## Safety
- Never launch the agent, fund wallets, buy credits, create accounts, provision paid resources or
  publish anything without the owner's explicit approval of the exact resources and budget.
- Do not loosen budgets, the tool allowlist or the payment gate to make something work; report it.
- In-process limits are not tamper-proof (exec can bypass them). Never describe them as secure isolation.
- Unknown cost is never free. Funding is not revenue; estimated income is not cash.
- Tests must not make network or payment calls (src/__tests__/money-lab replaces fetch with a failing spy).

## Commands
Setup: corepack enable pnpm && pnpm install --frozen-lockfile
Checks (configured in likma.project.json, run through the Likma checkout):
  python <likma>/scripts/likma.py project check --path .
  - types: pnpm run typecheck
  - money-lab: pnpm exec vitest run src/__tests__/money-lab
  - build: pnpm run build
Upstream suite: pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts
(context-hardening.test.ts hangs on unmodified upstream; plain `pnpm test` never finishes.)
No start command is configured on purpose: starting runs the agent.

## Likma tracking
Track features in .likma/features.json and docs/FEATURES.md; keep docs/CODEMAP.md current via
likma.project.json. Use project runtime begin/context/guard/record/end for substantial tasks.
Update docs/STATUS.md with real checks and blockers; never report planned work as complete.
