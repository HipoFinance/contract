# HPO tickets for loan requests

> **Status: deferred design record. Not approved for implementation.**
> Recorded so the analysis is not re-derived. The income→HPO link is being built first as a
> borrower-reward cut — see `2026-08-31-borrower-fee-hpo-burn.md`. Revisit this when borrower
> count grows enough that a per-borrower cost is material.

## Problem

Same as the borrower-fee spec: HPO has no mechanical link to Hipo's income, and
`governance_fee` cannot be used because it is read as a tax on deposits.

This design attacks it from the borrower side instead: borrowers pay HPO, non-refundably, for
the right to request loans, and the HPO is burned. Unlike a GRAM fee routed through a swap,
the buy pressure is direct — borrowers acquire HPO on the open market themselves — and the
burn is provable on-chain without any swap contract to build or trust.

## Decision (proposed, not adopted)

Borrowers buy **tickets** from the treasury with HPO. A ticket is consumed per loan request.
HPO is burned on receipt and is never returned to anyone, under any circumstance.

Example sizing: 10,000 HPO buys 10 tickets. The point of batching is not accounting
convenience — it is that one HPO purchase covers ten rounds, so nine out of ten loan requests
never touch a jetton at all and the fragile path stays rare.

### Mechanism

1. Borrower sends an HPO jetton transfer to the treasury's HPO wallet. `forward_ton_amount`
   carries no GRAM; this message only buys tickets.
2. The treasury receives `transfer_notification(query_id, amount, sender, forward_payload)`,
   which carries **both the amount and the borrower's address** — the proof required. It
   credits `tickets[sender] += amount / price` and immediately sends `burn` to its own HPO
   wallet for `amount`. The treasury holds HPO only between the notification and the burn.
3. `request_loan` is otherwise **unchanged**: it decrements `tickets[borrower]` and proceeds
   exactly as today. Re-bids and rejections consume a ticket and cost no HPO beyond it.

### Why not "burn HPO and forward the burn receipt to the treasury"

This was the first shape considered and it does not work against a standard jetton master.
TEP-74 is: owner → own wallet `burn`; wallet → master
`burn_notification(query_id, amount, sender, response_destination)`; master →
`response_destination` `excesses(query_id)`. Setting `response_destination` to the treasury
delivers only `excesses`, which carries a query_id and **nothing else** — no amount, no
burner identity. A 1-nanoHPO burn produces a message indistinguishable from a 5000 HPO burn,
so it is not a proof of payment. Making it work would require a custom HPO master that
forwards burn details, i.e. modifying a live token's master contract, which gains nothing
over the transfer-then-burn flow above.

### Design points settled during the interview

- **One message can carry both assets.** `forward_ton_amount` on a jetton transfer is
  delivered with the `transfer_notification`, so a design where the loan request rides in
  `forward_payload` and the collateral rides in `forward_ton_amount` is possible. The ticket
  model does not need it — tickets are bought separately and `request_loan` stays as it is —
  but it is the reason the original two-phase bookkeeping concern was dropped.
- **`transfer_notification` is non-bounceable** in the standard jetton wallet (`0x10`
  prefix). Today `request_loan` is bounceable, so a throw returns the borrower's GRAM
  automatically. On a jetton path a throw means the HPO is already credited to the treasury
  and any attached GRAM is stuck with no refund. **The handler must not `throw_unless` on any
  borrower-triggerable condition** — it must detect and refund explicitly. This is the single
  most dangerous part of the design, because the natural FunC idiom here is exactly the thing
  that loses funds.
- **The handler must verify `src` is the treasury's own HPO wallet**, or anyone can forge a
  notification and mint themselves tickets.
- **Consume the ticket at request time, not on acceptance.** On-acceptance is fairer, but
  acceptance happens inside `decide_loan_requests` / `process_loan_requests`, which are
  gas-bounded loops with a 255-message cap and a `soft_gas_limit`; a dict read/write per
  accepted borrower there is exactly the kind of change that moves `MaxGas`. At request time
  it is one dict update in a cold path.
- **Burning a ticket on a round that fails via `elected?` or `too_late?` is acceptable.**
  Borrowers themselves drive `participate_in_election`, so a round that misses its window is
  a borrower-side failure, and the cost is an incentive to keep the protocol moving.
- **A minimum purchase is needed.** `tickets` is keyed by a 256-bit address and the treasury
  pays its storage, so a floor stops the dict being bloated from many addresses. It is
  self-limiting — tickets cost real HPO — but the floor should be explicit.

### Sizing

Express the price as a share of borrower income per round, not as a USD target that goes
stale. A 4M GRAM loan yields on the order of a few hundred GRAM per round at current network
yields, so the ticket price should be sanity-checked against that. Note that HPO trades
around $0.005–0.009 (~797M circulating, ~$4–7M cap), so the originally suggested 5000 HPO is
roughly $25–45, not $5.

### Why it is deferred

- Its yield scales with **borrower count**, capped at 100 by `max_validators` and currently 2.
  TVL is the protocol's binding constraint, and the borrower-reward cut scales with TVL.
- It places an HPO jetton wallet inside the loan-request path, so an upgraded, paused or
  moved HPO wallet means no loans, an idle pool and zero staker yield. The borrower-reward
  cut isolates the external dependency in a separate contract whose failure is harmless.
- The anti-sybil argument for it is weaker than it first appears. `min_payment` is backed by
  collateral (`stake_amount >= min_payment + max_punishment`) and
  `treasury_reward = max(min_payment, ...)` charges the floor to collateral, so a borrower who
  underperforms still owes it. Max punishment on a 4M GRAM stake is only ~101 GRAM, but the
  pool's downside is bounded at "you get `min_payment` instead of the full reward" — a guard
  that works. A ticket cost raises the bar for repeatedly winning loans and underperforming;
  it is a marginal improvement, not a hole being closed.
- While Hipo operates the borrowers itself, the mechanism is Hipo paying Hipo — a buyback in
  a fee costume, with a contract change attached. Its value in that period is signalling
  rather than economics. It becomes a genuine third-party revenue channel only once
  independent borrowers are a meaningful share of the book.

## Open questions if revived

- Ticket price and batch size, and whether the price is a governance parameter or fixed.
- Whether outstanding tickets survive a price change (they should — they are tickets, not
  HPO, so a repricing does not invalidate them).
- Where the treasury's HPO wallet address and the `tickets` dict would live. The extension
  cell's four refs are **all taken** (`proposed_governor`, `collection_codes`, `bill_codes`,
  `old_parents`), so a `tickets` dict cannot be added without restructuring the cell — which
  is the largest hidden cost in this design and is not counted in the sketch above.
- Whether unused tickets should expire, and what happens to a borrower's balance if the HPO
  jetton is ever migrated.
