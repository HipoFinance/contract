# Auction floors and forced accrual

## Problem

The pool earns only on stake that is lent **and** elected. Two request shapes keep capital from
either, at almost no cost to whoever sends them:

- **A tight `max_stake` idles the leftover.** Since the stake-cap release
  (`2026-09-26-request-stake-cap.md`), a capped loan's excess is not lent that round. A request can
  rank first and fit, set `max_stake` to its own loan plus collateral, and leave everything behind it
  unlent whenever the next request is too large to fit. In round 1790529288 two such requests
  (1,000,000 each, capped at 1,001,500) would have left about 1.73M of 3.74M idle. They didn't, only
  because another borrower resized at the last second. The cap was meant to protect a borrower from
  stake above the elector's limit; nothing stops it being set far below that limit.
- **A loan that is never elected earns nothing.** A request whose stake is under the election floor is
  accepted, takes its accrual, and is returned by the elector with no reward. At `min_payment = 0`
  the pool gets nothing back. Several such requests can hold most of a round's capacity for a few
  GRAM. `2026-09-02-minimum-bid-efficiency.md` closed this as harmless because such a bid "only wins
  on spare capacity". That premise does not hold: accrual hands spare capacity to every accepted
  request in proportion to its size.

A simulation of greedy borrowers against twelve rule variants (private, 2026-09-27) found:

- These two shapes are the only large losses. The pool's contractual share (97.255% of the reward
  on elected stake at `reward_share` 1799) already sets a floor on price.
- Price competition above that floor was worth at most ~1.7% of the pool's take.
- The capped shape halved a round's take.
- The never-elected shape cut it by two thirds.

## Decision

One treasury release with three governor-set floors and forced accrual. Together they held against
every attack tried in the simulation.

1. **Rate floor.** `request_loan` refuses a request whose efficiency, computed exactly as
   `request_sort_key` computes it, is below `min_efficiency`. A loan that is never elected then pays
   its `min_payment` out of collateral, so holding capacity it cannot use costs about what that
   capacity would have earned.
2. **Stake floor.** `request_loan` refuses a request whose `loan_amount + stake_amount` is below
   `min_request_stake`. It is set a little under the election floor, so a request that could never be
   elected is refused outright.
3. **Cap floor.** A non-zero `max_stake` below `stake_cap_floor` is raised to it, and the raised
   value is what the request cell stores. It is set a little under the elector's per-validator
   limit, so a cap still protects a borrower from stake that earns nothing but can no longer leave
   the leftover idle. 0 still means no cap. *Raise rather than refuse* (the governor's choice): a
   refusal throws away a bid, and in the simulation it drove whole borrowers out of the round.
4. **Forced water-fill.** Accrual is no longer one proportional pass that drops each capped
   loan's excess. Accepted loans are served in ascending order of cap room per GRAM of loan
   (`(max_stake − loan − collateral) / loan`; uncapped loans last). Each gets
   `min(room, left × loan / remaining_loans)`, and `left` and `remaining_loans` shrink as it goes.
   - This is the exact water-fill in a single pass: capped loans take what they can, and whatever
     they cannot take flows on to loans with room, at those loans' own bid rates.
   - A loan that fails the accrual collateral check takes nothing, and its share flows on the same way.
   - Nothing is left unlent unless every accepted loan is full.

The floors are one governor op, `set_auction_floors`, since they are tuned together against the same
election. The upgrade's migrator seeds the starting values, so the floors are in force from the first
request after it lands *(revised 2026-09-28 after sign-off, the governor's choice: the release first
shipped them at 0 and set them with a second transaction)*. Starting values: `stake_cap_floor` 2,500,000, `min_request_stake`
680,000 and `min_efficiency` 620, each ~5–12% under what it guards against, from two weeks of
per-round data (see the runbook). They are revised by the same op when the election moves, which the
data suggests is a monthly check and a change a few times a year. *(Revised 2026-09-28 after sign-off:
the first values, 2,760,000 / 800,000 / 640, put the stake floor above the smallest elected stake,
754,342, which is the election floor that matters; ~867,000 was a borrower's own safety margin, not
the floor.)*

Rejected alternatives:

- **Remove `max_stake`.** It stops caps idling capital, but honest borrowers go back to paying the
  bid rate on stake above the elector's limit, which is the problem the cap solved. It does nothing
  about never-elected loans.
- **Give the idle leftover to the best rejected request, free of `min_payment`** (the governor's
  first idea). It only helps when a rejected request exists and its stake would be elected. In the
  simulation it made being rejected valuable: borrowers sent oversized high-ranked requests *meant*
  to be rejected, to catch the leftover at the floor price.
- **Give the leftover to accepted loans free of `min_payment`, with no caps.** Nothing idles, but
  size becomes free again: the last mover took the whole pool with one validator, above the elector
  limit, and excluded everyone else.
- **Charge a capped loan for the share it refused.** The pool is paid, but the capital still sits idle.
- **Lend a residual to the best rejected request at its own rate** (part of the simulated package).
  With a cap floor near the elector limit, two accepted loans cannot both be full in today's pool, so
  a residual needs a lone accepted borrower, and it is usually under the election floor anyway. It
  would add state to the gas-limited decide chain and lend borrowers less than they asked for.
  Dropped; the residual stays on the balance, as it does today.
- **Refuse caps below the floor** instead of raising them: see (3).
- **Derive the floors on chain** (yield from the rate window, the election floor from config). The
  contract cannot see the next election's floor or limit when a request arrives, and a floor derived
  from a noisy window would move under bidders. Governor-set values are explicit and rarely change.

## Changes

- `contracts/treasury.fc`
  - Extension: `min_efficiency:uint24`, `min_request_stake:uint32` and `stake_cap_floor:uint32`,
    the last two in whole GRAM. They go after `reward_share`, before the refs, and the bit-budget
    comment above `pack_extension` is updated. They are **required fields**: `unpack_extension` reads
    them unconditionally, so the storage layout of this version is fixed, with no optional parsing.
    A one-off migrator, `wrappers/upgrade-code-test/add_auction_floors.fc`, rewrites the deployed
    extension with the three starting values during the upgrade *(revised 2026-09-28 after sign-off: the first
    implementation read them tolerantly and had no migrator; the governor chose a fixed layout)*.
    *(Implementation: held in one global, `auction_floors`, with three accessors, because FunC
    addresses at most 31 globals and the treasury was at the limit.)*
  - `request_loan`:
    - refuse with `err::invalid_parameters` when `min_efficiency` is non-zero and the request's
      efficiency is below it;
    - refuse with `err::insufficient_funds` when `loan_amount + stake_amount < min_request_stake`
      (in nanoGRAM);
    - when `max_stake` is non-zero, set it to `max(max_stake, stake_cap_floor)` before the existing
      `max_stake ≥ loan + stake` check and before packing the request.
  - `set_auction_floors` (new op, governor only): reads the three values, checks them, returns excess
    gas the way `set_reward_share` does.
  - `decide_loan_requests`:
    - the accept phase keys `accepted` by `(room ratio, address)` instead of by address. That is 416
      bits, past what an int key holds, so the dict is keyed by slice; `get_loan_request` finds an
      address in it by walking it;
    - the accrual loop walks it in ascending order with the water-fill rule above, keeping `left` and
      `remaining_loans` in the existing `available` / `allocated` temporaries across continuations;
    - scaling of `min_payment` and the collateral check are unchanged.
  - `get_treasury_state`: the three values appended at the end.
- `request_efficiency` is the top 24 bits of `request_sort_key` itself, so the floor and the sort use
  one computation. It and the accrual key live in `treasury.fc`, not `utils.fc`, as the spec first
  said: every contract that includes `utils.fc` compiles all of it, and editing it moved the Wallet
  code hash away from the bytecode deployed on mainnet.
- `contracts/imports/constants.fc`: `op::set_auction_floors`, plus gas constants re-measured.
  `gas::request_loan` 48000 → 50000, `gas::decide_loan_requests` 22000 → 24000,
  `gas::process_loan_requests` 31000 → 32000 and `gas::recover_stake_result` 53000 → 56000, to the
  suite's 10% margin. The treasury's larger code costs ~230 gas more on the non-loan ops that touch
  the extension, so `gas::deposit_coins`, `gas::mint_tokens` and the `_cost` twins of the frozen
  constants rise to their measured values. `gas::send_unstake_all` (now 103 short) and
  `gas::last_bill_burned` (raw cost still covered) stay put: the first is compiled into the Wallet
  and the second into the Collection, and raising either would move a deployed code hash. The first
  gets a `_cost` twin, as the other frozen wallet constants have; MinGas still proves the fee the
  wallet demands covers the chain.
- `contracts/schema.tlb`: `set_auction_floors`. The `request_loan` message is unchanged.
- `wrappers/Treasury.ts`: `sendSetAuctionFloors`; `getTreasuryState` reads the three appended values,
  with the temporary old-shape branch for reads before the upgrade.
- `scripts/setAuctionFloors.ts`, `scripts/showState.ts` (show the floors), and a runbook section in
  `scripts/upgrade_treasury.md`.
- `docs/architecture.md` (loan economics: floors, cap floor, water-fill), `docs/integration.md`
  (refusals and cap raising for borrowers; new getter fields), `graphs/04-request-loan.dot`, a new
  `graphs/34-set-auction-floors.dot`, and `CHANGELOG.md`.
- A status line on `2026-09-02-minimum-bid-efficiency.md` (reopened and answered here) and on
  `2026-09-26-request-stake-cap.md` (the "excess stays in the treasury" rule is superseded).

## Invariants

- **The exchange-rate identity is untouched.** Accrual changes who is lent the leftover, not how
  lent coins are accounted; `total_staked` still sums what left the balance.
- **Nothing is lent above a borrower's effective cap.** Water-fill clamps at the same
  `max_stake − loan − collateral` as today. Only the effective cap moves, and only upward, to
  `stake_cap_floor`.
- **A loan is still priced at its own bid rate on everything it stakes.** Scaling is unchanged, and
  so is the recovery clamp at `reward + collateral`.
- **With every floor at 0, `request_loan` behaves exactly as today.** Only the water-fill differs, and
  it differs only when some accepted loan is capped: uncapped rounds decide identically, up to
  nanoGRAM rounding (the running `left / remaining_loans` ratio is the same, but each `muldiv`
  floors against shrinking operands).
- **The decide chain stays single-pass and gas-bounded.** One walk of `accepted` in key order, with
  the same soft-gas continuation, and the running state lives where it lives today.
- **Loss ordering, the collateral check and `total_request_fees` are unchanged.**

## Compatibility

- **Storage:** the extension grows by 88 bits. Worst case (every coin pooled) is 972 of 1,023
  bits. The migrator seeds the starting values, so the floors apply from the first `request_loan` after
  the upgrade; requests standing across it keep what they were stored with. It is tested against a fresh capture
  of the mainnet treasury, and replaces the reward-share migrator, whose release is on chain. The
  upgrade runs in the usual gap after a round is decided.
- **Requests standing across the upgrade** keep the caps they were stored with. The floors apply
  from the first `request_loan` after `set_auction_floors`, and a re-sent request picks them up.
- **Borrowers:** the message format is unchanged, but three things are new:
  - a bid below `min_efficiency`, or below `min_request_stake` in loan + collateral, now bounces with
    its collateral;
  - a tight cap is raised;
  - an uncapped loan may absorb more than its proportional share: capped loans' excess now flows to it.
  - The changelog says so. The public `HipoFinance/borrower` should read the floors and warn before
    sending. *(Done 2026-09-30 in borrower v2.3.0. It refuses to send a bid below either refusing floor
    and names the fix. It sends a cap below the cap floor as the floor, so the stored request matches
    and is not re-sent for a request fee on every check.)*
- **Getter:** `get_treasury_state` grows by three values, appended (ABI rule). Before the release,
  check every consumer in the census in `scripts/upgrade_treasury.md`, poker included.
- **`get_participation`'s `accepted` dict** is keyed by 416 bits instead of 256, and a 256-bit parse
  of a non-empty one throws (`sdk`, so `mcp`, and `gauge`'s accepted metrics). It is stored non-empty
  only when a decide chain continues across messages mid-accrual, which takes a book large enough to
  cross 80% of the gas limit; today's 2-5 requests decide in one transaction, so it is always stored
  empty. *(Revised 2026-09-28, the governor's decision: `accepted` is the decide loop's internal
  working state, not an interface. Readers stop parsing it rather than learning the new key: the
  contract's wrapper and `showState` keep it as an opaque cell, and `sdk`, `mcp` and `gauge` drop it.
  That leaves its layout free to change again.)* *(Revised 2026-09-29, the governor's decision:
  `accrued`, the decided loans until their stakes are sent, is internal in the same way. Every reader
  keeps it opaque too, gauge's `total_accrued_*` series go, and `borrower` and `sealed-borrower` hold
  both as raw cells; `sealed-borrower`, which did read them, reads `staked` and `recovering` only.)*
- **Gas:** `request_loan` gains two comparisons (the extension is already unpacked there). The accrual
  loop now handles a wider dict key and a ratio per loan. `MaxGas`/`MinGas` decide what the constants
  become, and `request_loan_fee` follows them live.

## Test plan

- **Floors at 0:** every existing auction test passes unchanged except those whose expected leftover
  involved a capped loan. For those, the new expectation is written out in the test.
- **Rate floor:** at `min_efficiency` exactly passes, one unit below bounces with collateral; 0 disables.
- **Stake floor:** loan + collateral at the floor passes, 1 nanoGRAM below bounces; 0 disables.
- **Cap floor:**
  - a cap below the floor is stored as the floor (read back through `get_loan_request`);
  - a cap above the floor is stored as sent;
  - 0 stays 0;
  - the `max_stake < loan + stake` refusal is judged after the raise.
- **Water-fill:**
  - two capped loans and one uncapped loan: the capped ones stop at their caps, and the uncapped one
    takes the rest;
  - all loans capped with room to spare: exact proportional fill;
  - all loans full: the residual stays on the balance and appears in the next round's `available`;
  - a loan failing the collateral check passes its share on;
  - the scaled `min_payment` follows each loan's final accrual.
- **Continuation:** a decide spread over several continuation messages produces the same accruals as
  a single one (`MaxGas`-sized book).
- **Replay:** round 1790529288's requests with the floors set produce no idle capital, since the
  rivals' caps are raised.
- `set_auction_floors`:
  - the governor only;
  - out-of-range values refused;
  - `get_treasury_state` returns the new values;
  - the migrator takes the captured mainnet account to the new layout, with the three starting values
    and every other field, including the participations dict, unchanged byte for byte; it refuses to run twice;
    and the upgrade without it fails in the dry run.

## Out of scope

- **Changing the smaller-loan tie-break.** It lets a request win a tie by being one GRAM smaller,
  which moves a round between borrowers without costing the pool. The sort key's 120 bits are
  already full.
- **Lending a residual to rejected requests,** and any free-of-`min_payment` lending; see Decision.
- **Deriving the floors on chain.**
- **Borrower-side changes** (sealed-borrower sizing, the public borrower's floor check): these follow
  the release; they are not part of it.
