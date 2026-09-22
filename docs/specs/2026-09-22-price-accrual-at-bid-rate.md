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

**Accrual is capped by collateral.** The accepted loan's collateral must still cover the scaled
payment, the burn floor and the punishment on the grown stake. The loan takes the largest accrual
that satisfies this, up to its proportional share:

```
accrue      = muldiv(available, loan_amount, allocated)                   ;; proportional share, as today
punishment  = max_recommended_punishment(loan_amount + accrue + stake_amount)  ;; at the full share
spare       = stake_amount - min_burn - punishment
if min_payment > 0:
    accrue  = min(accrue, max(0, muldiv(spare, loan_amount, min_payment) - loan_amount))
elif spare < 0:
    accrue  = 0                                                           ;; today's rule
min_payment' = muldiv(min_payment, loan_amount + accrue, loan_amount)
```

This is exact with one evaluation. Punishment is `flat + proportional × stake` (config 40), so it
never grows as the accrual shrinks. The bound `accrue ≤ spare × loan / min_payment − loan` gives
`min_payment' ≤ spare` after both floors round down. A zero accrual is always admissible:
`request_loan` already required `stake_amount ≥ min_payment + min_burn + punishment(loan + stake)`.
What a capped loan does not take stays on the treasury balance and is lent in the next round, as
today.

Rejected alternatives:

- **Give the accrued part's reward wholly to the pool** (the second option recorded on 2026-09-20).
  It also removes the subsidy, but borrowers would then carry punishment risk on capital that is
  pushed onto them and earns them nothing. Every bidder would be driven to request exactly the
  lendable amount they cannot know in advance, which is the lendable-amount-lock problem made worse.
- **Freeze the lendable amount and stop accruing** (the third option). Unrequested capital would sit
  idle in thin rounds. The freeze has its own reason to exist and is kept as its own TODO.
- **No accrual when the scaled check fails**, as the current all-or-nothing rule does. The stricter
  check would idle a whole share where most of it could be lent.
- **Redistribute a capped loan's remainder to the others.** No capital idles, but it needs a second
  pass with its own continuation and re-checks, in the chain `retry_distribute`'s removal just
  hardened. The remainder is small whenever collateral is sized for the bid, and borrowers control it.
- **Hide or randomise the close** (`2026-09-22-commit-reveal-bids.md`, `2026-09-19-soft-close.md`).
  Once rank is honest, reacting last only lets a bidder win by paying more per GRAM than the bid
  they answered, and a bid placed early at break-even cannot be profitably answered. The timing
  problem shrinks to what it costs a bidder who bids below their own value. Revisit only if the
  rounds after this change show otherwise.

## Changes

- `contracts/treasury.fc`, `decide_loan_requests`: the accrual loop computes the capped
  `accrue_amount` and packs the scaled `min_payment`, replacing today's all-or-nothing collateral
  check. Nothing else in the file changes: `process_loan_requests`, `log_loan` and
  `recover_stake_result` already read `min_payment` and `accrue_amount` from the request.
- `docs/architecture.md`, *Loan economics*: `min_payment` is a rate on the whole stake, and accrual is
  capped by collateral.
- `docs/integration.md`: the same, for borrowers. The loan log's `min_payment` is now the scaled
  amount owed.
- `CHANGELOG.md`: the release and its date, published with the notice (below).
- `graphs/`: no change. No message is added, and neither `04` nor `05` labels the accrual step.

## Invariants

- **The exchange-rate identity is untouched.** Recovery computes `treasury_reward`, `new_coins` and
  the burn exactly as before, from the request it is handed; only the stored `min_payment` is larger.
- **The pool never receives less for the same bids and the same accrual.** `min_payment' ≥ min_payment`
  and the contractual share is unchanged. The one way the pool can end up with less is through capital
  a capped loan leaves idle. That depends on the borrower's collateral, and it is the price of never
  sending a loan whose collateral cannot cover its promise.
- **Collateral always covers the promise**, now on the grown stake: `stake_amount ≥ min_payment' +
  min_burn + punishment(total)` for every accrued loan, which is the property the old check existed for.
- **The unelected path stays bounded.** A loan that is not elected pays `min(stake_amount,
  min_payment')`, which the cap keeps inside collateral.
- **Ranking is unchanged.** `request_sort_key` and the `sorted` dict are not touched; the scaling
  happens after acceptance.
- **Loss ordering is unchanged**: punishment, then the pool, then the burner, then the borrower.
- **The round is never under-lent by more than capped remainders**, and nothing is lent that the
  treasury does not hold: the accrual is only ever lowered from today's value.
- **No committed bid is repriced.** The upgrade lands only while no request is standing (see
  *Compatibility*), so every request that meets the new rule was made after the rule was published.

## Compatibility

- **No storage, getter or message-schema change.** Requests and participations keep their layout;
  `get_treasury_state` keeps 28 values. No migrator.
- **A meaning changes, twice.** `min_payment` in an accrued request, and therefore in the loan log, is
  now the scaled amount owed. Any integrator that reads the loan log and divides `min_payment` by
  `loan_amount` sees the same rate as before. One that compares it with a request's `min_payment`
  sees a larger number and must be told why, in `docs/integration.md`.
- **Notice: about three days, public**, in `CHANGELOG.md` and `docs/integration.md`, with the date.
  Every borrower's pricing changes on the day, and they should all learn it the same way.
- **Upgrade window.** Once a round's participation has left `open`, `request_loan` refuses until the
  validator set changes, a gap of `elections_end_before + 900` s (9,092 s today). Upgrading inside
  that gap means no request made under the old rule is ever decided under the new one.
- **Gas:** one `muldiv` and a comparison per accepted loan in `decide_loan_requests`, plus the scaled
  `muldiv`. The punishment call already runs there. `MaxGas`' 100-request round must stay inside the
  soft limit.

## Test plan

- A loan that accrues `A` on `L` is packed, logged and recovered with `muldiv(m, L + A, L)`, and a loan
  that accrues nothing keeps `m` exactly.
- **The cap:** with collateral sized so the full share does not fit, the accrual is the largest value
  the formula allows. One GRAM more would break `stake ≥ min_payment' + min_burn + punishment`. The
  remainder stays on the balance and appears in the next round's `available`.
- A loan with collateral below even the zero-accrual requirement is impossible (refused at
  `request_loan`); assert the cap never produces a negative accrual.
- `min_payment = 0`: unchanged behaviour, full accrual when collateral covers punishment, none otherwise.
- **Recovery:** elected with the scaled payment binding, elected with the contractual share binding,
  and unelected paying `min(stake, min_payment')`. The pool's take is compared against the same round
  on the old code.
- **The motivating case:** replay round 1790070536's shape (two requests of 1,514,176 at 1,109.18 in a
  3,715,275 pool). Each owes `muldiv(1,109.18, 1,857,638, 1,514,176)`, which exceeds its contractual
  share at the round's yield.
- A multi-loan round where one loan is capped and the others are not: the others' accruals are
  exactly today's.
- `MaxGas` / `MinGas` green; the decide loop's measured gas per accepted loan recorded.

## Out of scope

- `2026-09-02-minimum-bid-efficiency.md` (unelected-slice griefing): still open. This change makes
  that griefing dearer when it accrues, but does not close it.
- The lendable-amount freeze (instant unstakes shrinking `available` before the close).
- Commit–reveal or a candle close: see *Decision*.
- Borrowers' own software, which must price `min_payment` per GRAM of total stake from the release date.
