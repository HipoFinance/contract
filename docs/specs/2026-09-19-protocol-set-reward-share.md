# The reward share is set by the protocol, not bid by the borrower

## Problem

The pool's revenue from a loan is

```
treasury_reward = max(min_payment, muldiv(reward, 65535 - borrower_reward_share, 65535))
```

— two quantities, and **the borrower picks which one binds**. `request_sort_key` ranks on only one of
them, `min_payment / loan_amount`; `borrower_reward_share` enters the key only as a tie-break, and
`request_loan` reads it as a bare `uint16` with no upper bound. Three consequences, all live today:

**The pool can be paid nothing.** A request with `borrower_reward_share = 65535` and
`min_payment = 0` makes both terms zero. Such a bid ranks last, but rank only decides the *order*
requests are served in — a low-ranked loan still wins whenever it fits in what higher bids leave, and
with a field this thin there is always room. Priced against the actual shape of round 1789742856 —
three loans, of 928,689 and of 1,351,481 twice:

| what the two larger loans bid | pool's take | each keeps | APY |
|---|---|---|---|
| today: share 1799, min_payment 934.16 | 2,475 | −38 | 17.9% |
| share 32768, min_payment 0 | 1,515 | +227 | 10.6% |
| share 65535, min_payment 0 | 607 | +454 | **4.1%** |
| the same, holding the whole pool | **0** | +610 | **0.0%** |

The pair's income would go from 11,992 GRAM a year to 436,848 — thirty-six times more — by
changing one number in a message they already send every round.

**Rank can be bought and taken back.** One quantum of `min_payment` above the field buys first
service; the share is where the money is recovered. A bid of share 14,617 with `min_payment` 935
outranks an honest 1,799 / 934.16 and hands the pool 935 instead of 1,170 — **17% of the take on that
loan**, while the bidder keeps eight times as much.

**And competition cannot help stakers**, because the dimension a borrower would compete on is not the
one the auction reads. In 46 settled loans the share has never been contested: every loan
has carried 1799, and the only variation in the protocol's history is a single hand-set value.

The two flaws share a cause. `max(a, b × R)` cannot be ordered against `max(a′, b′ × R)` without
knowing the round's reward `R`, which nobody knows at bid time — so no ranking rule over two free
dimensions is both monotone and oracle-free. The fix is to remove a dimension, not to rank better.

## Decision

**`borrower_reward_share` becomes a protocol parameter, not part of the bid.** The governor sets one
value for all loans; `request_loan` stops reading it from the message and snapshots the protocol's
value into the request, exactly as it already does with `borrower_fee`. The bid becomes one number:
`min_payment`.

With the share common to every bidder, `s₀ = (65535 − share)/65535` is a constant of the round, so:

- **The existing sort key becomes exactly monotone in what the pool receives.** Ranking on
  `min_payment / loan_amount` now orders bids by pool revenue, with no change to `request_sort_key`
  and therefore no re-sorting hazard.
- **The pool has a floor, with no reserve price to maintain:** `treasury_reward ≥ s₀ × reward`,
  always, whatever anybody bids. On today's figures that floor is an APY of **17.1%** against the
  current 17.9%, where today's floor is **0%**.
- **Competition can only push above it.** `min_payment` above the clamp is money the pool keeps.

Three attacks close at once. The share substitution and the `share = 65535` bid both need a field the
borrower no longer controls. So does the **borrower-monopoly APY attack**: a borrower who takes the
entire pool can still only pay the contractual share, so stakers see the same APY as in a contested
round. Exclusion stops being a protocol problem and becomes a commercial one between borrowers.

Rejected alternatives:

- **Cap the share instead of fixing it.** Bounds the catastrophe but legitimises the dial: bidding
  right at the cap stays free, so the equilibrium drifts from today's 2.745% up to the cap and we
  trade a tail risk for a permanent loss.
- **Allow the share below `s₀` and rank on it.** Equally secure, and it offers borrowers a *risk-free*
  way to compete — giving up part of a proportional claim rather than promising an absolute amount.
  But the dimension is either inert (as a tie-break, nobody uses it) or unstable (weighted, and with
  capacity scarce it is a Bertrand race to share 0, where a borrower's income is the 1 GRAM
  `min_burn` with no reward to offset it, so borrowers leave and the market oscillates). Stabilising
  it needs a minimum share as well as a maximum. The whole channel is worth at most 2.745% of the
  reward — about +0.5 points of APY — at the endpoint where borrowers stop bidding. It can be added
  later without undoing this change.
- **Pure fixed rent** (pool receives exactly `min_payment`, no share at all). Monotone and simpler
  still, but stakers lose upside participation and it needs a reserve price, which this design gets
  for free.

## Changes

- `contracts/imports/constants.fc` — `op::set_reward_share`.
- `contracts/treasury.fc` — `reward_share` global stored in the extension as `uint16` after
  `borrower_fee`; `request_loan` stops loading the share from the message and packs the extension's
  value into the request (`unpack_extension()` already runs at the top of that handler, so the read
  is free); `set_reward_share` mirroring `set_borrower_fee`, refusing `65535`; `recv_internal`
  dispatch; `get_treasury_state` appends it at index 26.
- `contracts/schema.tlb` and `docs/integration.md` — `request_loan` loses its
  `borrower_reward_share:uint16`; the new op; the getter's new value.
- `wrappers/Treasury.ts` — drop the field from the `request_loan` builder, add `rewardShare` at index
  26 and a `sendSetRewardShare`; `wrappers/common.ts` — the op code.
- `docs/architecture.md` — *Loan economics*: the share is protocol-set, and what that guarantees.
- `graphs/04-request-loan.dot` — the message's fields.
- `scripts/upgrade_treasury.md` and the upgrade script — write `reward_share = 1799`, today's value,
  so the upgrade changes no economics.
- Off chain, in the same release: every borrower's software must stop sending the field.

## Invariants

- **The exchange-rate identity is untouched.** The share still reaches `recover_stake_result` through
  the request; only its origin changes. `treasury_reward`, `new_coins` and the burn are computed
  exactly as before.
- **A committed loan cannot be repriced.** The value is snapshotted into the request at
  `request_loan`, following `borrower_fee` for the same reason: `set_reward_share` must not change
  the terms of a bid already made. There is no window in which no participation is mid-flight, so
  this has to be structural rather than a matter of timing the governance call.
- **Monotonicity holds within a round, which is where it matters.** The share is snapshotted at
  request time, so a `set_reward_share` sent while a participation is open leaves that round holding
  two different shares, and the key can then order two bids by `min_payment/loan` when the other
  carried the better share. The gap is bounded by the size of the governance change and lasts one
  round. Recorded rather than designed away: the alternative is applying the new value at acceptance,
  which reprices a committed bid — the thing the snapshot exists to prevent. `set_reward_share`
  belongs between rounds, and the runbook says so.
- **The ranking is unchanged and now monotone.** `request_sort_key` keeps its 120-bit shape and its
  16 bits of treasury share — constant across a round, so the key degenerates to efficiency then loan
  size, which is the intended order. `sorted` is never rebuilt and cannot mix two orderings.
- **The borrower fee is unchanged.** Its base is still the contractual share of the gross reward, now
  a protocol-set fraction, so the reasoning in `2026-08-31-borrower-fee-hpo-burn.md` carries over
  intact — including that the fee is charged on top of the pool's take and never carved out of it.
- **Loss ordering is unchanged**: punishment, then the pool, then the burner, then the borrower.
- **The floor is on the SPLIT of a reward, not on the pool's revenue.** `treasury_reward` is at least
  `s₀ × reward`, but `reward` is zero for a stake the Elector accepts and does not elect, so a loan
  that is never elected pays the pool nothing however this parameter is set. Stated here because the
  Decision above reads as a revenue floor and it is not one; see *What remains possible*.

## Compatibility

- **The `request_loan` body loses 16 bits.** An old encoder's message still parses its ref — refs are
  counted separately from bits — and then fails `s.end_parse()`, so the request throws and bounces
  with the collateral intact. Loud, which is the same choice made when the share widened from `uint8`
  to `uint16`. Every borrower's software needs updating in the same release.
- **The request and participation layouts are unchanged**, so requests and rounds in flight across the
  upgrade need no migration. They keep the share they were made with, so the first fully protected
  round is the first whose requests are all made after the upgrade.
- **Extension layout** gains 16 bits after `borrower_fee`: the budget comment above `pack_extension`
  moves from 664 to 680 non-rate bits, 772 to 788 in the realistic worst case, against the 1023-bit
  ceiling.
- **`get_treasury_state` grows from 26 to 27 values.** Third time; consumers index positionally *and*
  assert length, so the wrapper needs its temporary old-shape branch or `showState` and the dry run
  break before the upgrade lands. Borrowers now *must* read this getter — it is how they learn what
  share their loan will carry — so the value has to be exposed rather than kept private.
- **Upgrade is economically neutral**: writing 1799 reproduces today's terms exactly. No governance
  call is needed to activate it.

## Test plan

- A `request_loan` message carrying the old field is refused and the collateral is refunded.
- A request made after the upgrade carries the protocol's share, whatever the sender wanted.
- `set_reward_share` is governor-only and refuses 65535.
- **The attack is dead:** a borrower who would have bid share 65535 / `min_payment` 0 now yields the
  pool `s₀ × reward`; assert the pool's take against the same round replayed on the old contract.
- **The floor holds:** with every bidder at `min_payment` 0, the pool still receives
  `muldiv(reward, 65535 − reward_share, 65535)` on every loan.
- **Monotonicity:** across a table of bid pairs, the one the accept loop serves first is never the one
  that pays the pool less.
- A loan requested before the upgrade and recovered after it settles on its snapshotted share, not the
  extension's.
- A `set_reward_share` sent after a request does not change that request's share, and the getter shows
  the new value — the two-shares-in-one-round case, asserted rather than assumed.
- `reward_share = 1799` reproduces today's allocation and recovery figures loan for loan.
- `MaxGas` / `MinGas` stay green.

## What remains possible

**Idle capital.** A borrower can take a loan, not be elected, and pay the pool nothing — the reward is
zero, so its contractual share is zero too. Taking the whole pool that way needs slices the Elector
accepts (≥ `min_stake`, 300,000) but does not elect (under about 700,000): six or more of them on
today's 3.6M, each with its own address and validator key, costing roughly 102 GRAM of collateral
locked per slice and the 1 GRAM burn floor — about 6 GRAM a round, 2,900 a year, to earn stakers
nothing on what they hold.

Two things bound it, and they are why this is not a reason to delay the change:

- `min_payment` 0 **ranks last**, so every honest bid is served first. The damage is confined to
  capacity nobody honest bid for.
- Taking capacity *away* from an honest bidder means outranking it, which means promising a real
  `min_payment` — and an unelected stake pays that promise out of collateral. Buying rank in order to
  waste the pool costs money; collecting the leftovers does not.

This is the case `docs/specs/2026-09-02-minimum-bid-efficiency.md` was written about, and it is the
half of that spec this change does **not** supersede. A floor on `min_payment / loan_amount` forces
every bidder to promise something, which is exactly what makes idle capital expensive. The two
changes are complementary: this one closes the profitable attack, that one closes the griefing attack.
Worth reopening on its own terms.

A borrower can also simply decline to bid, and a round nobody bids for is unlent. No auction mechanism
fixes that.

## Found during implementation

Two things the spec had wrong, both corrected in the code rather than worked around:

**Gas moves, and two constants cannot follow it.** `request_loan` itself does get cheaper, but every
op that packs the extension pays for 16 more bits — about 99 gas, and 213 for `send_unstake_all`.
`gas::deposit_coins`, `gas::mint_tokens` and `gas::send_unstake_all` were raised to match. The other
two, `gas::reserve_tokens` and `gas::burn_tokens`, **could not be**: they feed `unstake_tokens_fee`,
which is compiled into `wallet.fc`, so raising either moves the Wallet code hash and the repo stops
reproducing the wallet deployed on mainnet. Verified by building both ways — the hash moves to
`b0808966…` and back to `b9caa42b…`. They join `gas::migrate_wallet` in `pinnedShortfalls` at 99 each,
which reaches a user on the unstake path as 297 gas of under-charge (the burn is budgeted twice, for
the retry) against the forward fees the same function budgets for messages usually never sent. Raise
them and delete the pins when the next wallet version ships.

**Three test fixtures parse the extension and end with `end_parse()`** — `reset_data.fc`,
`mint_dead_shares.fc` and the two-round-window migrator chain. That is deliberate: the comment in
`mint_dead_shares.fc` says a field added to the treasury should make it throw. All three were taught
the new field, and `tests/TreasuryMigration.spec.ts` now chains the reward-share migration after the
two-round-window one, which required capturing
`tests/fixtures/treasury-two-round-window-era-code.boc` so each migrator keeps being exercised against
the layout it was written for.

Also moved, and pinned: the largest gift a 0.1 GRAM `gift_coins` message can carry, from 0.09911 to
0.09910, because a bigger code cell costs more to store. The test already anticipated this.

## Out of scope

- **Exclusion.** A borrower can still take the whole pool by asking for an oversized loan; see
  `2026-09-18-max-loan-share.md`, closed. After this change that costs stakers nothing, so it is a
  commercial problem between borrowers rather than a protocol one.
- **A bounded share band for risk-free competition**, as described under rejected alternatives. Revisit
  if `min_payment` competition does not appear over a month of rounds.
- **`2026-09-02-minimum-bid-efficiency.md`** is superseded only in part. The *profitable* version of
  the bid it analysed — `min_payment` 0 with the borrower contracting for the whole reward — is gone.
  The *griefing* version is not: see *What remains possible*. A minimum bid efficiency remains the
  right answer to that, and should be reopened rather than treated as closed by this change.
