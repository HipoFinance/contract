# Take the Borrower's Max Factor From the Network, Not From a Copied Number

> Implemented in `HipoFinance/borrower`, not in this repo, as `borrower@1884f20`. The spec lives
> here because the behaviour it changes is how borrowers bid into the treasury, and because the
> incident that prompted it is a protocol-level one.

## Problem

`borrower.yaml` ships `max_factor_ratio: 3.0`, and `loadBorrowConfig` turns it into the
`max_factor` field of `new_stake`. The network's `max_stake_factor` (config param 17) was raised
from 3.0 to 4.5 some months ago. Nothing in the borrower reads that parameter, so every borrower
has been bidding a cap a third below what the network allows, and no operator had a reason to
notice.

The elector caps a winner's effective stake at `max_factor * (smallest stake in the elected set) /
65536` and credits the remainder back immediately, where it earns nothing until recovery. Measured
on round `1788759816`:

| | Hipo loan `Ef_WCNvY…` | a Tonstakers validator |
|---|---|---|
| submitted | 3,516,776.0956 GRAM | 2,841,027.6097 GRAM |
| declared `max_factor` | 196608 (3.0) | 294912 (4.5) |
| effective stake | 2,215,497.0000 GRAM | 2,841,027.6097 (uncapped) |
| credited back, idle | **1,301,279.0956 GRAM** | 0 |

`compute_returned_stake` on the elector returns the 1,301,279.0956 directly. The cap divided by 3
gives 738,499 GRAM as the 400th-place stake that round; at 4.5 the cap would have been 3,323,245
and only ~193,531 GRAM would have sat idle. So the same capital would have carried **50% more
validating weight**, and the pool's reward for the round scales with exactly that.

The round made the gap unusually visible — a bug in the borrower's treasury-state reads meant one
borrower absorbed what three normally share (see `2026-09-06-round-duration.md` and the
`borrower@37f2e4e` fix) — but the shortfall is present in every round, proportional to how far any
single loan runs past `3 x` the marginal elected stake.

The number was never the bug. A configuration value that mirrors a network parameter, with nothing
reading the network, is a stale value waiting to happen; this one waited months.

## Decision

Read `max_stake_factor` from config param 17 and make it the default.

- **`max_factor_ratio: 0` means "use the network maximum."** This is the idiom the same file
  already uses for `loan`, whose comment reads _"When zero, network config of min_stake will be
  used."_ One convention, already documented one screen further up.
- **A non-zero value stays an operator override**, and is used as written when it is below the
  network maximum. A warning is logged every cycle; the bid still goes out.
- **A value above the network maximum is clamped down to it**, with a line saying so.
- The shipped `borrower.yaml` changes to `0`.

### Why the key survives at all

The first proposal was to delete `max_factor_ratio` and always bid the network maximum, on the
grounds that no borrower would ever want less. That is true of capital efficiency and false of
everything else, because of how loans are sized.

`distribute` gives an accepted borrower their requested `loan_amount` **plus a pro-rata slice of
whatever is left in the round** — `treasury.fc:953`, `accrue_amount = muldiv(available,
loan_amount, allocated)`. `borrower.yaml`'s `loan` is a *minimum*, and there is no maximum
anywhere in the `Borrow` struct. A borrower who asks for 300,000 can be handed 3.5M, which is
precisely what happened above.

Effective stake drives shard assignment and validation workload, not only reward. So
`max_factor_ratio` is the only sentence in the config with which an operator can say "do not give
my node more duty than it can serve", and deleting it would leave them nothing.

It is also the *correct* sentence for saying it. What an operator needs to bound is their share of
block production, and that share is proportional to weight, which is relative to the rest of the
elected set. A factor expresses exactly that: a cap of 3 means at most three times the smallest
elected validator's weight, and it lowers the share of block production proportionally. So the
knob bounds the thing the hardware actually feels, and it keeps bounding it as the network moves.

The second reason is directional. Auto-reading the network value means a future increase to
`max_stake_factor` silently raises every borrower's weight and slashing exposure with no release
and no operator action. Today's failure mode was leaving money on the table; that one is taking on
more duty than the hardware was sized for. Keeping an override, and warning rather than silently
overriding a deliberate choice, keeps the loud direction loud.

### Rejected alternatives

- **Absent-means-network-max, with a pointer field.** Would work, and there is precedent for
  pointer fields in `Borrow` (`LegacyValidatorRewardShare`). Rejected because it introduces a
  second "unset" idiom into a file that already resolves this exact question with `0`, and because
  a key that vanishes from the file is harder to discover than one set to zero.
- **Refusing to start on a below-maximum value,** the way the borrower refuses to start on the
  legacy `validator_reward_share` key. That refusal is warranted because reading the old number on
  the new scale produces a *wrong bid* — it hands away almost the operator's whole share. A low
  `max_factor_ratio` produces a correct bid that earns less. Taking validators offline over lost
  yield is out of proportion, and a node that will not start earns nothing at all.
- **Warning only once at startup.** The service runs for months between restarts. A boot-time line
  is exactly the kind of message this failure already survived.
- **Reporting the idle GRAM in the warning,** by calling `compute_returned_stake` on the previous
  round's loan. It is the more persuasive number, but it costs a get method every cycle to report
  something the operator can act on from the ratio alone, and the previous round's loan address has
  to be derived to ask.
- **An absolute `max_loan` ceiling in place of the factor.** Reached for first while writing this,
  and wrong. It bounds GRAM, not duty: the same 1M GRAM is a different share of block production
  every round as the total elected stake moves, so a ceiling set once drifts against the thing it
  was meant to hold. The factor's relativity, which reads at first like unpredictability — it moves
  with the 400th validator's stake, which nobody can forecast — is the property that makes it the
  right instrument, because the quantity being bounded is itself a ratio.
- **Sending an over-range value and letting the elector decide.** Whether the elector clamps an
  over-range `max_factor` or rejects the `new_stake` outright was not verified. Clamping in the
  client makes the question moot; a rejected stake would cost a whole round.

## Changes

All in `HipoFinance/borrower`.

- `borrower/config.go` — `GetMaxStakeFactor(c *cell.Cell) uint32`, a sibling of the existing
  `GetMinStake`, reading the fourth field of config 17. `GetMinStake`'s comment already carries the
  full TL-B line, so the layout is not being newly derived.
- `borrower/process.go`
  - `loadBlockchainConfig` returns `maxStakeFactor` alongside `minStake`; both come from the
    `ConfigStake` cell it already fetches, so there is no extra network read.
  - `loadBorrowConfig` takes it as a parameter and resolves the final `max_factor`: `0` yields the
    network value, a non-zero value is clamped to it, and anything in `(0, 1)` still panics as
    today.
  - The comparison and the clamp happen in the `65536` integer domain, not on the `float32`, so a
    ratio that is not exactly representable cannot make the clamp misfire.
  - The resolved value is returned as it is now, so it continues to reach **both** the signed
    `confirmation` cell and `new_stake_msg` from one variable. These two must agree, and the
    resolution has to sit upstream of the signature for that to hold.
- `borrower.yaml` — `max_factor_ratio: 0`, with the comment rewritten to say what zero means and
  to describe the factor as relative to the smallest stake among the *elected* validators. The
  current wording, "the minimum stake accepted by the elector", reads as config 17's `min_stake`,
  which is not what the elector computes against.
- `README.md` — the `max_factor_ratio` row, if it documents the default.

## Invariants

- **No contract changes**, so nothing in `docs/architecture.md` moves. No treasury, parent or
  wallet upgrade, no governance action, no migration.
- **The `request_loan` wire format is untouched.** `max_factor` travels inside `new_stake_msg`,
  which the treasury only validates structurally — `check_new_stake_msg` (`utils.fc:331`) skips
  `256 + 32 + 32 + 256` bits and checks the 512-bit signature ref. The treasury neither reads nor
  constrains the value, before or after this change.
- **Collateral requirements are unaffected.** `max_punishment` is computed on `loan_amount +
  stake_amount` (`treasury.fc:709`, and again at `treasury.fc:955` for the accrued amount) — the
  submitted total, not the effective stake. A borrower is therefore already collateralised for
  exposure on the full amount, and raising the factor moves real exposure *toward* what collateral
  already assumes rather than past it.
- **The exchange rate, the participation state machine and the reward split are not involved.**
  This changes how much of an already-committed stake the elector counts, which lands in the
  round's reward and flows through the existing split untouched.
- **The signed confirmation and `new_stake_msg` carry the same `max_factor`.** The elector checks
  the signature over the confirmation; a mismatch is a rejected stake and a missed round.

## Compatibility

- An existing `borrower.yaml` with `max_factor_ratio: 3.0` keeps working unchanged and starts
  warning. Nothing is forced.
- `0` was previously a startup panic (`must be >= 1.0`), so no deployed config can be carrying it
  with a different meaning. The new meaning cannot collide with an old one.
- Rollout is a per-operator binary update with no ordering constraint against running rounds: the
  value is read fresh each cycle and only affects requests made after the update. Loans already
  committed carry the `max_factor` they were signed with.
- Operators who want the effect before the release can set `max_factor_ratio: 4.5` by hand today;
  the release makes that unnecessary rather than obsolete.

## Test plan

`borrower/config_test.go` is the home for the resolution logic; it should not need a network.

- `GetMaxStakeFactor` parses a config-17 cell and returns `294912`, exercised on the same fixture
  shape `GetMinStake` uses.
- Resolution, given a network maximum of `294912`:
  - `0` resolves to `294912`.
  - `3.0` resolves to `196608` and reports "below maximum".
  - `4.5` resolves to `294912` and reports nothing.
  - `6.0` resolves to `294912` and reports "clamped".
  - `0.5` still panics.
- The below-maximum case is a warning and not a refusal: resolution returns a usable factor rather
  than an error, so a bid is still built.
- A ratio that is not exactly representable as `float32` — `1.1` — resolves without the clamp
  firing against a network maximum above it, which is what the integer-domain comparison exists
  for.
- The value that reaches the signed `confirmation` equals the value stored in `new_stake_msg`, for
  a clamped configuration. This is the assertion that fails if resolution is ever moved downstream
  of the signature.

## Out of scope

- **Making `distribute` max-factor-aware,** so the treasury stops lending a borrower more than
  their declared factor can put to work and stranding the difference at the elector. Even with
  every borrower at the network maximum this round would have left ~193,531 GRAM idle, so the
  effect does not disappear once configs are fixed — it only shrinks. It needs the elected set's
  minimum stake, which is not knowable at distribution time, so it would have to work from an
  estimate. Worth its own spec.
- Changing the network's `max_stake_factor`, or anything about how the elector computes effective
  stake.
- The other operator's node, which is on the same stale `3.0` and is reached by the release rather
  than by us.
