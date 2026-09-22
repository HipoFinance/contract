# Commit–reveal loan bids

> **Status: closed 2026-09-22 — considered, not adopted.**
> Evaluated adversarially at the governor's request. It fixes the smallest of the three problems the
> auction has, at the largest engineering cost, and only with a bond that punishes honest failures.
> The next step is the leftover/accrue spec instead; see *Decision*.

## Problem

A loan request can be replaced for the price of gas until `participate_since`, and every request is
public the moment it lands. So the last sender sees every other bid and can answer it. The rational
response is to broadcast as late as possible, and every bidder does: requests cluster in the final
seconds, two have been refused for arriving after the close (T+2 and T+29), and a short network
disruption at the close would take out every bidder of the round together.

The proposal: bidders send a hash of their bid before the deadline, then reveal it in a window after
it. Nothing is visible while bids can still change, so there is nothing to react to.

## Where it would fit

`participate_since` is 900 s before the election ends and `participate_until` is 600 s after it. The
clean placement is **commits close at `participate_since − 300`, reveals run until
`participate_since`**: election timing, `get_times`, `participate_in_election` and the poker are all
untouched, and bidding simply closes five minutes earlier.

## What it genuinely fixes

Liveness. With no revision possible after the close, a commit gains nothing by being late and can go
out hours early; a reveal gains nothing by being late either (as long as selective reveal is
deterred, below), so it can go out at the start of a five-minute window with room to retry. That is a
real improvement over bids aimed at the final seconds, and it is the strongest argument for the idea.

## Why it was not adopted

**1. The last move reappears inside the reveal window.** Reveals are public and arrive one after
another. A bidder commits several bids from several addresses — free, since addresses and validator
keys cost nothing until something is elected — watches the others' reveals, and reveals only the one
that serves them best. Choosing among *k* prepared bids is a last move with a coarse grid. The only
defence is a **bond forfeited on a commit that is not revealed**, sized above the value of that choice.

That value is set by **size, not price**. The 2026-09-19 soft-close spec priced the last move at
roughly 16 GRAM a round, which is the price channel. The size channel — revealing the loan size that
just leaves a third loan no room — is worth what the leftover is worth: in rounds where a third loan
did fit, each of the two large borrowers collected 448–851 GRAM less. So the bond has to be of the
order of **1,000 GRAM per commit**, and that converts an honest failure from today's "late request
bounces, collateral intact" into "round lost *and* bond forfeited". Separately, a commit's collateral
leaks its loan size, because `max_punishment` scales with the loan, unless bidders pad it.

**2. It does not touch exclusion, which is the harm actually occurring.** The round of 1790005000 has
two staked loans, 3,694,536 GRAM between them, and no third. The exclusion is done with a loan size
published hours ahead — the large requests have not changed size in the final seconds since
2026-09-14 — not with timing. Hiding bids leaves untouched the reason an oversized ask is free: the
leftover is distributed in proportion to loan size.

**3. It blinds the entrant, not the incumbent.** The auction is won by fitting, not by outranking:
`decide_loan_requests` skips a request that does not fit and serves the next. Today a newcomer sizes
its loan to the room the standing requests leave. Sealed, nobody can see the room, and a bidder for
whom size is free can vary it at random to make guessing harder. Blindness costs the bidder that
needs the room and not the bidders who fill it.

**4. Stakers gain close to nothing.** Since the reward-share release the pool is paid
`max(min_payment, s₀ × reward)`. The observed last move only ever lowered `min_payment`, within the
range where the floor binds anyway. Sealed bids might raise `min_payment` a little; they do not move
what stakers earn materially.

**5. Engineering surface on a contract holding funds.** A new phase and a commits dict in the
participation (a layout change with migration); bond accounting beside `total_borrowers_stake` and
`total_request_fees`; the `max_validators` eviction moved to reveal time, which invites commit spam to
fill the slots; a refund loop for unrevealed commits, with its own continuation; a `request_loan`
schema change for every borrower and for the explorer integrations. The two most recent, much smaller
treasury releases each needed adversarial passes that found real bugs.

## Alternatives considered

- **Candle close** — a random cutoff inside a final window, drawn at `participate_in_election`; a
  revision after the drawn cutoff falls back to the bid that stood before the window. A bid sent
  before the window is always safe and a revision at T−1 almost never counts, so the incentive to
  wait disappears without hiding anything: one phase, no bond, sizing stays visible. Costs a timestamp
  and a fallback copy of the prior bid per request, and block-level randomness a block producer can
  grind slightly. Does not address exclusion. **The lighter fix if timing is still a problem after
  the leftover fix.**
- **Reduce what the last move is worth.** The proportional leftover makes size free, which makes the
  squeeze worth hundreds of GRAM, which is why bidders hug the deadline. Removing that removes the
  exclusion exposure and most of the sniping incentive at once.
- **Nothing on chain** — broadcast redundancy off chain. Already what bidders do.

## Decision

Not adopted. Next: the leftover/accrue spec — the rank-bought-per-GRAM-requested gap in
`decide_loan_requests`, deferred until after the reward-share release, which has now landed. Revisit
timing, with the candle close first, only if late arrivals still cost rounds once that ships.

## Correction to `2026-09-19-soft-close.md`

Its *What would work is disproportionate* paragraph values the last-mover side channel at "roughly
16 GRAM a round to each borrower". That is the price channel only; the size channel is worth hundreds
of GRAM a round, as above. The conclusion there — commit–reveal is disproportionate — stands, for the
reasons in this spec rather than that figure.
