# Record the Round Duration Alongside the Rate Pair

## Problem

The website runs two scheduled reads against the treasury: one for `get_treasury_state` and one
for `get_times`. The second exists almost entirely to compute APY.

Of the six values `get_times` returns, the website consumes exactly one number —
`nextRoundSince - currentRoundSince`, the round length — in `apy` and in `roundsPerYear`
(`website/src/components/app/Model.ts:1568,1141`). Two further call sites reference `this.times`
only as a `!= null` gate and never read a field off it (`Model.ts:1388,1400`); the data they
actually use is `treasuryState.participations[…].stakeHeldUntil`. `readTimes` polls every five
minutes (`updateTimesDelay`, `Model.ts:124`) for a value that changes once per ~18h round.

The same pairing is everywhere: `mcp/src/protocol.ts:32` does
`Promise.all([getTreasuryState(), getTimes()])`, `gauge/actor/treasury.go:173` calls both,
`scripts/showState.ts:44` calls `getTimes()` for this one subtraction, and so does DefiLlama's
yield adapter.

But the round length read from the live config is the **wrong denominator**, and not only
because it costs a second call. `previous_rate`/`current_rate` are updated in exactly one place —
`treasury.fc:1500`, in `recover_stake_result`, when a round has fully settled. A round in which no
loan was made never gets there: it goes `distributing → ready_to_burn` directly
(`treasury.fc:1144-1152`). So:

- **Half liquidity, every other round validated.** Settlements fall to one per two rounds, and
  each books a round's reward from a larger share of the pool, so the growth per update roughly
  doubles. Divided by one nominal round length, the published APY does not move even though the
  true rate of growth halved.
- **Days idle.** Nothing settles, the rate pair freezes, and the website keeps publishing the last
  APY as though the pool were still earning. On resumption, one round's reward after a multi-day
  gap would again be annualised as if it were one round.

The rate pair already carries the growth. Nothing carries the interval that growth happened over.

## Decision

Store the interval in the treasury, written in the same `if` that writes the rates, and expose it
from `get_treasury_state`. Measure it as the gap between the `round_since` of the two most
recently settled rounds:

```func
if rejected.dict_empty?() & accrued.dict_empty?() & staked.dict_empty?() & recovering.dict_empty?() {
    if round_since > last_settled_round {
        round_duration = round_since - last_settled_round;
        last_settled_round = round_since;
    }
    previous_rate = current_rate;
    current_rate = muldiv(total_coins, 1000000000, total_tokens);
    state = participation::ready_to_burn;
}
```

`round_since` is the validator set's real `utime_since`, which is what makes this the right
measure rather than merely a cheaper one:

- **Skipped rounds** widen the gap to 2 rounds, or to N after an idle stretch — matching the
  growth it is paired with, with no special handling.
- **Prolonged rounds** push the following `round_since` out, so the extra time lands in the number
  by itself.
- **A changed round length** applies to exactly the rounds validated under it, because these are
  the actual boundaries and not a config value read at some later moment.
- **A round whose stake the elector rejects instantly** still carries its own `round_since`, so it
  reports one round length rather than the near-zero span a wall-clock measure would produce.
- **No `now()`**, so no dependence on the hold period, on `stake_held_for`, or on how promptly the
  off-chain driver sends `finish_participation` (`treasury.fc:1236`).

### The monotonic guard

Settlements are not necessarily in `round_since` order. `treasury.fc:1502-1507` describes the case:
a round whose stake the elector rejects instantly can finish ahead of an older round still
validating, so settlement order can be R+1, R, R+2 while round order is R, R+1, R+2.

Both fields therefore move **only forwards**, under one guard. An out-of-order settlement updates
the rates and touches neither. Walking `last_settled_round` backwards instead was tried on paper
and is wrong: after the sequence above it would measure R+2 as two rounds from R, when R+1's and
R's rewards are already in `current_rate` and R+2's settlement adds one round's worth — halving the
reported APY. Monotonic gives the correct one round.

It is also the better meaning for a value consumers can read: `last_settled_round` is *the highest
round whose reward is in `current_rate`*, which is what makes it usable for detecting a stale rate.
The backwards version would report the protocol as a round further behind than it is.

### Rejected alternatives

- **Deriving it at read time from the network config** (`validators_elected_for`, or
  `next_round_since - current_round_since` from config param 34). Cheapest to write and needs no
  migration, but it answers "how long is a round" when the question is "how long did this pool take
  to earn this". It is wrong in both scenarios above, and it would have made `get_treasury_state`
  throwable on unreadable config — a failure mode it does not have today, and a bad one to
  introduce into what becomes the website's only scheduled read.
- **Wall clock between settlements** (`now() - last_rate_update`). Captures the same intervals,
  since the hold-period offset cancels in a difference, but reads the clock at a late and jittery
  moment when the contract already holds the exact round boundaries.
- **The settled round's own scheduled window** (`stake_held_until - stake_held_for - 60 -
  round_since`). One field, no second stored value, correct while every round validates — and
  wrong in precisely the skipped-round case this is meant to fix.
- **Narrowing `previous_rate`/`current_rate` from `store_coins` to a fixed width.** Considered
  while the extension layout was open, and rejected: `store_coins` is varuint16, so a rate near 1e9
  occupies 36 bits and stays there until the rate passes 2^32 — about 4.3x the launch rate, ~30
  years at 5%/yr — after which it widens rather than breaking. `uint32` would save 4 bits per rate
  and buy the same ceiling except that crossing it overflows silently; `uint48` is safe but costs
  12 bits more per rate than what is there now. There is also no pressure: the extension is ~704
  bits realistically and ~880 in the theoretical worst case, against 1023.
- **Appending the new fields instead of inserting them.** Chosen first, then reversed. The appeal was
  that no reader breaks; the cost was a getter tuple whose order matched neither storage nor meaning,
  with `round_duration` sitting a dozen fields away from the rate pair it describes, and `deficit`
  still needing a second call. The decision was to take the breakage once, deliberately, and get a
  getter that returns everything the treasury stores in the order it stores it — see below.

### The getter tuple mirrors storage order, and that is a breaking change

`get_treasury_state` returns root fields in `save_data` order, then extension fields in
`pack_extension` order. `round_duration` and `last_settled_round` therefore sit immediately after
`current_rate`, next to the pair they describe, and `deficit` joins the tuple in its own storage
position. The getter now returns everything the treasury stores, so an integrator makes one call and
can check the list against the layout rather than against a changelog.

`get_deficit()` is **removed** in the same release. It existed only because the tuple did not carry
the counter; once it does, a second get method for one field is a thing to keep in sync for no gain.
Its removal is itself a breaking change for the gauge, which called it — but the gauge is already on
the list for the reordering, so it costs nothing extra there.

The tuple goes from 21 values to 24, and the new fields are **inserted**, so every reader that
indexes it by position shifts:

| reader | how it reads | effect |
|---|---|---|
| `DefiLlama-Adapters/projects/hipo/index.js` | `result[0]`, `result[2]` | unaffected, both before the first insert |
| `dimension-adapters/fees/hipo/index.ts` | `stack[11]`, `[12]`, `[16]` | breaks — needs an upstream PR |
| `yield-server/src/adaptors/hipo/index.js` | `stack[11]`, … | breaks — needs an upstream PR |
| website, mcp, sdk, sdk-example, gauge | positional, via wrapper | breaks, ours to deploy |

This was decided with that cost in view, not around it. Old readers fail loudly rather than quietly —
the first inserted field arrives where an address is expected, so they throw instead of reporting
wrong numbers — and the rollout plan is: ship the contract and our own readers together, then open
the two DefiLlama PRs against the shape that is live. `scripts/upgrade_treasury.md` carries the
checklist.

`deficit` also becomes a required field in `TreasuryConfig`. Its `deficit?` optionality existed only
because the getter did not return it; that reason is gone.

## Changes

- `contracts/treasury.fc`
  - Two globals, `round_duration` and `last_settled_round`, packed in the extension as `uint32`
    each, immediately after `current_rate` in `pack_extension`/`unpack_extension`. Inline bits, not
    refs: the extension is already at the 4-ref ceiling (`proposed_governor`, `collection_codes`,
    `bill_codes`, `old_parents`).
  - The settlement branch at `treasury.fc:1500` gains the guarded block shown above.
  - `get_treasury_state` returns the full storage order, gaining `deficit` as well, with a comment
    recording that the insert is a deliberate breaking change and not a free precedent.
  - `get_deficit()` removed. The reasoning it carried — why the counter is absent from
    `calculate_min_coins`, which is a live invariant and not a note about the getter — moves up to
    the `deficit` global, where a reader looks for what the field means.
- `wrappers/Treasury.ts` — `roundDuration`, `lastSettledRound` and `deficit` as required fields on
  `TreasuryConfig`, stored by `treasuryConfigToCell` and read by `getTreasuryState`. All three are
  returned by the getter, so a round-tripped config always carries them and `| undefined` would be a
  case that cannot occur. Costs a mechanical update at the ~16 sites that build a config literal.
  `getTreasuryState` also branches on stack length so it can still read a 21-value pre-upgrade
  treasury, falling back to `get_deficit` for the one field that tuple never had.
- `wrappers/migrationDryRun.ts` — both fields in the `snapshot` field list.
- `wrappers/upgrade-code-test/add_round_duration.fc` — new migrator (below).
- `wrappers/upgrade-code-test/reset_data.fc` and `mint_dead_shares.fc` — these fixtures parse the
  extension by hand and end with `end_parse()`, and both already carry a comment saying their parse
  has to track the current layout. They read the two fields through; neither writes the extension
  back.
- `contracts/imports/constants.fc` — four gas constants raised, and the `migrate_wallet` pin in
  `MaxGas.spec.ts` widened. See below.
- `scripts/showState.ts` — APY from `roundDuration` instead of `getTimes()`; print
  `lastSettledRound`.
- `docs/integration.md` — the two fields in the `get_treasury_state` list; the APY section points
  at `round_duration` as the denominator and explains why it is not the round length.
- `docs/architecture.md` — the extension layout and the settlement paragraph at line 82.

## Invariants

- **Exchange-rate identity untouched.** Neither field is read by any accounting path. `total_coins`
  and `total_tokens` are not involved, and `round_duration` never feeds a fee, a reward split or a
  reserve.
- **Participation state machine unchanged.** No new state, no new transition, no change to *when*
  settlement happens — only two extra assignments inside a branch that already runs there.
- **The rate pair keeps its meaning.** `round_duration` annotates the pair; it does not redefine
  it. A round that does not move the rates does not move the duration either, because it is the
  same `if`.
- **`get_treasury_state` stays total.** It reads no network config and gains no new way to throw.
- **The getter tuple equals the storage layout.** Root fields in `save_data` order, then extension
  fields in `pack_extension` order, with nothing stored left out. That is the property that makes the
  order checkable rather than arbitrary, and `Getters.spec.ts` pins it.
- **No message schema change**, so `contracts/schema.tlb` is untouched.

## Compatibility

Storage layout changes, so this needs a migrator in the same `upgrade_code` — see
`scripts/upgrade_treasury.md`, and `wrappers/upgrade-code-test/add_borrower_fee.fc` as the model for
an extension-field insertion.

`wrappers/upgrade-code-test/add_round_duration.fc` parses the old root and extension by hand,
rewrites the extension with the two new `uint32`s after `current_rate`, and seeds them from the
live network rather than from zero:

```func
;; config param 15: validators_elected_for is the first uint32
int validators_elected_for = config_param(15).begin_parse().preload_uint(32);
;; config param 34: validators_ext#12, then utime_since
slice vset = config_param(34).begin_parse();
throw_unless(101, vset~load_uint(8) == 0x12);
int current_round_since = vset~load_uint(32);
```

`round_duration` is seeded with `validators_elected_for` and `last_settled_round` with
`current_round_since`, so the website shows a sensible APY from the moment the upgrade lands and
the value becomes genuinely measured at the first settlement after it. Seeding zero was rejected:
the website's `duration > 0` fallback would publish a made-up round count for up to ~18h.

`participations` is not touched, so in-flight rounds migrate as opaque refs and the migration does
not need a quiet window the way the borrower-fee one did.

The borrower-fee migration has already run on mainnet, so this one starts from that layout and ships
on its own with nothing to chain ahead of it. It also means `borrower_fee` on chain carries a live
non-zero rate rather than the zero its migrator seeded — a value this migrator has to carry through
while rewriting the extension around it, and one that a `0 -> 0` assertion would not protect.

The migrator follows the three enforced rules — no `COMMIT`, no `SETCODE`, fully inlined to exactly
method ids `0` and `0x6d67` — and ends both parses with `end_parse()`, which is what makes a second
run throw and revert.

**Cross-version read, temporary.** The wrapper's `getDeficit()` outlives the contract method it
calls: the old getter tuple has no deficit field, so reading a treasury still on the old code needs
it. It goes when the branch below does.

`getTreasuryState` reads a 21-value stack as the old shape,
reporting `round_duration` and `last_settled_round` as zero — a value no live treasury can report,
since the migrator seeds both from config — and falling back to `get_deficit()` for the field the old
tuple never carried. This is what lets `migrationDryRun` diff the *old* deployed state during the
rehearsal; without it the dry run degrades to "not readable across this upgrade" for precisely the
upgrade that most warrants one, and `showState` stops working against mainnet while the chain is
still on the old code. Same pattern as the borrower-fee cross-version reads, and removed the same way
once the upgrade has landed (`ad9e3a2`).

Consumers keep working untouched, since the values are appended. The website can then drop
`readTimes` entirely, move `apy`/`roundsPerYear` onto `roundDuration`, and replace the two
vestigial `times != null` guards at `Model.ts:1388,1400` with `treasuryState` guards. mcp, the
gauge and DefiLlama's yield adapter can drop their second call whenever convenient — nothing forces
their hand. None of that is in this repo.

## Test plan

- `tests/Getters.spec.ts` — `get_treasury_state` returns both values at positions 21 and 22, and
  the 21 preceding values are unchanged.
- New cases around settlement:
  - two consecutive settled rounds record `round_duration` equal to one round length;
  - a round with no loans leaves `previous_rate`, `current_rate`, `round_duration` and
    `last_settled_round` all untouched (it never reaches `recover_stake_result`);
  - a skipped round between two settled ones records a two-round gap;
  - an out-of-order settlement (R+1, then R, then R+2) leaves both fields alone on the middle
    settlement and measures R+2 as one round, not two.
- `tests/TreasuryMigration.spec.ts` — the new migrator against the mainnet account snapshot: fields
  preserved, both new fields seeded from config, the result parses under the new layout, the
  governor still matches, and a second run throws. The chain there grows a step —
  captured account -> deficit era -> borrower-fee era -> released — so each migrator keeps being
  tested against the layout it was written for. That needs a capture of the borrower-fee era code,
  added as `tests/fixtures/treasury-borrower-fee-era-code.boc` and built from the released source at
  the commit before this change. `tests/BorrowerFeeMigration.spec.ts` pins that era too, for the
  same reason `deficitEraCode` exists.
- `tests/Getters.spec.ts` — a test that reads the raw get-method stack and pins all 24 fields to
  their positions, so the next move of a field is a deliberate one.
- A pre-upgrade read case: the released wrapper reads a borrower-fee-era treasury — the shape on
  chain today — with every field landing where it belongs, `deficit` coming from the old code's
  `get_deficit`, and the dry run itemising the before side instead of reporting it unreadable.
- A case asserting `get_deficit` is gone from the released code, since a removed get method is a
  breaking change that otherwise shows up only as a blank dashboard.
- A cross-version read case: the released wrapper reads a pre-upgrade treasury and reports both
  fields as zero rather than throwing.
- A live-fee case: set `borrower_fee` to a non-zero rate between the borrower-fee and round-duration
  migrations, and assert it survives along with the fields on either side of it. The captured account
  predates the fee, so without this the only coverage is `0 -> 0`, which an off-by-one offset would
  pass just as happily.
- `tests/MaxGas.spec.ts` / `tests/MinGas.spec.ts` — the settlement path gains a compare and two
  stores and the extension cell gains 64 bits; re-pin if the bounds move.

### What the gas actually did

They moved, by the cost of parsing two more `uint32`s out of the extension, and only for ops that
unpack it: `deposit_coins` 19362 -> 19551, `mint_tokens` 12353 -> 12548, `reserve_tokens`
15521 -> 15605, `burn_tokens` 17400 -> 17545. All four are raised to their measured values.

`gas::migrate_wallet`'s pinned shortfall widens 953 -> 1142, the same +189 as `deposit_coins`. The
pin stays for the reason already recorded in `MaxGas.spec.ts`: that constant is compiled into
`wallet.fc`'s frozen `upgrade_wallet_fee`, so raising it would move the Wallet code hash to fix a
shortfall in wallets that are being replaced anyway. This is the second widening of the same shape
— the borrower fee did 646 -> 953 — and the note now says so.

## Out of scope

- **Removing or deprecating `get_times`.** It stays as-is: it is the only source for the
  participation window and `stake_held_for`, and it is used across the test suite. Unlike
  `get_deficit`, it is not made redundant by anything here.
- **Exposing `deficit` from `get_treasury_state`.** Rejected above; `get_deficit()` remains its
  reader.
- **The APY formula itself.** Only its denominator changes, and only in consumers.
- **Website, mcp, gauge, sdk and DefiLlama adapter changes.** Separate repos, tracked separately —
  but not optional, and not after the fact: the getter shape change breaks the positional readers in
  all of them. `scripts/upgrade_treasury.md` carries the rollout order.
- **`parent.fc` migrations.** Still does not run migrators; nothing here needs one.
