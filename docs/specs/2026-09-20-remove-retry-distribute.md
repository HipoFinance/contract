# Remove retry_distribute

## Problem

`retry_distribute` re-runs `distribute` on a round in `distributing`. `distribute` rebuilds the
participation with `new_dict()` in the `rejected`, `accepted`, `accrued`, `staked` and `recovering`
slots — harmless from `participate_in_election`, where a freshly opened round has all five empty,
and destructive from `retry_distribute`, because `decide_loan_requests` has by then moved requests
into them.

The loss is permanent and silent. Those borrowers are never refunded, their collateral stays in the
treasury, and `total_borrowers_stake` keeps counting it with nothing left to decrement it — which
shrinks `available_now` and `available_ton` for every future round. There is no recovery path: the
requests that would have driven the refund are gone.

It is governor-and-halter gated, so it is not an attack. It is a footgun on the one op whose whole
purpose is to be reached for in a hurry, when a round looks stuck and the operator is under
pressure. It has never been run on mainnet; its only production-era use was on testnet during
development. Found in the adversarial pass of 2026-09-20, reported independently by two reviews.

## Decision

**Delete the op.** Not guard it, not repair it.

A guard alone — refuse once `accepted`/`accrued`/`staked`/`recovering` hold anything — removes the
destruction but leaves nothing for the stalls it was reached for, because there is no
`retry_decide_loan_requests` and no `retry_process_loan_requests`.

Adding those was considered and rejected. Resuming is not a matter of re-sending the right
continuation: `decide_loan_requests` sets `total_staked = 0` on its way out, and
`process_loan_requests` has been accumulating `total_staked` since. A resume would have to pick its
entry point from which dicts are non-empty, and re-entering the wrong one silently zeroes the record
of what is already staked. That is a second footgun of the same shape as the first, built to rescue
an op that has never been needed.

What remains if the chain ever does stall is `upgrade_code`, which installs code carrying a one-off
repair written for the actual situation and reviewed as part of the upgrade — the same mechanism
that already carries storage migrations, and the mechanism used to drive this chain by hand during
development. Slower than a standing op, and the right trade for a repair that must be correct
rather than quick.

The other four retry ops stay. Each was traced: `retry_recover_stakes`, `retry_mint_bill`,
`retry_burn_all` and `retry_burn_ready` are additive or resumptive, none writes `new_dict()` over
live state, and each answers a stall that has no other remedy — `retry_mint_bill` rebuilds a bill
that exists nowhere else and holds a user's unstake, and `retry_burn_ready` covers a round that
settles while the pool is not participating and so has nothing to release it.

## Changes

- `contracts/treasury.fc` — delete `retry_distribute` and its `recv_internal` dispatch; leave a
  comment on `distribute`'s five `new_dict()` writes recording that its only caller opens the round.
- `contracts/imports/constants.fc` — delete `op::retry_distribute`; the code `0x6ec00c48` is retired
  and not reused.
- `contracts/schema.tlb`, `docs/integration.md` — drop the message.
- `wrappers/common.ts`, `wrappers/Treasury.ts` — drop `op.retryDistribute` and
  `sendRetryDistribute`.
- `scripts/retryDistribute.ts` — deleted.
- `scripts/upgrade_treasury.md` — note the removal in this release's section.
- `docs/architecture.md` — the governance-operations list.

## Invariants

- **No behaviour changes for any round that is not stuck.** The op is unreachable in normal
  operation; nothing on chain sends it and nothing depends on it.
- **The participation state machine is untouched.** `distribute` keeps its single caller,
  `participate_in_election`, for which the `new_dict()` writes are correct.
- **No accounting changes.** Removing the only way to destroy `accepted`/`accrued` can only make
  `total_borrowers_stake` more accurate, never less.

## Compatibility

- **No stored layout change**, so no migration is needed for this on its own.
- **A message carrying the retired op is refused** with `err::invalid_op` and bounces, as any
  unknown op does. The only sender is `scripts/retryDistribute.ts`, deleted here.
- **Gas:** `recv_internal` loses one dispatch comparison and the contract loses a handler, so the
  treasury gets marginally cheaper and smaller. `MaxGas` figures move down.

## Test plan

- `Governance.spec.ts` — the existing `retry_distribute` case is replaced by one asserting the op is
  now refused with `err::invalid_op` and the message bounces.
- `Access.spec.ts` — the access case for it is removed, since there is no op to deny.
- The rest of the suite proves the removal is inert: no other test drives a round through
  `retry_distribute`.

## Out of scope

- The other four retry ops, which stay as they are.
- Any resume mechanism for a stalled `decide_loan_requests` or `process_loan_requests`; if one is
  ever wanted it needs a spec that addresses the `total_staked` reset above.
