# Borrower fee routed to an HPO burner

## Problem

HPO has no mechanical link to Hipo's income. The lever that exists, `governance_fee`, is set
to `0.00%` on mainnet and has to stay there or near it: when it was 6.25% it was widely read
as "the protocol takes 6.25% of my deposit", when in fact it applies to `treasury_reward`
*after* the borrower's share is taken. Beyond the misreading, stakers resist depositing
anywhere that visibly takes a cut — the competition is running a validator yourself, not
another LST. TVL is the binding constraint on the protocol (below roughly 600k GRAM it
cannot lend at all), so anything that suppresses TVL to fund the token is self-defeating.

That rules out funding an HPO burn from the stakers' share. It does not rule out funding it
from the **borrowers' share**, which is paid for running validator infrastructure — a cost
stakers already accept as legitimate and which never appears as a protocol fee on deposits.

## Decision

Take a governance-settable fraction of the borrower's share at loan recovery and send it, in
GRAM, to a **burner** address hardcoded in the contract:
`EQAGPJMxJ73OLpHUgQhI5YeQe2ZuAuUQ-4f_zfN4rV2Fl6Jp`, the deployed swap-and-burn contract from the
sibling `burner` repository, which buys HPO with the GRAM it receives and burns it. It treats
`op::take_borrower_fee` as a payment rather than a known op, so the treasury needs no cooperation
from it beyond the address.

The tax base is the borrower's **contractual share of the gross reward**,
`muldiv(reward, borrower_reward_share, 65535)`, and `borrower_fee` is a fraction of it out of
65535 — so `32767` means "half of what the borrower contracted to earn". **The chosen rate is
32767**, half the borrower's contracted reward, which works out to 54.4% of their profit after
infra. The cut is charged
from the borrower's side (`stake_amount`), never carved out of `treasury_reward`, so the pool's
take is untouched. A flat floor `fee::min_burn` applies when the base is zero. See "Choosing
the base" below.

Sizing is a share of borrower income rather than a USD or HPO target, so it does not go stale
as prices move and does not need a quarterly retune of a live auction.

### Why the burner address is a constant and not a stored field

The extension cell has no room to spare. Its four refs are all taken
(`proposed_governor`, `collection_codes`, `bill_codes`, `old_parents`), so an address could
only go in as a 267-bit inline slice. That packs to 907 of 1023 bits on realistic values, and
to 1083 — an overflow — at the theoretical `store_coins` maximum for the two rate fields. The
fit would hold only because `current_rate = muldiv(total_coins, 1000000000, total_tokens)` is
about 36 bits in practice, i.e. by assumption rather than by type bound.

Spending that headroom on an address expected to change roughly once is a bad trade. A
constant costs zero bits and zero refs, and keeps the migration to a single `uint16`. The cost
is that replacing the manual address with the burner contract later requires a treasury
upgrade; that upgrade can restructure the extension at the same time if a settable address
still looks worthwhile then, decided with more information than exists today.

### Choosing the base

Three bases were considered.

**Realised `borrower_reward`** (`reward - treasury_reward`) — rejected. A borrower bidding
`min_payment >= reward` drives their realised take to zero via the
`treasury_reward = max(min_payment, ...)` clamp and pays nothing. Unprofitable for an ordinary
borrower, but free for one who wants the validator slot for reasons outside the loan.

**`treasury_reward`** — closes every structural escape, since it is non-zero whenever the pool
earns anything. Rejected on **parameter safety**. The borrower's net is `(G/255)[s - f(255-s)]`,
so the rate must stay below `f_max = s/(255-s)` or the borrower loses money on every round
regardless of reward size. At `s = 8` that ceiling is 3.24%, i.e. 2,124 out of 65535 — the
entire useful range is a sliver at the bottom of the scale, useful values are 585-976, and a
mis-set value two orders of magnitude inside the type's range destroys the borrower market.
The treasury cannot bound this itself, because `f_max` depends on each borrower's own
`borrower_reward_share`.

**Contractual share `muldiv(reward, borrower_reward_share, 65535)`** — chosen. The parameter
becomes self-limiting: 65535 is 100% of what the borrower contracted to earn, so the worst
possible mis-set takes their whole reward but cannot push them into collateral loss beyond
`fee::min_burn`. **`f_max` disappears as a hazard entirely.** The base reads `reward`, not
`treasury_reward`, so the `min_payment >= reward` escape stays closed — bidding a large
`min_payment` does not shrink the base, and the borrower simply pays from collateral. Reading
`reward` directly also avoids dividing by `255 - s`, so `borrower_reward_share = 255` needs no
special case.

The accepted cost: `borrower_reward_share = 0` pays only `fee::min_burn`. Such a borrower earns
nothing and hands the pool the entire reward — forgoing ~45 GRAM to avoid ~21 — so stakers
strictly gain. It is a gift, not an attack, and the floor still means every accepted loan burns
something. The related `min_payment = 0` / `share = 255` bid is a pre-existing auction weakness
recorded in `2026-09-02-minimum-bid-efficiency.md`.

### Sizing (as of 2026-09-03)

Operator-confirmed parameters: staker APY ~17% (TON's validator APY was raised a few months
ago; the exchange rate measured 1.159645026 -> 1.161531630 over exactly 3.79 days, which
annualizes to 16.9% and is real, not a `gift_coins` artifact). Both borrowers bid
`min_payment` = 80 GRAM and `borrower_reward_share` = 8/255. `total_coins` = 7,995,225 GRAM,
2 loans per 65,536 s round period (481.5 periods/year), ~2M GRAM lent to each borrower.

| Quantity | Value |
| --- | --- |
| `treasury_reward` per loan | 1,411 GRAM |
| implied gross round reward | 1,457 GRAM |
| borrower revenue | 45.7 GRAM/round |
| infra ($200/mo each at $1.35/GRAM) | 3.7 GRAM/round |
| **borrower profit** | **42.0 GRAM/round, ~$27,300/year each** |

`min_payment` of 80 is far below `treasury_reward` of 1,411, so the share formula binds and the
`max(min_payment, ...)` clamp never fires in a normal round. That is why the base is
`treasury_reward` and not `min_payment`.

The borrower's contractual reward — the fee base — is
`muldiv(reward, 2056, 65535)` = **45.7 GRAM** per loan per round (2056 is today's share of 8
expressed in the widened scale).

| Target | Burn/loan | `borrower_fee` | Annual burn |
| --- | --- | --- | --- |
| 30% of borrower profit | 12.6 GRAM | 18,073 (27.6% of reward) | 12,140 GRAM (~$16,400) |
| 50% of borrower profit | 21.0 GRAM | 30,122 (46.0% of reward) | 20,233 GRAM (~$27,300) |
| **50% of borrower reward — chosen** | **22.9 GRAM** | **32,767** (54.4% of profit) | **22,010 GRAM (~$29,700)** |

`fee::min_burn` of 1 GRAM is inert at these rates — it binds only when `treasury_reward` falls
below ~112 GRAM at 0.89%, i.e. a round earning almost nothing, where the `min_payment` clamp
has already taken over. Its purpose is the `min_payment = 0` / `share = 255` bid, not the
everyday case. It is a constant rather than a governance parameter to avoid a second knob.

Effect at request time is negligible: the collateral check moves from `80 + 101 = 181` GRAM to
`80 + 1 + 101 = 182` GRAM.

### Widening borrower_reward_share to uint16

`borrower_reward_share` is a `uint8` out of 255, and at the shares borrowers actually bid the
granularity is measured against their own take rather than the total, so it is very coarse:

| share | one step moves borrower revenue by |
| --- | --- |
| 8/255 (today) | 12.5% (5.7 GRAM of 45.7) |
| 4/255 | 25% |
| 2/255 | 50% |
| 1/255 | 100% — the only remaining move is zero |

Competition cannot push the share down smoothly; it falls off a cliff. Widening to `uint16` out
of 65535 makes one step 0.049% (0.022 GRAM). `255 * 257 = 65535` exactly, so `share8 * 257` maps
the old range onto the new one losslessly and `8` becomes `2056` with identical economics.

**The sort key widens with it — truncation was rejected as an attack surface.** An earlier draft
kept `request_sort_key` at 112 bits by packing `(65535 - borrower_reward_share) >> 8` into the
existing 8-bit slot, to avoid migrating the `sorted` dict. Truncation is monotone, so a worse
offer can never outrank a better one — but it collapses them into a **tie**, and the tie falls
through to `loan_amount_round_comp`, where the smaller loan wins. A borrower could bid up to
255/65535 (~0.37% of gross, ~5.7 GRAM per round) worse for the pool and still rank equally,
then win on loan size.

The severity is bounded, but the shape is what condemns it: **that surface does not exist
today.** With `uint8` a borrower cannot express "slightly worse than 8/255" — the next value is
a full 12.5% step that ranks strictly worse. Widening the payment precision while leaving the
ranking coarse is exactly what creates a band to hide in, so the change meant to sharpen
competition would hand borrowers a way to dodge it.

The key therefore becomes 120 bits with no truncation:

```
int treasury_reward_share = 65535 - borrower_reward_share;
return (efficieny << (16 + 80)) + (treasury_reward_share << 80) + loan_amount_round_comp;
```

24 + 16 + 80 = 120, and the maximum value is exactly `2^120 - 1`, so it fits with no overflow
and no slack. The ten `udict_*(112, ...)` call sites on `sorted` move to 120, and any live
`sorted` dict is rebuilt by the migrator.

**The wire format breaks, deliberately.** `request_loan` reads `borrower_reward_share` as a
plain `uint16`, with no compatibility tail. An old-format message carries exactly 8 bits before
its ref, so `load_uint(16)` hits cell underflow and throws (exit code 9); `request_loan` is
**bounceable**, so the borrower's collateral returns automatically. The failure is loud,
non-destructive and self-announcing — a borrower discovers it on their next request and updates
before the round they care about. That is strictly safer than a silent misparse, and it keeps
the parse unconditional.

### One-phase rollout with a migrator

An earlier draft used tolerant reads and a second cleanup upgrade to avoid migrating in-flight
records. That is dropped: the migrator handles everything in one deployment, so no
compatibility branch is ever committed to the contract and `end_parse()` is preserved on
`unpack_request`.

The migrator must:

1. Rewrite the extension cell, adding `borrower_fee = 0`.
2. For every participation, repack every request in `requests`, `rejected`, `accepted`,
   `accrued`, `staked` and `recovering` into the new fixed layout, mapping
   `share16 = share8 * 257` and `borrower_fee = 0` — those loans were committed before the fee
   existed and must recover untaxed.
3. Rebuild each participation's `sorted` dict with 120-bit keys, derived from its `requests`.

**Deploy while `total_borrowers_stake` is zero.** That condition means no pending requests, so
`requests` and `sorted` are empty on every participation and step 3 is a no-op — only the
records in `staked` and `recovering` need repacking, which is about 4 today (two borrowers, two
live participations). It held on 2026-09-04 and is readable from `scripts/showState.ts`
immediately before sending the upgrade. The theoretical worst case is 100 requests per
participation across 8 participations; the migrator's cost scales with that count, so the
observed count is checked rather than assumed. A migrator that exceeds gas fails safe — it
exits non-zero, `c4` and `c5` are discarded, and the treasury stays on its old code and data —
so the failure mode is a retry, not a loss.

**Migrator correctness risk.** Per the two-method-id rule documented at `upgrade_data`, a
migrator must be fully inlined: `EXECUTE` does not set `c3`, so any non-inlined call would
dispatch into the treasury's own method dictionary. The migrator therefore carries its own copy
of the request layout rather than calling `pack_request`, and the two copies can silently drift.
The test plan covers this with an equivalence assertion.

### Sizing min_payment (operator guidance, not a contract change)

`min_payment` is a per-request bid, not a protocol parameter, but it was reviewed here because
it interacts with the fee. It has been 80 GRAM since before TON's block reward rose from ~4% to
~17%, and at that level it is nearly a dead parameter: `treasury_reward` is ~1,411, so the
clamp never fires and the pool's guaranteed floor is only 5.7% of what it actually earns.

Size it against the **guaranteed minimum loan, not the current one**. `decide_loan_requests`
accepts a request only when `available >= loan_amount`, so an accepted borrower always receives
at least the requested 900,000 GRAM; everything above that is `accrue_amount`, which is exactly
what disappears when liquidity is stressed. `treasury_reward` on a 900,000 loan at 17% is
**634 GRAM**.

| `min_payment` | binds below staker APY |
| --- | --- |
| 80 (today) | 2.15% |
| 150 | 4.02% |
| 300 | 8.05% |
| 400 | 10.73% |
| 500 | 13.41% |
| 634 | 17.01% |
| 1,000 | 26.83% |

**1,000 binds today** on a minimum-size loan — a fully-performing borrower in a low-liquidity
round would owe 366 GRAM out of collateral. It only looks safe because `accrue_amount` inflates
loans to ~2M, and that cushion is exactly what disappears under stress.

**Settled 2026-09-04:** the operator raised the requested `loan_amount` floor to 1,000,000 GRAM
and `min_payment` to 400. The larger floor improves the margin, since the guaranteed-minimum
loan now earns more:

| | 900k floor | 1M floor |
| --- | --- | --- |
| `treasury_reward` at 17% | 634 GRAM | 704 GRAM |
| `min_payment = 400` binds below | 10.73% APY | 9.66% APY |

So 400 tolerates a network reward cut to ~9.7% — roughly a 43% drop from today — before it
charges a fully-performing borrower. Note `max_punishment` is 101 GRAM at both 900k and 4M
stakes: it is flat, so `min_payment` is the only lever that raises borrower skin in the game.
Collateral becomes 501 GRAM per borrower, 1,002 total, up from 181 each. Verify by reading
`total_borrowers_stake` at the next open participation.

### Why a reward spike cannot make a borrower lose

Borrowers commit `min_payment` and `borrower_reward_share` before the round's reward is known.
With share `s` and gross reward `G`, while the share formula binds:

```
treasury_reward = G(255 - s)/255
borrower_reward = G·s/255
burn_share      = f · G(255 - s)/255
borrower net    = (G/255)·[ s - f(255 - s) ]
```

`G` factors out. The borrower's margin is a fixed ratio of the reward, so an unexpectedly large
round scales revenue and burn together and they profit strictly more in absolute terms. The
sign of the net depends only on the rate, giving a hard bound:

```
f_max = s / (255 - s)
```

At `s = 8` that is **3.24%**. Below it the borrower profits on every round whatever the reward;
above it they lose on every round whatever the reward. The 0.89%–1.49% range sits well inside.
Fixed infra makes spikes strictly better for the borrower: at 2x reward the burn falls from 30%
to 28.7% of profit because infra amortizes.

In the other direction, only a round with `G < 82.6` GRAM makes the `min_payment` clamp bind,
and there `treasury_reward` is pinned at 80 so the burn is the 1 GRAM floor. Such a round is
already a loss for the borrower through the pre-existing `min_payment` guarantee; the fee adds
at most 1 GRAM to it.

**`f_max` depends on the borrower's own `borrower_reward_share`.** A borrower bidding `s = 4`
has `f_max` = 1.59%, so a global 1.49% would leave them almost no margin. This is left to the
market: `borrower_fee` is public and readable before bidding, so a share too low to carry the
fee is simply an irrational bid, in the same way `s = 0` earns nothing today. Governance should
nonetheless keep the rate well under `f_max` for the lowest share it wants to keep viable.

### Why this and not the alternatives

- **Raise `governance_fee` instead** — rejected. Both it and this change use `treasury_reward`
  as their base, but in opposite directions: `governance_fee` is **carved out of** it
  (`new_coins = treasury_reward - fee`), so it reduces what reaches the pool and shows up
  directly in staker APY — the exact line item that caused the 6.25% problem. This change
  charges the borrower `borrower_fee/65535` of `treasury_reward` **on top**, out of
  `stake_amount`, leaving `new_coins` untouched. Same base, different payer. The constraint
  that `governance_fee` stay at or near zero is treated here as fixed.
- **Burn a fixed HPO amount per loan request** (the original proposal) — deferred to
  `2026-08-31-hpo-tickets-for-loans.md`. It puts an HPO jetton wallet inside the loan-request
  path, which adds a third-party liveness dependency to the treasury's revenue path, and its
  yield scales with borrower count (capped at 100, currently 2) rather than with TVL, which
  is the number the protocol actually needs to grow. It is a reasonable second mechanism once
  borrower count justifies it, and it is recorded so the design is not re-derived.
- **Route the Hipo-operated borrowers' `op::loan_result` to the burner** — rejected. That
  message carries returned collateral *plus* reward, so burning it would burn principal, and
  borrowers (including Hipo's own) have real server costs to cover. Any workable version is
  an operator policy rather than a protocol guarantee, which is what this change exists to
  avoid.

### Honest framing

Every channel — governance fee, borrower cut, HPO burn — is ultimately paid out of the same
round reward. Borrowers bid `borrower_reward_share` in a permissionless auction, so a cut of
their income is partly bid back as a higher share, which lands on `treasury_reward` and
therefore on staker APY. This change does not create value from nowhere. What it changes is
*legibility*: the cut sits on a line stakers do not own emotionally and which is understood
as payment for infrastructure. Given the 6.25% history that is a real advantage, and it is
the argument for this design — not a claim that the fee is free.

## Changes

- `contracts/imports/constants.fc` — new `op::take_borrower_fee` and `op::set_borrower_fee`
  (assign unused 32-bit op codes), `const slice burner` holding the recipient address, and
  `const int fee::min_burn = 1 GRAM`. The burner must be a basechain address: the fee
  arithmetic below budgets a basechain forward fee.
- `contracts/treasury.fc` — one new extension field, `borrower_fee` (`uint16`, out of 65535,
  same shape as `governance_fee`), added to `pack_extension` / `unpack_extension` and returned
  from `get_treasury_state`.
- `contracts/treasury.fc` — `recover_stake_result`, `reward >= 0` branch only:

  ```
  int borrower_reward = reward - treasury_reward;
  stake_amount += borrower_reward;              ;; borrower's funds, pool already paid
  int burn_share = 0;
  if (borrower_fee > 0) {
      int burn_base = muldiv(reward, borrower_reward_share, 65535);
      burn_share = min(stake_amount, max(fee::min_burn, muldiv(burn_base, borrower_fee, 65535)));
      stake_amount -= burn_share;
  }
  ```

  **The `borrower_fee > 0` guard is required, not cosmetic.** Without it the floor would charge
  1 GRAM on every loan even at a zero rate, so `borrower_fee = 0` would no longer reproduce
  current behaviour and would stop being a kill switch — which the rollout plan depends on.

  The `min` is a safety clamp: today `stake_amount + borrower_reward >= max_punishment >= 0`
  holds because `stake_amount >= min_payment + max_punishment` is enforced in `request_loan`,
  and without the clamp the burn could drive the `loan_result` payout negative. It fixes the
  priority order as **the pool first, then the burner, then the borrower**.
- `contracts/treasury.fc` — `recover_stake_result`, `reward < 0` branch: the same rule, after
  the punishment is taken and after the pool takes up to `min_payment`.

  ```
  treasury_reward = min(stake_amount, min_payment);
  stake_amount -= treasury_reward;
  if (borrower_fee > 0) {
      ;; reward < 0 here, so the contractual base is zero and only the floor applies
      burn_share = min(stake_amount, fee::min_burn);
      stake_amount -= burn_share;
  }
  ```

  Priority here is punishment, then the pool, then the burner, then the borrower. **This branch
  also needs `reserve_amount` adjusted**: it is
  `max(0, incoming_ton - stake_amount - fee - recover_stake_fee)`, so shrinking `stake_amount`
  by `burn_share` without subtracting `burn_share` there as well would silently *reserve* the
  burn in the treasury instead of sending it — the feature would look correct while the money
  stayed put.
- `contracts/treasury.fc` / `contracts/imports/utils.fc` — **widen `borrower_reward_share` to
  `uint16` out of 65535**, per "Widening borrower_reward_share" above. Touches the
  `request_loan` parse (plain `uint16`, no compatibility tail), `pack_request` /
  `unpack_request` (16 bits in natural position), `request_sort_key` (key widens to 120 bits),
  the `treasury_reward` computation in `recover_stake_result`
  (`muldiv(reward, 65535 - share, 65535)`), and `log_loan`. All ten `udict_*(112, ...)` call
  sites on `sorted` become `udict_*(120, ...)`.
- `scripts/` — a **migrator** run via `upgrade_code`'s `migrate_code` ref, per "One-phase
  rollout with a migrator". Fully inlined, carrying its own copy of the request layout.
- `contracts/treasury.fc` / `contracts/imports/utils.fc` — **snapshot `borrower_fee` into the
  request.** `pack_request` appends the rate as a `uint16` after `new_stake_msg`, and
  `recover_stake_result` uses the snapshotted value rather than the current one, so a loan is
  always recovered at the rate it was requested under.

  This is required, not a refinement. `borrower_fee` is otherwise read at recovery, so a
  governance change would retroactively alter the terms of loans already committed — and the
  obvious mitigation, changing the rate only between rounds, **does not exist**: with
  interleaved round chains there is always a participation in states 1-5.

  The new fixed layout is `min_payment` (coins), `borrower_reward_share` (`uint16`),
  `loan_amount`, `accrue_amount`, `stake_amount` (coins), `borrower_fee` (`uint16`), then the
  `new_stake_msg` ref — with `end_parse()` preserved, since the migrator converts every
  in-flight record and no legacy form ever has to parse. `pack_request` uses ~300 bits of 1023
  with one ref, so both new fields cost nothing structurally. Its return tuple widens from 6 to
  7, which touches every `unpack_request` call site.
- `contracts/treasury.fc` — `request_loan`: the collateral check becomes
  `stake_amount >= min_payment + max(fee::min_burn, muldiv(min_payment, borrower_fee, 65535)) + max_punishment`
  when `borrower_fee > 0`, so the tax is committed at request time. `request_loan` currently
  reads only root fields and does **not** call `unpack_extension()`; reading `borrower_fee`
  adds a cell parse to that path, so `gas::request_loan` and the `request_loan_fee()` budget
  both move and must be re-measured rather than assumed.
- `contracts/treasury.fc` — send `burn_share` explicitly, before `take_profit`, non-bounceable
  and with `send::pay_gas_separately + send::ignore_errors`. It must **not** be folded into
  `reserve_amount`: reserving it would leave the coins in the treasury balance without a
  matching `total_coins` increase, where `get_surplus` would report them as withdrawable
  surplus. `ignore_errors` is required — `recover_stake_result` is non-bounceable, and a throw
  there strands the round in `recovering` forever and blocks every later round's bills.
- `contracts/treasury.fc` — `set_borrower_fee`, governor-only, mirroring `set_governance_fee`.
- `contracts/imports/utils.fc` — `log_repayment` gains `burn_share`, stored after
  `borrower_share` and before the `borrower` address.
- `contracts/imports/utils.fc` — `request_loan_fee()` gains one `s_fwd_fee` in **both**
  `forward_fee` (the whole-lifecycle `total`) and `recover_forward_fee` (what is left
  unreserved at recovery to pay for that transaction's sends). Without the second, the new
  send competes with `loan_result` and `take_profit` for the same unreserved remainder.
- `contracts/imports/constants.fc` — `gas::recover_stake_result` rises by one send plus a
  `muldiv`, and `gas::request_loan` rises by an `unpack_extension()` call it does not make
  today. Both feed `request_loan_fee()`, so the prepaid loan fee rises. That is operationally
  safe — borrowers read the fee dynamically before attaching gas rather than hard-coding it —
  but the `MaxGas`/`MinGas` bounds must still be re-derived deliberately rather than edited
  until they pass.
- `contracts/schema.tlb`, `docs/integration.md` — the `log::repayment` and `log::loan` layouts,
  the new governance op, the new getter, and the **breaking** `uint8` -> `uint16` change to
  `borrower_reward_share` in `op::request_loan`, called out as breaking with the
  `share8 * 257` conversion so integrators can port their existing value exactly.
- `docs/architecture.md` — the "Loan economics" section, which currently describes the split
  as borrower share → `governance_fee` → pool, with no third cut.
- `contracts/treasury.fc` — new getter `get_loan_request(int round_since, slice borrower)`
  returning `(found?, stage, min_payment, borrower_reward_share, loan_amount, accrue_amount,
  stake_amount, borrower_fee)`, where `stage` names which dict the request was found in
  (`requests`, `rejected`, `accepted`, `accrued`, `staked`, `recovering`). Today none of a
  borrower's bid is observable: `get_participation` returns the raw dicts, so a caller must know
  the internal packing, and `min_payment` can only be inferred from `total_borrowers_stake`
  arithmetic. Getters cost nothing on-chain.
- `wrappers/Treasury.ts` — the setter, the new getter, and the `Request` / `TreasuryConfig` fields.
- `wrappers/burner.ts` — reads `burner::wc` / `burner::addr` out of `constants.fc`, so the script and
  the tests share one source for an address that only exists in the contract source.
- `scripts/setBorrowerFee.ts` — governance script. It prints the share every borrower currently in
  the book bid and what the rate would take from each, because the same rate is a different deal for
  each of them, and requires the value typed twice.
- `scripts/showState.ts` — `borrower_fee`, shown as disabled when zero.

## Invariants

- **Exchange-rate identity.** The cut is deducted from `stake_amount`, which flows to the
  borrower. It never touches `treasury_reward`, `new_coins`, `total_coins` or `total_tokens`,
  so minting and burning arithmetic is unaffected and the rate still only moves through
  `new_coins`.
- **Rate monotonicity.** Unchanged: nothing here subtracts from `total_coins`.
- **`min_payment` is still guaranteed.** `treasury_reward = max(min_payment, ...)` is computed
  before the cut and is not reduced by it, so the pool's floor is untouched and stakers cannot
  be made worse off by the cut than they are today.
- **Payout priority.** Punishment (where applicable), then the pool, then the burner, then the
  borrower. The `min(stake_amount, ...)` clamp enforces it and keeps the `loan_result` payout
  non-negative, preserving today's `stake_amount + borrower_reward >= max_punishment >= 0`.
- **`borrower_fee = 0` is a total kill switch.** Guarded by `borrower_fee > 0` in all three
  places (both recovery branches and the `request_loan` check), so a zero rate reproduces
  current behaviour exactly, floor included.
- **`deficit` accounting.** The burn is taken after `deficit += shortfall` and only from
  collateral that survived the punishment, so it can never increase a shortfall or mask one.
- **No retroactive repricing.** A loan is recovered at the rate snapshotted in its request, so
  a `set_borrower_fee` mid-flight cannot change the terms of a committed loan.
- **A reward spike cannot cause a loss.** While the share formula binds the borrower's net is
  `(G/255)[s - f(255-s)]`, whose sign is independent of the reward `G`. Any rate below
  `f_max = s/(255-s)` leaves the borrower profitable at every reward level.
- **Collateral safety.** The cut applies only when `reward >= 0`. A defaulting borrower's
  collateral is never routed to the burner, and `deficit` accounting is unchanged.
- **Participation state machine.** No state transitions change. The new send is fire-and-forget
  with `ignore_errors`, so a broken or undeployed burner cannot wedge `recover_stake_result`,
  cannot leave a round in `recovering`, and cannot block `owes_reward?` for later rounds.
- **No new external dependency in the lending path.** `request_loan`, `distribute`,
  `decide_loan_requests` and `process_loan_requests` are untouched, so the gas-bounded loops
  and the 255-message caps are unaffected.

## Compatibility

- **Stored data.** The extension, every stored request, and every `sorted` dict change layout.
  All three are converted by the migrator in one deployment — see "One-phase rollout with a
  migrator". See `scripts/upgrade_treasury.md`; the migrator must obey the two-method-id rule
  so it stays fully inlined.
- **Deploy window.** Send the upgrade while `total_borrowers_stake` is zero, so no pending
  requests exist and the `sorted` rebuild is a no-op.
- **Extension headroom.** After this change the extension holds 640 bits on realistic values
  (1023 available) and **all four refs**. Any future field that needs a ref forces a
  restructure of the cell; that is a pre-existing condition, not one this change creates, but
  it is the reason `burner` is a constant here.
- **Rollout ordering.** The upgrade ships with `borrower_fee = 0`, which reproduces today's
  behaviour exactly; `32767` is set by `set_borrower_fee` in a separate governance action once
  the upgrade is confirmed healthy. `0` remains the kill switch. **Upgrade the treasury before the
  borrowers**, not after: both orders have a window in which requests bounce, but the treasury's
  deploy condition (`total_borrowers_stake == 0`) already puts you between request windows, so that
  window is one you choose rather than one you wait out. See `scripts/upgrade_treasury.md`.
- **In-flight rounds.** The migrator sets `borrower_fee = 0` on every converted request, so no
  round staked before the upgrade is taxed, whatever the rate is set to afterwards.
- **Borrower software.** Breaking: `op::request_loan` now requires a `uint16`
  `borrower_reward_share`. An old-format request throws on cell underflow and bounces, returning
  the collateral, so no funds are at risk and the borrower learns immediately. Existing bids
  port exactly as `share8 * 257`.
- **Message schemas.** `log::repayment` gains a field — integrators parsing it sequentially
  must be updated. `docs/integration.md` and `contracts/schema.tlb` change accordingly.
- **Getters.** `get_treasury_state` gains one return value; wrappers and any external reader
  destructuring it positionally must be updated. The burner address is readable from the
  source and from the code hash rather than from a getter.
- **Changing the burner.** Requires a treasury upgrade, not a governance message. Accepted
  deliberately — see the Decision section.

## Test plan

- `Loan.spec.ts` — with `borrower_fee > 0` and `reward > 0`: the burner receives
  `muldiv(muldiv(reward, borrower_reward_share, 255), borrower_fee, 65535)`, the borrower
  receives the remainder plus collateral, and `total_coins` is unchanged relative to a
  `borrower_fee = 0` run.
- `borrower_fee = 0` reproduces current balances exactly, message for message.
- **Bypass test — `min_payment >= reward`.** The borrower still pays the full cut, funded from
  collateral, and the pool still receives `min_payment` in full. Must fail against a build that
  taxes the realised `borrower_reward`.
- **Bypass test — `borrower_reward_share = 0`.** The pool receives the whole reward and the
  borrower still pays the cut from collateral. Must fail against a build that taxes only the
  borrower's contractual share.
- **Floor test.** A loan whose `treasury_reward` is small enough that the rate yields less than
  `fee::min_burn`: the burner receives exactly `fee::min_burn`.
- **Kill-switch test.** `borrower_fee = 0` reproduces current balances exactly, message for
  message, and the burner receives nothing — specifically *not* `fee::min_burn`.
- **Clamp test.** Collateral only just covers `min_payment` plus a partial cut: the burner
  receives what is available, the `loan_result` payout is non-negative, and the pool is paid
  ahead of the burner.
- **Punish branch.** `reward < 0` with collateral surviving the punishment: the pool takes up
  to `min_payment`, the burner takes its cut from the remainder, `deficit` matches the current
  path, and the reserved amount is reduced by `burn_share` so the burn actually leaves the
  treasury rather than being reserved.
- **Punish branch, collateral exhausted.** The burner receives nothing and `deficit` is
  unchanged from the current path.
- `request_loan` rejects a request whose collateral does not cover
  `min_payment + burn floor + max_punishment`, and accepts one that does.
- **Snapshot test.** Request at one rate, `set_borrower_fee` to a different rate before
  recovery, and confirm the loan is charged the rate from its request.
- **Legacy-request test.** A request packed without the rate field parses as 0 and recovers
  untaxed — the in-flight upgrade path.
- **Scale-invariance test.** Recover the same loan against a 2x and a 0.5x reward: the burn
  moves proportionally and the borrower keeps `(1 - borrower_fee/65535)` of their contracted
  share in both cases.
- **Maximum-rate test.** `borrower_fee = 65535`: the borrower keeps none of their reward but
  loses no collateral beyond `fee::min_burn`, and the pool's `treasury_reward` is unchanged.
- **`borrower_reward_share = 0` test.** The base is zero, the burner receives exactly
  `fee::min_burn`, and the pool receives the whole reward.
- **Getter test.** `get_loan_request` returns the bid a borrower submitted, reports the correct
  `stage` as the round advances through `requests` -> `accrued` -> `staked`, and reports
  `found? = false` for an unknown borrower or a deleted round.
- **Legacy wire format is rejected loudly.** An old-format `op::request_loan` throws on cell
  underflow, the message bounces, and the borrower's collateral is returned in full — no silent
  misparse and no funds stranded.
- **Share precision.** Two bids differing by one unit out of 65535 produce payouts differing by
  that proportion, and `treasury_reward` for `share16 = share8 * 257` matches the pre-upgrade
  computation exactly for the same reward.
- **Sort-key ordering — the truncation hazard.** A bid worse for the pool by 1..255 out of 65535
  must rank strictly below a better one, even when the better bid asks for a larger loan. This
  test must fail against a build that truncates the share into an 8-bit slot.
- **Sort-key range.** `request_sort_key` never exceeds `2^120 - 1` at the extremes of
  `efficieny`, `treasury_reward_share` and `loan_amount`, and `sorted` is keyed at 120 bits
  throughout.
- **Migrator equivalence.** A request converted by the migrator parses identically to one packed
  fresh by `pack_request` from the same inputs — the guard against the migrator's private copy
  of the layout drifting from the contract's.
- **Migrator end-to-end.** Upgrade a treasury carrying live participations in `staked` and
  `recovering`: every request survives with `share8 * 257` and `borrower_fee = 0`, rounds
  recover with unchanged payouts, and `sorted` is rebuilt correctly when a request is pending.
- Burner is an uninitialised address: recovery still completes, the round leaves `recovering`,
  and later rounds' bills are not blocked.
- `Governance.spec.ts` / `Access.spec.ts` — `set_borrower_fee` accepts the governor and
  rejects everyone else, including the halter.
- `MaxGas.spec.ts` / `MinGas.spec.ts` — re-derive the `recover_stake_result` bound and the
  `request_loan_fee` components; confirm a loan lifecycle is still fully covered by the
  prepaid fee with the extra send.
- Upgrade test covering the extension migration from the current layout.

## Out of scope

- The burner contract itself (GRAM → HPO swap and burn). The treasury only sends GRAM to an
  address; the swap is done by hand until a contract exists.
- Any change to `governance_fee` or its value.
- The HPO ticket mechanism — see `2026-08-31-hpo-tickets-for-loans.md`.
- Raising `min_payment` to 400 and the `loan_amount` floor to 1,000,000. Those are changes to
  the borrowers' request scripts, not to the contracts; done 2026-09-04, independently of this
  upgrade.
- Any further widening of `pack_participation`, which is untouched here.
- Making the burner address settable, and any restructuring of the extension cell to allow it.
- The `min_payment = 0` / `borrower_reward_share = 255` auction weakness — see
  `2026-09-02-minimum-bid-efficiency.md`. `fee::min_burn` means such a bid still burns, but the
  underlying problem (a bid that returns nothing to the pool can win on spare capacity) is not
  addressed here.
