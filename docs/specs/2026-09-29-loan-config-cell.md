# Loan settings in a cell of their own

Status: draft, 2026-09-29. Folds into the auction-floors release
([2026-09-28-auction-floors-and-forced-accrual.md](2026-09-28-auction-floors-and-forced-accrual.md)),
which is not deployed yet: one upgrade, one migrator.

## Problem

The treasury's storage is at three edges at once:

| resource | used | limit |
|---|---|---|
| extension bits | 876 realistic, 972 at the coin-supply bound, 1140 at varuint16's own maximum | 1023 |
| extension refs | 4 (`proposed_governor`, `collection_codes`, `bill_codes`, `old_parents`) | 4 |
| FunC globals | 31 | 31 |

The auction floors already had to bend to fit: whole-GRAM `uint32` stakes instead of coins, and one
packed global instead of three. The next loan-side field has nowhere to go.

Six stored fields are read only by the loan side of the protocol:

| field | where it is today | read by (besides its setter and `get_treasury_state`) |
|---|---|---|
| `governance_fee` | extension | `recover_stake_result` |
| `borrower_fee` | extension | `request_loan` (snapshotted into the request) |
| `reward_share` | extension | `request_loan` (snapshotted into the request) |
| `auction_floors` | extension | `request_loan` |
| `rounds_imbalance` | root | `distribute`, inside the decide chain |
| `loan_codes` | root, a ref | `process_loan_requests`, `recover_stakes`, `recover_stake_result`, `send_message_to_loan`, `get_loan_address` |

Yet every operation that unpacks the extension — deposits, unstakes, mints, burns, every governance op —
parses four of them, and every transaction loads and stores the other two with the root.

## Decision

Move all six into one **loan config cell**, stored in the root in the ref slot `loan_codes` holds today.

```
loan_config#_
    governance_fee:uint16
    borrower_fee:uint16
    reward_share:uint16
    rounds_imbalance:uint8
    min_efficiency:uint24 min_request_stake:uint32 stake_cap_floor:uint32
    loan_codes:^(Hashmap 32 ^Cell)
    = LoanConfig;
```

144 bits and one ref, so about 880 bits and three refs are left for loan-side fields to come.

- **One global, `cell loan_config`, parsed on demand.** A handler that needs the settings calls
  `unpack_loan_config()` once, which returns them as a tensor, and keeps them in locals. A setter
  builds a new cell with `pack_loan_config(...)`. The root, and so the cell, is written by
  `recv_internal`'s trailing `save_data()`, so no setter can forget to persist it — the same reason
  `deficit` lives in the root.
- **Why the `loan_codes` slot and not a fourth root ref.** The root keeps its shape: three refs, and
  `load_data` / `save_data` do exactly the loads and stores they do today, minus `rounds_imbalance`.
  An operation that does not lend therefore pays nothing extra. A fourth ref would put the root at its
  own ref limit and add a load and a store to every transaction.
- **Why not inside the extension.** Its four refs are taken.
- **Why not the root's spare bits.** Every transaction would load and store them; that only moves the
  edge, and it moves it onto the hot path.
- **Rejected: nesting `collection_codes` and `bill_codes`** to free an extension ref. It puts a cell
  load on mint and burn, which are user operations.

**The extension no longer overflows at all.** It keeps 632 bits of non-rate fields: 740 realistic, 836
at the coin-supply bound, and 1004 even at varuint16's own maximum, under 1023. The unreachable-bound
argument above `pack_extension` stops carrying the weight.

**Globals: 31 → 26.** Six go (`governance_fee`, `borrower_fee`, `reward_share`, `auction_floors`,
`rounds_imbalance`, `loan_codes`), one comes (`loan_config`).

## Changes

- **`contracts/treasury.fc`**
  - **Storage**
    - `save_data` / `load_data`: drop `rounds_imbalance`; `loan_codes` → `loan_config`, same position.
    - `pack_extension` / `unpack_extension`: drop the four fields.
    - New `unpack_loan_config()` / `pack_loan_config(...)`, and `min_efficiency` / `min_request_stake` /
      `stake_cap_floor` become helpers over the unpacked floors value.
  - **Handlers:** `request_loan`, `distribute`, `process_loan_requests`, `recover_stakes`,
    `recover_stake_result`, `send_message_to_loan` and `get_loan_address` unpack the loan config once.
  - **Setters:** `set_governance_fee`, `set_borrower_fee`, `set_reward_share`, `set_rounds_imbalance` and
    `set_auction_floors` rebuild the loan config instead of calling `pack_extension`. They still unpack
    the extension for the governor check.
  - **`get_treasury_state`:** unchanged tuple, values read from the loan config.
- **`wrappers/upgrade-code-test/add_auction_floors.fc`**
  - It parses the current mainnet root and extension as today, and writes the new root with a loan
    config cell and the new extension without the four fields.
  - The seeded floors are the same, 620 / 680,000 / 2,500,000.
  - The name stays, so the runbook's `migratorName` does not move; its header says it also builds the
    loan config.
- **`wrappers/upgrade-code-test/reset_data.fc`**: the new layout.
- **`wrappers/Treasury.ts`**: the config builder writes the new layout. `TreasuryConfig`'s fields
  stay flat, so tests do not change shape. The getter reader is unchanged.
- **`contracts/schema.tlb`**
  - `LoanConfig`, and the new `treasury_storage` and `extension`.
  - Drop the stale "absent on an extension packed before them" note on the floors.
- **Docs**
  - `architecture.md`: the storage split becomes three parts, hot root, loan config and rare extension.
  - `scripts/upgrade_treasury.md`: the auction-floors section. The migrator also moves six fields, and
    both hashes are new. A future migrator that adds a loan code writes it into the loan config.
  - CHANGELOG entry amended.

## Invariants

- **Storage is the same state, relocated.** Every value the treasury holds after the migration equals
  its value before, except the three seeded floors. `get_treasury_state` returns the same 31 values
  in the same positions, so every reader in the census is untouched.
- **Setters still persist.** The loan config is a root field, and `save_data()` runs after every
  routed message.
- **Snapshots are unaffected.** `borrower_fee` and `reward_share` are still copied into each request
  at `request_loan`, so a change still cannot reprice a committed loan.
- **Loan addresses do not move.** `loan_codes` is the same dict, reached through one more ref, so
  `find_code(round_since)` returns the same code and every round's loan address is unchanged.
- **Other contracts' hashes do not move.** Nothing goes into `utils.fc`.

## Compatibility

- **Layout:** the root and the extension both change, so the migrator runs in the same upgrade. Its
  end_parse guards remain the re-run refusal: the old root has one more field, and the new root fails
  the old parse.
- **Messages and getters:** no schema or tuple change. `get_loan_address` returns the same address.
- **Off-chain readers:** none parses the treasury's raw storage. A grep across the sibling repos
  finds it only in this repo's own wrapper, tests and scripts. `migrationDryRun` reads getters and
  keeps working.
- **Gas**
  - Operations that do not lend get slightly cheaper: the extension is four fields shorter, and the
    root is one field shorter.
  - Each lending operation pays one extra cell load, about 100 gas, which is 0.00004 GRAM at the
    basechain price. That covers `request_loan`, the decide chain, `process_loan_requests`,
    `recover_stakes`, `recover_stake_result` and `send_message_to_loan`.
  - `MaxGas` and `MinGas` settle the constants.
  - The Wallet-compiled frozen constants (`send_unstake_all`, `last_bill_burned`) are not touched.

## Test plan

- **Migration against the mainnet fixture (`TreasuryMigration.spec.ts`)**
  - Every root, extension and loan-config field lands at its offset, and the refs are unchanged
    (`loan_codes` compared by hash).
  - The getter tuple after the upgrade equals the one before, except the three floors.
  - The dry-run diff is exactly the three floors.
  - The re-run is refused.
- **Setters:** each of the five changes its value, as read by the getter, leaves the other four and
  `loan_codes` alone, and survives into the next transaction.
- **Loans work end to end:** the existing suites (Loan, AccrualPrice, StakeCap, AuctionFloors,
  BorrowerFee, Governance) pass unchanged.
- **Code upgrades:** `get_loan_address` for an old round still resolves after a code upgrade
  (Librarian and Upgrade suites).
- **Gas:** MaxGas and MinGas stay green, and the constants are adjusted where they move.
- **Budgets:** the storage-budget comments in `treasury.fc` are rewritten with the new numbers.

## Out of scope

- `collection_codes`, `bill_codes` and every other extension or root field.
- Any getter or message change.
- Wallet, parent, collection, bill and loan contracts.
