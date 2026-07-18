# Mint dead shares at deployment

## Problem

`total_coins` and `total_tokens` start at 0, which forces zero-guards on every rate
computation (`deposit_coins`, `mint_tokens`, `reserve_tokens`, `burn_tokens`, the loan
reservation math, the `current_rate` update, `gift_coins`, `get_max_burnable_tokens`) and
leaves the root cause of the first-depositor inflation attack open: on a fresh deployment an
attacker can be the first depositor, then inflate the rate arbitrarily via `gift_coins`
so later deposits suffer rounding truncation. `err::deposit_too_small` (spec 2026-07-17)
closed the zero-mint half; this closes the rate-inflation half. Todo at `treasury.fc:2197`.

## Decision

Mint **dead shares** owned by nobody: the treasury starts (and, on mainnet, is migrated to)
a state where `total_coins = total_tokens = 10 GRAM`-equivalent, backed by the 10 GRAM
storage buffer (`fee::treasury_storage`) the treasury must hold forever anyway — no extra
capital is locked. Because no wallet holds the dead tokens, they can never be burned, so
`total_tokens ≥ dead tokens > 0` and `total_coins > 0` hold permanently and every zero-guard
is removed. Inflating the rate becomes strictly unprofitable: a `gift_coins` donation
accrues pro-rata to the dead shares, and with `err::deposit_too_small` in place victims can
no longer be forced into zero-token donations, so the attacker only loses money.

Decisions from the interview:

- **Rollout**: both fresh deployments (initial data) and the deployed mainnet treasury
  (one-off `upgrade_data` migration). Required for removing the zero-guards from shared
  code: without it, a theoretical full unstake returns mainnet to `0/0` and the next
  deposit hits a division by zero.
- **Size/funding**: 10 GRAM, aliased with the storage buffer. `calculate_min_coins` drops
  its separate `fee::treasury_storage` term (the dead component of `total_coins`, which
  starts at exactly 10 GRAM and only grows, replaces it); the `available_ton` formulas in
  `reserve_tokens`, `burn_tokens`, `participate_in_election`, and `get_max_burnable_tokens`
  keep subtracting `fee::treasury_storage`, which is exactly what keeps the dead backing
  unlendable and unpayable. Rejected: funding 1–10 GRAM on top of the buffer — extra locked
  capital for no additional safety (even ~0.001 GRAM of dead shares makes the attack
  economically absurd).
- **Jetton supply**: dead shares live only in treasury accounting. The parent's
  `total_tokens` (TEP-74 `get_jetton_data` supply) keeps counting wallet-held tokens only
  and now differs from the treasury's `total_tokens` by the dead amount, documented in
  `Integration.md`. Rejected: counting them in the parent — supply would exceed the sum of
  wallet balances and mainnet would need a parent migration too.
- **Migration mints at the current rate** (`dead_tokens = muldiv(10 GRAM, total_tokens,
  total_coins)`, then `total_coins += 10 GRAM; total_tokens += dead_tokens`), so existing
  holders are not diluted (muldiv rounds down, infinitesimally in holders' favor). The
  already-present 10 GRAM buffer becomes the backing; the treasury balance does not change.
- **The "last staker sweeps all coins" special case** (`tokens == total_tokens` in
  `reserve_tokens` / `burn_tokens`) becomes unreachable — dead tokens are never burned — and
  is removed. Consequence: the final unstaker gets `muldiv` rounding like everyone else and
  dust (a few nanoGRAM) accrues to the pool instead of being swept to them.
- **Dead shares earn rewards** pro-rata (`dead_tokens / total_tokens` of the pool's reward
  share — ~0.001% at mainnet scale). Accepted: it compounds the permanently locked buffer,
  and any alternative (excluding them from the rate) would reintroduce special cases.

## Changes

- `contracts/treasury.fc`:
  - `deposit_coins`, `mint_tokens`: unconditional `tokens = muldiv(coins, total_tokens,
    total_coins)` (drop the `if total_coins` bootstrap branch).
  - `reserve_tokens`, `burn_tokens`: unconditional `coins = muldiv(tokens, total_coins,
    total_tokens)` (drop the last-staker sweep and the `elseif total_tokens` guard).
  - `participate_in_election`: unconditional `reserved_amount = muldiv(total_unstaking,
    total_coins, total_tokens)`.
  - Round finish: unconditional `current_rate = muldiv(total_coins, 1000000000,
    total_tokens)`.
  - `gift_coins`: remove the `if total_tokens` guard; always add to `total_coins`.
  - `get_max_burnable_tokens`: unconditional muldiv.
  - `calculate_min_coins`: return `total_borrowers_stake + total_staking + total_coins`
    (drop `fee::treasury_storage`, now covered by the dead component of `total_coins`).
  - Remove the dead-shares todo line.
- `contracts/imports/constants.fc`: bump `gas::deposit_coins` 19035 → 19123 (measured
  worst case moved up 88 gas — the larger stored totals cross a coins-serialization
  boundary). Other measured ops moved slightly down (`mint_tokens` −121, `reserve_tokens`
  −344, `burn_tokens` −95, `send_unstake_all`/`migrate_wallet` −18); their pins keep the
  headroom, consistent with the pre-existing stale-high pins for wallet ops on main.
- `wrappers/upgrade-code-test/mint_dead_shares.fc` (+ compile config): test-only upgrade
  target implementing the one-off migration, used by `tests/DeadShares.spec.ts`.
- `scripts/createTreasury.ts`: initial `totalCoins = totalTokens = toNano('10')`; top up
  the treasury with 10 GRAM as part of the deploy flow (until then `get_surplus` is
  negative and the backing is a claim, not a balance — no user-facing path is exposed
  because no real tokens exist yet, but the top-up should be immediate, not a reminder).
- `scripts/upgrade_treasury.md`: add a "Mint dead shares" migration recipe using the
  standard one-off `upgrade_data` template with the at-current-rate mint above.
- `Integration.md`: document that the treasury's `total_tokens` includes 10 GRAM of
  unowned dead shares and permanently exceeds the jetton supply reported by the parent.
- `docs/architecture.md`: update the exchange-rate section (dead shares, removal of the
  last-staker sweep, buffer aliasing).
- No change to `parent.fc`, `wallet.fc`, `loan.fc`, `collection.fc`, `bill.fc`, or any
  message schema (`schema.tlb` untouched — data layout is unchanged, only values).

## Invariants

- **Non-zero totals, forever**: burn requests reach `reserve_tokens`/`burn_tokens` only via
  the parent from wallet-held balances (plus in-flight unstakes), which sum to
  `total_tokens − dead_tokens`. So at most `total_tokens − dead_tokens` can ever be burned,
  and both totals stay positive — the removed zero-guards are unreachable, not merely
  unlikely.
- **Exchange-rate identity**: unchanged formulas; the rate still starts at 1.0 on fresh
  deployments (`previous_rate`/`current_rate` initial 1e9 stay consistent).
- **Storage buffer safety**: `available_ton` everywhere still subtracts
  `fee::treasury_storage`, so loans and unstakes can never consume the dead backing;
  `withdraw_surplus` reserves `total_coins`, which contains the dead component (≥ 10 GRAM),
  so the governor cannot withdraw it either — no double-count, no under-reserve.
- **No dilution**: migration mints at the current rate; fresh deployments start at 1:1
  before any holder exists.
- **Deposit fairness, participation state machine, bill accounting**: untouched.
- `err::deposit_too_small` still applies and is still needed (rounding truncation at
  rate > 1 is unaffected by dead shares).

## Compatibility

- Stored data layout unchanged in every contract; mainnet needs only the one-off
  `upgrade_data` value migration (standard procedure from `scripts/upgrade_treasury.md`,
  reset the template afterwards).
- Message schemas unchanged. Integrator-visible deltas: treasury `total_tokens` ≠ parent
  jetton supply (by the dead amount), and the last unstaker no longer receives the rounding
  dust. Documented in `Integration.md`.
- Rollout: treasury-only code change; batch the mainnet upgrade with the other treasury
  todos (`deposit_too_small` is already in code awaiting upgrade; mint op-code change).
  Migration ordering: safe with in-flight participations — it only shifts
  `total_coins`/`total_tokens` by matched amounts at the current rate.

## Test plan

- Update fixtures in all specs (`Wallet`, `Loan`, `Governance`, `Access`, `Getters`,
  `Large`, `MaxGas`, `MinGas`): initial `totalCoins`/`totalTokens` = `toNano('10')`. The
  existing 10 GRAM top-up in the fixtures becomes the dead-share backing.
- **Recompute, don't bump**: reward-split and totals assertions change materially because
  test pools are small (10 GRAM dead vs. ~10 GRAM staked means dead shares absorb ~half of
  test rewards). Each changed expectation must be re-derived from the new math.
- New cases:
  - Fresh treasury: first deposit mints 1:1; totals grow from the 10 GRAM baseline.
  - `gift_coins` with only dead shares present: accepted, rate rises, a later deposit mints
    at the new rate; a dust deposit still bounces with `err::deposit_too_small`.
  - Inflation-attack scenario: attacker gifts a large amount pre-victim; victim's deposit
    mints tokens worth their deposit minus bounded rounding (< 1 token nano-unit); attacker
    strictly loses the gift's dead-share fraction.
  - Unstake-all: every holder burns everything; totals return to the dead-share baseline
    (plus accrued rewards/dust), and a subsequent deposit succeeds — no division by zero.
  - Surplus: `get_surplus` ≈ 0 after deploy + 10 GRAM top-up; `withdraw_surplus` cannot
    touch the dead backing.
  - Migration: build a treasury with old-style state (rate > 1), run the `upgrade_data`
    body, assert the rate is unchanged and totals shifted by exactly 10 GRAM /
    `muldiv(10 GRAM, total_tokens, total_coins)`.
- `MaxGas.spec.ts` / `MinGas.spec.ts`: re-run; removed branches may shift gas slightly —
  adjust bounds and fee constants deliberately. (Outcome: only `gas::deposit_coins` needed
  a bump, 19035 → 19123; verified as a fixed point by re-running MaxGas with the new
  constant. New cases live in `tests/DeadShares.spec.ts`, including an end-to-end migration
  test through two real `upgrade_code` messages.)

## Out of scope

- The mint op-code todo and the remove-library todo (`treasury.fc:2196,2198`) — only share
  the eventual upgrade batch.
- Any parent/wallet change (jetton supply intentionally excludes dead shares).
- A minimum-deposit amount or other deposit-semantics changes.
