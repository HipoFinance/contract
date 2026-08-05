# Explorer actions for Hipo flows

## Problem

TON explorers show Hipo operations as raw multi-contract message chains. A deferred
unstake, for example, appears as a generic jetton "Burn" plus unrelated-looking bill
transactions, and the round-end payout appears disconnected from the unstake that caused
it. Protocols like Tonstakers get a single "Stake" / "Unstake" action with an amount,
because the explorers' trace classifiers recognize their message patterns. Nothing on
Hipo's side is broken — this is purely about getting Hipo's patterns into the external
classifiers.

Research findings (2026-08-04):

- **tonviewer.com + Tonkeeper wallet** are powered by TonAPI. Open-source core:
  `tonkeeper/opentonapi` (actions built by "straws" in `pkg/bath`), op-code decoding in
  `tonkeeper/tongo` (`abi/schemas/hipo_finance.xml` already exists but only covers
  `deposit_coins`, `proxy_tokens_minted`, `tokens_minted`), labels in
  `tonkeeper/ton-assets` (Hipo already listed). No Hipo straws yet. tongo accepts
  community PRs (precedent: bemo, swap.coffee); `pkg/bath` straws have historically been
  team-written, so that PR needs an accompanying issue/ask to the TonAPI team.
- **toncenter API v3** (`toncenter/ton-indexer`) is the highest-leverage target: its
  Python action classifier (`indexer/indexer/events/blocks/staking.py`) already emits
  `stake_deposit` / `stake_withdrawal` / `stake_withdrawal_request` with a `provider`
  field for Tonstakers, nominators, swap.coffee, and Ethena — and its actions feed many
  frontends, including actonscan.com. Community PRs have precedent (swap.coffee PR #245,
  Cocoon PR #353). Hipo op-codes are already in its `ton-marker` TLB, but no classifier.
- **actonscan.com** (TON Core's Acton toolkit, `ton-blockchain/acton`) consumes toncenter
  v3 actions, so it lights up automatically once the toncenter PR lands. Its ABI catalog
  already annotates all seven Hipo contracts, but with pre-rename "hTON" naming.
- **tonscan.org** (`catchain/tonscan`) renders per-message labels from the closed-source
  api.ton.cat backend; the frontend repo is stale. Only its `catchain/address-book` is
  realistically PR-able (treasury label).
- **tonscan.com** (Bastion Digital) is fully closed source with no contribution path;
  outreach only.

## Decision

No contract changes. Contribute action recognition to the external repos, impact-first:

1. **toncenter/ton-indexer** — classifier PR (feeds actonscan + all API v3 consumers).
2. **tonkeeper/tongo** — complete `hipo_finance.xml`, then **tonkeeper/opentonapi** —
   bath straws PR plus an issue to the TonAPI team (feeds tonviewer + Tonkeeper).
3. Small label/naming PRs: `catchain/address-book` (add Hipo treasury),
   `ton-blockchain/acton` (rename hTON → hGRAM in the ABI catalog).
4. tonscan.com: short outreach message with a pointer to this action taxonomy; no code.

User-facing staking actions (deposit, unstake, and their deferred completions) are the
primary deliverable. Borrower-loan and round/governance actions are a best-effort second
wave: upstream schemas have no loan-shaped action types today, maintainers may decline
niche types, and op-code-level decoding (already present in acton, dton, and partially in
tongo) is an acceptable fallback for them.

Rejected alternative: defining our own "explorer hints" (e.g. text comments or extra
notification payloads) in the contracts — explorers do not consume such hints, and
contract changes for display purposes are unjustified for mainnet contracts holding funds.

## Action taxonomy

All op-codes below are from `contracts/schema.tlb` (verified). Addresses: treasury
`EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ`, parent
`EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w`.

**Stake — instant** (graph 02.1): `deposit_coins#3d3761a6` → treasury →
`proxy_tokens_minted#5be57626` → parent → `tokens_minted#5445efee` → wallet →
`transfer_notification#7362d09c`. One action: *Stake N GRAM, received M hGRAM*.

**Stake — deferred** (graph 02.2): `deposit_coins` → treasury → {`proxy_save_coins#47daa10f`
→ `save_coins#4cce0e74`} + {`mint_bill#4b2d7871` → collection → `assign_bill#3275dfc2` →
bill → `ownership_assigned#05138d91`}. One action: *Stake N GRAM (pending until round
end)*. Completion at round end (graph 08): `burn_bill#6f89f5e3` → `bill_burned#840f6369` →
`mint_tokens#42684479` → `proxy_tokens_minted` → `tokens_minted` →
`transfer_notification`: *Stake completed, received M hGRAM*.

**Unstake — instant** (graph 03.1): `unstake_tokens#595f07bc` (TEP-74 burn) → wallet →
`proxy_reserve_tokens#688b0213` → parent → `reserve_tokens#386a358b` → treasury →
`proxy_tokens_burned#4476fde0` → `tokens_burned#5b512e25` →
`withdrawal_notification#f0fa223b` carrying the GRAM. One action: *Unstake N hGRAM,
received M GRAM*. Classifiers must claim the trace before/instead of the generic jetton
Burn action (in opentonapi: a straw whose parent matches the already-merged
`BubbleJettonBurn`, like Tonstakers' `PendingWithdrawRequestLiquidStraw`).

**Unstake — deferred** (graph 03.2): same head through `reserve_tokens`, then `mint_bill`
→ `assign_bill` → `ownership_assigned`. One action: *Unstake N hGRAM requested (payout at
round end)* — maps to `stake_withdrawal_request` in toncenter terms. Completion at round
end (graph 08): `burn_bill` → `bill_burned` → `burn_tokens#7cffe1ee` →
`proxy_tokens_burned` → `tokens_burned` → `withdrawal_notification`: *Withdrawal of M
GRAM* (`stake_withdrawal`). Rollback leg (`proxy_rollback_unstake#32b67194` →
`rollback_unstake#1b77fd1a`) must not classify as a withdrawal.

**Borrower/round (second wave, best-effort)**: `request_loan#36335da9` (borrower →
treasury); loan disbursement to Elector via loan contracts; recovery
`recover_stake_result#0fca4c86` → `loan_result#faaa8366` (borrower) +
`take_profit` (governor). The Elector legs may already surface as
`ElectionsDepositStake`/`ElectionsRecoverStake` in TonAPI. Governance messages stay
op-code-decoded only.

## Changes

Nothing in this repository's contracts, wrappers, or tests. Per external repo:

- `toncenter/ton-indexer`: message classes in
  `indexer/indexer/events/blocks/messages/staking.py`, Hipo matchers in
  `blocks/staking.py` (modeled on `TONStakersDepositMatcher`), registration in
  `events/event_processing.py`, serialization in `blocks/utils/block_tree_serializer.py`
  and `ton-index-go/index/parse/actions.go` (provider value `hipo`), YAML test traces in
  `indexer/tests/test_cases/`, backfill script in `indexer/actions-updates/`.
  Decisions made during implementation: a deferred stake is a `stake_deposit` at request
  time with `tokens_minted = null` as the pending signal (their schema has no
  deposit-request type); round-end completion legs emit a second `stake_deposit` /
  `stake_withdrawal` per settled user, joined to the request half by the bill SBT address
  (the role `ts_nft` plays for Tonstakers — deposits use a new additive `payout_nft`
  field); a rollback matcher returns no blocks so the trace stays a plain `jetton_burn`;
  amounts come from the proxy messages, not `msg.value` (a `deposit_coins.coins` of zero
  means "stake everything after fees").
- `tonkeeper/tongo`: extend `abi/schemas/hipo_finance.xml` with the unstake/bill/round
  ops above (verify existing three ops field-by-field against `schema.tlb` — verified
  correct). `burn_bill#6f89f5e3` is deliberately not declared: it is byte-identical to
  TEP-85 `revoke`, which tongo already decodes as `SbtRevoke`; declaring it again would
  create an ambiguous duplicate decoder for the opcode.
- `tonkeeper/opentonapi`: Hipo straws in `pkg/bath` (deposit modeled on
  `DepositLiquidStakeStraw`, unstake on the jetton-burn-parent pattern), golden-trace
  tests in `pkg/bath/testdata/`, plus a tracking issue for the team. Action-type
  decision: use the pool-shaped `DepositStake`/`WithdrawStakeRequest`/`WithdrawStake`
  actions with a new `hipo` `StakingImplementation` enum value, not the
  `DepositTokenStake` shape the interview leaned toward — the token-stake actions carry
  no pool account (the treasury would never be attributed in account-scoped queries),
  render withdraw requests with a hardcoded "ALL" amount, and have no completed-withdraw
  type, so instant unstakes could not display at all. Two trace subtleties handled: the
  generic NFT straw merges `assign_bill`/`ownership_assigned` before Hipo straws run
  (matcher accepts both shapes), and a rolled-back unstake looks like a success because
  the treasury `throw(0)`s after sending `proxy_rollback_unstake` (a dedicated guard
  keeps it a plain burn).
- `catchain/address-book`: YAML label for the treasury.
- `ton-blockchain/acton`: hTON → hGRAM naming fixes in `acton-abi-catalog`.
- This repo, docs only: add an "Explorer actions" section to `docs/integration.md`
  summarizing the taxonomy above, so future integrators (and future PRs) have a canonical
  reference; update it if upstream reviews change the mapping.

## Invariants

- No on-chain state, message, or gas change; all protocol invariants in
  `docs/architecture.md` are untouched. `MaxGas`/`MinGas` unaffected.
- New durable constraint documented by this spec: **op-codes in `contracts/schema.tlb`
  become external ABI for explorers.** Once classifiers ship, changing an op-code or
  message layout in a future upgrade silently breaks explorer display and requires
  coordinated upstream PRs. Any future spec that touches schemas must list the explorer
  repos as affected integrators.

## Compatibility

- Explorers classify historical traces too (toncenter requires a backfill script in the
  PR), so pre-rename hTON-era transactions get the same actions — naming in display
  strings should say hGRAM/GRAM per current branding, matching what ton-assets already
  shows.
- The deployed wallet fleet has mixed versions (old parents); classifiers match on
  treasury/parent addresses and op-codes, both stable across wallet upgrades. The parent
  address can change in a future upgrade (`old_parents` mechanism) — noted in the
  upstream PRs so classifiers key on the treasury where possible.

## Test plan

- Upstream test fixtures from real mainnet traces, one per taxonomy row: instant stake,
  deferred stake + its round-end completion, instant unstake, deferred unstake + its
  completion, rollback (must stay unclassified), and a `request_loan` example. Collect
  trace hashes from recent treasury history before opening PRs.
- opentonapi: golden JSON cases in `pkg/bath/bath_test.go` referencing those hashes.
- toncenter: YAML trace cases mirroring `tonstakers.yaml`.
- Local sanity check: decode the same traces with our wrappers to confirm amounts in the
  emitted actions match `withdrawal_notification` / `transfer_notification` payloads.

## Out of scope

- Any change to the deployed contracts or their schemas.
- tonscan.com and api.ton.cat backends (closed source; outreach only).
- dton.io and ton.app (already covered / not an explorer).
- Guaranteeing upstream acceptance or timelines — we control PR quality, not merges.
- Hipo webapp changes.
