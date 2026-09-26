# A borrower-set cap on the stake a loan request will accept

## Problem

Since the accrual-pricing release (deployed 2026-09-26, `2026-09-22-price-accrual-at-bid-rate.md`),
`decide_loan_requests` scales an accrued loan's `min_payment` by `(loan_amount + accrue_amount) /
loan_amount`. The accrual is forced: every accepted loan takes its proportional share of the leftover.
But the elector pays nothing on a validator's stake above `max_factor` times the smallest elected stake,
so a loan pushed past that cap is charged the bid rate on stake that earns nothing, and even a
`min_payment` at exactly the pool's contractual share binds and is paid out of collateral.

It is not a corner case. A loan accepted alone takes the whole pool, and a missing or refused peer
request, unequal loan sizes, or a room that fits only one make that ordinary. At deployment the pool
(~3.7M) exceeded the per-validator cap (~3.06M). A borrower who cannot rule out winning alone must
price below the bare loan: the sealed-bid daemon prices on `min(loan + A_hi + own stake, cap) × loan /
(loan + A_hi)`, which lowered its bids by about 17%. That is a cost to honest competition, not to
stakers: the pool's floor is untouched, and stake above the cap sat idle before too.

## Decision

**A request may name `max_stake`, the most it will stake in total.** `decide_loan_requests` limits the
loan's accrual so that `loan_amount + accrue_amount + stake_amount ≤ max_stake`, where `stake_amount` is
the collateral: exactly what the loan contract sends to the elector, and what the elector's cap applies
to. A borrower sets it at the cap it expects the elector to apply and is never lent stake it would be
charged for and not paid on.

- **Optional, trailing.** `request_loan` reads `max_stake` only when bits remain after `min_payment`. A
  request without it has no cap, so every existing borrower keeps working unchanged. A request that
  carries it must satisfy `max_stake ≥ loan_amount + stake_amount`, or it is refused and bounced.
- **Excess stays in the treasury.** The accrual loop stays a single pass: a capped loan takes
  `min(proportional share, max_stake − loan − stake_amount)`, and whatever it does not take is not lent
  this round. That is economically what happened before, when the same stake went to the elector over
  its cap and came back unpaid, except that it now stays liquid for instant unstakes and the next round.
- **No notice period.** Nobody's terms change unless they opt in: a request without the field is
  decided exactly as today, and a capped loan's excess goes to no one else. Changelog entry, deployed in
  the usual gap after a round is decided.

Rejected alternatives:

- **The treasury works out the cap itself.** The elector's cap depends on the smallest stake the coming
  election elects, which is not known when `decide_loan_requests` runs; `config 17`'s `max_stake_factor`
  alone does not give it. The borrower is the one who both knows its validator and bears the cost.
- **Hand a capped loan's excess to the other loans.** More of the pool would earn, but it needs a
  second pass, and for exactness an iteration, in the gas-limited decide chain whose continuation was
  just hardened. It would also change uncapped borrowers' accrual, which is what makes a notice
  unnecessary. Worth revisiting if capped excess turns out to be common.
- **Clamp the pool's take at the reward instead of reward + collateral.** It would stop the loss, but
  it also makes an over-promise cost at most the borrower's share of the reward, which reopens the
  subsidy the accrual-pricing release closed.
- **A mandatory field.** Forces every borrower to update for a protection only some need.

## Changes

- `contracts/treasury.fc`
  - `request_loan`: after `min_payment`, `int max_stake = s.slice_bits() ? s~load_coins() : 0;`, then the
    ref and `end_parse`. Refuse (`err::invalid_parameters`) when `max_stake > 0` and `max_stake <
    loan_amount + stake_amount`. `0` means no cap.
  - `pack_request` / `unpack_request`: `max_stake` appended as `coins` after `request_fee`. The unpack
    reads it only when bits remain, so requests packed by the previous code -- standing, accepted,
    staked or recovering across the upgrade -- read as uncapped.
  - `decide_loan_requests`, accrual loop: clamp `accrue_amount` to `max(0, max_stake − loan_amount −
    stake_amount)` when `max_stake > 0`, before the collateral check and before `min_payment` is scaled.
  - Every other `pack_request` call carries the request's `max_stake` through unchanged.
  - `get_loan_request` appends `max_stake` as a ninth value.
- `contracts/schema.tlb`: `request_loan` gains the optional trailing `max_stake:Coins`, with a comment on
  how it is detected.
- `wrappers/Treasury.ts`: `sendRequestLoan` takes an optional `maxStake`; `requestDictionaryValue` reads
  and writes the trailing field; `getLoanRequest` reads it.
- `docs/integration.md`, `docs/architecture.md`: the field, what it bounds, and why to set it.
- `graphs/04-request-loan.dot`: the message's fields.
- `CHANGELOG.md`, `scripts/upgrade_treasury.md`: the release; code only, no migrator.

## Invariants

- **Nothing is lent that would not have been lent before.** The cap only ever lowers `accrue_amount`;
  a request without it is decided exactly as today.
- **The exchange-rate identity is untouched.** Unlent excess stays on the balance and is counted by
  `distribute` next round like any other balance; no accounting path changes.
- **The scaled `min_payment` follows the capped accrual**, so a capped loan is held to its rate on at
  most `max_stake − stake_amount`.
- **The collateral check, the recovery clamp at `reward + stake_amount`, loss ordering and
  `total_request_fees` are unchanged.**
- **The old share format is still refused.** Sixteen bits of share cannot parse as a complete `coins`
  (4 + 8n bits), so `end_parse` throws exactly as today.

## Compatibility

- **Message:** backward compatible. Old encoders send no trailing field and are uncapped. Explorer
  decoders of `request_loan` (the open opentonapi and tongo PRs) must accept the optional field.
- **Storage:** the request cell grows by one `coins` for new requests; old requests are read tolerantly,
  so no migrator and no quiet window beyond the usual gap.
- **Readers of request cells** (sealed-borrower, borrower, the wrapper) parse front to back without an
  end check, so a trailing field is harmless to them. `get_loan_request` grows from 8 to 9 values,
  appended; the SDK reads it positionally.
- **Gas:** `request_loan` and the accrual loop do slightly more work; `gas::request_loan` moves with it
  and therefore `request_loan_fee`, which both borrower daemons now read live. Not a wallet constant.
- **Borrower software:** to benefit, a borrower sends `max_stake`. The sealed-bid daemon would set it to
  its per-loan cap estimate and could then price on the bare loan again; the public borrower would gain
  a config key. Both are follow-ups, not part of this change.

## Test plan

- A request without the field is stored with `max_stake = 0` and decided exactly as before (same
  accrual, same scaled `min_payment`).
- A request with `max_stake` below `loan_amount + stake_amount` is refused and its collateral bounced.
- **The cap binds:** a lone loan in a pool larger than its cap accrues exactly `max_stake − loan −
  stake_amount`; `min_payment` is scaled on that; the excess stays on the treasury balance and appears
  in the next round's `available`.
- A capped loan beside an uncapped one: the uncapped loan's accrual is exactly what it is today.
- A request packed by the previous code (no trailing field), staked across the upgrade, recovers and
  settles normally.
- The 16-bit share format is still refused.
- A replacement can add, change or remove the cap.
- `get_loan_request` returns the cap; the wrapper round-trips it.
- `MaxGas` / `MinGas` green; the `request_loan` and decide-loop gas re-measured.

## Out of scope

- Setting `max_stake` in the sealed-bid daemon and the public borrower (follow-ups once deployed).
- Redistributing a capped loan's excess to other loans.
- The lendable-amount freeze and minimum bid efficiency (separate TODOs).
