# Money Lab

A small, supervised economic experiment built on
[Conway Automaton](https://github.com/Conway-Research/automaton).

One Automaton instance gets a clear mission, a finite budget and a few spend controls. It chooses a
useful small product, tries to find genuine users and investigates legitimate revenue. Income is
uncertain: the goal is to observe what an autonomous agent can actually build, use and earn, and to
measure it honestly.

> **Status:** first-run development build. Mocked tests pass; nothing has been launched, funded or
> published yet. Live use requires the owner's approval of the exact resources and budget.

## What Money Lab adds to Automaton

All additions are inert unless `~/.automaton/automaton.json` contains a `moneyLab` block.

| Area | Behaviour |
| --- | --- |
| Mission | Code-owned Money Lab prompt plus the `money-lab-strategy` skill; the agent keeps strategic freedom |
| Strict profile | Unknown/missing keys or zero limits stop startup; one pinned, priced model |
| Inference budget | Per-call, hourly and daily caps in USD cents, persisted across restarts; bounded output tokens |
| Payments | No credit purchases or x402 payments from inside the agent; the owner provisions credits |
| Tools | Allowlist; replication, transfers, sandbox creation, domains, outbound messaging, git push and runtime self-modification are denied |
| Journal | Experiments (one active build), owner help requests, operator ledger in the existing `state.db` |
| Sleep | Sleeps when a budget window is exhausted or after repeated no-progress cycles; only the operator wakes it early |
| Accounting | Funding, credit purchases, consumed costs, estimated revenue, confirmed revenue and cash received are reported separately |

## Operator commands

Output is in French.

```bash
node dist/index.js --money-lab status        # state, budgets, resources, experiments, help, finances
node dist/index.js --money-lab summary       # daily summary
node dist/index.js --money-lab pause "raison"
node dist/index.js --money-lab resume
node dist/index.js --money-lab help-list
node dist/index.js --money-lab help-resolve <id> "note"
node dist/index.js --money-lab help-reject <id> "note"
node dist/index.js --money-lab ledger-add <kind> <amount-cents|unknown> <reference> ["note"] [--provider-import]
```

Pausing stops new paid inference. **It does not stop Conway hosting billing**; see the shutdown
section of the checklist.

## Install and run

Do **not** use the upstream `curl … automaton.sh | sh` installer: it tracks upstream `main` and
would replace this build. Follow [money-lab/CONWAY-CHECKLIST.md](money-lab/CONWAY-CHECKLIST.md)
(pinned commit, configuration, backups, supervised smoke run, bounded experiment, shutdown).

Start from [money-lab/automaton.money-lab.example.json](money-lab/automaton.money-lab.example.json).
Its budget values are provisional; set them from current Conway prices and the approved budget.

## Development

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run src/__tests__/money-lab
pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts   # upstream suite
pnpm build
```

`src/__tests__/context-hardening.test.ts` hangs on unmodified upstream as well, so a plain
`pnpm test` does not finish. Project rules for coding agents are in [AGENTS.md](AGENTS.md).

## Documentation

- [money-lab/INTEGRATION.md](money-lab/INTEGRATION.md): pinned upstream commit, changed files, spend paths, units, **known limitations**
- [money-lab/CONWAY-CHECKLIST.md](money-lab/CONWAY-CHECKLIST.md): installation, funded run and resource stop
- [docs/STATUS.md](docs/STATUS.md), [docs/FEATURES.md](docs/FEATURES.md), [docs/CODEMAP.md](docs/CODEMAP.md): project status, verified features, code map
- Upstream Automaton documentation: [ARCHITECTURE.md](ARCHITECTURE.md), [DOCUMENTATION.md](DOCUMENTATION.md), [constitution.md](constitution.md)

## Safety limits

The controls run inside the agent process. The shell tool can still reach the wallet, the state
database and the API key through obfuscated commands, so this is a **supervised experiment** with
dedicated, finite funds, not secure unattended financial automation. No profit is guaranteed;
displayed income is not necessarily received.

## Credits and license

Based on [Conway-Research/automaton](https://github.com/Conway-Research/automaton) at commit
`d8f816881fd24b6f5e3d616e59edec387a447667` (0.2.1). MIT License; see [LICENSE](LICENSE), which is
retained unchanged.
