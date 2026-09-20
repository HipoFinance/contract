# Hold back the request fees an instant unstake can currently spend

## Problem

A borrower's `request_loan` attaches collateral **and** a fee. The collateral becomes
`total_borrowers_stake`; the fee becomes plain balance that nothing tracks. It is spent later, twice,
from that balance:

- `process_loan_requests` sends `proxy_new_stake` at `proxy_new_stake_fee` per accepted loan —
  ≈0.38 GRAM on mainnet (34,000 masterchain gas at 10,000 nano, plus four masterchain forwards);
- `recover_stakes` sends `proxy_recover_stake` at `recover_stake_fee` per staked loan — ≈0.26 GRAM.

Both are `send::regular` with no `ignore_errors`, so a shortfall fails the action phase and reverts
the whole transaction. The self-message that drove it is already consumed, so the round stalls: in
`distributing` with requests accepted and no continuation, or in `recovering` with stakes still in
the Elector. A stalled round satisfies `owes_reward?`, which holds every later round's bills.

`distribute` reserves that money — `available_now` subtracts `size * total_fee` — and
`calculate_min_coins` adds it back so `withdraw_surplus` cannot take it. **`reserve_tokens` and
`burn_tokens` subtract neither.** Their `available_ton` is only

```
ton_balance_before_msg - fee::treasury_storage - total_borrowers_stake
```

so an instant unstake may legally take every GRAM above the 10 GRAM storage floor, including the
fees the rounds in flight have already been paid for and are about to spend. Found in the
adversarial pass of 2026-09-20 and reported by two independent reviews of different areas.

Not exploitable at today's figures: 3 concurrent loans need well under 1 GRAM against a 10 GRAM
floor. The margin closes at roughly **15 concurrent loans** if a staking window and a recovery
window overlap, or **26** on the staking side alone. It is a fixed floor against a need that scales
with the number of bidders, and `fee::treasury_storage` is not there to fund this.

## Decision

**Track the prepaid fees in a root counter, `total_request_fees`, and subtract it in
`reserve_tokens`, `burn_tokens` and `get_max_burnable_tokens`** alongside `total_borrowers_stake`.

The counter moves with `size`, the number of standing requests, not with messages:

| site | change | why |
|---|---|---|
| `request_loan`, new request | `+= total_fee` | the fee has just arrived and the round will spend it |
| `request_loan`, replacement | no change | `size` is unchanged; the extra fee a re-bid pays is an over-reserve in the safe direction |
| `request_loan`, eviction over `max_validators` | `-= total_fee` | that request's lifecycle ends here |
| `process_loan_requests`, reject loop | `-= total_fee` | same |
| `recover_stake_result` | `-= total_fee` | the last draw on the round's budget has been made |

Every one of those five sites **already calls `request_loan_fee()`** for its own reasons, so the
counter adds no gas where it is maintained. Where it is read it is a root field that `load_data()`
already loads, so it adds nothing measurable there either. Each decrement is
`total_request_fees -= min(total_request_fees, total_fee)`, which clamps at zero and absorbs the
drift from a network fee price that moved between the request and its settlement.

Rejected alternatives:

- **Walk the participations on each unstake**, mirroring `calculate_min_coins`. Simplest code, no
  migration — and measured at **+11,342 gas in `reserve_tokens` and +10,978 in `burn_tokens`**,
  against a frozen shortfall of 99 gas each. About 5,000 of that is `request_loan_fee()` alone,
  which reads three config params. Those two constants are frozen to keep the Wallet code hash, so
  the wallet's fee cannot rise to meet it: the cost would come out of measured surplus that can
  never be topped up without a new wallet generation, and it would grow with the participations
  dict. This is the option that would put the wallet at risk, which is the opposite of the goal.
- **Carry the budget inside the message chain** — have `distribute` and `finish_participation` send
  the round's gas budget with their self-messages, so it is in transit rather than on the balance.
  Touches neither frozen handler and needs no stored field. Rejected for now because the money is
  exposed from `request_loan` until `distribute`, which is hours, not the seconds the chain runs;
  protecting only the chain leaves the larger window open, and `distribute`'s own
  `amount = max(size * total_fee, available)` send would then be the thing that fails when the
  balance is short. Worth revisiting if the counter ever proves awkward.
- **Raise `fee::treasury_storage`.** One constant, no migration, and it permanently reduces what
  every staker can instantly unstake by a figure that has to be guessed for a worst case that
  scales with TVL.
- **Do nothing and document the threshold.** Rejected because the threshold is reached by bidders
  arriving, which is the outcome the protocol wants.

## Changes

- `contracts/treasury.fc` — `global int total_request_fees;` in root storage, stored after
  `total_borrowers_stake` and before `deficit`; maintained at the five sites above; subtracted in
  `reserve_tokens`, `burn_tokens` and `get_max_burnable_tokens`; appended to `get_treasury_state`.
- `wrappers/Treasury.ts` — `totalRequestFees` in `TreasuryConfig` and `getTreasuryState`, with the
  temporary absent-field fallback the getter already uses for `rewardShare`.
- `wrappers/migrationDryRun.ts`, `scripts/showState.ts` — the new field.
- `wrappers/upgrade-code-test/add_reward_share.fc` — extended to seed `total_request_fees`, or a
  second migrator; decided during implementation on whichever keeps the migrator simpler to read.
- `scripts/upgrade_treasury.md` — the field and its seed value in this release's section.
- `docs/architecture.md` — the instant-unstake liquidity rule now names the fees as reserved.

## Invariants

- **The exchange rate is untouched.** `total_request_fees` is a liquidity bound, like
  `total_borrowers_stake`; it enters no rate, no reward and no token arithmetic.
- **Nothing that could be paid before is refused now that should not be.** The counter only ever
  holds back GRAM the treasury has actually been paid and is committed to spend. A staker whose
  instant unstake is refused because of it takes the deferred path, as they already do whenever the
  pool is short — no unstake is lost, only re-routed.
- **The counter cannot strangle the pool.** It is bounded by `size * total_fee` over the rounds in
  flight, at most 100 requests per round at ≈0.72 GRAM, and every path that removes a request
  decrements it.
- **It cannot go negative.** Every decrement clamps, so a fee price that fell between request and
  settlement cannot underflow `store_coins`.
- **The seeded value is conservative.** The migrator seeds the counter for the requests standing at
  upgrade time; if it seeds zero instead, the contract is exactly as safe as it is today and
  self-corrects within one round.

## Compatibility

- **Root storage gains one `coins` field.** Requests and participations are untouched, so rounds in
  flight need no migration.
- **`get_treasury_state` grows from 27 to 28 values.** Fourth time. Walk the census in
  *Changing the shape of a getter*, including `poker`, which guards `len < 26` and survives.
- **No message schema changes.** No new op, no field added to any message.
- **Gas:** no new work at any maintenance site; one extra `store_coins`/`load_coins` in
  `save_data`/`load_data`, which every handler pays. `MaxGas` will move by that much and the `_cost`
  twins move with it; the two frozen constants must be re-measured to confirm the shortfall has not
  grown past the measured surplus, on both unstake paths.

## Test plan

- An instant unstake that would have taken the prepaid fees is refused and takes the deferred path,
  with a standing request in the dict.
- The counter is exact across a full lifecycle: request, re-bid, eviction, rejection, staking,
  recovery — assert it returns to its starting value once the round settles.
- A re-bid does not increase it; an eviction over `max_validators` decreases it.
- It clamps rather than underflowing when the fee price falls between request and settlement.
- The round that stalls today does not: ~15 accepted loans, an instant unstake for everything
  `available_ton` offers, then `process_loan_requests` and `recover_stakes` both complete.
- `MinGas`'s two exact-fee unstake tests and the four-postponement test stay green, and `MaxGas`
  shows the frozen shortfall still inside the measured surplus.
- The migration rehearsal in `TreasuryMigration.spec.ts` covers the new field.

## Out of scope

- `2026-09-02-minimum-bid-efficiency.md` and the rank-versus-capital question; separate specs.
- Any change to what `distribute` reserves or to `calculate_min_coins`; both already hold this money
  back and are correct.
