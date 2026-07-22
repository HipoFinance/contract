# Hipo Contracts

Hipo is a decentralized liquid staking protocol on the TON blockchain. Users deposit GRAM
(the network coin, recently rebranded from TON) and receive hGRAM jettons (formerly hTON);
the pooled coins are lent to validators ("borrowers") each validation round, and rewards
accrue to the hGRAM exchange rate.

> Terminology: GRAM = the coin, hGRAM = the jetton. The network itself is still called the
> TON blockchain. Use GRAM/hGRAM everywhere; only `contracts/imports/stdlib.fc` (vendored)
> and historical documents keep the old TON/hTON names.

Read [docs/architecture.md](docs/architecture.md) before changing any contract — it explains
the contracts, the validation-round state machine, and the protocol invariants that changes
must preserve. Flow-by-flow message diagrams live in `graphs/` (build with
`make build_graphviz && make graphs`). Message schemas for integrators are in
`docs/integration.md` and `contracts/schema.tlb`.

## Commands

- Install: `npm install`
- Build contracts: `npx blueprint build` (FunC → `build/`)
- Test all: `npx blueprint test` (Jest + @ton/sandbox; the suite is large and slow)
- Test one file: `npx jest tests/Wallet.spec.ts`
- Lint: `npm run lint`
- Mainnet scripts: `npx blueprint run <script>` — requires `blueprint.config.ts`, which is
  gitignored (it holds an API key); create your own from `@ton/blueprint`'s `Config` type.

## Layout

- `contracts/` — FunC sources: `treasury.fc` (core), `parent.fc` + `wallet.fc` (jetton),
  `loan.fc` (per-round, masterchain), `collection.fc` + `bill.fc` (per-round SBTs),
  `librarian.fc` (library-cell deployment), `imports/` (op-codes, fees, helpers)
- `wrappers/` — TypeScript wrappers and compile configs for each contract
- `tests/` — Jest specs; `helper.ts` has shared fixtures, `MaxGas`/`MinGas` pin gas bounds
- `scripts/` — governance and operations scripts for the deployed mainnet contracts
- `graphs/` — Graphviz sources for every message flow

## Working on changes

The contracts are deployed on mainnet (addresses in README.md) and hold user funds. Changes
must consider upgrade compatibility of stored data (see `scripts/upgrade_treasury.md`) and
gas costs (`MaxGas.spec.ts` / `MinGas.spec.ts` must stay green).

For any new feature or behavior change, run the `/spec` skill first: it interviews the
requester, records a short spec in `docs/specs/`, and only then moves to implementation.
