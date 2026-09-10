# Changelog

What changed in the Hipo contracts, newest first. The spine is **mainnet releases**, because for a
contract that is what actually changes anything: code that has not been deployed has changed nothing
for a staker, a borrower or an integrator.

Each release names the deployed treasury code hash, so you can check what an address is running with
`scripts/showCodeHashes.ts` and compare. Two other files carry the depth this one deliberately does
not repeat:

- [`docs/specs/`](docs/specs) — why a change was made, and which alternatives were rejected.
- [`scripts/upgrade_treasury.md`](scripts/upgrade_treasury.md) — how each upgrade was deployed, its
  migrator, and what was checked before and after.

This file starts at **2026-07-16**. Earlier history is in the git log.

---

## 2026-09-09 — Burner repointed

**Treasury code** `22d7118ecc29fdab794f99a4111b503e20d995ceec725eca6d6da5808b05acc8`

`burner::addr` now names `EQDcjZDWvotoVE0X4HSdt2pR3b2sBZ4XikzSVSdPiqdQMLRK`. The first burner had
no `set_code`, so the gas fix and upgrade hatch it needed could not be delivered to it — it had to
be redeployed, and the address moved with it. The replacement is upgradable in place.

Code-only: `burner::addr` is compile-time, so storage was untouched and the getter still returns 26
values. Reverting only that constant reproduces the previous release's hash byte-for-byte.

**Integrators:** nothing to do. Anything keyed on the *burner* address rather than the treasury
needs the new one.

## 2026-09-07 — Two-round rate window

**Treasury code** `430d16608514e5b924e6abc8621820dc4b5328baab456a71fc114e2e6d978dd6`
· Spec [`2026-09-07-two-round-rate-window.md`](docs/specs/2026-09-07-two-round-rate-window.md)

- The rate window is measured in `burn_ready_participations`, once per barrier release, instead of
  at settlement. Settlement is not ordered, so the old placement paired a delta from one event with
  an interval from another; at the barrier the pairing is exact.
- The window spans **two** releases rather than one, which cancels the round-to-round oscillation
  `rounds_imbalance` produces. `round_duration` was renamed `window_duration` — same position, same
  width, about twice the value (131072).
- `mid_rate` and `mid_round` were **appended**, taking the getter from 24 values to 26.

**Integrators:** positions 0–23 are unchanged and keep their meaning, so anything that annualises by
dividing the year by the published span keeps working and simply stops seeing a sawtooth. Divide by
`window_duration`, never by a round length — that roughly *squares* the APY. `@hipo-finance/sdk`
exposes `computeApy`.

Appending was chosen as the safe option and still broke one reader: `gauge` asserted the tuple's
exact *length* rather than indexing into it. Worth knowing before assuming an append is free.

## 2026-09-06 — Round duration published

**Treasury code** `572a7f2fa7b767fd4d1913d1b4136be3b034b9edd628be027370859a84edd065`
· Spec [`2026-09-06-round-duration.md`](docs/specs/2026-09-06-round-duration.md)

Published the interval the rate pair grew over, so consumers could annualise without guessing a
round length. Getter went to 24 values.

Partly superseded the following day by the two-round window, which kept the field and its position
and changed what it spans.

## 2026-09-05 — Borrower fee and the HPO burn

**Treasury code** `200e562398228a563957dbac54f6c8fc869b5b93f247d4f6e5b32059b4bd626e`
· Spec [`2026-08-31-borrower-fee-hpo-burn.md`](docs/specs/2026-08-31-borrower-fee-hpo-burn.md)

A governance-settable share of the borrower's **contracted** reward is taken at loan recovery and
sent, in GRAM, to a burner contract that stakes it, buys HPO on DeDust and burns it. It is charged
from the borrower's side, never carved out of the pool's take, so the exchange rate is untouched.

Three stored layouts changed together, converted by one migrator:

- the extension gained `borrower_fee` (`uint16`)
- every request gained a 16-bit `borrower_reward_share` and a 16-bit `request_fee`
- each participation's `sorted` dict was rekeyed from 112 to 120 bits

**Integrators:** this is a **breaking change to `op::request_loan`** — `borrower_reward_share` is now
a `uint16` out of 65535. Borrowers must be rolled with the treasury; port an existing bid by
multiplying by 257.

## 2026-08-25 — Deficit field

**Treasury code** `48d47fa20efa18bd99c5d49228d132e07023b345b8c56a5746f106e5a6cadfe0`
· Deployed 08:37:57 UTC

Records what a defaulting borrower's collateral could not cover, so pool losses are visible and the
governor can clear the counter deliberately rather than the shortfall being silent.

**Integrators:** this one **broke readers**. `deficit` was *inserted* at index 5, the slot `parent`
had occupied, so anything reading position 5 as an address started throwing. `vesting`, `club`,
`dune` and `burner` were all broken by it and were not noticed until a census on 2026-09-07. It is
the reason later releases append rather than insert, and the reason
[`scripts/upgrade_treasury.md`](scripts/upgrade_treasury.md) now carries a list of every known
reader of `get_treasury_state`.

## 2026-07-16 – 2026-08-24 — Earlier changes in this period

These reached mainnet, but this repository does not record the dates, so they are grouped:

- **Dead shares.** The treasury holds unowned shares backed by the 10 GRAM storage buffer, which
  keeps both totals permanently positive: no zero-guards, no "last staker" case, and the
  first-depositor inflation attack strictly loses money. Verifiable on chain — the treasury's
  `total_tokens` exceeds the parent's jetton supply by the dead amount.
  Spec [`2026-07-18-mint-dead-shares.md`](docs/specs/2026-07-18-mint-dead-shares.md).
- **Zero-token deposits rejected**, so a deposit too small to mint anything fails instead of
  donating itself. Spec
  [`2026-07-17-reject-zero-token-deposits.md`](docs/specs/2026-07-17-reject-zero-token-deposits.md).
- **Postponed-unstake bill fix** — it used the wrong round's collection and bill code.
- **GRAM / hGRAM rebrand** completed across the contracts, tests and docs.

Also in this window, a run of recovery-path corrections: reward ordering enforced before a round's
deposit bills burn; a round that made no loans kept until its bills burn; an unstake that can
neither be paid nor postponed rolled back; a retried bill minted on the parent it was validated
against; `current_vset_hash` read instead of `total_recovered` before messaging a loan; unattributable
coins kept rather than dropped; a stale `distribute` self-message refused; the borrower repaid when
a round settles at a loss; and governance able to re-run the settled-round scan.

---

## Not on chain

Changes to how the contracts are built, tested, deployed and documented. No effect on a deployed
contract, but they are why the releases above could be made.

### Upgrades

- **Migrations travel in the upgrade message.** A storage migration is a `migrate_code` cell the
  treasury blesses and executes once, before its own `load_data()` and governor check. One signed
  transaction, nothing one-off stored on chain, and the released code hash stays the hash of the
  plain contract. It replaced a two-deploy paste-and-reset procedure.
- **The upgrade script dry-runs against the live account.** It fetches the treasury's real code and
  storage, replays the whole upgrade in a sandbox, and prints a field-level diff before asking for
  anything — so an operator approves observed behaviour on real state rather than a description of
  intent. It also prints the migrator's full source and demands its hash typed back.
- Dangerous parts of the upgrade output are coloured to look dangerous.

### Tests

- **Gas constants are checked against what the operations actually cost**, so a declared bound
  cannot drift from reality unnoticed.
- **The wallet code deployed on mainnet is tested**, not just the current source — including the
  upgrade, `unstake_all` and rollback chains.
- **Migrations are rehearsed against the captured live treasury account**, chained through every
  previous migrator so each keeps being tested against the layout it was written for.
- **Type-checking runs before the tests.** `npm test` runs `pretest`; `npx jest` and
  `npx blueprint test` skip npm scripts, so a type error could reach a deploy script past both.

### Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the contracts fit together and the invariants
  a change must preserve, including the cash cycle and why `available_ton` leaves `total_staking`
  alone.
- [`docs/specs/`](docs/specs) — one spec per feature or behaviour change, written before the code.
- [`scripts/upgrade_treasury.md`](scripts/upgrade_treasury.md) — the upgrade runbook and the record
  of every upgrade run, plus the census of everything that reads `get_treasury_state`.
- `docs/integration.md` moved under `docs/`, and the README was overhauled.

### Tooling

- ESLint moved to flat config for ESLint 10, and vulnerable transitive dev dependencies were cleared
  (twice — 2026-07-24 and 2026-09-09).
- Project subagents and an orchestrate workflow under `.claude/`.
