# Hipo Architecture

This document explains how the Hipo contracts work together and which invariants any change
must preserve. It complements the message-flow diagrams in `graphs/` (one per flow, start
with `00-legend.dot`) and the TL-B schemas in `contracts/schema.tlb` and `Integration.md`.

Terminology: GRAM is the network coin (rebranded from TON), hGRAM is Hipo's jetton
(rebranded from hTON). Older comments and docs may still use the TON/hTON names.

## The big picture

Stakers deposit GRAM into the **treasury** and receive **hGRAM** jettons. The treasury lends
the pooled GRAM to **borrowers** (validator node operators) each validation round through
per-round **loan** contracts on the masterchain. Borrowers stake the loans in the Elector,
earn validation rewards, and the rewards are split between the borrower, the protocol
(governance fee), and the pool. Stakers' rewards are not paid out directly: they accrue in
the exchange rate, because rewards increase `total_coins` while `total_tokens` stays fixed.

The exchange rate is the core accounting identity:

- Minting a deposit: `tokens = coins * total_tokens / total_coins`
- Burning on unstake: `coins = tokens * total_coins / total_tokens`

Coins in flight are tracked separately (`total_staking` for pending deposits,
`total_unstaking` for pending withdrawals) and only enter `total_coins`/`total_tokens` at
the moment tokens are actually minted or burned.

**Dead shares** keep both totals permanently positive: the treasury starts with
`total_coins = total_tokens = 10 GRAM` of shares owned by no wallet (on mainnet they were
minted at the current rate by the dead-shares migration — see
`scripts/upgrade_treasury.md`). Because burns can only originate from wallet-held tokens,
the dead shares can never be burned, so no rate computation needs a zero-guard and there is
no "last staker" special case — rounding dust on the final unstake stays in the pool. The
backing 10 GRAM is aliased with the storage buffer (`fee::treasury_storage`): the
`available_ton` formulas subtract the buffer, which keeps the dead backing unlendable and
unpayable, while `calculate_min_coins` counts it through `total_coins` (not separately), so
the governor cannot withdraw it as surplus. Dead shares also close the first-depositor
inflation attack: donating via `gift_coins` accrues pro-rata to the dead shares, so
inflating the rate strictly loses money (see `docs/specs/2026-07-18-mint-dead-shares.md`).
The parent's jetton supply counts only wallet-held tokens and therefore stays below the
treasury's `total_tokens` by the dead amount.

## Contracts

| Contract | Chain | Instances | Role |
| --- | --- | --- | --- |
| `treasury.fc` | basechain | 1 | Pool accounting, loan lifecycle, round participation, governance |
| `parent.fc` | basechain | 1 (upgradable via `old_parents`) | Jetton master; proxies all wallet ↔ treasury traffic |
| `wallet.fc` | basechain | 1 per user | TEP-74-style jetton wallet with extra fields for staking/unstaking in progress |
| `loan.fc` | masterchain | 1 per borrower per round | Holds a loan; can only send stakes to the Elector, so borrowers cannot withdraw loans |
| `collection.fc` | basechain | 1 per round | NFT collection of that round's bills; fans out `burn_all` at round end |
| `bill.fc` | basechain | 1 per deferred operation | SBT (non-transferable NFT) recording a pending deposit or unstake: amount, owner, and direction |
| `librarian.fc` | masterchain | 1 | Deploys and pays storage for shared library cells used by wallet/loan/bill code |

Code cells for loan, collection, and bill are versioned per round in the treasury
(`loan_codes`, `collection_codes`, `bill_codes` dictionaries keyed by `round_since`), so old
rounds keep resolving their historical addresses after a code upgrade.

## Validation rounds and the participation state machine

TON validation rounds are consecutive, but their lifecycles overlap: while round *N* is
validating, the election for round *N+1* runs, and round *N*'s stakes stay frozen in the
Elector for `stake_held_for` after round *N* ends. The treasury therefore keeps up to three
`participations` at once, keyed by `round_since` (the unix time the round's validator set
takes effect) — informally the "odd" and "even" chains of rounds.

Each participation moves through these states (`participation::*` in
`imports/constants.fc`):

1. **open (0)** — created by the first `request_loan` for the upcoming round; borrowers'
   requests are collected and sorted.
2. **distributing (1)** — entered by `participate_in_election` once the election window
   opens. `distribute` snapshots the available balance *in the same transaction* and decides
   which loan requests to accept (`decide_loan_requests` / `process_loan_requests`).
3. **staked (2)** — accepted loans have been sent through loan contracts to the Elector.
4. **validating (3)** — `vset_changed` observed the round begin.
5. **held (4)** — the next `vset_changed`; the round is over but stakes are frozen.
6. **recovering (5)** — after `stake_held_until`, `finish_participation` triggers
   `recover_stakes`; each `recover_stake_result` books rewards or punishments.
7. **burning (6)** — when the last loan is recovered, rewards are in `total_coins`,
   `current_rate`/`previous_rate` are updated, and `burn_all` is sent to the round's
   collection. Every bill burns back into the treasury (`mint_tokens` / `burn_tokens`), and
   `last_bill_burned` deletes the participation.

`vset_changed` is driven by config parameter changes (elector validator-set updates), and
each stage has a governance-triggerable retry (`retry_distribute`, `retry_recover_stakes`,
`retry_burn_all`, `retry_mint_bill`) in case a message is lost.

### Loan economics

`distribute` limits how much can be lent in one round via `rounds_imbalance`, so one of the
two round chains cannot starve the other. Borrowers post their own stake alongside the loan
(`total_borrowers_stake`); on recovery, the reward is split by `borrower_reward_share` (out
of 255), the treasury's share pays `governance_fee` (out of 65535) to the governor, and the
remainder increases `total_coins` for all hGRAM holders. Losses are deducted from the
borrower's own stake first — stakers are only exposed after the borrower's stake is
exhausted.

## Deposit flow (`deposit_coins`)

See `graphs/02.*`. The deposit fee is dynamic (`get_treasury_fees`); the deposited amount is
reserved and the remainder returned as gas excess. A deposit that would mint zero tokens at
the current exchange rate (dust below one token nano-unit) is rejected with
`err::deposit_too_small` before any state change, so it cannot become a silent donation to
the pool.

- **`instant_mint = true`**: tokens are minted immediately through the parent at the current
  rate.
- **`instant_mint = false`** (production): the deposit is recorded as a bill on a round's
  collection, `total_staking` increases, and tokens are minted only when that round finishes
  (its `burn_all`). The round is chosen as the **latest non-open participation** (state
  strictly between `open` and `burning`); if none exists, the mint is instant.

The invariant behind that choice: **a deposit's tokens must not exist until the rewards of
every round whose loans were committed before the deposit are reflected in the exchange
rate.** The latest non-open participation is exactly the latest round with already-committed
loans, and participations finish in `round_since` order, so minting after it is both correct
and the minimal delay. Choosing the "currently validating" round instead would be wrong: in
the window where the next round is already `staked` but not yet begun, it would let a
depositor capture a full round of rewards their coins never took part in. The conservative
direction is intentional — a depositor may occasionally wait longer or sit unlent for a
round, but can never collect unearned rewards.

Note that pending deposits sit in the treasury balance and *are* lendable in subsequent
rounds (only rounds starting after the deposit), which is consistent with the invariant:
the depositor's tokens exist before any of those rounds' rewards land.

## Unstake flow (`unstake_tokens` → `reserve_tokens`)

See `graphs/03.*`. Unstaking starts as a TEP-74 `burn` on the user's wallet, with an
optional custom payload selecting a mode (`unstake::*`):

- **auto (0)**: instant if the treasury has enough liquid GRAM, otherwise deferred via a
  bill to the end of the round.
- **instant (1)**: instant or rolled back.
- **best (2)**: always deferred to the end of the round, maximizing earned rewards.

Deferred unstakes reserve the tokens (`total_unstaking`), mint a bill on the **earliest**
non-open participation (so payout happens at the first opportunity), and pay out GRAM at the
rate current when the bill burns.

## Governance and operations

Two privileged roles live in the treasury extension: the **governor** (parameter changes,
upgrades, surplus withdrawal, profit recipient) and the **halter** (emergency stop). Key
operations, each with a graph and a script in `scripts/`:

- Governor handover is two-step with a 24-hour delay (`propose_governor` →
  `accept_governance`).
- `set_stopped` halts new deposits; `set_instant_mint` toggles deferred minting;
  `set_governance_fee` and `set_rounds_imbalance` tune economics.
- Upgrades: `upgrade_code` for the treasury itself (see `scripts/upgrade_treasury.md` for
  the procedure), `proxy_upgrade_code` for the parent, and per-user wallet upgrades
  (`send_upgrade_wallet` / `migrate_wallet`) with `old_parents` allowing balances to merge
  from a previous parent.
- `gift_coins` donates GRAM to the pool (raises the rate for everyone).

The treasury's persistent state is split into frequently-loaded fields (`save_data` /
`load_data`) and a rarely-needed `extension` cell (`pack_extension` / `unpack_extension`) to
keep gas low on hot paths. **Any upgrade must keep the stored data layout compatible or
migrate it explicitly.**

## Testing

Tests run on `@ton/sandbox` with a mock elector (`wrappers/elector-test`) and cover flows
end-to-end (`Wallet`, `Loan`, `Governance`, `Access`, `Large`), getters, and gas bounds.
`MaxGas.spec.ts` and `MinGas.spec.ts` pin worst-case and minimum fees — if a change moves
gas costs, those expectations (and the fee constants in `imports/`) must be revisited
deliberately, not just updated to make tests pass.
