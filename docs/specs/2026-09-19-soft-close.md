# Soft close on late loan requests

> **Status: closed 2026-09-19 — considered, not adopted, no interview held.**
> Rejected on its own mechanics before design questions were worth answering. Recorded so the idea
> is not proposed a third time.

## Problem

A borrower can replace their own loan request for the price of gas until the moment bidding closes
— `request_loan` carries the collateral forward, so a revision costs 0.724 GRAM — and
`request_loan` only refuses once `now() >= participate_since`. So the bidder who sends last sees
every other bid and can answer it, while everyone else's terms are already public and frozen.

Observed on mainnet: on 2026-09-14 our request landed 18 seconds before the close and the two
incumbents re-sized theirs to leave 2,257 GRAM too little for it. Since then they have revised at
T−1 in every round, changing only price. The defence available to a bidder is to broadcast as late
as possible, which is why two of our own requests have landed late — one at T+2 and one at T+29,
both refused.

## The mechanism considered

The classic anti-sniping rule: a request arriving within *N* seconds of the close moves the close to
`now + N`, capped at some ceiling. `get_times` leaves room for it — `participate_until` is
`participate_since + 600`, and nothing forces the election to start at the earliest moment — so the
whole 600-second window is available, and `participate_in_election` would have to respect the
extended close or whoever pokes it would end the auction early.

## Why it was not adopted

**The extension budget is a resource the sniper can burn.** A ceiling is not optional: without one an
attacker pushes the close past `elections_end_before` and the treasury misses the election
altogether, which is far worse than losing a round to a snipe. But any ceiling recreates a hard final
instant, and reaching it is cheap. At 60-second extensions under a 300-second ceiling it costs five
no-op revisions — about 3.6 GRAM — after which the deadline is fixed and the real bid lands one
second before it with nobody able to answer. The rule does not merely fail; it leaves the sniper
better off, because after the budget is spent the close is *more* predictable than it is today, and
it has added a stalling tool that favours whoever already runs the machinery to revise cheaply.

**Restricting which requests extend does not rescue it.** The obvious repair — only a request that
improves its sender's rank extends the window — is blind to the attack it exists for. Efficiency is
`min_payment / loan_amount`, so the squeeze of 2026-09-14, a *larger* loan, lowers the sniper's own
rank and would never extend. Restricting extensions to borrowers with no standing request fails too:
both incumbents already park a seed request hours ahead, so they would never qualify and every
revision would snipe exactly as it does now.

**What would work is disproportionate.** Commit–reveal removes the last move outright: commit a hash
before the close, reveal after, and nobody can react because nothing is visible. It fits inside the
600-second window. It is also two new phases, a reveal deadline, handling for bids that are never
revealed, and a rewrite of the request lifecycle on a contract holding user funds — against a side
channel worth roughly 16 GRAM a round to each borrower and, in steady state, close to nothing to
stakers, since the pool's take is set by `borrower_reward_share` rather than by who bids last.

**And most of the harm is ours to fix, not the protocol's.** The last-mover advantage has changed an
outcome once. What it has actually cost is two requests hugging the deadline and arriving late. That
is a broadcast problem, answered off chain by sending to every liteserver at once and by parking a
request early and revising it, neither of which needs a contract change.

## Out of scope / related

- `docs/specs/2026-09-18-max-loan-share.md` — the other half of the same exposure, also closed.
- The remaining candidate is ranking on what the pool earns: the auction sorts on
  `min_payment / loan_amount` while staker revenue is set by `borrower_reward_share`, which only
  breaks exact ties. Raised 2026-09-11; needs its own spec.
