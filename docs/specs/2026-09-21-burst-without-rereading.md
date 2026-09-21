# The burst retries without re-reading the chain

## Problem

The poker opens a burst around each transition deadline so that a poke aimed a second early is
retried at once rather than a minute later. The constants say the cadence is one second. Mainnet
says it is two.

Every attempt is a whole cycle: masterchain info, chain clock, config 32/34, config 36,
`get_treasury_state`, `get_times` — six liteserver round trips before anything is decided, which
costs about a second. Added to the one-second sleep that makes the cadence two seconds per
attempt, so the three-second tail fits two attempts rather than three or four.

Measured on 2026-09-20, the same spacing at all three transitions:

```
12:19:20 📨 Sent finish_participation(1789808392)
12:19:22 ↩️  finish_participation(1789808392) refused: not_ready_to_finish_participation (204)

18:52:52 ↩️  participate_in_election(1789939464) refused: too_soon_to_participate (203)
18:52:54 📨 Sent participate_in_election(1789939464)

21:24:28 📨 Sent vset_changed(1789873928)
21:24:30 ↩️  vset_changed(1789873928) refused: vset_not_changed (206)
```

The cost is about one second on every transition the chain accepts later than the computed
deadline — and the deadline is computed from a block's `gen_utime`, so arriving a beat early is
the normal case, not the exception. The 18:52 poke is the shape of it: refused at :52, accepted
at :54, where a one-second cadence would have had it at :53.

The second cost is that the tail expires while the chain is still catching up. At 21:24 the
rotation deadline was 21:24:24 and the masterchain applied the new set at 21:24:28; had it taken a
few seconds longer, the burst would have ended and the transition would have waited for the
60-second retry.

## Decision

**Inside a burst, re-send without re-reading.** A cycle reads, decides, and sends as it does now.
It then keeps re-sending that same set on a one-second cadence until the burst window closes,
never re-reading, and only then returns to a full cycle that reads and confirms.

This is affordable for the reason everything else in this service is affordable: every guard runs
before `accept_message()`, so an external that is early, redundant, or aimed at work already done
is discarded in the compute phase with no transaction committed and nobody charged.

**The tail widens from 3 seconds to 10.** With attempts no longer costing a read there is no
reason for the window to be narrow, and the case it now covers is real: a transition the chain
applies several seconds after the computed deadline is caught at one-second cadence instead of
falling to the 60-second retry. The lead stays at 2 seconds and the tick at 1.

### What a refusal is allowed to conclude

The burst has no read, so the refusal codes are the only thing it learns from. They do not all
mean the same thing, and one of them means two things:

| code | from an external, means | burst |
| --- | --- | --- |
| 202 `unable_to_participate` | state is no longer `open` — the round moved on | **drop** |
| 204 `not_ready_to_finish_participation` | state is no longer `held` | **drop** |
| 207 `vset_not_changeable` | state is neither `staked` nor `validating` | **drop** |
| 7 `round_not_found` | the treasury has no such round | **drop** |
| 203 `too_soon_to_participate` | `now() < min(participate_since, round_since)` | keep |
| 205 `too_soon_to_finish_participation` | `now() < stake_held_until` | keep |
| 206 `vset_not_changed` | **ambiguous** — see below | keep |

`206` is the one that cannot be trusted. `vset_changed` throws it on
`new_vset_hash != current_vset_hash` (treasury.fc), which fails both *before* the rotation, when
the stored hash still matches the config, and *after* a successful `vset_changed`, because the
handler updates the stored hash to the new one. Same code, opposite meanings, and only a state
re-read tells them apart. So the burst keeps retrying on 206 and lets the next full cycle decide.
That is the safe direction: the cost of retrying a round that is already done is a discarded
external, and the cost of dropping a round that is not is a minute.

An accepted send (`nil`) also keeps the poke in the set. A liteserver taking the bytes says
nothing about whether the treasury ran them, which is the rule the whole service is built on.

Anything else — an unexpected exit code, a transport failure — drops the poke from the burst and
leaves it to the next full cycle, which has a read to reason with.

### What this trades

**A halt landing mid-burst still lends.** The decision to send `participate_in_election` is made
from a read at the top of the cycle; under this change the sends continue for up to the whole
burst window afterwards, so the window in which a halt is invisible to the poker grows from about
one second to about eleven.

This is accepted, and it is worth being precise about why rather than waving at it:

- The race already exists. The read precedes the send today by roughly a second, and no amount of
  re-reading closes it — the state can change between the last read and the block that includes
  the message.
- `docs/architecture.md` already records that **`set_stopped` does not stop a round being lent**:
  `participate_in_election`, `distribute` and `process_loan_requests` have no `stopped?` check, and
  anyone may send the external. The poker's halt policy is a courtesy that keeps *this service*
  from being the one that lends a halted pool, not a guarantee that nobody will.
- For the outcome to differ, a halt would have to land inside that window *and* at an election
  deadline, where the same halt eleven seconds later produces the identical result.

Widening 1 second to 11 does not change the shape of that exposure. It is written down here so
that the next person weighing a wider tail knows what they are widening.

**More discarded externals.** At a rotation with two rounds in flight, two instances, and a tail
that 206 never prunes, the ceiling is about forty refused externals in ten seconds instead of
about eight. Each is a compute phase that never commits, so none of them costs the treasury
anything — but the number is a reason to keep the tail at ten seconds rather than raising it
further, because the constraint here is a node deciding it is being spammed, not gas.

The identical-body collision works in our favour here and is the reason the query id is
deliberately not salted per instance: both instances build the same op, round and second, so a
node that already holds one copy answers `duplicate message` rather than carrying a second. The
distinct traffic is bounded at roughly one message per second per poke however many instances run.

## Changes

**`HipoFinance/poker`**

- `poke/clock.go` — `BurstTail` 3s → 10s, documented as measured from the poke's **first** send,
  not the most recent attempt, so that a poke refused every second cannot extend its own burst
  indefinitely. `BurstLead` and `BurstTick` unchanged.
- `poke/clock.go` — `NextWait` loses its burst arm. The burst is no longer expressed as a short
  sleep between cycles, so the arm would be dead code that still looked load-bearing.
- `poke/run.go` — `Cycle` gains a burst step after `send`: while the window is open and the set is
  non-empty, sleep `BurstTick` and re-send, pruning per the table above. It respects context
  cancellation, and returns `BurstTick` as the next wait when a burst ran, so the confirming read
  follows immediately rather than a minute later.
- `poke/run.go` — no burst in blind mode (it pokes two dozen candidates and a one-second cadence
  across all of them is a different proposition) and none under `DRY_RUN` (nothing is sent).
- `poke/reject.go` — a `Settled()` predicate over the exit codes, separate from `Expected()`.
  Two different questions about the same code: `Expected` asks whether to warn a human, `Settled`
  asks whether to stop retrying, and 206 answers them differently.

Nothing in the contract repository changes except this spec and the paragraph in
`docs/architecture.md` that describes the driver's cadence.

## Invariants

- **A send is still not a confirmation.** The burst starts no new clocks and confirms nothing:
  `Tracker.first[p]` is set only when absent, so re-sends do not reset a poke's age, and
  confirmation remains a state re-read against `DueByContract`. The published age is stale for at
  most the burst window, which is bounded by `BurstTail`.
- **Over-poking stays free.** Every additional attempt is discarded before `accept_message()`.
  This is the property the whole change rests on; if a future contract change moved any of the six
  guards after `accept_message`, this change would start costing the treasury money and would have
  to be reverted with it. `tests/Loan.spec.ts`'s "should not charge the treasury for an external it
  rejects" is the test that would catch it.
- **The settling ops are never withheld.** Unchanged: `vset_changed` and `finish_participation`
  are sent in every mode.
- **The halt policy is unchanged in kind**, only in the width of the window above.

## Compatibility

No contract change, no stored data change, no message schema change. The three externals are
byte-identical to what is sent today.

Operationally: `hipo_poker_pokes_rejected_total` and `hipo_poker_pokes_duplicate_total` will rise
by roughly five times at each transition, because attempts are five times as frequent. Nothing
alerts on either, and `hipo_poker_poke_errors_total` — which `PokerNotSending` does alert on —
counts transport failures only and is unaffected. `monitor/alerts-runbook.md` gains a line under
`PokerNotSending` so that the step change in the rejection counter is not read as a regression.

## Test plan

In `HipoFinance/poker`, table-driven and with no chain access:

- The burst re-sends on a one-second cadence and stops when the window closes, with a fake sender
  recording attempt times — the test that would have caught the two-second cadence being described
  as one.
- Each code in the table above prunes or keeps, asserted per code rather than in bulk. In
  particular: **206 keeps** (the ambiguity is the point), and 202/204/207/7 drop.
- A poke refused every second does not extend its own burst: the window is measured from the first
  send, so an endlessly refused poke still ends at `BurstTail`.
- An accepted send keeps the poke in the set.
- Blind mode and `DRY_RUN` run no burst.
- Context cancellation ends a burst in progress.
- `Tracker` ages are unchanged by re-sends: a poke first sent at T and re-sent nine times still
  reports an age measured from T.

Each of these to be mutation-checked before the change is committed — inverting the 206 rule,
removing the window bound, and letting blind mode burst must each fail a named test. The recurring
failure here has been tests that pin a function while the bug lives in the wiring between them.

Verification on mainnet is the log at the next three transitions: attempts one second apart rather
than two, and the accepted send arriving one second after a `too_soon` refusal rather than two.

## Out of scope

- **Making the cycle's read cheaper** (fewer round trips, caching the config within a burst). It
  was considered and rejected for now: a slimmed read still needs config 34 to decide whether
  `vset_changed` is due, so it saves perhaps half the latency for considerably more machinery, and
  this change makes the read's cost irrelevant inside the burst, which is where it hurt.
- **Salting the query id per instance.** Deliberately not done; the collision is free
  deduplication and this change relies on it more, not less.
- **Bursting in blind mode.**
- **Any change to the 60-second retry**, which is for wedged rounds where a second is irrelevant.
