# Fix postponed unstake bill using the wrong round's collection/bill code

## Problem

When a deferred unstake cannot be paid at its round's finalization because the
treasury is illiquid (`available_ton < coins`), `burn_tokens` in `treasury.fc`
postpones the payout by re-minting the unstake bill onto the **next** non-open
participation (`next_round_since`). See `contracts/treasury.fc:426-463`.

The postpone branch reuses the `collection_code` / `bill_code` that were resolved
at the top of the handler from the **original** round:

```
cell collection_code = collection_codes.find_code(round_since);   // original round
cell bill_code       = bill_codes.find_code(round_since);
...
create_collection_address(my_address(), next_round_since, bill_code, collection_code);
```

A collection's address is derived from both its code cell **and** the `bill_code`
stored in its data (`create_collection_data` / `create_collection_address` in
`utils.fc`). The per-round code dictionaries are keyed by `round_since` and read
with `udict_get_preveq?`, so `find_code(round_since)` and
`find_code(next_round_since)` return **different** cells whenever a
`collection_codes` / `bill_codes` upgrade was installed with a key in
`(round_since, next_round_since]`.

In that case the postponed bill is deployed on a collection address computed with
the *old* code but the *next* round number — an address that does **not** match
the real `next_round_since` collection (which the treasury drives with
`find_code(next_round_since)` everywhere else). Consequences:

- The treasury's `burn_all` for `next_round_since` targets the correctly-coded
  collection, so the orphaned bill is never burned.
- If it ever did reply, `mint_tokens` / `burn_tokens` recompute the collection
  address from `find_code(next_round_since)` and would reject it with
  `err::access_denied`.

Net: that user's unstake payout is stranded until a governor `retry_mint_bill`.

Likelihood is low — it needs a real liquidity shortfall at a round boundary
(a designed, normal path) to coincide with a collection/bill **code upgrade**
landing between two adjacent active rounds — but the funds at risk are a real
unstake payout, not dust, and the fix is mechanical.

This is the only place in the contracts that resolves a per-round code for one
round but builds a contract address for a different round; the deposit and
`reserve_tokens` flows resolve the code for the same round they address.

## Decision

In the postpone branch of `burn_tokens`, resolve the collection and bill codes
from `next_round_since` (the round the bill is actually being minted onto)
instead of reusing the original round's codes. Keep the top-of-handler
`round_since` lookups as-is — they are correct for the access-control check on
the incoming message.

Do not refactor the code-lookup pattern elsewhere; no other site has the
one-round/other-round mismatch.

## Changes

- `contracts/treasury.fc` (`burn_tokens`, postpone branch, ~line 445): before
  building the `next_round_since` collection address, add
  `cell next_collection_code = collection_codes.find_code(next_round_since);`
  and `cell next_bill_code = bill_codes.find_code(next_round_since);`, and pass
  those to `create_collection_address(my_address(), next_round_since,
  next_bill_code, next_collection_code)`.

## Invariants

- **Postponed bills live where the treasury will drive them.** The bill for a
  round must sit on the collection whose code equals `find_code(round)` for that
  round, because `burn_all` and the `mint_tokens`/`burn_tokens` access checks all
  use `find_code(round)`. The fix makes the mint target
  `find_code(next_round_since)`, restoring this for the postpone path (it already
  held on every non-postpone path and whenever codes are unchanged across rounds).
- **Access control unchanged.** The incoming-message check at
  `treasury.fc:414-417` still uses the original `round_since` codes, matching the
  collection that actually sent this `burn_tokens`.
- No change to the exchange-rate identity, the participation state machine, or
  `total_staking` / `total_unstaking` accounting: the postpone branch still
  `throw(0)`s without mutating balances, so tokens stay reserved in
  `total_unstaking` until the bill finally burns.

## Compatibility

- **Stored data:** no change to `save_data` / `extension` layout, wallet, or
  participation. No migration.
- **Message schemas:** unchanged (`contracts/schema.tlb`, `Integration.md`
  unaffected).
- **Rollout:** pure code change to the treasury, shipped via the normal
  `upgrade_code` procedure (`scripts/upgrade_treasury.md`). No ordering
  constraint with running rounds; the fix only alters the postpone branch and
  only observably differs once a code upgrade exists in the dictionaries.
- Behavior is identical to today for all deployments that have never upgraded
  `collection_codes` / `bill_codes`.

## Test plan

- New regression test (extend `tests/Loan.spec.ts`, or a focused spec): drive a
  deferred unstake to a round finalization where the treasury is illiquid so
  `burn_tokens` postpones, with a **different** collection/bill code registered
  for `next_round_since` than for the original round. Assert the postponed bill
  is deployed at the `next_round_since`-coded collection address and that it
  ultimately burns and pays out (before the fix it lands on the wrong address and
  strands).
- Confirm existing tests stay green: with unchanged codes,
  `find_code(round_since) == find_code(next_round_since)`, so the postpone path
  is byte-for-byte equivalent.
- `MaxGas.spec.ts` / `MinGas.spec.ts`: the postpone branch gains two
  `udict_get_preveq?` lookups, so `burn_tokens` worst-case gas rises. Measured
  worst case moved from within the old `16627` budget to `17270` (the postpone
  path is now the max). `gas::burn_tokens` was bumped to `17400` in
  `imports/constants.fc` — above the observed worst case with a margin consistent
  with the sibling burn-path constants. It is counted for both the first and
  second burn attempt in `unstake_tokens_fee` / `unstake_all_fee`, so the user
  fee re-derives automatically. Full suite (90 tests) and lint pass with the bump.

## Out of scope

- Finding 2 (a deferred deposit whose tokens round to 0 at mint time and are
  donated to the pool): reviewed and accepted as-is — self-inflicted, sub-GRAM,
  breaks no invariant, not exploitable against others. No code change; an
  optional one-line note in `docs/architecture.md` could record it, but this spec
  does not.
- Any broader refactor of the per-round `find_code` call sites.
