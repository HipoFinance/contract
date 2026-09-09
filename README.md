# Hipo

Hipo is a **decentralized**, **permission-less**, **open-source** liquid staking protocol on the
TON blockchain. Visit [hipo.finance](https://hipo.finance) to stake, or read the
[docs](https://docs.hipo.finance).

Stake any amount of GRAM, receive **hGRAM** jettons in return, and keep them liquid while they earn
validation rewards. Rewards are not paid out — they accrue in the hGRAM exchange rate, so each
hGRAM is redeemable for steadily more GRAM.

> **Terminology.** GRAM is the network coin (rebranded from TON) and hGRAM is Hipo's jetton
> (rebranded from hTON). The blockchain itself is still called TON. Only vendored files such as
> `contracts/imports/stdlib.fc` and historical documents keep the old names.

## Deployed contracts

| Contract              | Address                                            |
| --------------------- | -------------------------------------------------- |
| Treasury              | `EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ` |
| Parent (hGRAM master) | `EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w` |
| HPO jetton master     | `EQDQEUr0LPi8m6D6F0Wrvuok7tZbAcr0yn2Y7hK291MMzMjM` |
| Burner                | `EQDcjZDWvotoVE0X4HSdt2pR3b2sBZ4XikzSVSdPiqdQMLRK` |

Wallet, loan, bill and collection contracts have no fixed address — an instance is deployed per
user or per validation round.

## Components

| Repository                                                  | What it is                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| **contract** (this repo)                                     | The on-chain FunC contracts                                       |
| [website](https://github.com/HipoFinance/website)            | hipo.finance — the staking app and the docs site                  |
| [borrower](https://github.com/HipoFinance/borrower)          | Helps validators borrow from the protocol and validate blocks     |
| [sdk](https://github.com/HipoFinance/sdk)                    | `@hipo-finance/sdk`, the TypeScript client every integration uses |
| [sdk-example](https://github.com/HipoFinance/sdk-example)    | A minimal worked example of the SDK                               |
| [mcp](https://github.com/HipoFinance/mcp)                    | Read-only MCP server at `https://mcp.hipo.finance/mcp`            |
| [burner](https://github.com/HipoFinance/burner)              | Buys HPO with the borrower fee and burns it                       |
| [audits](https://github.com/HipoFinance/audits)              | Third-party audit reports                                         |

## Smart contracts

### Treasury

The main contract. All GRAM is deposited here and lent to borrowers. It holds the pool accounting
(`total_coins` / `total_tokens`), runs the validation-round state machine, and publishes protocol
state through `get_treasury_state`.

### Parent

The jetton master for hGRAM. It proxies all traffic between wallets and the treasury. The parent is
itself upgradable, and `old_parents` lets a holder's balance merge across from a previous parent.

### Wallet

A jetton wallet with extra fields and some custom behaviour. Each holder has their own, at its own
address.

### Loan

Safeguards a loan given to a borrower. A new instance is deployed on the masterchain for each
validation round. Borrowers cannot withdraw a loan — they can only stake it in the Elector.

### Bill and Collection

Some operations cannot complete instantly. Unstaking hGRAM while the funds are staked in the
Elector has to wait for the round to end, for example. In those cases the user is issued a **bill**,
an SBT (a non-transferrable NFT), which they redeem when the round settles. Each bill belongs to a
**collection** deployed for that round.

### Librarian

Several of the contracts above are deployed as library cells. The librarian helps deploy them and
pays for their storage.

## How it works

### Stakers

Ordinary TON validation needs a large stake — the network minimum is currently **300,000 GRAM**
(config parameter 17). Most people don't hold that. Hipo pools deposits so any amount can earn.

Deposit GRAM and receive hGRAM. Hold it, send it, or use it in other DeFi protocols; whoever brings
it back can burn it for the corresponding GRAM. Meanwhile the pooled GRAM is lent to validators,
who return it with a reward. Because rewards raise `total_coins` while `total_tokens` stays fixed,
every hGRAM becomes worth more GRAM over time. There is no rebase and no reward claim.

Unstaking is either **instant**, paid from whatever liquidity is free at that moment, or **full**,
which waits for the round to settle and returns the best rate.

### Borrowers

Borrowers are node operators with the skills and hardware to validate, but not necessarily the
minimum stake. They request a loan, stake it, validate, and share the reward.

Loans are safeguarded: a borrower can never withdraw one, only stake it. On recovery, a punishment
is settled before anything else and comes out of the borrower's own collateral, so misbehaviour is
paid for by the borrower and not by stakers.

That protection is strong but not absolute. If a punishment exceeds the collateral behind it, the
shortfall is recorded in the treasury's `deficit` — pool money a defaulting borrower walked away
with — which the governor clears separately. It is readable from `get_treasury_state`.

### Fees

Two fees, both governance-settable:

- The **governance fee** takes a share of each round's reward for the protocol.
- The **borrower fee** takes a share of the borrower's own contracted reward at loan recovery and
  sends it, in GRAM, to the [burner](https://github.com/HipoFinance/burner), which stakes it, buys
  HPO on DeDust and burns it — reducing HPO supply rather than accruing to the pool.

Current values are on chain rather than in this file; read them with `scripts/showState.ts` or the
[stats page](https://hipo.finance/stats/).

### Published rate and APY

The treasury publishes a rate window — a start rate, an end rate, and the seconds between them —
that spans **two** validation rounds, which cancels the round-to-round oscillation a single round
shows. Annualise by dividing the year by `window_duration`; **do not** divide by a round length,
which roughly squares the result. `@hipo-finance/sdk` exposes `computeApy` so integrations don't
reimplement it.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the contracts fit together and which
  invariants a change must preserve. **Read this before changing any contract.**
- [`docs/integration.md`](docs/integration.md) — message schemas and getters for integrators.
- [`contracts/schema.tlb`](contracts/schema.tlb) — TL-B for every message.
- [`docs/specs/`](docs/specs) — one spec per feature or behaviour change, with the reasoning and
  the alternatives that were rejected.
- [`scripts/upgrade_treasury.md`](scripts/upgrade_treasury.md) — the mainnet upgrade runbook, and a
  record of every upgrade performed.

## Graphs

Every message flow has a Graphviz diagram in [`graphs/img`](graphs/img). To understand the
internals, read the graph for a flow before reading its code — start with `00-legend.dot`.

Requirements: [Docker](https://docs.docker.com/get-docker/) and `make`.

```sh
make build_graphviz
make graphs
```

## Development

Written in FunC using the [Blueprint](https://github.com/ton-org/blueprint) toolset, with a large
test suite covering the protocol's behaviour and its gas costs.

```sh
npm install            # install dependencies
npx blueprint build    # compile the contracts to build/
npm test               # run the test suite
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run check          # typecheck, then lint, then tests — run before any deploy
```

Prefer `npm test` over `npx jest` or `npx blueprint test`: it runs `pretest`, which type-checks
first. The other two skip npm scripts entirely, so a type error can sail past them.

Mainnet scripts run with `npx blueprint run <script>`. They need a `blueprint.config.ts`, which is
gitignored because it holds an API key — create your own from `@ton/blueprint`'s `Config` type.

## Audits

Reports live in [HipoFinance/audits](https://github.com/HipoFinance/audits):

| Date    | Auditor                                            |
| ------- | -------------------------------------------------- |
| 2025-04 | [Quantstamp](https://quantstamp.com)                |
| 2024-03 | ProgramCrafter                                      |
| 2023-10 | [TonTech](https://ton.tech)                         |
| 2023-10 | Daniil Sedov                                        |

## Security

The contracts are deployed on mainnet and hold user funds. If you find a security issue, please
**report it privately** rather than opening a public issue — contact one of the team accounts
listed on [hipo.finance/verify](https://hipo.finance/verify/), which is also the page to check any
Hipo address, link or handle against before trusting it.

## License

[MIT](LICENSE)
