# Money Lab — integration note

Status: development build, mocked tests only. Not launched, not funded, nothing published.
Specification: `MONEY_LAB_CORE_SPEC_v0.1.md` (lean first-run scope), amended by the owner on
2026-10-04: maximum agent freedom except replication, with optional price caps.

## Upstream baseline

| Item | Value |
| --- | --- |
| Repository | https://github.com/Conway-Research/automaton (MIT, `LICENSE` retained unchanged) |
| Pinned commit | `d8f816881fd24b6f5e3d616e59edec387a447667` (2026-08-26, "it's beautiful") |
| Package | `@conway/automaton` 0.2.1 |
| Verified | `origin/main` at clone time (2026-10-03) was this exact commit |
| Toolchain used | Node 22, pnpm 10.28.1 (`packageManager`), lockfile unchanged |

## Reused, not duplicated

| Need | Existing module used |
| --- | --- |
| Agent loop, tools | `src/agent/loop.ts`, `src/agent/tools.ts` |
| Policy | `PolicyEngine` + `createDefaultRules` (one extra rule, no-op without the profile) |
| Inference limits | `InferenceRouter` + `InferenceBudgetTracker` + `inference_costs` table |
| Storage | Same SQLite `state.db`; `kv` table for pause/no-progress; three small tables for the journal |
| Wake/sleep | `wake_events`, `sleep_until`, heartbeat daemon |
| Prompt | `buildSystemPrompt` (one code-owned section) |
| Skills | Standard `SKILL.md` loader (`money-lab/skills/money-lab-strategy`) |
| CLI | `automaton --money-lab …` subcommand in `src/index.ts` |

## Change set

New: `src/money-lab/{profile,journal,guard,prompt,tools,status,cli,cycle}.ts`,
`src/__tests__/money-lab/money-lab.test.ts`, this `money-lab/` folder.

Upstream patches (all narrow; behaviour unchanged when no `moneyLab` block is configured):

| File | Change |
| --- | --- |
| `src/types.ts` | `moneyLab?` on config; `dailyBudgetCents?`, `pinnedModel?`, `strictCostAccounting?` on model strategy; `costEstimated?`, `budgetLimit?` on inference result |
| `src/inference/budget.ts` | Daily budget check from persisted costs (absent/0 keeps upstream "no limit"); rejections name the limit |
| `src/inference/router.ts` | Optional pinned model. Opt-in strict accounting: tool schemas counted in the estimate; missing or zeroed usage and timeouts record the estimate and are flagged |
| `src/conway/x402.ts` | Process-wide payment gate (installed only when the owner disables payments) |
| `src/agent/tools.ts` | `executeTool` fails closed without policy context under Money Lab; top-ups and signed x402 amounts recorded so payment caps see them |
| `src/conway/x402.ts` (result) | `paidCents` on the result when a payment was signed |
| `src/agent/policy-rules/index.ts` | Registers `money_lab.first_run` rule |
| `src/agent/loop.ts` | All tools except replication/owner-denied; orchestration off; automatic top-ups only without payment caps; pause if a pinned model is missing or unpriced; owner pause; sleep on hourly/daily exhaustion, pause on per-call/session rejection; pause on unknown cost when limits are set |
| `src/agent/system-prompt.ts` | Money Lab mission + rules block |
| `src/heartbeat/tasks.ts` | USDC auto-top-up only when payments are allowed without caps; no upstream-update wake |
| `src/index.ts` | Profile validation (invalid = exit 1); optional payment gate; bootstrap top-up only without caps; pause-aware run loop; only operator events cut a sleep short; no-progress tracking; `--money-lab` CLI |

## Freedom model

The agent may use every tool and choose any legitimate activity. The runtime enforces only:

| Rule | Why |
| --- | --- |
| No replication: child sandboxes/funding/messaging, orchestrator workers, `maxChildren: 0` | Owner decision |
| No runtime code self-modification (`edit_own_file`, `pull_upstream`, `reset_to_upstream`, writes/shell into the runtime install) and no edits to `automaton.json`, `wallet.json`, `config.json`, `state.db*`, `constitution.md` | Otherwise the agent could remove the replication ban or corrupt the spending records |
| `CONWAY_API_KEY` not readable through the shell | Protects the owner's credential from prompt injection; Conway tools still use it |
| Owner pause | Lets the owner stop new spending at any time |
| Optional price caps (inference per call/hour/day, payments per payment/day), `null` = none | Limits cost, not capability |
| Optional `deniedTools`, `payments: "disabled"`, `noProgressCycles` | Owner switches, all off/empty by default except what the example sets |
| Upstream treasury rules (x402 domain allowlist `treasuryPolicy.x402AllowedDomains`, default `conway.tech`; transfer caps; minimum reserve) | Kept as upstream owner settings; payment caps tighten the amounts |

## Spend paths

| Path | Upstream behaviour | Money Lab behaviour |
| --- | --- | --- |
| Inference (router) | Matrix model, hourly/session/per-call only, missing usage counted as 0c | Owner model or matrix; per-call/hourly/daily caps when set; zero/missing usage and timeouts charged at the estimate |
| `topup_credits` | Any tier up to $2,500, unrecorded | Allowed within per-payment/daily caps; recorded in `spend_tracking` |
| `transfer_credits` | Treasury caps (default $50/transfer, $250/day) | Treasury caps tightened to the payment caps |
| `x402_fetch` | Max $1 per payment, recorded as 0c | Max = per-payment cap; the signed amount is recorded toward the daily cap (the daily check reserves the cap before the call) |
| Automatic top-ups (startup, inline, heartbeat) | Buy $5 when credits are low | Only when payments are allowed **without** caps (they bypass tool policy) |
| `create_sandbox`, `register_domain`, other paid Conway tools | Agent tools, paid from credits | Allowed; bounded by the credits the owner provisions |
| Orchestrator / local workers | Separate inference client, **bypasses router budgets**, spawns workers | Not initialised (replication) |
| `executeTool` without policy context | **Executes with no policy** | Denied (`MONEY_LAB_POLICY_MISSING`) |
| Heartbeat wakes during sleep | Start paid cycles | Ignored; only operator resume/help resolution wakes the agent |

## Units

`costPer1k*` in the model registry is in hundredths of a cent per 1 000 tokens.
Cost (cents) = ceil(input/1000 × in/100 + output/1000 × out/100). Fixture: `gpt-5-mini`
(8 / 32), 10 000 in + 1 000 out = 1.12 c → recorded 2 c. Rounding up slightly overstates small
calls. Limits must be positive integers or `null` (no limit); zero is rejected so it can never be
mistaken for either.

## Known limitations (do not remove from reports)

1. **Shell is not sandboxed by these checks.** `exec` runs arbitrary commands in the sandbox. The
   rule blocks obvious references to `automaton.json`, `wallet.json`, `state.db`,
   `~/.automaton/{config.json,constitution.md}`, the runtime install path and `CONWAY_API_KEY`.
   Obfuscated commands (encoding, variables, other interpreters) can still read the wallet key,
   edit the DB (e.g. clear the pause, delete cost rows) or call Conway APIs directly. This is a
   **supervised experiment**, not secure unattended financial automation. The real exposure limit
   is the credits and USDC the owner provisions.
2. With `payments: "allowed"`, a transfer or payment can be triggered by instructions hidden in a
   web page or message (prompt injection). Price caps bound each payment and each day; they do not
   judge whether a payment is wise.
3. The per-call ceiling uses a pre-call estimate (chars/4). The real cost is recorded afterwards and
   counts towards hourly/daily limits. A provider error thrown after the request was sent (other
   than a timeout) records no cost; reconcile with Conway billing when errors appear in the logs.
4. Pause is checked before each inference call and each tool. A call already in flight completes.
   **Pause does not stop Conway hosting billing.** Sandboxes or domains the agent creates are
   billed until deleted; list them before shutdown.
5. While awake the agent processes queued inbox messages; while sleeping, only operator events
   wake it.
6. A process restart clears `sleep_until` (upstream behaviour), so the first cycle after a restart
   runs even during a long no-progress sleep. Budgets, pause and the no-progress counter persist.
7. Use a fresh `state.db` for the run: the finance summary includes every row of
   `inference_costs`, including any from before the profile was enabled.
8. Money Lab tables are created with `CREATE TABLE IF NOT EXISTS`, outside upstream schema versions.
9. Telegram notifications are not implemented; the CLI is the help/notification channel.
10. Web research: no search adapter was added; the agent can use HTTP retrieval via `exec`.
11. `check_for_updates` still runs `git fetch` against the configured remote (no wake, no pull).

## Tests (2026-10-04, Node 22, pnpm 10.28.1)

| Check | Pinned upstream `d8f8168` | Money Lab branch |
| --- | --- | --- |
| `pnpm typecheck` | pass | pass |
| `pnpm build` | not run | pass |
| `vitest run --exclude src/__tests__/context-hardening.test.ts` | 63 files, 1614/1614 pass | 64 files, 1654/1654 pass (freedom model) |
| `context-hardening.test.ts` | **hangs** (no result after 150 s; `buildContextMessages` blocks) | same hang; its other blocks, incl. `buildSystemPrompt` (8 tests), pass |

The `context-hardening` hang is a pre-existing upstream baseline failure in code this branch does
not touch (`src/agent/context.ts`); it is why a plain `pnpm test` never finishes.

`src/__tests__/money-lab/money-lab.test.ts`: 40 tests, including a simulated first cycle and payment caps. Global `fetch` is replaced by a spy that
throws, USDC balance reads are mocked, and no test starts a funded loop. Coverage maps to
specification section 10: mocked mode has no network/payment effects and missing policy fails
closed; pause blocks paid calls and top-ups while status reports hosting as separately billed;
per-call/hourly/daily limits use correct units and persist across restart; replication, recovery
funding (when payments are disabled or capped) and runtime/safeguard edits are denied, while all
other tools stay available and payments respect per-payment/daily caps; help requests survive
restart, repeated or unrelated resolutions are harmless, agent tools cannot resolve them;
funding is not revenue, estimated ads are not cash, credit purchases are not double-counted;
no-progress cycles trigger a long sleep while keeping experiment context.

Not tested: `check_for_updates` (runs `git fetch`), a real Conway sandbox, real provider usage
reporting, or the CLI against the compiled `dist/` (the CLI was smoke-tested via `tsx` with a
temporary `HOME`).
