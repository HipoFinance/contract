# Accrued capital is priced at the bid's own rate

## Problem

`decide_loan_requests` serves requests in `request_sort_key` order, accepts each one that still fits,
and then spreads what is left over (`available`) across the accepted loans in proportion to
`loan_amount`. The accrued amount joins the loan and is staked with it, but the request is re-packed
with its `min_payment` **unchanged**:

```func
int accrue_amount = muldiv(available, loan_amount, allocated);
...
builder accrued_request = pack_request(min_payment, borrower_reward_share, loan_amount, accrue_amount, ...);
```

So rank is bought per GRAM *requested* (`min_payment / loan_amount`) while capital arrives, and is
earned on, per GRAM *staked* (`loan_amount + accrue_amount`). A bidder who expects a leftover can
price `min_payment` on the whole stake they will end up holding and divide it by a smaller request.
That inflates their displayed efficiency, and leaves their promise short of what they will actually
stake.

That is how the auction has been held since 17 September 2026. From the treasury's own logs:

| round | two large requests | accrued to each | `min_payment` | displayed eff | per GRAM staked |
|---|---|---|---|---|---|
| 1789939464 | 1,509,060 | 346,376 | 1,001.80 | 680 | 553 |
| 1790005000 | 1,473,519 | 373,750 | 979.25 | 681 | 543 |
| 1790070536 | 1,514,176 | 343,462 | 1,109.18 | 750 | 611 |

Break-even for a borrower over those rounds is about 650–680 in the same units. The displayed number
sits above it and the real price below it. A competitor who prices honestly on their own loan must
out-rank the displayed number. In round 1790070536 that meant bidding above 750 and paying for it,
while the inflated bid could have risen to about **800 at no cost at all**, because a `min_payment`
priced on the accrued stake does not exceed the pool's contractual share until then.

Two consequences follow, and the second is the one that shapes the field:

- **The bet protects itself by exclusion.** The inflated `min_payment` binds, and is paid out of
  collateral, only when the leftover fails to arrive, i.e. when a third loan fits. Sizing the
  requests to leave less room than any other bidder needs keeps the leftover, and so keeps the bet
  from being called. Since 19 September the two large requests have been resized at T−2 s. In two
  rounds the resize left **exactly 30,010 and 30,005 GRAM less** than the smallest competing request
  that was already visible. In rounds where the leftover did not arrive, `min_payment` bound and was
  paid from collateral: 88, 998, 134 and 120 GRAM per loan.
- **Out-ranking is asymmetric.** One side can raise its displayed efficiency for free up to the
  point where the accrued stake stops covering it; the other pays for every unit. No bidding strategy
  closes that gap, because it is in the arithmetic, not in the bids.

For stakers the pool's floor is intact: since the reward-share release the pool takes at least its
contractual share of whatever an elected stake earns. What is broken is that the auction's single
price signal does not mean what it says.

## Decision

**When a loan accrues, its `min_payment` scales with it.** The accepted request is re-packed with

```
min_payment' = muldiv(min_payment, loan_amount + accrue_amount, loan_amount)
```

so `min_payment / loan_amount` is the price per GRAM of everything the loan stakes, not just the
part that was requested. The sort key is untouched; what changes is that the number it ranks on
becomes true. A borrower who wants the leftover pays for it at the rate they bid; a borrower who
out-ranks another pays that rate on every GRAM they take, squeeze included.

**Accrual is unchanged; collection is bounded at recovery.** Every accepted loan takes its full
proportional share of the leftover, exactly as today, so no capital is left idle. The promise can now
exceed the collateral that was checked at `request_loan`: collateral covered `min_payment`, and
`min_payment'` is larger. So `recover_stake_result` bounds what it collects instead:

```
treasury_reward = min(max(min_payment', contractual share), reward + stake_amount)
```

The borrower owes their bid rate on the whole stake. If the reward covers it, they pay it and keep
the rest. If it does not, the shortfall comes out of their collateral. Collateral bounds only what
the pool can *collect*, never what the borrower *owes*: a borrower who over-promises on thin
collateral loses the whole reward and all of their collateral. The accrual loop's existing check
(`stake_amount ≥ min_payment + min_burn + punishment(total)`, all-or-nothing) stays exactly as it is.

Rejected alternatives:

- **Give the accrued part's reward wholly to the pool** (the second option recorded on 2026-09-20).
  It also removes the subsidy, but borrowers would then carry punishment risk on capital that is
  pushed onto them and earns them nothing. Every bidder would be driven to request exactly the
  lendable amount they cannot know in advance, which is the lendable-amount-lock problem made worse.
- **Freeze the lendable amount and stop accruing** (the third option). Unrequested capital would sit
  idle in thin rounds. The freeze has its own reason to exist and is kept as its own TODO.
- **Cap the accrual at what collateral covers.** This was this spec's first draft, and a replay
  rejected it. Borrowers size collateral to the unscaled `min_payment`, so the cap cut the two large
  loans' accrual from about 343,000 each to about 1,700, and about 690,000 GRAM sat unlent in every
  recent round. Over the eight rounds since 17 September the pool would have collected **1,673 GRAM
  less**, while the borrowers it was meant to charge lost only 884. It also creates a griefing path
  that does not exist today: with punishment a flat 101 GRAM, today's accrual check effectively
  always passes, whereas under a cap any winner could idle the leftover just by posting thin
  collateral. The bound belongs where the money is collected, not where it is lent.
- **Refuse accrual when the scaled check fails**, or **redistribute a refused share to the others.**
  The first idles capital for the same reason. The second needs a second pass with its own
  continuation, in the chain `retry_distribute`'s removal just hardened, and still idles capital when
  nobody else was accepted.
- **Hide or randomise the close** (`2026-09-22-commit-reveal-bids.md`, `2026-09-19-soft-close.md`).
  Once rank is honest, reacting last only lets a bidder win by paying more per GRAM than the bid
  they answered, and a bid placed early at break-even cannot be profitably answered. The timing
  problem shrinks to what it costs a bidder who bids below their own value. Revisit only if the
  rounds after this change show otherwise.

## Changes

- `contracts/treasury.fc`, `decide_loan_requests`: the accrual loop packs
  `muldiv(min_payment, loan_amount + accrue_amount, loan_amount)` in place of `min_payment`. The
  accrual and its check are untouched.
- `contracts/treasury.fc`, `recover_stake_result`, rewarded branch: `treasury_reward` is clamped to
  `reward + stake_amount`, so a promise larger than reward plus collateral empties the collateral
  instead of driving `stake_amount` negative (which would throw in `store_coins` and wedge the round).
  The unrewarded branch already collects `min(stake_amount, min_payment)`. `process_loan_requests`
  and `log_loan` read the request as they do now.
- `docs/architecture.md`, *Loan economics*: `min_payment` is a rate on the whole stake, and collateral
  bounds what the pool collects, not what the borrower owes.
- `docs/integration.md`: the same, for borrowers. The loan log's `min_payment` is now the scaled
  amount owed.
- `CHANGELOG.md`: the release and its date, published with the notice (below).
- `graphs/`: no change. No message is added, and neither `04` nor `05` labels the accrual step.

## Invariants

- **The exchange-rate identity is untouched.** Recovery computes `treasury_reward`, `new_coins` and
  the burn exactly as before, from the request it is handed; only the stored `min_payment` is larger.
- **The pool never receives less for the same bids.** Accrual is unchanged and `min_payment' ≥
  min_payment`. The clamp only binds where today's code could not have collected anyway: before this
  change, collateral covered `min_payment`, so `reward + stake_amount ≥ min_payment` always held.
- **No capital is idled by this change.** Every accepted loan accrues exactly what it accrues today.
- **The borrower's balance never goes negative.** On the rewarded path `treasury_reward ≤ reward +
  stake_amount`; on the unrewarded path `min(stake_amount, min_payment')` as before.
- **The burner may now receive less than `fee::min_burn`.** When a promise exhausts the collateral,
  the pool is paid first and the burner takes what remains, possibly nothing. That is the existing
  loss ordering applied to a case that could not occur before, not a new ordering.
- **Ranking is unchanged.** `request_sort_key` and the `sorted` dict are not touched; the scaling
  happens after acceptance.
- **Loss ordering is unchanged**: punishment, then the pool, then the burner, then the borrower.
- **No committed bid is repriced.** The upgrade lands only while no request is standing (see
  *Compatibility*), so every request that meets the new rule was made after the rule was published.

## Compatibility

- **No storage, getter or message-schema change.** Requests and participations keep their layout;
  `get_treasury_state` keeps 28 values. No migrator.
- **The clamp is inert for loans decided before the upgrade:** their collateral was checked against
  the `min_payment` they carry, so their promise never exceeds reward plus collateral.
- **A meaning changes, twice.** `min_payment` in an accrued request, and therefore in the loan log, is
  now the scaled amount owed. Any integrator that reads the loan log and divides `min_payment` by
  `loan_amount` sees the same rate as before. One that compares it with a request's `min_payment`
  sees a larger number and must be told why, in `docs/integration.md`.
- **Notice: about three days, public**, in `CHANGELOG.md` and `docs/integration.md`, with the date.
  Every borrower's pricing changes on the day, and they should all learn it the same way.
- **Upgrade window.** Once a round's participation has left `open`, `request_loan` refuses until the
  validator set changes, a gap of `elections_end_before + 900` s (9,092 s today). Upgrading inside
  that gap means no request made under the old rule is ever decided under the new one.
- **Gas:** one `muldiv` per accepted loan in `decide_loan_requests`, and one `min` per settled loan
  in `recover_stake_result`. `MaxGas`' 100-request round must stay inside the
  soft limit.

## Test plan

- A loan that accrues `A` on `L` is packed, logged and recovered with `muldiv(m, L + A, L)`, and a loan
  that accrues nothing keeps `m` exactly.
- **Accrual is unchanged:** for the same requests and pool, every `accrue_amount` equals the old
  code's, including a thin-collateral loan whose scaled promise exceeds its collateral.
- **The clamp:** a rewarded loan whose `min_payment'` exceeds `reward + stake_amount` pays exactly
  that, returns zero to the borrower, burns zero, and settles without throwing. The next loan in the
  same round still settles.
- `min_payment = 0`: unchanged behaviour end to end.
- **Recovery:** elected with the scaled payment binding, elected with the contractual share binding,
  and unelected paying `min(stake, min_payment')`. The pool's take is compared against the same round
  on the old code.
- **The motivating case:** replay round 1790070536's shape (two requests of 1,514,176 at 1,109.18 in a
  3,715,275 pool). Each accrues 343,462 as today and owes `muldiv(1,109.18, 1,857,638, 1,514,176)`,
  which exceeds its contractual share at the round's yield and is collected in full.
- `MaxGas` / `MinGas` green; the decide loop's measured gas per accepted loan recorded.

## Out of scope

- `2026-09-02-minimum-bid-efficiency.md` (unelected-slice griefing): still open. This change makes
  that griefing dearer when it accrues, but does not close it.
- The lendable-amount freeze (instant unstakes shrinking `available` before the close).
- Commit–reveal or a candle close: see *Decision*.
- Borrowers' own software, which must price `min_payment` per GRAM of total stake from the release date.
