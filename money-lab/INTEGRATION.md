# Money Lab — first-run integration note

Status: development build, mocked tests only. Not launched, not funded, nothing published.
Specification: `MONEY_LAB_CORE_SPEC_v0.1.md` (lean first-run scope).

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
| `src/inference/router.ts` | Pinned model bypasses matrix/fallback. Opt-in strict accounting: tool schemas counted in the estimate; missing or zeroed usage and timeouts record the estimate and are flagged |
| `src/conway/x402.ts` | Process-wide payment gate checked before any x402 request/signature |
| `src/agent/tools.ts` | `executeTool` fails closed without policy engine/turn context under Money Lab |
| `src/agent/policy-rules/index.ts` | Registers `money_lab.first_run` rule |
| `src/agent/loop.ts` | Allowlisted tools only; orchestration off; no inline top-up; pause if the pinned model is missing or unpriced; pause check before inference; bounded output tokens; sleep on hourly/daily exhaustion, pause on per-call/session rejection; pause on unknown cost |
| `src/agent/system-prompt.ts` | Money Lab mission + enforced envelope block |
| `src/heartbeat/tasks.ts` | No USDC auto-top-up/wake; no upstream-update wake |
| `src/index.ts` | Strict profile validation (invalid = exit 1); payment gate; no bootstrap top-up; pause-aware run loop; only operator events cut a sleep short; no-progress tracking; `--money-lab` CLI |

## Spend paths checked

| Path | Upstream behaviour | First-run behaviour |
| --- | --- | --- |
| Startup `bootstrapTopup` | Buys $5 credits if USDC ≥ $5 and credits < $5 | Skipped; x402 gate also blocks it |
| Inline loop top-up | Same, every 60 s when low | Skipped; gate blocks |
| Heartbeat `check_usdc_balance` | Auto top-up and wake on failure | Returns without buying or waking |
| `create_sandbox` / spawn 402 retry | Top-up then retry | Tools denied; gate blocks |
| `topup_credits`, `x402_fetch`, `transfer_credits`, `fund_child` | Agent tools | Denied by allowlist; x402 gate as second layer |
| `executeTool` without policy context | **Executes with no policy** | Denied (`MONEY_LAB_POLICY_MISSING`) |
| Router inference | Hourly/session/per-call only, matrix may select `gpt-5.2` regardless of config, output estimate assumes 1000 tokens, client turns missing usage into 0 tokens (0c) | Pinned priced model, per-call/hourly/daily limits, output bounded to `maxOutputTokens`, zero/missing usage and timeouts charged at the estimate and paused for reconciliation |
| Heartbeat wakes (distress when credits are critical, inbox, reflection) | Wake the agent and start paid cycles | Ignored during a sleep; only operator resume/help resolution wakes it |
| Orchestrator / local workers | `UnifiedInferenceClient`, **bypasses router budgets** | Not initialised |
| Replication, domains, messaging, git push, self-mod, heartbeat/genesis edits | Agent tools | Denied by allowlist |
| Runtime-installed tools | Loaded from DB | Not loaded; denied by allowlist |

## Units

`costPer1k*` in the model registry is in hundredths of a cent per 1 000 tokens.
Cost (cents) = ceil(input/1000 × in/100 + output/1000 × out/100). Fixture: `gpt-5-mini`
(8 / 32), 10 000 in + 1 000 out = 1.12 c → recorded 2 c. Rounding up overstates small calls;
with a 30 c/day cap this allows at most 30 calls/day and realistically ~10–20. **This may be too
little for useful work**; the operator should check real Conway prices and decide whether to raise
the cap explicitly (config change, not a code bypass). All profile limits must be > 0: zero is
rejected rather than meaning "unlimited".

## Known limitations (do not remove from reports)

1. **Shell is not sandboxed by these checks.** `exec` runs arbitrary commands in the sandbox. The
   rule blocks obvious references to `automaton.json`, `wallet.json`, `state.db`, `heartbeat.yml`,
   `inference-providers.json`, `~/.automaton/{config.json,skills,constitution.md}`,
   `CONWAY_API_KEY` and `/pay/N`; the rest of `~/.automaton` (WORKLOG.md, workspace) stays usable
   by the agent. Obfuscated commands (encoding, variables, other
   interpreters) can still read the wallet key, edit the DB (e.g. clear the pause, delete cost rows)
   or call Conway APIs directly with the API key (creating sandboxes or domains spends Conway
   credits). The API key and wallet are on the same machine. This is a
   **supervised experiment**, not secure unattended financial automation. Exposure is limited by
   keeping the agent wallet without spendable USDC and provisioning only finite Conway credits.
2. The per-call ceiling uses a pre-call estimate (chars/4). The real cost is recorded afterwards
   and counts towards hourly/daily limits, so one call can exceed the per-call estimate slightly.
   A provider error thrown after the request was sent (other than a timeout) records no cost;
   reconcile with Conway billing when errors appear in the logs.
3. Pause is checked before each inference call and each tool. A call already in flight completes.
   **Pause does not stop Conway hosting billing.**
4. Inbound social messages: set `socialRelayUrl` to `""`. While awake (not sleeping) the agent still
   processes queued inbox messages; while sleeping, only operator events wake it.
5. A process restart clears `sleep_until` (upstream behaviour), so the first cycle after a restart
   runs even during a long no-progress sleep. Budgets, pause and the no-progress counter are
   persisted and still apply; a cycle blocked by a budget makes no paid call.
6. Use a fresh `state.db` for the run: the finance summary includes every row of
   `inference_costs`, including any from before the profile was enabled.
7. Money Lab tables are created with `CREATE TABLE IF NOT EXISTS`, outside upstream schema versions.
8. Telegram notifications are not implemented; the CLI is the help/notification channel.
9. Web research: no search adapter was added. The agent can use `exec` (curl) for permitted HTTP
   retrieval only; a search API would need a scoped extension and a cost allowance.
10. `check_for_updates` still runs `git fetch` against the configured remote (no wake, no pull).

## Tests (2026-10-03, Node 22, pnpm 10.28.1)

| Check | Pinned upstream `d8f8168` | Money Lab branch |
| --- | --- | --- |
| `pnpm typecheck` | pass | pass |
| `pnpm build` | not run | pass |
| `vitest run --exclude src/__tests__/context-hardening.test.ts` | 63 files, 1614/1614 pass | 64 files, 1651/1651 pass (final check) |
| `context-hardening.test.ts` | **hangs** (no result after 150 s; `buildContextMessages` blocks) | same hang; its other blocks, incl. `buildSystemPrompt` (8 tests), pass |

The `context-hardening` hang is a pre-existing upstream baseline failure in code this branch does
not touch (`src/agent/context.ts`); it is why a plain `pnpm test` never finishes.

`src/__tests__/money-lab/money-lab.test.ts`: 37 tests, including a simulated first cycle. Global `fetch` is replaced by a spy that
throws, USDC balance reads are mocked, and no test starts a funded loop. Coverage maps to
specification section 10: mocked mode has no network/payment effects and missing policy fails
closed; pause blocks paid calls and top-ups while status reports hosting as separately billed;
per-call/hourly/daily limits use correct units and persist across restart; replication, recovery
funding and runtime/safeguard edits are denied through enabled tools; help requests survive
restart, repeated or unrelated resolutions are harmless, agent tools cannot resolve them;
funding is not revenue, estimated ads are not cash, credit purchases are not double-counted;
no-progress cycles trigger a long sleep while keeping experiment context.

Not tested: `check_for_updates` (runs `git fetch`), a real Conway sandbox, real provider usage
reporting, or the CLI against the compiled `dist/` (the CLI was smoke-tested via `tsx` with a
temporary `HOME`).
