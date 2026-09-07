# Measure the Rate Over a Two-Round Window, at the Barrier Instead of at Settlement

> Supersedes parts of `docs/specs/2026-09-06-round-duration.md`: the monotonic guard and its
> "not a one-scalar problem" conclusion, that spec's decision to insert new fields rather than append
> them, and its rule that `get_treasury_state` mirrors storage order — replaced here by append-only
> plus completeness. Still standing: why the interval is measured from `round_since` rather than read
> from config, and why the getter returns everything the treasury stores in one call.

## Problem

Two independent defects in what the treasury publishes about its own rate of growth.

**1. The rate pair and its interval describe different events.** They are written in the same `if`
(`treasury.fc:1529-1534`) but move on different triggers: `previous_rate`/`current_rate` on every
settlement, `round_duration`/`last_settled_round` only on an in-order one. Settlement is not
ordered: when the elector rejects a whole round's stakes, `new_stake_error` (`loan.fc:88-91`) runs
`recover_stake_result` within seconds, so round R+1 settles while R is still validating. The result
is a rate delta of one round's reward paired with an interval of two rounds, for two settlements.

The elector-rejection case publishes a spurious **0%** that sits on the dashboard for roughly a
round: R+1 settles with no reward at all, moving the pair by nothing across a two-round interval.
An older round merely delayed past a newer one — never observed in production — reads half the true
rate for two settlements instead. Both are conservative and self-correcting, and
`docs/integration.md:173` documents them as a caveat.

**2. Round imbalance makes the published rate oscillate.** `rounds_imbalance` caps how much one
round chain can lend relative to the other, so the two chains lend different amounts and the reward
booked per settlement alternates with them. Live: 3,021,861 and 3,516,623 GRAM across rounds
`1788694280` and `1788759816`, a ±7.6% deviation about the mean. Annualised from a single
settlement that is a sawtooth between roughly 14.0% and 16.3% around a true ~15.1%, flipping every
~18h. Nothing is wrong with any individual reading — two consecutive ones average to the truth —
but every chart that plots us plots the sawtooth.

Both defects come from the same root: a window one settlement wide, whose two halves are captured
at different moments.

## Decision

Three changes, which compose into a window that is exact by construction and stable in steady
state. None of them changes an existing tuple position.

### 1. Snapshot at barrier release, once per batch

Move the rate write out of the settlement branch in `recover_stake_result` and into
`burn_ready_participations` (`treasury.fc:1011`), taken **once per scan** with the interval measured
to the highest round the scan released.

This works because a round only reaches `ready_to_burn` once its own rewards are in `total_coins`,
and the barrier guarantees no round below the released run still owes one (`owes_reward?`,
`treasury.fc:187`). So the delta is precisely the rewards of the rounds in
`(last_settled_round, highest]` and the interval is precisely that span. The two halves describe the
same event because they *are* the same event, and the monotonic guard that produced the two-settlement
artifact disappears rather than being worked around.

Deferring the *snapshot* is the only thing that works. Deferring the reward — parking each round's
rate update to be released in order, one per round — inverts the error into an **over-report**, which
is the dangerous direction: `total_coins` is credited per loan recovery (`treasury.fc:1452`), not at
settlement, so a per-round deferred snapshot captures rewards booked after it should have been taken.
Holding rewards out of `total_coins` instead would corrupt the exchange rate for anyone unstaking in
the meantime, so it is not an option.

**Every released round advances the window, including one that lent nothing.** A round with no loans
reaches `ready_to_burn` from `process_loan_requests` (`treasury.fc:1158-1166`) and is released by the
same scan. With a two-round window this is not only harmless but better: the window then always spans
one lending round and one empty one, so the published value stays steady, and a pool whose borrowers
are bidding but which is lending nothing reports 0% in real time. That was a stated goal of
`2026-09-06-round-duration.md` ("Days idle … the website keeps publishing the last APY as though the
pool were still earning") that measuring the gap did not actually achieve, because the interval only
widens retroactively at the next settlement. It does not cover a pool with no `request_loan` at all:
no participation is created, so there is no release event and the pair freezes exactly as today.

### 2. Widen the published window to two release events

Maintain three (rate, round) observations — oldest `O`, middle `M`, newest `W` — and publish the span
`[O, W]`. Two slots cannot slide: at release *N* you need the rate from *N-2*, and to roll forward at
*N+1* you need the one from *N-1*, which the pair never held. A tumbling window costs no extra rate
but alternates between one-round and two-round spans, so the sawtooth returns on half the readings.

`O.round` is derivable as `last_settled_round - window_duration`, so only `M` needs new storage:

| slot | field | status |
| --- | --- | --- |
| `O.rate` | `previous_rate` | existing, position unchanged |
| `W.rate` | `current_rate` | existing, position unchanged |
| `W.round - O.round` | `window_duration` | existing, **renamed** from `round_duration` |
| `W.round` | `last_settled_round` | existing, position unchanged |
| `M.rate` | `mid_rate` | **new** — stored beside the pair, returned last |
| `M.round` | `mid_round` | **new** — stored beside the pair, returned last |

Two is the right width because two is the *period* of the alternation, not because it is generic
smoothing: each window holds exactly one high chain and one low chain, so the oscillation cancels
rather than being damped.

The update, in `burn_ready_participations` after the scan loop, with `highest` the greatest
`round_since` released:

```func
if highest > last_settled_round {
    previous_rate = mid_rate;
    window_duration = highest - mid_round;
    mid_rate = current_rate;
    mid_round = last_settled_round;
    current_rate = muldiv(total_coins, 1000000000, total_tokens);
    last_settled_round = highest;
    pack_extension();
}
```

The assignment order is load-bearing: each old value is read before it is overwritten. The
`highest > last_settled_round` guard covers a scan that released nothing and a round released around
the scan by `retry_burn_all`.

### 3. The rates stay `store_coins` — a specced change, reverted in implementation

This spec originally called for re-encoding all three rates as fixed `uint64`, on the grounds that
three varuint16 rates push the extension's theoretical worst case to ~1036 bits against the 1023
ceiling. **That was implemented, found wrong, and reverted.** It is recorded here rather than deleted
because the reasoning is the useful part.

The bit budget, with 664 bits of non-rate fields (the 632 that were there, plus `mid_round`):

| case | rate encoding | total | fits 1023 |
| --- | --- | --- | --- |
| realistic (rate ~1.16e9, 4 bytes each) | 3 × 36 | 772 | yes |
| every coin in existence pooled (rate ~5.9e17) | 3 × 68 | 868 | yes |
| varuint16's own maximum (rate ≥ 2^112) | 3 × 124 | 1036 | no |
| the rejected fixed width | 3 × 64 | 856 | yes |

Only the third overflows, and **it is unreachable**. Dead shares pin `total_tokens` at ~8.6e9 nano and
the coin supply caps `total_coins` at ~5.1e18 nano, so `muldiv(total_coins, 1e9, total_tokens)` cannot
exceed ~5.9e17 — 60 bits. The binding constraint is the coin supply, not the encoding, and against
that bound `store_coins` costs 868 bits where `uint64` costs 856. Twelve bits.

For those twelve bits the fixed width buys a new failure mode: `store_uint(rate, 64)` **throws exit 5**
on an over-large rate, inside `pack_extension`, which would wedge every op that touches the extension.
`store_coins` widens instead. `tests/MaxGas.spec.ts` found this immediately — its fixture sets
`totalTokens = 1n` to drive worst-case gas, which makes `current_rate` run past 2^64 — and while that
state is synthetic and unreachable with dead shares intact, "unreachable" there rests on an invariant
of a different subsystem. Trading a graceful widening for a hard throw to save twelve bits against an
impossible worst case is the wrong side of that trade.

So the layout change is `mid_rate` (`store_coins`) and `mid_round` (`uint32`), appended, and nothing
is re-encoded. The migrator gets simpler for it: it copies every existing field through untouched.

### Storage groups; the getter appends

These are separate decisions and this spec makes them separately. `mid_rate` and `mid_round` are
stored immediately after `last_settled_round`, with the pair they describe, because nothing off chain
parses the extension cell — only this contract and its migrators do, and grouping is where a reader of
`treasury.fc` will look. `get_treasury_state` returns them **last**, because that tuple is an
interface every off-chain reader indexes by position.

That drops the "the tuple mirrors storage order" property the previous release paid a breaking change
to obtain, and replaces it with two rules that are simpler and protect more:

1. **The tuple is append-only.** A field is never inserted and never moved, so an index that means
   something today means the same thing forever.
2. **The tuple is complete.** Everything the treasury stores appears in it, so an integrator makes one
   call and never needs a second getter.

Completeness was the half of the mirror that had real value — it is what let `get_deficit` be deleted.
Ordering was the half that cost a breaking change, and it bought only the ability to check the tuple
against the layout, which no integrator can do anyway because they cannot see the layout.
`Getters.spec.ts` pins the positions either way.

### Appending reverses the previous spec, deliberately

`2026-09-06-round-duration.md` chose to *insert* new fields so the getter tuple would mirror storage
and keep related fields adjacent. That argument was made while a positional break was already being
paid for. It is the wrong trade now, and the evidence is stronger than "one more break".

**The rollout checklist is not the population of readers, and has now failed twice.** A census of
`~/code/HipoFinance/` on 2026-09-07 — the grep that `scripts/upgrade_treasury.md` already prescribes —
found that the 2026-09-06 release broke three readers that were on nobody's list, because `deficit`
took index 5, the slot `parent` had occupied:

| reader | reads | state |
| --- | --- | --- |
| `vesting/index.html` | `HIPO_JETTON_MINTER_ADDRESS_INDEX = 5`, then `.loadAddress()` | live at `vesting.hipo.finance`, last commit 2024-12-17 |
| `club/assets/index-CsswUuK1.js` | sequential; the 6th read is `readAddressOpt()` | live at `club.hipo.finance`, last built 2026-08-22 |
| `dune/exporter/export-rates.mjs` | index 5 as `readAddressOpt()` | dormant since 2026-08-20; fails on its next run |

All three call an address reader on what is now an integer, so they throw rather than report wrong
numbers — on `vesting` that is the lookup that resolves a holder's hGRAM wallet. That is on top of
`borrower`, which read `participations` at what became `parent`, panicked every cycle, and cost two
validators round `1788759816` with a stake left in the elector about six hours past
`stake_held_until` — in a release whose entire subject was the getter's shape.

**And a "local" insert is not local.** Placing `mid_rate`/`mid_round` at index 16 *in the tuple*, next
to the group they belong to, would shift everything above them and take the tuple to 26.
That still breaks `wrappers/Treasury.ts`, `migrationDryRun.ts`, `showState.ts`, the `Getters.spec.ts`
pins and ~16 `TreasuryConfig` literals in tests; `borrower` (`borrower_fee`, 20 → 22); `gauge`, which
checks the field count as well as positions; `sdk`, and through its sequential reads `website`, `mcp`
and `sdk-example`; and upstream `dimension-adapters/fees/hipo`, which reads `governanceFee` at
`stack[19]`. The choice of insert point is itself load-bearing — after `current_rate` instead of after
`last_settled_round` would additionally break `yield-server`, which reads `stack[12]`, `[13]`, `[14]`
and stops. Adjacency is not worth re-running a list that has twice proven incomplete.

Appending, by contrast, moves nothing. Positions 0–23 are unchanged, and because the meaning of the
three existing fields is preserved — start rate, end rate, and *the length of the window they span* —
**any reader that divides by the interval field stays correct with no change at all.** Verified
against the actual code rather than the previous spec's table: `dimension-adapters` (`stack[1]`,
`[12]`, `[13]`, `[14]`, `[19]`), `yield-server` (`stack[12]`, `[13]`, `[14]`),
`DefiLlama-Adapters/projects/hipo` (`result[0]`, `[2]`), `hpo-trader` (`stack` 0 and 1) and
`website/scripts/hipo-fund-snapshot.mjs` (`state[0]`, `[1]`) all keep working untouched. The only
reader that breaks is one that assumed the interval is one round — exactly the reader `round_duration`
was introduced to eliminate. The published value simply stops oscillating.

The rename `round_duration` → `window_duration` is a compile-time break in our own TypeScript and
nothing else. It is worth taking: the name says "round" for a value that now spans two of them, which
is the misreading the field exists to prevent. Silent semantic drift is the worse outcome.

### The pair stops publishing while the barrier holds

With the snapshot at release, nothing is published while an older round still owes its reward — about
a round, in the elector-rejection case, replacing today's spurious 0% with a stale but plausible
reading. `last_settled_round` already exposes the staleness and the true exchange rate stays readable
from `total_coins`/`total_tokens`.

A round that never settles would freeze the pair indefinitely, and that is accepted without a timeout
or fallback. It is not a new failure mode: such a round already blocks **every later round's bills**
through `owes_reward?`, halting deferred deposit and unstake settlement — an alarm far louder than a
stale APY, and one that would be handled for reasons unrelated to the rate pair. `retry_recover_stakes`
has never been used in production.

## Changes

- `contracts/treasury.fc`
  - `pack_extension`/`unpack_extension`: `round_duration` renamed `window_duration`; `mid_rate`
    (`store_coins`) and `mid_round` (`uint32`) inserted after `last_settled_round`, with the pair they
    describe. Two new globals in the same place. The existing rates are untouched, and a comment
    records the bit budget above so the `uint64` question is not reopened from scratch.
  - `get_treasury_state` returns the two **last**, at positions 24 and 25, with a comment stating the
    append-only and completeness rules and why the storage mirror was given up.
  - `burn_ready_participations` (`:1011`): track the highest released `round_since` in the loop; apply
    the guarded update above after it. Every released round counts, with no `total_staked` test.
  - `recover_stake_result` (`:1529-1534`): the rate write and the monotonic guard are deleted. Its
    trailing `pack_extension()` goes with them **if** it has no other extension write to persist —
    `deficit` is a root field, so it should not; verify during implementation rather than assume.
  - **`process_loan_requests` (`:1176`) and `retry_burn_ready` (`:2023`) call the scan and never call
    `pack_extension()`** — only `recover_stake_result` does. That is why the update above packs the
    extension itself, inside the branch, so the cost lands only on a scan that actually advanced the
    window and not on every `process_loan_requests` continuation. Without this the rate write is
    silently dropped on two of the three paths.
- `wrappers/Treasury.ts` — `roundDuration` → `windowDuration`; `midRate` and `midRound` as required
  fields on `TreasuryConfig`, stored by `treasuryConfigToCell` and read by `getTreasuryState`.
- `wrappers/migrationDryRun.ts` — both new fields in the `snapshot` field list.
- `wrappers/upgrade-code-test/add_two_round_window.fc` — new migrator (below).
- `wrappers/upgrade-code-test/reset_data.fc`, `mint_dead_shares.fc` — both parse the extension by hand
  and end with `end_parse()`; they must track the new layout.
- `scripts/showState.ts` — `windowDuration`; the APY line is unchanged arithmetic.
- `docs/integration.md` — rename the field and rewrite its description for a two-round window; **delete
  the "One caveat on the pairing" paragraph at `:173`**, which this change makes obsolete; note the two
  appended fields and that existing positions are unchanged.
- `docs/architecture.md` — the extension layout, the `ready_to_burn` description at `:81`, and the two
  paragraphs on what the monotonic guard costs, which are replaced by the exact-pairing property.
- `docs/specs/2026-09-06-round-duration.md` — a superseded-by note at the top.
- `contracts/imports/constants.fc` — gas constants re-pinned to measurement.

No message schema change, so `contracts/schema.tlb` is untouched, and no message flow changes, so
`graphs/` is unaffected.

## Invariants

- **Exchange-rate identity untouched.** None of these fields is read by any accounting path.
  `total_coins`/`total_tokens` are unchanged, and no fee, reward split or reserve reads the window.
- **Participation state machine unchanged.** No new state, no new transition, no change to when a
  round settles or when it is released. The scan gains a tracked variable and a trailing update.
- **The reward-ordering barrier is unchanged.** `owes_reward?`, `holds_bills?` and the ascending
  release order are untouched, so deferred deposits still cannot mint at a rate excluding an older
  round's reward. This change rides on the barrier; it does not modify it.
- **The window is exactly paired.** `current_rate - previous_rate` is the reward of exactly the rounds
  in `(last_settled_round - window_duration, last_settled_round]`, and `window_duration` is exactly
  that span. This is the property the old design lacked, and it holds by construction rather than by
  the settlement order being well-behaved.
- **Both round fields still only move forwards**, now because the barrier releases in ascending order
  rather than because a guard rejects going backwards.
- **The getter tuple still equals the storage layout**, root fields then extension fields, with nothing
  stored left out. `Getters.spec.ts` keeps pinning it.
- **`get_treasury_state` stays total.** No config read, no new way to throw.

## Compatibility

Storage layout changes, so this needs a migrator in the same `upgrade_code`. It starts from the
round-duration layout, which is what is on chain (`get_treasury_state` returns 24 fields, `get_deficit`
answers with exit code 11).

`wrappers/upgrade-code-test/add_two_round_window.fc` parses the old root and extension by hand and
appends the two new fields, copying everything else through unchanged. Unlike the last migrator it
**reads no network config** — the seeds come from state the treasury already holds:

```func
mid_rate  = previous_rate;
mid_round = last_settled_round - round_duration;
```

That makes the published window immediately `[previous_rate, current_rate]` over `window_duration` —
byte-for-byte today's reading, correct on landing — and a genuine two-round window from the **first**
post-upgrade release, with no warm-up. It inherits whatever imprecision the round-duration seed carried
(`round_duration` is still the seeded 65536 and `last_settled_round` the seeded `1788694280`, since no
round has settled under that code yet), which is the same character of approximation already live.

The migrator must assert `round_duration > 0` and `last_settled_round > round_duration`; seeding a
negative or zero `mid_round` would publish a nonsense interval until two releases had passed, with
nothing on chain saying so.

It follows the three enforced rules — no `COMMIT`, no `SETCODE`, fully inlined to exactly method ids
`0` and `0x6d67` — and ends both parses with `end_parse()`, which is what makes a second run throw and
revert: every field sits in the same place in the new layout, so a re-run reads through to the end and
trips on `mid_rate`/`mid_round` left over. `participations` moves as an opaque dict, so no quiet window
is needed.

**Integrators need to do nothing.** Positions 0–23 are unchanged and the three window fields keep their
meaning, so a reader dividing by the interval stays correct and merely stops seeing a sawtooth. The
release notes should say the window widened from one round to two; no PR is required against DefiLlama.
Our own readers need the `roundDuration` → `windowDuration` rename, which is a compile error, not a
silent break.

## Test plan

- `tests/RoundDuration.spec.ts` — renamed and rewritten for the new semantics; the existing cases at
  `:296` and `:313` covering the monotonic guard are replaced, since the behaviour they pin is gone.
- Window correctness:
  - two consecutive lending rounds: the window spans two rounds after the second release;
  - **the imbalance case**: alternating high/low lending amounts produce a *steady* growth-per-second
    across consecutive releases — the core motivation, and the case today's code sawtooths on;
  - **the 100%-imbalance case**: with `rounds_imbalance` at 100% so rounds alternate lending and empty,
    the annualised value matches the balanced case within rounding. Same capital deployed, same APY;
  - a skipped round and a multi-day idle stretch widen the window rather than distorting it.
- Ordering and batching:
  - elector rejects R+1 entirely: R+1 parks with **nothing published** (no spurious 0%), then R settles
    and one batch release covers both, spanning the correct interval;
  - a batch release advances the window exactly **once**, not once per round released;
  - `retry_burn_all` releasing a round around the scan does not advance the window, and the next scan's
    span covers it and its reward.
- Persistence, the regression tests for the landmine above:
  - `process_loan_requests` releasing a no-loan round persists the update;
  - `retry_burn_ready` persists the update.
- `tests/Getters.spec.ts` — the raw stack pins all 26 fields to their positions, and positions 0–23 are
  asserted identical to the current release, which is the property that makes "no integrator action"
  checkable rather than claimed.
- `tests/TreasuryMigration.spec.ts` — the new migrator against the mainnet account snapshot, chained
  through deficit → borrower-fee → round-duration → this one, so each migrator keeps being tested
  against the layout it was written for. Needs a capture of the round-duration-era code as
  `tests/fixtures/treasury-round-duration-era-code.boc`. Assert: both rates survive the varuint16 →
  `uint64` re-encode exactly, `borrower_fee` survives at its live non-zero rate, the seeds land as
  specified, the result parses under the new layout, the governor still matches, and a second run
  throws.
- `tests/MaxGas.spec.ts` / `tests/MinGas.spec.ts` — the settlement path loses its stores, the scan gains
  the update and a conditional `pack_extension`, and the extension gains 72 bits. Re-pin to measurement.

## Out of scope

- **A stored APY field.** Rejected: compounded APY needs a fractional power, which is not a FunC
  computation; simple interest differs by over a percentage point at ~15% and every consumer would
  re-derive it anyway. It would also destroy verifiability — `current_rate` can be checked against
  `total_coins`/`total_tokens` and re-windowed by the reader — bake in one fee and compounding
  convention where DefiLlama, the website and the gauge each want a different one, and force exactly
  the positional break this design avoids, for a value that is derived. Widening the window delivers
  the stable number that motivated it.
- **A `get_apy()` convenience method.** One division in each consumer, and
  `2026-09-06-round-duration.md`'s reasoning for deleting `get_deficit()` applies in spirit.
- **Removing `get_times`.** Still the only source for the participation window and `stake_held_for`.
- **The APY formula in consumers.** Unchanged arithmetic; only the interval it divides by widens.
- **Website, mcp, gauge, sdk and DefiLlama changes.** Nothing is forced. mcp publishes this value as
  `rateIntervalSeconds` and may want to follow the rename; that is its own repo's call.
- **Bundling with `2026-09-07-borrower-max-factor-from-config.md`.** That change is implemented in
  `HipoFinance/borrower` and needs no treasury upgrade, so there is nothing to bundle. This ships alone.
