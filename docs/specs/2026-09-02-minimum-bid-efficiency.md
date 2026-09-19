# Minimum bid efficiency for loan requests

> **Partly superseded 2026-09-19 by `2026-09-19-protocol-set-reward-share.md`, and worth REOPENING
> for the rest.** The *profitable* version of the bid analysed below — `min_payment = 0` with the
> borrower contracting for the whole reward — is no longer expressible: the reward share is set by the
> protocol, so such a request hands the pool its full contractual share. The *griefing* version
> survives untouched, because that share is a share of a reward, and a stake the Elector accepts but
> does not elect earns none: six or more slices under the elected floor take the pool's whole capacity
> and pay it nothing, for about 6 GRAM a round. A floor on `min_payment / loan_amount` is still the
> answer to that, and it is the only one on the table. The reasoning that closed this spec ("it sorts last and only wins on spare capacity") also
> turned out to be thin: the pool is fully lent every round, and sorting last costs nothing when
> there is room, which there always is for the bidders who are the field.
>
> **Status: closed 2026-09-10 — no change. The behaviour is by design.**
> Found while specifying `2026-08-31-borrower-fee-hpo-burn.md`. Recorded separately because it
> is a pre-existing property of the auction, not something that change introduces. The analysis
> below stands; the decision it was waiting for is in *Decision* at the end.

## Problem

A loan request with `min_payment = 0` and `borrower_reward_share = 255` yields

```
treasury_reward = max(min_payment, muldiv(reward, 255 - borrower_reward_share, 255))
                = max(0, 0)
                = 0
```

so the borrower keeps the entire round reward and the pool receives nothing. The collateral
such a request must post is `min_payment + max_punishment` = `max_punishment` alone, which is
**101 GRAM on a 4,000,000 GRAM stake** (live figure, 2026-08-29).

`request_sort_key` sorts on efficiency (`min_payment / loan_amount`) first and
`treasury_reward_share` second, so this bid sorts last among all requests and cannot displace a
better one — the eviction path in `request_loan` drops the *worst* request when the book
exceeds `max_validators`. It therefore only wins on **spare capacity**.

Spare capacity is the normal condition today: the protocol has 2 borrowers against roughly
8M GRAM of TVL, and `distribute` lends whatever `available` allows to every request it can
satisfy, in sort order, without any floor on what a request must return.

## Why it matters

The exposure is not a loss of principal — `loan.fc` can only send stakes to the Elector, and
the punishment path is unchanged. It is that a round's entire reward can be captured by a
borrower who contributed nothing but a server, at a collateral cost of ~101 GRAM, whenever the
pool has capacity nobody else bid for. Stakers see a round with no reward and no explanation.

## Options considered

- A governance-set minimum efficiency (`min_payment * 2^k / loan_amount`) checked in
  `request_loan`, rejecting bids below it. Simple, but sets a price floor that could leave
  capacity unlent in a thin market — which is worse than a bad bid if the alternative is no
  bid at all.
- A minimum `treasury_reward_share`, i.e. capping `borrower_reward_share` below 255.
- Leaving `distribute` free to reject the tail when the pool would earn nothing, rather than
  gating at request time.
- Doing nothing, on the grounds that a bid returning nothing is still better than idle GRAM
  and the situation resolves itself as borrower count grows.

## Decision

**Do nothing.** The last option was adopted; the first three are rejected.

The auction already contains the defence. A zero-return bid sorts last, so it can never displace
a request that pays the pool anything at all — it only ever consumes capacity that no better bid
asked for. In that situation the alternative is not a better round, it is idle GRAM: the pool
earns nothing either way, and at least the coins are validating. There is no state in which
accepting the bid is worse for stakers than rejecting it.

The three gating designs all buy protection against a case that cannot occur by adding a floor
that can leave capacity unlent when the market is thin — trading a harmless outcome for a real
one. A price floor is also the wrong instrument here: what actually raises the pool's take is
more borrowers bidding against each other, and competition is expected to push efficiency *up*
over time, not down. The situation this spec describes is a symptom of two borrowers, not of a
missing rule.

Revisit only if the premise breaks — if a bid returning nothing to the pool ever starts
displacing one that would have paid, the sort order is what changed, and that is a different
spec.

## Interaction with the burner spec

`2026-08-31-borrower-fee-hpo-burn.md` sets `fee::min_burn` as a floor so that such a bid still
burns 1 GRAM, but that is a side effect, not a fix: the pool still receives nothing from the
round. The two changes are independent.
