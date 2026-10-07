# Money Lab — project operating rules
Money Lab is a thin extension of Conway Automaton for a small, supervised economic experiment.
Read money-lab/INTEGRATION.md, money-lab/CONWAY-CHECKLIST.md, money-lab/PLAN.fr.md and docs/STATUS.md first.
Shared methods come from Likma Dev System (https://github.com/Cloied/likma-dev-system); this project's
identity, scope and constraints are defined here and in the Money Lab specification.

## Scope
- Lean first-run scope only. Do not build deferred architecture: SaaS/dashboard, multi-tenant engine,
  marketplace, model framework, vector database, ROI engines, payment server,
  comprehensive ledger/broker, unrestricted self-modification.
- Keep upstream Automaton code and its MIT LICENSE. Prefer small patches under src/money-lab/ over
  edits to upstream modules; behaviour must stay unchanged when no moneyLab block is configured.
- Code, comments and repository documentation: English. Operator-facing output: French.

## Safety
- Never launch the agent, fund wallets, buy credits, create accounts, provision paid resources or
  publish anything without the owner's explicit approval of the exact resources and budget.
- Owner decision (2026-10-04): the bot gets maximum freedom; only replication is forbidden, and
  spending is bounded by optional price caps. Do not add capability restrictions without the owner's
  approval, and do not remove the replication ban, runtime protection or price-cap enforcement.
- Owner decision (2026-10-04): Conway Cloud is closed; the default runtime is self-hosted on a VPS
  (Anthropic Claude Sonnet 5.5, Telegram owner channel, Stripe revenue sync). The bot's ultimate goal
  is survival: only provider- or owner-confirmed revenue extends its balance.
- Owner decision (2026-10-05): full autonomy. The bot may run a portfolio of up to 3 experiments, use
  web search/fetch, see pages (view_page), publish in its own GitHub organization and read its analytics
  with narrowly scoped credentials it can read (GH_TOKEN, GOATCOUNTER_TOKEN), split its budget by purpose,
  sleep at most 6 h, and must hold a weekly review that maintains ~/LESSONS.md. It also drives a headless
  browser (browse) with its own profile; it must never use the owner's accounts or create accounts.
- Owner decision (2026-10-06): free models collect, the best model decides. harvest sends extraction work
  to free services (Groq, Gemini, OpenRouter ":free" models, local Ollama) with keys the agent cannot read,
  falling back to Haiku; approving an idea and stopping an active experiment are binding Claude Opus
  decisions applied by the runtime. The owner creates the free service accounts; the bot never does.
- Owner request (2026-10-07): pages must look professional, simple and original. The runtime ships a
  design kit and a design skill (money-lab/design-kit, money-lab/skills/money-lab-design), copied into
  the agent's home at start, and three checks (check_design, first_impression, design_review).
- In-process limits are not tamper-proof (exec can bypass them). Never describe them as secure isolation.
- Unknown cost is never free. Funding is not revenue; estimated income is not cash.
- Tests must not make network or payment calls (src/__tests__/money-lab replaces fetch with a failing spy).

## Commands
Setup: corepack enable pnpm && pnpm install --frozen-lockfile
Checks (configured in likma.project.json, run through the Likma checkout):
  python <likma>/scripts/likma.py project check --path . [--only LABEL]
  - types: pnpm run typecheck
  - money-lab: pnpm exec vitest run src/__tests__/money-lab
  - build: pnpm run build
  - e2e (real process, fake APIs, ~3 min): node money-lab/e2e/run.mjs harness
    (= pnpm run build && node money-lab/e2e/harness.mjs)
  - chaos (real process, failing fake APIs, ~1-4 min): node money-lab/e2e/run.mjs chaos
    (= pnpm run build && node money-lab/e2e/chaos.mjs)
  - upstream (~2 min): pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts
    (context-hardening.test.ts hangs on unmodified upstream; plain `pnpm test` never finishes.)
No start command is configured on purpose (`start_disabled`): starting runs the agent.
bot_guards in likma.project.json maps each agent guard to the tests that prove it.

## Likma tracking
Track features in .likma/features.json and docs/FEATURES.md; keep docs/CODEMAP.md current via
likma.project.json. Use project runtime begin/context/guard/record/end for substantial tasks.
Update docs/STATUS.md with real checks and blockers; never report planned work as complete.

<!-- likma:begin -->
## Likma routine
Managed by Likma `project upgrade`; edit project rules outside the likma markers.
Likma Dev System supplies shared methods; this project's documents govern its identity, stack and scope.
Run the CLI as `likma project <action> --path .` (install: `pipx install --editable <likma checkout>`, or put
`<likma checkout>/bin` on PATH; without it use `python "$LIKMA_HOME/scripts/likma.py"`).

- Start: run `likma project brief` (status, features, audit findings, last handoff); read docs/STATUS.md.
- Plan: record features with numbered acceptance criteria and scope paths (`project feature add`); split
  multi-file work into tasks (`project feature task ID add`) and `project feature plan ID`.
  Verify the first usable slice (docs/FIRST-SLICE.md) before expanding.
- Work: use `project setup|start|check` with the configured commands; never guess commands. Parallel agents
  work in `project worktree add NAME`. On failure read `project diagnostics` before rerunning; record
  hypotheses with `project attempt`. Search `project knowledge find` before repeating research.
- Verify: `project feature verify ID --criterion-check N:CHECK`; after merges or broad edits `project feature reverify`
  runs each check once for all stale features. Inspect rendered UI for visual changes.
- Finish: run `project audit`, update docs/STATUS.md, end an active run with `project runtime end --summary`
  (import measured usage first with `project runtime import-usage`). Propose reusable lessons with
  `project lesson propose`. Report outcome, evidence, affected paths and how to test; never report unrun
  checks or mocks as done.
- Unknown cost is never free; never renew sessions or runs to evade limits.
- Load only skills relevant to the task: read `<likma checkout>/skills/<area>/<name>/SKILL.md` from the index
  below (installed copies are prefixed `likma-`; plugins namespace them as `likma:<name>`).

### Skill index (profile bot, Likma 0.10.0)
- agents/autonomous-agents: building, auditing or running an unattended LLM agent with tools, shell, spend or an owner channel; produces…
- agents/llm-evaluation: measuring an LLM feature, RAG or agent (eval sets, graders, judges, baselines, CI gates, drift); produces a v…
- agents/mcp-servers: designing, building or reviewing a Model Context Protocol server or its tools (naming, schemas, pagination, e…
- delivery/incident-response: Use during or after an outage, failing journey, data or security incident or severe regression; produces seve…
- delivery/observability: adding or fixing logs, metrics, traces, SLOs, alerts, dashboards or synthetic checks (OpenTelemetry, RED/USE,…
- delivery/production-readiness: Use before a launch or high-risk release to decide go/no-go by risk tier (restore-tested backups, alerts, rat…
- delivery/project-bootstrap: starting a project with Likma or adopting it in a repo (bootstrap or init, profile, real commands in likma.pr…
- efficiency/context-selection: a large repo, monorepo or long session needs the right skills, files, callers and passages without reading th…
- efficiency/execution-efficiency: a failing check is rerun unchanged, tool calls repeat, polling spans turns or output floods (diagnostics, ret…
- efficiency/knowledge-reuse: a task depends on prior research, setup facts, versions, decisions or failed hypotheses (project knowledge wi…
- efficiency/research-efficiency: a decision needs external facts (library or API behaviour, vendor limits, standards) or searches keep repeati…
- engineering/distributed-jobs: adding queues, workers, schedulers, webhook consumers or async integrations needing retries, idempotency keys…
- quality/debugging: a bug, failing test, crash or regression has no established cause; produces a reproduction, isolated root cau…
- quality/privacy-review: code collects, logs or sends personal data to analytics, error tracking or LLM providers; produces a data inv…
- quality/security-review: reviewing a diff or code you own for vulnerabilities (authz, injection, SSRF, uploads, secrets, dependencies)…
- quality/testing-strategy: planning or auditing tests for a feature, bug fix or codebase; produces a risk-to-test matrix mapping each ac…
- quality/threat-modeling: Use before or while designing a feature handling identity, money, sensitive data, untrusted input or agent to…
- specialists/ai-integration: an AI/LLM feature where model output, prompt injection, tool authority, cost and reliability need boundaries;…
- workflow/agent-delegation: splitting work across subagents or parallel sessions; produces isolation checks, self-contained briefs, statu…
<!-- likma:end -->
