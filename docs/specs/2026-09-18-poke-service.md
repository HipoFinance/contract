# A poke service that drives the protocol forward

## Problem

Three external messages are the only thing that advances the participation state machine:
`participate_in_election` (open → distributing), `vset_changed` (staked → validating → held)
and `finish_participation` (held → recovering). Nothing on chain moves them. `route_external_message`
in `treasury.fc` accepts exactly those three and nothing else.

Today the only sender is `HipoFinance/borrower`, running on borrower-operated machines
(`borrower/process.go`, `Process()`). When those stop — which has happened repeatedly, including
whenever the governor stops their own borrowers — the protocol stops:

- deferred unstakes are not paid at the time the pool promised, because the round they are
  billed against never reaches `burning`;
- a `vset_changed` can be missed for a whole round or more, which pushes `stake_held_until`
  out and delays every later round behind it;
- an `open` round that never gets `participate_in_election` holds borrower collateral and a
  participation slot indefinitely.

This is not hypothetical. The comment above `get_treasury_state` records the last occurrence:
a getter shape change broke `borrower`, "the only off-chain sender of finish_participation, so
two validators missed a round and a stake sat in the elector six hours past `stake_held_until`."

The existing alerts in `operation/monitor/rules/treasury-alerting-rule.yaml` (`TreasuryRoundStuck`,
`TreasuryRoundBurnWaiting`, `TreasuryParticipationsAccumulating`) do notice, but at hours-scale
thresholds and they require a person to act. They are a backstop for a driver that does not exist.

## Decision

Build `HipoFinance/poker`: a small always-on Go service whose only job is to send those three
externals at the moment the contract will accept them, and every 60 seconds afterwards until the
state actually moves. Two instances, one on each Swarm node. No wallet, no key, no Redis.

The decisions below are the ones that were not obvious.

### It holds no key, and that is structural

All three ops are unsigned externals and the treasury calls `accept_message()` itself, so the
sender pays no gas and signs nothing. The service therefore needs no wallet at all, and a fully
compromised poke host can do nothing that any anonymous member of the public could not already do.

That is also the reason the governor retries are **out of scope**: `retry_distribute`,
`retry_recover_stakes`, `retry_burn_all` and `retry_mint_bill` are internal messages gated on
`governor | halter` (`treasury.fc:1909`, `:1928`, and so on). Automating them means a hot governor
key on an always-on box, and in `retry_burn_all`'s case it means encoding a judgment the runbook
deliberately leaves to a person — run on a `ready_to_burn` round it steps over the reward-ordering
barrier and underpays that round's unstakers. Rejected on both counts.

### Over-poking is free, so it pokes without hesitating

Every handler does its `throw_unless` checks *before* `accept_message()`. An external sent at the
wrong moment is rejected during the compute phase, no transaction is committed and nobody pays for
it. So "fire every minute until resolved" costs the treasury exactly one accepted transaction per
state change, regardless of how many attempts it took, and two instances sending the same poke is
free rather than something to coordinate away.

The same property means duplicate senders never conflict: borrowers keep their existing poke
behaviour, and the service is redundancy rather than a replacement. Nothing in `borrower` changes.

### Being late is still worth doing

`participate_in_election` has no upper bound — only `now() >= min(participate_since, round_since)`.
A round that has missed its election window can and should still be poked: it distributes, the
elector rejects the stakes, `new_stake_error` runs `recover_stake_result`, and the round settles and
returns borrower collateral. Without the poke it stays `open` forever. So the service never declines
to poke on the grounds that it is too late to win the election; "too late" is precisely when the
poke is doing its most valuable work.

### It reads the treasury, but a bad read degrades to blind rather than to wrong

Picking what to poke wants the participations dictionary, which means `get_treasury_state` index 7
(participations) and index 9 (`stopped?`). Those are the same positional reads that broke `borrower`
on 2026-09-06, so a naive implementation puts the backstop and the borrowers in one failure domain —
one treasury upgrade takes out both at once, which is the exact shape of the incident this service
exists to prevent.

So the read is guarded and the failure is designed:

- The tuple's length is checked against a constant compiled in next to the reads, and index 7 must
  be a cell and index 9 an integer, before either is trusted. A tuple that does not match **is not
  interpreted**; it is treated as a read failure.
- On any read failure the service enters **blind mode**: it derives candidate `round_since` values
  from the network config alone — `utime_since` and `utime_until` of config params 32, 34 and 36,
  deduplicated — and fires all three ops at each candidate every 60 seconds, letting the contract's
  own guards decide what actually applies. Blind mode parses nothing the treasury returns and so
  cannot be broken by any treasury upgrade.

Config 32/34/36 reach back far enough: with an 18-hour round and a 9-hour hold, a round in `held` or
`recovering` carries a `round_since` equal to config 34's or config 32's `utime_since`. Config 36 is
absent outside the election window and is simply skipped when null.

Reading precisely is the normal path because it produces honest logs and honest metrics; blind mode
exists so that a broken read costs accuracy rather than the protocol.

### The halt policy: wait for the refund branch, do not withhold the message

`stopped?` is read in exactly two places in the treasury, `deposit_coins` and `request_loan`.
`participate_in_election`, `distribute`, `decide_loan_requests` and `process_loan_requests` have no
stop check, which the solvency runbook already records: halting "does NOT stop the open round's
already-placed loan requests from being lent at its next `participate_in_election`, which anyone can
send." Today that hazard is unreliable — with borrowers down, a halted treasury happens not to lend.
A service poking every minute would make it dependable, during exactly the incident in which the
governor halted the pool.

The first version of this spec simply withheld `participate_in_election` while `stopped?` was set.
That was wrong, and it was wrong for a reason worth writing down: **because `request_loan` checks
`stopped?`, a halted pool can gain no new requests.** An open round therefore holds only bids placed
before the halt — a fixed set of third parties whose collateral sits in the treasury for as long as
the round stays open. Withholding the message strands them indefinitely, for no benefit to anyone.

`distribute` already has the right answer:

```func
int elected?  = ~ config_param(config::next_validators).null?();
int too_late? = now() >= min(participate_until, round_since);
if elected? | too_late? {
    ;; reject all requests if already elected or there is not enough time for safe participation
```

Poked inside the election window it lends. Poked once that branch is guaranteed, it moves every
request to `rejected`, refunds each borrower through `process_loan_requests`, and retires the round
**without lending a single GRAM**. So while `stopped?` is set the service does not withhold
`participate_in_election`; it defers it until `elected? | too_late?` holds — **plus a margin**.

The margin is not caution, it is the difference between a guard and a branch, and the first
version of this shipped without it. Everywhere else in this service an early send is free, because
the treasury's guards run before `accept_message()` and a rejected external commits nothing. That
is what pays for a burst which deliberately starts two seconds early. **`participate_until` is not
one of those guards.** `participate_in_election`'s guards are `state == open` and
`now() >= min(participate_since, round_since)` (treasury.fc:883-886); `participate_until` is read
afterwards, inside `distribute` (treasury.fc:828), with the message already accepted and the state
already committed. Being early there does not throw — it takes the other branch and lends. And
`now()` is the `gen_utime` of whichever block collated the message, which can precede the send;
with several copies going to several endpoints the deciding value is the *minimum* `gen_utime`
among them, and one early copy is irreversible.

So the `too_late?` arm waits `refundMargin` (300s) past its threshold. 300 because that is when
config 36 appears anyway, so for the upcoming round this arm now fires no earlier than the
`elected?` arm, which has no race in either direction. What the arm still buys is the stale open
round, whose threshold is `round_since` and hours in the past, where the margin is satisfied the
moment it is tested. The round closes, the
collateral comes back, the pool lends nothing, and no third party is left waiting on a halt being
lifted. Settling is never withheld in any mode.

That is strictly better than both alternatives, which is why it replaced the original decision
rather than being offered alongside it.

**When blind, only half of that condition is readable**, and that half is the useful one.
`too_late?` needs `participate_until` from `get_times`, which blind mode does not trust; `elected?`
is just "config 36 exists", which is network state. So blind mode participates normally for a
bounded two hours — with `PokerBlindMode` warning within five minutes — and after that only while
config 36 exists, where `distribute` can only refund. It therefore stops being able to lend, but
never stops being able to retire a stranded round.

Failing safe by never participating again would have meant a getter change silently stopping the
pool earning *and* stranding borrower collateral until someone noticed. Failing open indefinitely
would have meant an unrelated upgrade removing the halt guard with nobody told. Two hours is well
under one round, so at most one lending round is exposed.

### The first poke is sent at the first opportunity

This service aims at the exact second because it can: it is not competing for an election slot, it
has no wallet to serialise, and a mistimed external costs nothing.

How much that is worth was measured on chain afterwards, and it is worth less than this spec
originally claimed. An earlier draft said the borrowers poke on a 60-second timer with up to 60
seconds of jitter, so a transition waits about a minute. That was read off `borrower/main.go`
rather than measured, and it is **wrong for `participate_in_election`**: every one of the five
rounds before this service was deployed landed that message at exactly `participate_since + 3s`,
with consecutive rounds exactly 65536s apart — zero variance. Where the variance actually lives is
`vset_changed` (+4s to +38s across the same window) and, inherited from it, `finish_participation`:
`stake_held_until` is set to `now() + stake_held_for + 60` at the transition into `held`, so every
second of `vset_changed` lateness is paid again by the settlement a round later.

So the timing case for this service is `vset_changed` and what follows from it. The case for
`participate_in_election` is redundancy alone, and that is still the case that matters — the
borrowers being precise is no use at all on the days they are not running.

All three deadlines are computable in advance, so the loop sleeps until one rather than polling
towards it:

| op | it becomes legal at |
| --- | --- |
| `participate_in_election` | `min(participate_since, round_since)`, from `get_times` |
| `vset_changed` | the next validator-set rotation, config 34's `utime_until` |
| `finish_participation` | the participation's own `stake_held_until` |

Two details decide whether aiming at a second actually works.

**The clock that matters is the chain's, not the host's.** The guards compare against `now()`, which
is the `gen_utime` of the block that includes the external, and a host clock that is a few seconds
fast will fire early every single time and lose a whole retry interval to it. So the service asks a
liteserver for the time (`GetTime`, one cheap round trip per cycle), tracks
`offset = liteserver time − local time`, and schedules against the corrected clock. The liteserver's
clock is not literally the block's `gen_utime`, but it is the clock of a node that produces or
follows those blocks, which removes the systematic error that matters. `hipo_poker_clock_synced`
exists because an unobserved clock reports an offset of zero, which is indistinguishable from
perfect sync while every deadline is being computed on raw host time.

**A rejection is free, so it leans early rather than late.** Being one second early means the block
that would have carried the external is produced before the deadline, the guard throws, no
transaction is committed and nobody pays. Being one second late means the transition waits for the
next attempt. The costs are not symmetric, so the service opens a short burst around the deadline —
one send per second from two seconds before until three seconds after — and then drops to the
60-second retry. Worst case that is six discarded externals, which is six compute phases that never
commit; typical case the transition lands in the first masterchain block at or after the deadline.

The 60-second retries afterwards are deliberately plain: no jitter, no backoff. Jitter exists to
spread load across many independent senders, and there are two of these; the duplicate sends are free
for the same reason the burst is.

### Everything else

- **Two instances**, one per node, matching the deliberately duplicated collector sets. Duplicate
  pokes are free (above), so this needs no leader election.
- **Chain access**: our own liteservers first (a node `gauge` already reads from), falling back to
  the public pool from ton.org's global config when they are unreachable. Own nodes alone would put
  the poke service in the same failure domain as the validators, and validators going down is one of
  the cases this is meant to survive. Endpoints are configuration, not design: they live in the
  private stack file, and this document names none.
- **Cadence**: the first poke goes at the first opportunity, then every 60 seconds while anything is
  unconfirmed; see *The first poke is sent at the first opportunity* above.
- **No Redis.** Unconfirmed-poke ages are in memory, so a restart resets them; that costs the alert's
  `for:` window and nothing else, the same trade `gauge` documents for its own restarts.

## Changes

**`HipoFinance/poker` (new repository)** — Go, `tonutils-go`, image built to
`ghcr.io/hipofinance/poker:sha-<commit>` on push to `main`, matching `gauge` and `exporter`.

- `main.go` — signal handling and the timer loop; same shape as `borrower/main.go`.
- `poke/chain.go` — liteserver pool (own nodes, public fallback), config 15/16/32/34/36 reads.
- `poke/state.go` — guarded `get_treasury_state` read: length and per-index type checks, returning
  either a parsed participation set or a read failure. Never a partially trusted tuple.
- `poke/due.go` — given participations (or blind candidates) and `stopped?`, the set of `(op,
  round_since)` pokes that are due; the halt policy (`participateDue`, `refundOnlyFor`) and the
  blind two-hour window live here.
- `poke/send.go` — builds and sends the three external bodies; identical encoding to
  `wrappers/Treasury.ts`'s `sendParticipateInElection` / `sendVsetChanged` / `sendFinishParticipation`.
- `poke/clock.go` — the chain-clock offset and the deadline schedule: when the next poke is due, and
  the burst window around it.
- `poke/metrics.go` — the Prometheus series listed below, served on `:10000`.
- `Dockerfile`, `Makefile`, `.github/workflows/build.yml`, `README.md`, `CLAUDE.md`.

**`HipoFinance/operation`**

- `stack/poker.yaml` — `poker1`/`poker2`, one per node by `node.hostname` constraint, `user: "717:717"`,
  `monitor` network only, no secrets, `TREASURY_ADDRESS` and liteserver settings as environment.
- `monitor/config-collector-1/prometheus.yaml` and `.../config-collector-2/prometheus.yaml` — a
  `poker` job with targets `poker1:10000` and `poker2:10000`. Mirrored change, as always.
- `monitor/rules/poker-alerting-rule.yaml` — the six alerts below.
- `monitor/rules/tests/rules_test.yaml` — firing and clearing cases for each.
- `monitor/alerts-runbook.md` — a `### PokerReadFailing`, `### PokerBlindMode`,
  `### PokerBlindModeExpired`, `### PokerBlindModeFlapping`, `### PokerClockUnreliable` and
  `### PokerPokeUnconfirmed` section each; `check-runbook.sh` fails without them.
- `uid.md` — 717 poker (714 is free but 715 and 716 are taken; the list is append-only in practice).

Metrics: `hipo_poker_last_read_success_seconds` (unix time, initialised at process start and only
ever moved forward by a cycle that reached the chain, so a persistent failure shows as a growing
number rather than an absence), `hipo_poker_blind_mode` (0/1), `hipo_poker_blind_mode_since_seconds`,
`hipo_poker_unconfirmed_poke_seconds{op,round_since}`, `hipo_poker_pokes_sent_total{op}`,
`hipo_poker_poke_errors_total{op}`, `hipo_poker_confirmed_transitions_total{op}`,
`hipo_poker_treasury_state_fields` and `_expected`, and `hipo_poker_clock_offset_seconds`.

Deliberately absent: per-round participation state. `gauge` already publishes
`hipo_treasury_participation_state` and the round-lifecycle alerts are built on it; a second
publisher of the same fact would only create a way for the two to disagree.

Alerts, all warnings: `PokerReadFailing` (cannot reach the chain at all, so not even poking blind —
`for: 5m` over a threshold that clears the loop's 5-minute sleep cap three times over),
`PokerBlindMode` (`for: 5m`), `PokerBlindModeExpired` (blind past two hours, no longer lending),
`PokerBlindModeFlapping` (a read that keeps breaking, which `PokerBlindMode`'s `for` can never
see), `PokerClockUnreliable` (never synced, or more than 30s from the chain) and
`PokerPokeUnconfirmed` (**oldest unconfirmed poke over 60 seconds, no `for:`** — about two minutes
to Telegram once the 15s scrape, the 1-minute evaluation interval and Alertmanager's 30s
`group_wait` are counted, and those three are the floor rather than the threshold).

`PokerReadFailing` was not in the first draft of this spec and is not redundant with blind mode.
They are different failures wanting different people: "cannot reach the chain" and "cannot trust the
treasury" are separated here for the same reason `TreasuryStateStale` and
`TreasuryStateShapeChanged` are separated in the existing rules. Without the validator sets there
are no candidate rounds either, so a chain-level failure is strictly worse than blind mode and has
to be visible as its own thing.

A dead instance needs no new rule — `job="poker"` is not one of the jobs with a bespoke down alert,
so `targets-alerting-rule.yaml`'s `TargetDown` catch-all covers it, exactly as `CLAUDE.md` in that
repo describes.

**`HipoFinance/contract` (this repository)** — no contract, wrapper or deployment change.

- `docs/architecture.md` — a note under *Governance and operations* that the three externals have a
  dedicated off-chain driver of last resort, and that it deliberately holds no key.
- `tests/Loan.spec.ts` — one test pinning the property the whole design rests on: an external sent
  outside its guard leaves the treasury's balance and the participation's state byte-identical. The
  suite already asserts the exit codes (`unableToParticipate`, `notReadyToFinishParticipation`); this
  adds that nothing was paid and nothing was committed.
- This spec.

## Invariants

The service sends no message that an anonymous member of the public could not already send, and
holds no key, so every invariant in `docs/architecture.md` is preserved by construction rather than
by argument:

- **Exchange-rate identity, deposit/unstake fairness, loan safety** — untouched; no contract changes,
  and the service originates no internal message.
- **Every state transition stays gated on chain.** The service's timing is an optimisation and never
  a permission. `participate_in_election` still requires `state == open` and
  `now() >= min(participate_since, round_since)`; `vset_changed` still requires a genuinely changed
  validator-set hash and `state ∈ {staked, validating}`; `finish_participation` still requires
  `state == held` and `now() >= stake_held_until`. Blind mode is safe precisely because it delegates
  every decision to those guards.
- **The reward-ordering barrier** in `burn_ready_participations` is untouched: the service never sends
  `retry_burn_all`, so it cannot release a `ready_to_burn` round over an older round that still owes
  a reward, and the deferred-minting invariant behind `instant_mint = false` is unaffected.
- **Governance-gated state is unreachable.** No key, so `set_stopped`, `set_deficit`, the retries and
  every upgrade path remain exactly as manual as they are today.

The one behaviour that genuinely changes: an already-halted treasury will now reliably have its open
rounds *retired* rather than lent, where before they would sit open until someone noticed. The
service never sends `participate_in_election` to a halted treasury at a moment when `distribute`
would lend, so it does not widen the documented hazard that halting fails to stop lending — but it
does not close it either, because anyone may still send that message at the lending moment. That
remains a property of the contract, not of this service.

## Compatibility

No stored data layout change, no `contracts/schema.tlb` change, no message schema change, no
migration, and nothing to order against running rounds — the service can be deployed or removed at
any point in a round and the protocol behaves as it does today.

The one coupling is to `get_treasury_state` indices 7 and 9. The tuple is append-only by the rule
recorded in the getter, so those indices are stable going forward; the guarded read exists for the
case where that rule is broken again, and its contract is that a mismatch degrades to blind mode and
raises `PokerBlindMode` rather than producing a wrong answer. `TreasuryStateShapeChanged` already
alerts on the shape change itself, so the two signals arrive together and say different things: the
tuple moved, and the poker stopped trusting it.

Deployment ordering, mirroring the note in `stack/gauge.yaml`: the alerting rules and runbook sections
go in with or before the first image, or the alerts have no series to evaluate; and the GHCR package
must be made pullable by the host before the first deploy.

## Test plan

In `HipoFinance/poker`, unit tests over table-driven fixtures — no chain access:

- Due-poke computation for a participation in each of states 0–7, asserting exactly which op is due
  and that states 6 and 7 produce none.
- The halt policy, which is the subtlest thing here: with `stopped?` set,
  `participate_in_election` is withheld inside the election window and due once
  `elected? | too_late?` holds, by both arms of that condition separately; a stale open round is due
  immediately; and the two settling ops are unaffected in every case.
- Blind candidate derivation from real config 32/34/36 cells, including config 36 absent.
- The blind window: all three fired inside two hours, `participate_in_election` withdrawn after it,
  and `hipo_poker_blind_mode_since_seconds` set once and not re-set on subsequent failures.
- The guarded read: a tuple that is too short, and one whose index 7 is not a cell, each producing a
  read failure rather than an interpretation. This is the test that would have caught 2026-09-06.
- Body encoding for the three ops asserted byte-for-byte against the cells `wrappers/Treasury.ts`
  builds, so the two senders cannot drift.
- The clock: a host clock deliberately skewed forwards and backwards against a fixed block
  `gen_utime`, asserting the burst opens at the corrected deadline and not the local one, and that
  the schedule falls back to 60-second retries once the burst window closes.

In `HipoFinance/operation`: `monitor/script/test-rules.sh`, with a firing-and-clearing case in
`monitor/rules/tests/rules_test.yaml` for each alert, and `check-runbook.sh` passing.

In this repository: `npm test`, with the added `tests/Loan.spec.ts` case above. Gas bounds are
unaffected — no contract path changes.

The dry-run is not a formality. The first one caught a bug no test over parsed cells could have:
`GetBlockchainConfig` fails the whole request if any requested parameter is absent, and config 36 —
the next validator set — exists only during an election window. Asking for it alongside the others
left the service unable to read anything at all for most of every round. It is now two calls, and
`TestBuildNetworkConfigWithoutAnElection` is the regression.

Before the first deploy, run both instances against mainnet in dry-run (compute and log the due set,
send nothing) for one full round and diff what they would have sent against what the borrowers
actually sent. A round in which the poker would have sent something the borrowers did not is the
result that justifies the service; a round in which it would have sent something neither the contract
nor the borrowers wanted is the one that blocks the deploy.

## What an adversarial review changed

The service was reviewed hostilely before deployment, against the FunC rather than against these
notes. One claim held up unchanged: a rejected external costs nobody anything. **A second one did
not survive the next review and is corrected above** — "deferring the poke to `distribute`'s refund
branch can never cause a stake instead of a refund" was written here after a reviewer walked every
reachable `round_since` and both sides of a rotation. Nobody walked the `gen_utime` lag, which is
the only axis that matters at that boundary and the one this service has a whole abstraction for.
`participate_until` is a branch selector inside `distribute`, not a guard in front of it, so an
early send there stakes rather than throwing. It is fixed with a margin; the lesson is that "we
checked it" is worth exactly as much as the axis nobody thought to check.

Six other things did not hold up, and they are recorded because each was a plausible-looking piece
of code that did the wrong thing:

- **The burst measured itself from the oldest outstanding poke**, so one wedged round put every
  cycle on the plain retry interval and switched off the first-opportunity burst for every other
  round — during exactly the incident it exists for. The unit test on the scheduling function
  passed throughout; the regression now sits at the wiring.
- **Blind mode could not see the rounds it exists to rescue.** Candidates came from the three
  `round_since` values the validator sets name, but the treasury holds up to eight participations,
  so a round that missed two rotations fell off the list permanently and blind mode has no exit
  timer. It now reaches six epochs further back.
- **An unsent poke started a clock**, so a dry run published ages for messages it never sent and a
  blocked network path read as "the treasury is refusing us".
- **A policy change counted as a state transition**: confirmation compared against what the service
  chose to send, so the governor halting the pool mid-window logged a confirmation for something
  that never moved. It compares against the contract's own guards now.
- **A read flapping every few minutes silenced everything.** The blind boundary reset every poke's
  age, so nothing reached the alert threshold, while `PokerBlindMode`'s `for` never saw five
  continuous minutes either. `PokerBlindModeFlapping` is the alert that closes it.
- **A chain outage froze the published ages**, so a poke that happened to be one retry old when the
  chain went away fired for the whole outage.

Smaller: the halted log line said participate was withheld on exactly the cycles it was being sent;
config 15 was fetched as a required parameter for a field never read, so an unreadable config 15
would have stopped all poking; `vsetTimes` accepted a validator-set tag the contract throws on; and
endpoint sends were serial with a 10-second timeout each.

The lesson worth keeping is the first one. Every one of these passed a test suite that was already
mutation-checked, because the tests pinned the functions rather than the wiring between them.

## What the second adversarial review changed

The code written in response to the first review was itself reviewed, because fixes written under
a review's pressure are exactly where new bugs live. That was worth doing: the worst finding of
either pass came from it — the halt policy above, which could have let a halted treasury lend.

The other findings, each a fix that did not do what its own commit message claimed:

- **The loop could spin at 1Hz forever.** An empty tracker reports an age of zero, which the
  scheduler read as "sent a moment ago". Nothing is in the tracker when every send is failing, or
  under `DRY_RUN` — the two states where a hot loop is least affordable, and the second of which
  this spec asked to be run against mainnet for a full round.
- **Concurrent sends still waited for the slowest endpoint**, because the results were read after
  the wait group. One black-holed endpoint still added its whole timeout to every poke in a cycle.
- **Nothing measured whether the read data was current.** The session takes the first endpoint that
  *answers*, so a liteserver that is far behind in sync wins whenever it replies; sends go to every
  endpoint, so the poke lands and the round advances while the poker never sees it. Every existing
  check passed. `hipo_poker_read_block_seqno` closes it.
- **Every send failing raised nothing at all**, which was a direct consequence of getting the
  previous review right: a poke only starts a clock once it has actually left, so with every send
  failing there is nothing to go unconfirmed, while reads keep succeeding so nothing else fires.
- Smaller: a validator set with inverted times underflowed the epoch length blind mode derives;
  `Send` with no endpoints reported success; `increase()`'s edge extrapolation made a threshold
  mean three or four depending on history; a read outage sent a spurious RESOLVED for a wedged
  round; and the runbook had every `PokerReadFailing` number wrong, copied from gauge's equivalent
  and never updated when the rule changed.

Two conclusions worth keeping. First, the failure mode of both reviews was the same: tests that
pin functions while the bug lives in the wiring between them, and prose that was reasoned from
code rather than measured against it. Second, a review's own "checked and sound" list is a claim
like any other — the first review's most reassuring paragraph is the one the second review
overturned.

## Out of scope

- **The governor retries** — `retry_distribute`, `retry_recover_stakes`, `retry_burn_all`,
  `retry_mint_bill`. They need a hot governor or halter key and, for `retry_burn_all`, a judgment the
  runbook assigns to a person. This means the gap the runbook already names stays open: a round wedged
  in `distributing` or `staked` is still "named by nothing" and still needs a human.
- **Changes to `borrower`.** It keeps poking; the service is redundancy, not a replacement.
- **Any contract change**, including a dedicated `get_pokes()` getter that would let the service read
  what is due without touching the tuple. It is attractive — a new getter is safe under the
  append-only rule and would remove the last ABI coupling — but it costs a treasury upgrade, and the
  guarded-read-plus-blind-fallback design already makes a tuple change survivable. Revisit if the
  tuple moves again.
- **Driving anything other than the treasury.** The collection burn chain, wedged bills and orphaned
  rounds are repair work with a documented procedure and stay manual.
