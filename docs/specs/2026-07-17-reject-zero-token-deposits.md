# Reject zero-token deposits

## Problem

`deposit_coins` accepts any amount ≥ 1 nanoGRAM. Because the hGRAM exchange rate is above
1.0, a dust deposit can round down to zero tokens in
`tokens = muldiv(coins, total_tokens, total_coins)`. Today such a deposit is still added to
`total_coins` (instant path) or `total_staking` (deferred path, resolved in `mint_tokens`
at round end): the depositor receives nothing, the coins become a silent donation to the
pool, and a useless 0-token wallet is deployed.

Besides losing user funds, this is the value-capture half of the classic first-depositor
inflation attack: an attacker who inflates the rate via `gift_coins` (see the dead-shares
todo) profits exactly because victims' deposits round to 0 tokens and become donations.
Not exploitable on the current mainnet state (`total_tokens` is large), but a real hazard
for any fresh deployment and cheap to close.

## Decision

Reject a deposit in `deposit_coins` when it would mint zero tokens **at the current rate**,
by throwing a new dedicated error code. The transaction aborts before any state change, the
message bounces, and the depositor gets their coins back minus gas.

- The check must live in `deposit_coins`, not `mint_tokens`: at bill-burn time the bill is
  already destroyed and `collection.fc` ignores bounces, so a throw in `mint_tokens` would
  leave `total_staking` permanently inflated and the coins stuck untracked.
- Residual edge accepted: for a deferred deposit the rate keeps growing until the bill
  burns, so a deposit within the round's rate growth (~1–2 nanoGRAM) of the threshold can
  still mint 0 tokens at burn time. That case keeps today's behavior (dust donated to the
  pool, and the zero-amount `tokens_minted` still sent). With the guard in place it
  requires a deposit of exactly N nanoGRAM during the round in which the rate crosses the
  integer N — loss bounded to a few nanoGRAM. Rejected alternatives:
  - Clamping `tokens = max(1, tokens)` in `mint_tokens`: needless dilution edge, more code
    on a delicate path.
  - A fixed minimum deposit amount: changes public deposit semantics for integrators; can
    be revisited later.
  - Skipping the `proxy_tokens_minted` send when tokens == 0 (no bounce): the wallet needs
    that message even with a zero amount — it deletes the round's `staking` dict entry
    (deployed and populated at deposit time via `proxy_save_coins`) and returns the gas
    excess and notification to the owner. Skipping it would strand a phantom
    staking-in-progress entry in the wallet forever (an entry shared by same-round
    deposits), fixable only by changing `wallet.fc`, which would force the wallet upgrade
    this change otherwise avoids.

## Changes

- `contracts/imports/constants.fc`: add `const int err::deposit_too_small = 110;`, and
  bump `gas::deposit_coins` from 18741 to 19035 (the measured worst case from
  `MaxGas.spec.ts` with the new guard; +294 gas), which slightly raises the dynamic
  deposit fee.
- `wrappers/common.ts`: add `depositTooSmall: 110` to `err`.
- `contracts/treasury.fc`: in `deposit_coins`, alongside the existing throws (after
  `enough_fee?` is computed, before `raw_reserve`), compute prospective
  `tokens = total_coins ? muldiv(coins, total_tokens, total_coins) : coins` and
  `throw_unless(err::deposit_too_small, tokens > 0)`. Applies to both instant and deferred
  paths. Remove the `;; todo: reject zero token creation` line.
- `Integration.md`: document the new error code for `deposit_coins`.
- `graphs/02.*`: update only if the deposit graph enumerates failure modes.

No change to `wallet.fc`, `parent.fc`, or any other contract — a zero-token
`tokens_minted` simply never gets sent. No wallet upgrade or user migration is needed, and
there is no dependency on the mint op-code todo.

## Invariants

- Exchange-rate identity: unchanged — the guard only prevents the case where `total_coins`
  grows with `total_tokens` unchanged (an implicit donation), which strengthens the
  intent that donations happen only via `gift_coins`.
- Deposit fairness (mint after the latest committed round): unchanged; round selection
  logic is untouched.
- Participation state machine and bill accounting: untouched; the throw happens before
  `raw_reserve` and before any message is sent, so a rejected deposit has no side effects.
- `total_coins == 0` bootstrap case: prospective tokens = coins ≥ 1, so first deposits
  always pass.

## Compatibility

- No stored-data layout change in any contract; no migration needed.
- Message schemas unchanged; only a new documented rejection (exit code 110) on
  `deposit_coins`. `schema.tlb` unaffected.
- Rollout: treasury-only code change. Ship in one `upgrade_code` batched with the other
  treasury-side todos (dead-shares/starting-ratio fix, mint op-code change on the treasury
  side) rather than a standalone upgrade ceremony.

## Test plan

In `tests/Wallet.spec.ts` (or a small dedicated describe block):

- Dust deposit (1 nanoGRAM) with rate > 1, instant mint on: transaction fails with exit
  code 110, no wallet deployed, `total_coins`/`total_tokens` unchanged, coins bounced back.
- Same with instant mint off (deferred path): rejected, `total_staking` unchanged, no bill
  minted.
- Deposit exactly at the threshold (smallest `coins` with `muldiv(...) ≥ 1`): succeeds and
  mints ≥ 1 token.
- Bootstrap: first deposit into an empty treasury still works.
- `MaxGas.spec.ts` / `MinGas.spec.ts`: re-run; the added muldiv slightly changes deposit
  gas — adjust bounds deliberately if they move. (Outcome: worst-case `deposit_coins`
  compute gas moved 18741 → 19035; `gas::deposit_coins` updated accordingly, all other
  measured ops unchanged or below their pins.)

## Out of scope

- Clamping or throwing in `mint_tokens` (see Decision).
- The inflation-attack root fix (dead shares / starting ratio) — separate todo.
- Zero-amount jetton transfers between wallets (`send_tokens` with amount 0 is
  TEP-74-legal) and zero-token unstakes (already rejected by `wallet.fc` with
  `insufficient_funds`).
- The mint op-code change todo (no dependency; only shares the eventual upgrade batch).
