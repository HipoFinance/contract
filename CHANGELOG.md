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

## Not yet deployed — A borrower-set cap on the stake a loan request will accept

· Spec [`2026-09-26-request-stake-cap.md`](docs/specs/2026-09-26-request-stake-cap.md)

Closes the known gap below. **Breaking for borrowers:** `request_loan` requires `max_stake` right
after `min_payment`: the most the loan will stake in total, loan + accrue + collateral (own stake
included), or 0 for no cap. `decide_loan_requests` stops a capped loan's accrual at the cap before
the collateral check and the scaling, and what it does not take stays in the treasury for the next
round. A cap below `loan_amount` + collateral is refused. A body without the field is refused and its
collateral bounced, and the code before this release refuses a body with it, so borrower software
switches on the treasury's code hash. A request with 0 is decided exactly as before. The request cell
gains the field; requests packed by the previous code read as uncapped, so there is no migrator.
`get_loan_request` gains a ninth value, appended.

---

## 2026-09-26 — Accrued capital priced at the bid's own rate

**Treasury code** `f003de4b9ab34a61dd7d70a0a68a5faaf6ac0a8821ff2d720f9fecf8dd71475d`
· Spec [`2026-09-22-price-accrual-at-bid-rate.md`](docs/specs/2026-09-22-price-accrual-at-bid-rate.md)

Announced 2026-09-23 and deployed 2026-09-26 at 03:29:35 UTC, inside the gap after round
1790398216 was decided (02:18:47) and before the next round opened (04:50:20), so no bid made under
the old rule is decided under the new one.

When a round's leftover accrues to a loan, the loan's `min_payment` is scaled by
`(loan_amount + accrue_amount) / loan_amount`. Borrowers are ranked on `min_payment / loan_amount`;
from this release that number is what they pay per GRAM of everything they stake, rather than per
GRAM requested. The pool collects at most the reward plus the borrower's collateral. No storage,
message or getter changes; no migration.

**Known gap, found after the announcement:** the elector pays nothing on stake above its cap, but the
scaling charges the bid rate on everything lent. A loan that ends up with most of the pool -- the only
one accepted, say -- can pass that cap, and then even a `min_payment` at the pool's contractual share
binds. With the pool (~3.7M) above the cap (~3.06M) today, careful borrowers price below the bare loan
to stay safe. A borrower-set cap on the stake a request will accept is being specified to close it.

---

## 2026-09-21 — Reward share set by the protocol

**Treasury code** `6cd64455cf733d84a56da540b1ad757e966bdbe8146fe32d52c01efc038a8c6c`
· Specs [`2026-09-19-protocol-set-reward-share.md`](docs/specs/2026-09-19-protocol-set-reward-share.md),
[`2026-09-20-prepaid-request-fees.md`](docs/specs/2026-09-20-prepaid-request-fees.md),
[`2026-09-20-remove-retry-distribute.md`](docs/specs/2026-09-20-remove-retry-distribute.md)

**`borrower_reward_share` is no longer bid.** It is a protocol parameter the governor sets with the
new `op::set_reward_share`, held in the extension as a `uint16` after `borrower_fee` and snapshotted
into each request at `request_loan` — exactly as `borrower_fee` already was, so a bid already made
cannot be repriced. It was seeded at `1799`, the value every request on chain had been bid at, so
the release changed no economics on landing.

The pool's take on a loan is `max(min_payment, reward × (65535 − share) / 65535)`, and while the
borrower chose the share, the borrower chose which of those two terms binds. A bid of share 65535
with `min_payment` 0 makes both zero, and a last-ranked bid still wins whatever the bids above it
leave — so the pool could be paid nothing for lending its coins, and rank could be bought with one
quantum of `min_payment` and taken back in the share. With one share for every bidder,
`request_sort_key` is unchanged and now orders bids exactly by what the pool receives, and the pool
has a floor of `(65535 − share) / 65535` of every reward where it previously had none.

That floor is on the **split** of a reward, not on revenue: a stake the Elector accepts but does not
elect earns nothing, and a share of nothing is nothing. Unchanged by this release.

**Prepaid request fees are held back from instant unstakes.** A `request_loan` prepays the gas its
round spends on `proxy_new_stake` and `proxy_recover_stake`. `distribute` and `calculate_min_coins`
already reserved that money, but `reserve_tokens` and `burn_tokens` did not, so an instant unstake
could take it and leave a round unable to pay for its own message chain — a fixed 10 GRAM storage
floor against a need that grows with the number of bidders. Root gained `total_request_fees`
(`coins`, after `total_borrowers_stake`), maintained where a request's lifecycle begins and ends and
subtracted in those two handlers and in `get_max_burnable_tokens`. The migrator reconstructs it by
walking `participations`. No unstake is lost to it: an instant unstake it blocks takes the deferred
path, as one already does whenever the pool is short.

**`retry_distribute` is removed**, op `0x6ec00c48` retired and not reused. Re-running `distribute` on
a round that had already run `decide_loan_requests` erased that round's accepted and accrued requests
without refunding them, and left `total_borrowers_stake` counting collateral nothing could release.
It had never been run on mainnet.

`get_treasury_state` **appended** `reward_share` and then `total_request_fees`, taking it from 26
values to 28.

**Integrators:** `op::request_loan` is a **breaking change** — the 16-bit `borrower_reward_share` is
gone from the body, and a message still carrying it throws at `end_parse` and bounces, with the
collateral intact but the round missed. Borrowers must roll with the treasury, and must now read
`reward_share` from `get_treasury_state` (index 26) to price a bid at all, since they can no longer
state it. Getter positions 0–25 are unchanged and keep their meaning. Anything that parses
`request_loan` bodies out of blocks must accept both shapes and go on accepting both: every request
made before the upgrade carries the share, and those bodies stay on chain.

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
