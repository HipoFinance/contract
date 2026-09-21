# Cap what one borrower is allocated in a round

> **Status: closed 2026-09-19 — considered, not adopted.**
> The mechanism works and the problem is real, but the cap cannot both stop one entity filling the
> pool and leave an honest borrower's slice large enough to be elected — those are the same
> threshold — and the value that separates them moves with TVL, so the parameter would need standing
> governor oversight to stay correct. Analysis kept in full: the problem stands, and anyone
> returning to it should start from *Why it was not adopted* rather than rediscover it.

## Problem

`decide_loan_requests` accepts requests in `request_sort_key` order while each still fits, then
adds the remaining `available` to the accepted loans **in proportion to their loan size**. Because
the leftover is proportional, every accepted borrower ends up with the same multiplier

```
stake_i = loan_i × (1 + leftover / Σ loans)
```

so two accepted borrowers each stake `available / 2` **whatever loan size they asked for**. Asking
for a larger loan therefore costs the asker nothing, and it is the only way to leave a third
borrower no room. The auction has no defence against it.

Two borrowers found this on mainnet in September 2026 and now hold the auction:

| round | the two large loans | third loan | pool's take |
|---|---|---|---|
| 1789611784 | 2 × 1,350,000 of 3,581,625 | none fitted | 2,276 |
| 1789677320 | 2 × 1,350,000 of 3,538,635 | none fitted | 2,314 |
| 1789742856 | 2 × 1,350,000 of 3,628,809 | 927,808 fitted | 2,462–2,491 |

The two ask 1,350,000 each, which leaves 838,635–881,625 — bracketing the smallest stake the Elector
has recently elected, so a third loan usually cannot both fit and be worth winning. Raising their
ask by ~9,000 each would close it permanently, at no cost to them.

The cost to stakers is not the excluded borrower's lost income. It is that with no third bid the
winners' `min_payment` goes slack and the pool collects only the ordinary contractual share. In
round 1789742856, where a third loan did fit and took the leftover away, both winners' floors bound
and the pool collected **29–141 GRAM more** than it otherwise would have.

This is the exclusion half of the monopoly exposure recorded in
`docs/specs/2026-09-02-minimum-bid-efficiency.md`; that spec closed on the pricing half.

## The mechanism considered

A governance parameter `max_loan_share` (uint16, out of 65535). In `decide_loan_requests`, no
single request may be allocated more than that fraction of the round's snapshot:

```
cap  = muldiv(available + allocated, max_loan_share, 65535)
take = min(loan_amount, cap)
```

`available + allocated` is invariant across the continuation loop — `distribute` writes
`(available, 0)` into the `total_staked` / `total_recovered` temporaries — so the cap is a fraction
of the original snapshot in every continuation, with nothing new to store. A request over the cap is
truncated rather than rejected; `min_payment` stays as bid, so over-asking costs the borrower rather
than being free; the leftover stays proportional, so the round is never under-lent.

The design holds up on its own terms. What it does, by bidder shape, on a 3,628,809 pool with a 25%
cap:

| who bids | today | with the cap |
|---|---|---|
| one entity, one request | stakes 3,628,809 | 3,628,809 — unchanged |
| one entity, two requests | 1,814,404 each | 1,814,404 each — unchanged |
| two entities, one each | 1,814,404 each | 1,814,404 each — unchanged |
| two entities squeezing a third | they take 1,363,309 each, the third gets in only if allowed | 1,212,812 each, third gets 1,203,184 **guaranteed** |
| five bidders | the top two fill the pool | four get 907,202, the fifth is rejected |

The first three rows are the reassuring part: because the untaken remainder returns as
`accrue_amount`, the cap changes nothing until there is competition for capacity, and no round is
ever left under-lent.

## Why it was not adopted

**1. The Sybil threshold and the electability threshold are the same number.** A pool divides into
`available / elected_floor` slices that are still large enough to be elected — 4.83 at the September
2026 figures. To stop one entity filling the pool you need `share < floor/available`; to keep a
capped loan electable when the pool is full you need `share ≥ floor/available`.

| max_loan_share | cap | to fill the pool | Sybil works? | capped loan electable? |
|---|---|---|---|---|
| 0.30 | 1,088,643 | 4 × 907,202 | yes | yes |
| 0.25 | 907,202 | 4 × 907,202 | yes | yes |
| 0.207 | 751,163 | 5 × 725,762 | no | **no** |
| 0.15 | 544,321 | 7 × 518,401 | no | **no** |

No value satisfies both. This is structural, not a tuning failure: if the pool can be split into *k*
electable slices, nothing in the contract distinguishes *k* entities from one entity with *k*
addresses. The honest claim is therefore much narrower than the mechanism suggests — it raises the
cost of exclusion from **zero** to **running four or five performing validators instead of two**.

**2. It would need standing governor oversight — the decisive objection.** The only useful values sit
around `floor/available`, and both of those move: the pool grows with deposits and the elected floor
moves with every election. A parameter that is correct today is wrong a month from now, silently, and
the failure is not visible until a round is lost or a slice goes unelected. Governance parameters in
this protocol are set and left (`governance_fee`, `borrower_fee`, `rounds_imbalance`); one that
requires continuous attention to stay correct is a standing operational liability, and a governor who
stops watching leaves the protocol worse off than with no cap at all.

**3. In steady state it adds nothing for stakers.** The +29 to +141 observed in round 1789742856 came
from the incumbents' floors binding against a leftover they had priced on and did not get. Once a cap
is normal they price on the capped stake, the floors stop binding, and the pool's take returns to
`reward × (65535 − borrower_reward_share)/65535` — which is invariant to how the pool is split. The
parameter that sets what stakers earn is `borrower_reward_share`, and the auction does not select on
it. That gap, not this one, is where staker returns are decided.

**4. It reduces price pressure rather than adding it.** Rank only matters when not everyone fits.
Guaranteeing slots means nobody has to outbid anybody, so `min_payment` drifts toward zero across the
field.

## Engineering findings worth keeping

Two things any future attempt must handle, both found while checking this one adversarially:

- **A division by zero that wedges the round.** If `muldiv(available, share, 65535)` truncates to
  zero, every request is accepted at loan 0, `allocated` stays 0, and the accrue loop's
  `muldiv(available, loan_amount, allocated)` divides by zero. The continuation throws, the
  participation sticks in `distributing`, and every retry throws identically -- recoverable only by
  changing the parameter, and since `retry_distribute` was removed on 2026-09-20 that means an
  `upgrade_code` carrying the repair. Today this is impossible because `request_loan`
  guarantees every accepted loan is positive; truncation breaks that invariant, so it needs an
  explicit guard.
- **The parameter must be snapshotted into the request, not read live.** Reading it live follows
  `rounds_imbalance`, which also sizes rather than prices — but lowering the cap after seeing the
  standing requests truncates them while their `min_payment` stays as bid, which reprices a committed
  bid by governance action. That is exactly what `borrower_fee` is snapshotted to prevent, and it
  matters more here because the governor may also be a borrower. Cost: 16 bits in the request layout,
  and a compatibility tail for requests in flight across the upgrade.

Smaller ones: a borrower who cannot project `available` must over-ask to reach the cap and eat the
rank penalty for it; and `get_treasury_state` would grow from 26 to 27 values, breaking positional
readers for the third time.

### `min_stake` is not the floor any more

Worth recording because it runs through the analysis above and through
`decide_loan_requests`' neighbours: **config 17's `min_stake` (300,000) is stale, and there is no
plan to raise it on chain.** The binding minimum is what the Elector actually elects — around
700,000 in September 2026 and rising — so any rule anchored on `min_stake` is anchored on a number
that stopped describing the network.

It also explains why nobody bids near it. A 300,000 loan is not merely unattractive; it is
self-defeating, because if several bidders each ask for a small loan the pool splits into several
small stakes and *none* of them is elected. Every contestant ends up holding a loan that earns
nothing. So the field converges on loans near the elected floor whatever the contract permits, and a
cap or a floor that talks about `min_stake` is talking about a constraint that does not bind.

## What would change the answer

- A cap expressed **against the elected floor** rather than as a fraction of the pool —
  `cap = k × the smallest recently elected stake`, read from the Elector — would track the binding
  constraint by itself and need no oversight. Given that `min_stake` is stale and the real floor
  moves every election, this is the only shape worth trying if the idea comes back.
- **Identity beyond the address**, which would separate *k* entities from *k* addresses and make the
  Sybil threshold irrelevant. Nothing in TON offers it cheaply.

## Preferred alternatives

- **Rank on what the pool earns.** The auction sorts on `min_payment / loan_amount` while revenue is
  set by `borrower_reward_share`, which only breaks exact ties. This moves the number that actually
  sets staker APY, and it makes exclusion less rewarding as a side effect, because a bidder who wants
  rank has to give the pool more rather than merely ask for more. Raised 2026-09-11; needs its own
  spec.
- **A soft close.** Extend bidding when a request lands in the final seconds. Self-contained, no new
  economics, no parameter to maintain, and it removes the other half of the incumbents' advantage:
  replacing their own request for the price of gas one second before the close, after everyone
  else's bid is public and frozen.
