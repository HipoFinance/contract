# Explorer actions for the loan and round lifecycle

## Problem

The staker-facing half of the protocol now reads well in explorers (see
`2026-08-04-explorer-actions.md` and its follow-up fixes). The borrower and round-lifecycle
half does not. Measured over 603 recent mainnet traces around the treasury and parent:

- `request_loan` appears in **129 traces and is classified in none**. It does at least decode:
  tonviewer shows one "Execution of smart contract" row whose payload carries `LoanAmount`,
  `MinPayment`, `BorrowerRewardShare` and the whole `NewStakeMsg`.
- A round-end trace is **up to 106 transactions rendering as 86 actions, ~57 of them bare
  "Execution of smart contract"**.
- Eleven loan/round op-codes are **not declared in tongo's ABI at all**, so they render as raw
  hex with no name and no fields: `0x574a297b`, `0x6a31d344`, `0x071d07cc`, `0x2f0b5b3b`,
  `0x23274435`, `0x4f173d3e`, `0x089cd4d0`, `0x407cb243`, `0xcd0f2116`, `0x8b556813`,
  `0x5e2d81f4`.
- **The five log topics the treasury emits are invisible.** `emit_log` sends an external-out
  message whose 256-bit destination address *is* the topic (`log::loan` = 1, `repayment` = 2,
  `finish` = 3, `failed_burning_tokens` = 4, `deficit` = 5) and whose body starts straight at
  `round_since` with no op-code. Explorers key external-out decoding on a body op-code, so
  they read the first 32 bits — `round_since` — as if it were one, and tonapi duly reports a
  different "op-code" every round.
- The three ops that arrive as **external** messages (`participate_in_election`,
  `vset_changed`, `finish_participation` — the only three `route_external_message` accepts)
  produce **no action at all**: tonviewer shows "Something happened but we don't understand
  what". 46 `vset_changed` and 23 each of the other two in the sample window.

What already works and must not be disturbed: the Elector legs surface as
`ElectionsDepositStake` / `ElectionsRecoverStake` through the loan contracts;
`request_loan`, `loan_result`, `recover_stake_result`, `burn_all` and `last_bill_burned` are
already declared in tongo; and the per-bill `JettonMint` / `WithdrawStake` / `DepositStake`
actions from `opentonapi#971` already make the staker's own money legible inside these
traces.

## Decision

Four deliverables, in dependency order.

1. **Complete the tongo ABI** for the eleven loan/round ops above, so every row gains a name
   and its `round_since` — the field that lets one round be followed through a trace. Same
   shape of contribution as `tongo#499`, which was merged. Open as `tongo#504`.
2. **Read the treasury's logs in `bath`.** They carry figures that appear nowhere else, so
   this has to come before the actions that report those figures. It is also the one piece
   that does not wait on a tongo release.
3. **New action types in opentonapi's OpenAPI schema** for the loan lifecycle, filled from 2.
4. **Straws** that build those actions, and that give the three external round triggers an
   action where they have none.

Decided by interview (2026-09-18):

- **Audience is stakers, for transparency** — not only operators. An 86-row trace is
  unreadable to a non-expert however well each individual row is named, so collapsing the
  repetitive legs is a deliverable in its own right rather than a nice-to-have.
- **Propose new action types directly**, rather than reusing `SmartContractExec` with better
  payloads. This is the slower and less certain path: a schema change to a shared API needs
  maintainer buy-in and client rendering before anyone sees it, and the same pattern has left
  us waiting weeks before. Chosen deliberately, because a decoded payload behind an
  "Execution of smart contract" row does not serve a staker, which is who this is for.
- **The new types are generic, with an implementation enum — not Hipo-specific.** Upstream's
  own design language is a generic action plus a discriminator: `DepositStakeAction` carries
  `implementation: PoolImplementationType`, whose enum already contains `hipo`. A
  `LoanRequestAction` that any lending pool could emit is far likelier to be accepted than a
  `HipoLoanRequestAction`, costs us nothing, and reuses an enum value we already own.
  Rejected: Hipo-branded type names.
- **Reusing `DepositStake` / `WithdrawStake` for loans is rejected outright**, not merely as
  a style matter: consumers aggregate those as pool inflow and outflow, so lending activity
  reported through them would corrupt every staking metric downstream, including our own
  DefiLlama adapter.
- **Governance and maintenance ops are out of scope** (`set_*`, `propose_governor`,
  `accept_governance`, `upgrade_code`, `gift_coins`, `withdraw_surplus`, `retry_*`).
- **The logs are not decoration, they are the data source.** `LoanSettled` is supposed to
  carry the reward split, and that split exists **nowhere else**: `loan_result` carries only a
  query id, and `recover_stake_result` carries `ok`, `borrower` and `round_since` with no
  amounts at all. Only `log::repayment` has `repayment_amount`, `loan_amount`,
  `accrue_amount`, `stakers_share`, `governor_share`, `borrower_share` and `burn_share`.
  Likewise `log::finish` is the only place a round's `total_staked` / `total_recovered` /
  `total_coins` / `total_tokens` appear together. So the logs have to be read before
  the actions can be built, not after them.
- **`bath` reads the logs itself rather than waiting for tongo.** tongo dispatches
  external-out messages on a body op-code, which these do not have, so it cannot decode them
  today at any width. opentonapi does not need it to: `core.Message` carries
  `DestinationExtern` (a raw `BitString`, so the topic is readable) and `Body`, and
  `BubbleTx` already keeps `externalOut`. A straw can therefore match on the topic and parse
  the body directly. This also means deliverable 2 is **not blocked on the tongo release**,
  unlike 3 and 4.
- **Separately, ask tongo to dispatch `ext_out` on the destination topic.** Its
  `ExtOutMessageDecoder` already takes `dest` and ignores it, with a `//todo` next to it.
  Worth raising as a generic capability — the topic-in-`addr_extern` convention is a common
  TON idiom, not a Hipo invention — but as its own request, not a dependency of this work.
- **The three externals are in scope and the mechanism is proven.** An earlier draft called
  them blocked, confusing a new **API action type** with a new **bubble type** — the latter
  is internal to `bath` and costs nothing outside it. A straw may claim the external
  transaction and emit an action naming the treasury as both executor and contract, which is
  what upstream already does for tick-tock transactions. Verified by prototype against
  mainnet trace `aa85817453304d37…`: zero actions become one.

## Changes

Nothing in this repository's contracts, wrappers, or tests. Per repository:

- `tonkeeper/tongo`, `abi/schemas/hipo_finance.xml`: declare the eleven ops. Three of them —
  `participate_in_election`, `vset_changed`, `finish_participation` — must be declared as
  **ext_in**, not internal: `route_external_message` is the only handler that accepts them,
  and it accepts nothing else. `proxy_new_stake` carries `new_stake_msg:^NewStakeMsg` —
  declare it by reference to the Elector's existing schema rather than restating it. Declare
  the pre-2026-09-05 `request_loan` layout as well, or history stops decoding: the
  `borrower_reward_share` widening means an old request underflows the current declaration
  rather than merely misreporting.
- `tonkeeper/opentonapi`, `api/openapi.yml` plus generated code: three action types, each
  carrying `implementation: PoolImplementationType`. Their amount fields come from the logs
  of deliverable 2, not from the internal messages, which do not carry them.
  - `LoanRequest` — borrower, pool, loan amount, minimum payment, borrower reward share,
    round.
  - `LoanSettled` — borrower, pool, round, amount recovered, and the split: borrower reward,
    protocol fee, burner fee, pool take, or the punishment when the round lost money.
  - `PoolRoundTransition` — pool, round, and which transition (`election`, `began`, `ended`,
    `settling`), covering the three externals and giving a staker the round's spine.
- `tonkeeper/opentonapi`, `pkg/bath/hipo.go`: straws building those three, folding each
  loan's staking leg (`proxy_new_stake` → `new_stake` → confirmation) and settlement leg
  (`recover_stake_result` → `loan_result` / `take_profit` / `take_borrower_fee`) into one
  action per loan. Anchored on `references.HipoTreasury`, per the rule the September fixes
  established: a straw that names an account must be pinned to an address only Hipo can send
  from, and "sent by the treasury" is not such a pin — see that spec's notes on
  `reserve_tokens`.
- `tonkeeper/opentonapi`, `pkg/bath/hipo.go`: read the treasury's external-out logs, keyed
  on the topic in `DestinationExtern`, to fill the actions above. The five bodies, each
  starting at `round_since:uint32` with no op-code, are defined by `log_*` in
  `contracts/imports/utils.fc` and `log_deficit` in `treasury.fc`. Field names follow those
  function signatures, and every field must be checked against the FunC rather than against
  `schema.tlb` — which does not describe the logs at all, and was wrong about the externals.
  Note `log_loan`'s seventh field is declared `borrower_fee` in the signature but passed
  `request_fee` at the call site; confirm which it is before naming it.
- This repository, docs only: `contracts/schema.tlb` got these three wrong twice over.
  `participate_in_election`, `vset_changed` and `finish_participation` were declared
  `InternalMsgBody` when `route_external_message` is the only handler that takes them, and
  `finish_participation` was given a `uint32` query id when `treasury.fc` reads
  `load_uint(64)`. Both are fixed. The second one matters more than a wrong annotation
  looks: it is a plausible-looking lie that was copied straight into the ABI, where it
  reported the low half of the query id as the round. Anything generated from this file
  should be checked against the FunC, not against the file. Extend the "Explorer Actions" section of
  `docs/integration.md` with the loan/round taxonomy.

## Invariants

- No on-chain state, message, or gas change. Every invariant in `docs/architecture.md` is
  untouched; `MaxGas`/`MinGas` unaffected.
- The staker-facing actions shipped in `opentonapi#971` must not change. A round-end trace
  already yields `JettonMint` and `WithdrawStake` per settled bill; straws added here fold
  only loan legs and must leave those counts exactly as they are. The 603-trace replay sweep
  is the check, not an assumption.
- A log is only trusted from the treasury's own transaction. The topic is an address the
  treasury writes, so a look-alike external-out from any other contract must not be read as
  Hipo's — the same anchoring rule the September fixes established, applied to logs.
- Reported amounts come from message bodies, never from attached values: `loan_result` and
  `recover_stake_result` carry the figures, and the attached GRAM includes gas.
- The constraint from `2026-08-04-explorer-actions.md` applies and widens: these eleven
  op-codes become external ABI once declared, so changing their layout later needs a
  coordinated upstream PR.

## Ordering and risk

The ABI must land **and be released and bumped in opentonapi** before the straws are worth
reviewing: until then `decodedBody` is nil for these ops, a straw would have to match raw
op-codes, and the maintainer's review of `opentonapi#939` explicitly asked for abi names
instead. Sequence: tongo PR → tongo release → opentonapi PR. The log reading (deliverable 2) is the
exception: `bath` parses those bodies itself, so it can be built and reviewed without waiting,
and it is the part the action types depend on.

The schema change is the risk. Mitigations, in the order they should be tried:

- Keep the straws separable from the type change in the opentonapi PR, so that if the
  maintainer declines the new types we can fall back to emitting `SmartContractExec` without
  redoing the straw work.
- Open the PR with the generic naming and an explicit offer to rename or narrow, rather than
  waiting on an issue first. `#938` showed an issue alone does not move faster.
- If the types are declined outright, the ABI half still stands on its own and this spec's
  fallback is the `SmartContractExec` shape described in the rejected alternative above.

## Test plan

- tongo: decode one real mainnet message per declared op, check every field against the
  **FunC source** rather than `contracts/schema.tlb`, and assert each decode consumes the
  whole body — a field declared too narrow decodes fine and reports a plausible number, so
  leftover bits are the only signal. Trace hashes for all eleven are in the local replay corpus.
  Implemented as `abi/hipo_finance_test.go` in `tongo#504`, which also pins the two field
  widths that decode "successfully" while reporting the wrong number.
- opentonapi: replay the round-end traces offline through the harness that reproduces the
  committed goldens byte for byte; assert the loan legs collapse and that `JettonMint`,
  `WithdrawStake` and `DepositStake` counts are unchanged.
- Re-run the 603-trace regression sweep against unmodified `origin/master`: no trace that
  does not touch Hipo may change.
- One real mainnet log per topic, decoded and checked field by field against the `log_*`
  functions, asserting the body is fully consumed. `log::failed_burning_tokens` and
  `log::deficit` may have no mainnet instance; if so, say the fixture is constructed.
- A forgery case per new straw, in the style of `TestHipoStrawsRejectForgeries`: every new
  action names a borrower, so each must be unforgeable by a look-alike chain.
- Goldens for one `vset_changed`, one `participate_in_election`, one `request_loan` and one
  full round-end trace.

## Out of scope

- Any change to the deployed contracts or their schemas (the `schema.tlb` fix is an
  annotation correction, not a layout change).
- Governance and maintenance op-codes.
- A local round-lifecycle viewer script in this repository — offered during the interview
  and explicitly declined.
- toncenter `ton-indexer`: its classifier is frozen mid-rewrite, so loan actions there wait
  for the port (see the `explorer-actions-prs` notes).
- Teaching tongo to dispatch external-out messages on their destination topic. Worth asking
  for on its own merits, and `bath` does not need it, so it must not gate this work.
