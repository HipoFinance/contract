# Upgrade Treasury

## How migrations work

A storage migration no longer gets pasted into `upgrade_data` and then reset with a second
deploy. It travels inside the upgrade message as `migrate_code`, and the treasury blesses
that cell and executes it once, in the same transaction, before its own `load_data()` and
governor check run. So there is **one** signed transaction, nothing one-off is ever stored on
chain, and the released code hash stays the hash of the plain contract.

**A migrator is code, not data. It runs with the treasury's full authority.** That is no more
power than the `new_code` in any upgrade already has — that code's `upgrade_data` runs under
`set_c3` and can do anything — but it moves the one-off logic out of the reviewed, hash-published
code release and into a message field. So:

- publish the **migrator hash alongside the code hash**, and have every signer read the migrator
  source, not just the code hash;
- `upgradeCode.ts` prints the migrator source in full and demands its hash typed back before it
  will send, so this cannot be skipped by scrolling.

### The dry run

Before asking for any confirmation, `upgradeCode.ts` fetches the treasury's **actual code and
storage from the network**, replays the entire upgrade against them in a local sandbox, and prints
a field-level diff of what would change:

```
  code hash   966d5606af61ec8f -> ee2b6f02d1ae9fd8
  data hash   316841b16867dd41 -> 3d6a8e2033a69abd
  data size   450 bits / 3 refs -> 454 bits / 3 refs

  STATE DIFF: 1 field(s) would change.

    deficit  - absent (getter not in this code)
             + 0
```

So the operator approves observed behaviour on real state, not a description of intent. An
unintended change is a visible line rather than a discovery after the fact.

If the dry run fails, the script aborts without offering to send. That also catches the mistake
most likely to actually happen — **forgetting the migrator**, which leaves the new code reading a
layout one field short:

```
  RESULT: upgrade would FAIL with exit code 9
  Nothing would change on chain: the treasury would stay on its current code
  with its current data. Do not send this upgrade.
```

The diff compares every field `get_treasury_state` exposes, plus the deficit, the exchange rate,
and the storage cell's hash and size. It does **not** compare the _contents_ of `participations`,
`loan_codes`, `collection_codes`, `bill_codes` or `old_parents` — only their entry counts, since
migrations move them as opaque refs. The printed output says so too.

### What is and is not guaranteed on failure

**Provided the migrator contains no `COMMIT` and no `SETCODE`**, any failure — an unparseable
result, a governor that no longer matches, out of gas, an infinite loop, junk left on the stack —
exits non-zero, discards `c4` and `c5`, and leaves the treasury on its **old code with its old
data**. `set_code` is an action, so it never takes effect. This is measured, not assumed.

Those two preconditions are not decoration:

- **`COMMIT`** locks in `c4` and the already-queued `set_code`, making every check afterwards
  decorative. A migrator that commits and then writes an unparseable cell leaves the treasury on
  the new code with storage `load_data()` cannot read — and `recv_internal` loads data before
  dispatch, so **no further `upgrade_code` can ever be received. That is unrecoverable.**
- **`SETCODE`** is appended after the `set_code` that `upgrade_code` queued, and the last action
  wins, so a migrator could redirect the treasury to code the upgrade message never named.

**Absent is the only way to say "no migration".** Anything present is executed, and anything that is
not a migrator throws and reverts. An empty cell is deliberately _not_ accepted as a second way to
mean nothing: tolerating it would let a value-only migration — one that changes numbers without
changing the layout, as dead-shares did — skip silently while the upgrade reported success, because
`load_data()` would parse the unmigrated cell perfectly well. Older revisions of `upgradeCode.ts`
sent an empty cell unconditionally, so an upgrade driven by one of those will fail; update the script
rather than working around it.

Both are enforced mechanically by `tests/TreasuryMigration.spec.ts`, which also asserts the
migrator compiles to exactly two method ids, `0` and `0x6d67`. That second rule matters because
**`EXECUTE` does not set `c3`** — `c3` still holds the treasury's own code while a migrator runs,
so a non-inlined function in a migrator compiles to `CALLDICT` and would dispatch into the
_treasury's_ dictionary. Two method ids means fully inlined, which makes that impossible.

The post-migration check proves the result **parses** under the new layout and still names the
same governor. It does **not** validate accounting: a migrator that writes a wrong `total_coins`
will be accepted. That is deliberate — migrations sometimes need to change those values, as the
dead-shares migration did — but do not mistake the check for an accounting guarantee.

### The parent does not run migrators yet

`migrate_code` is named that way throughout `treasury.fc`, including in `proxy_upgrade_code`, which
forwards an upgrade to another contract. **`parent.fc` has not been given this mechanism.** It still
carries the plain template, which ignores the cell entirely, so a migrator proxied to the parent is
**silently dropped rather than executed**.

That fails safe in the case that matters: a parent migration that was needed and did not run leaves
the new code reading the old layout, `load_data()` throws, and the upgrade reverts whole. The bad
case is a migrator meant to do something other than change the layout — it would be dropped without
a word while the upgrade reported success.

**Do not proxy a migrator to the parent until `parent.fc` runs one.** Giving it `run_migrator` and
the same null-and-empty guard is a TODO for whenever a new parent is deployed, which is also when
its code hash is free to move.

### Writing one

Put it in `wrappers/upgrade-code-test/`, entered at `method_id(0x6d67)`, plain FunC with no `asm`,
and let it carry whatever constants it needs in its own source. Parse the old layout by hand
rather than through a helper: by the time it runs, `set_c3` has already happened, so the
treasury's `load_data()` is the **new** parser and would misread the old cell. End that parse with
`end_parse()` — that is what makes a second run throw and revert instead of corrupting.

## Changing the shape of a getter

`get_treasury_state` returns a flat tuple that every consumer reads **positionally**. A field inserted
into the middle of it breaks nothing on chain and every off-chain reader — so **append**. Storage is a
separate question with a separate answer: nothing off chain parses the extension cell, so a new field
goes wherever it belongs there, and only the tuple has to stay append-only. The round-duration release
tied the two together and paid for it; the census below is what that cost.

Insert only when there is a reason that survives contact with this section, and then treat the list
below as the rollout checklist — for that tuple, or for `get_times`, `get_participation`,
`get_loan_request` or `get_treasury_fees` — and grep `~/code/HipoFinance/` for the method name before
sending, because the list is a floor. Where a field lands matters even then: an insert after
`last_settled_round` spares `yield-server`, and one after `current_rate` does not.

**In this repo**, updated in the same commit as the contract: `wrappers/Treasury.ts`
(`getTreasuryState`, `TreasuryConfig`), `wrappers/migrationDryRun.ts`, `scripts/showState.ts`.

**Ours, deployed alongside the upgrade:**

| repo                 | reads                                                                               | notes                                                    |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `borrower`           | `process.go`, tonutils-go, indices for `participations`, `stopped?`, `borrower_fee` | **roll this one with the treasury** — see below           |
| `website`            | through the sdk wrapper                                                             |                                                          |
| `mcp`                | through the sdk wrapper                                                             |                                                          |
| `sdk`, `sdk-example` | `Treasury.ts`, sequential `stack.read*`                                             | the wrapper everything else inherits                     |
| `gauge`              | `actor/treasury.go`, checks the field count                                         | the check was an equality; **broke on an append** — see below |
| `vesting`            | `index.html`, `HIPO_JETTON_MINTER_ADDRESS_INDEX`, then `.loadAddress()`             | live at `vesting.hipo.finance`; fixed 2026-09-07          |
| `club`               | built bundle in `HipoFinance/club`; source is `HipoGang/webapp`, via the `sdk`       | live at `club.hipo.finance`; fixed 2026-09-07 by an SDK bump |
| `dune`               | `exporter/export-rates.mjs`, indexed with a comment naming each position             | its cron failed silently for a day; fixed 2026-09-07      |
| `burner`             | `scripts/deployBurner.ts`; `imports/constants.fc` cites an index in a comment        | deploy-time only; was broken, fixed 2026-09-07           |

`club` deserves its own line in a rollout, because fixing it is not a code edit. The source is
`HipoGang/webapp`, which reads the treasury only through `@hipo-finance/sdk`, so it is fixed by
bumping that dependency. Deploying it means: **pull `HipoFinance/club` first** — the team pushes
built artifacts there directly, and `HipoGang/webapp` may be behind — then `npm run build` and copy
`dist/` over the whole repo. `dist/` is the complete site, `public/` and all.

Readers that take only `total_coins` and `total_tokens` survive any insert after index 2 and are
listed so the next census does not have to rediscover them: `hpo-trader/trader/tonclient/hipo.go`
(and its comment is right — never read the rate pair as an exchange rate) and
`website/scripts/hipo-fund-snapshot.mjs`.

`driver` and `hipostat` read the tuple too, both from a shape several releases stale. Both were
archived on 2026-09-07 and are no longer part of any rollout.

**Upstream, needing merged PRs:** `dimension-adapters/fees/hipo` reads `stack[1]`, `[12]`, `[13]`,
`[14]` and `[19]`; `yield-server/src/adaptors/hipo` reads `stack[12]`, `[13]` and `[14]` and stops.
`DefiLlama-Adapters/projects/hipo` reads `result[0]` and `result[2]`, so it survives any insert
after index 2. Open these once the new shape is live on chain, since the adapters have to read the
tuple as it actually is. Note how much the exact insert point matters: an insert after
`last_settled_round` spares `yield-server` and an insert after `current_rate` does not.

### The census of 2026-09-07, and why this list is still only a floor

The `borrower` failure below was not the only one. A grep of `~/code/HipoFinance/` on 2026-09-07 —
the one this section already tells you to run — found that the round-duration release broke three
more readers that were on nobody's list, because `deficit` took index 5, the slot `parent` had
occupied. `vesting` and `club` are both live user-facing sites and both call an address reader on
what is now an integer, so they throw; on `vesting` that is the call that resolves a holder's hGRAM
wallet address. `dune`'s exporter is a scheduled job, so it failed where nobody was looking: last
success 2026-09-06 11:04 UTC, then four straight failures before anyone noticed. All three were
fixed on 2026-09-07, along with `burner`, which the table had listed as unverified and which turned
out to be broken the same way.

A note on how that last fact was nearly missed. The first pass through `dune` read a **stale local
clone** and concluded the exporter had been dormant since 2026-08-20 — off by two weeks, and it
would have made the outage look like an old, low-stakes one instead of same-day fallout from this
release. `git fetch` before judging a sibling repo's state, and prefer `gh run list` over the commit
log for anything driven by a cron.

Two lessons, in order of importance. First, **run the grep, and grep the deployed artifacts too** —
`club` was only found because the search covered a built `assets/index-*.js` bundle with no local
source. Second, this is the argument that reversed the insert-don't-append decision in
`docs/specs/2026-09-07-two-round-rate-window.md`: a list that has twice failed to be the population
is not a list worth re-running for the sake of field adjacency. **Prefer appending unless there is a
reason that survives contact with this section.**

### Appending is not free either: `gauge`

The two-round-window release appended, moved no existing index, needed no upstream PR — and still
took `gauge` off the air. Its reader guarded itself with `fields != 24`, so a tuple that grew to 26
failed the check and `getTreasuryState` returned an error before reading anything. The whole treasury
series stopped, on an upgrade that could not have touched a single field it reads.

The guard was right to exist and wrong in its comparison: **too few is fatal, too many is not.** A
short tuple means an older treasury whose indices are shifted, and the accessors panic on the type
they did not expect. A long one means the treasury grew, and it only grows by appending. Fixed in
`gauge` to `fields < 24`, with the rule split into a testable function.

So when checking readers before a release, do not stop at "does this index still mean what it says".
Also ask **whether anything asserts the tuple's length**, in a wrapper, a schema, or a test. That is
a different failure and appending does not spare you from it.

### Why `borrower` is not just one more reader

It is the only off-chain sender of `finish_participation` (`op::finish_participation`, `0x23274435`)
— nothing else in the fleet sends it, and the contract has no timer of its own. `loadTreasuryState`
runs at the top of its `Process` loop, so a shifted index takes out the `request_loan` loop and the
recovery poke in the same panic, for every operator running it, not just ours. The failure leaves no
trace on chain to search for: the request never gets built, so there is no bounced message, only
wallets that stop sending.

The consequence is that stakes stay in the elector past `stake_held_until` until somebody pokes the
treasury by hand (`scripts/finishParticipation.ts`) or a borrower on a working build comes along.
That is what happened on 2026-09-06: this release went out without `borrower` on the list, two nodes
missed round `1788759816` entirely, and round `1788628744`'s stakes came back about six hours late,
after a `stake_not_returned` alert. Fixed in `borrower@37f2e4e`.

## Add Deficit Field

> **Already performed on mainnet, 2026-08-25 08:37:57 UTC. Kept as the record of what was run.**
> The upgrade carried code hash `SNR/og76GL2ZxdSSKNEy4HAjs0W4xWpXRvEG5abK3+A=` — the plain
> `Treasury` build, no leftovers — and migrator `f7ce19beb5d30494…`, which is
> `upgrade-code-test/AddDeficit`. `get_deficit()` on the treasury returns 0 and every other field
> is unchanged. `migratorName` is back to `null`. Do not re-run it: the migrator ends its parse
> with `end_parse()`, so a second run throws and reverts the whole upgrade.

One-off migration for the deficit counter, inserting a `deficit` field into root storage between
`total_borrowers_stake` and `parent`, starting at zero. Ship it in the same `upgrade_code` that
deploys the treasury carrying the deficit counter and the borrower refund fix.

The migrator is `wrappers/upgrade-code-test/add_deficit.fc`. It is exercised against a snapshot of
the live mainnet account — real deployed code, real storage cell — in
`tests/TreasuryMigration.spec.ts`.

1. In `scripts/upgradeCode.ts`, set:

    ```ts
    const migratorName: string | null = 'upgrade-code-test/AddDeficit'
    ```

2. Run the script. It prints the migrator hash and its full source, and requires the hash typed
   back before sending. Read the source at that prompt; it is the last point before signing.

3. Set `migratorName` back to `null` once the migration has landed, so the next upgrade does not
   carry it.

4. Verify with `showState.ts`: `get_deficit()` returns 0, and `total_coins`, `total_tokens`,
   `parent`, `governor`, `halter` and the exchange rate are all unchanged. The code hash should
   equal the plain `Treasury` build.

## Mint Dead Shares

> **Superseded procedure, kept as the record of what was actually run.** This migration was
> performed with the old two-deploy method: paste into `upgrade_data`, deploy, reset, deploy
> again. New migrations use `migrate_code` instead — see _How migrations work_ above.

One-off migration for the dead-shares upgrade (see
`docs/specs/2026-07-18-mint-dead-shares.md`). It mints unowned shares backed by the
already-present 10 GRAM storage buffer, **at the current exchange rate**, so existing
holders are not diluted and the treasury balance does not change. Run it in the same
`upgrade_code` that ships the code removing the zero-guards.

1. Use this migrate code in `treasury.fc`:

    ```func
    () upgrade_data(slice src, int query_id, cell new_data, slice return_excess) impure method_id {
        ;; Add code for upgrading data here.

        ;; This is just a template, and will only run after upgrade_code.
        ;; If data is upgraded, remember to reset this code,
        ;; so that the next upgrade won't change data by mistake.
        int dead_tokens = muldiv(fee::treasury_storage, total_tokens, total_coins);
        total_coins += fee::treasury_storage;
        total_tokens += dead_tokens;
        save_data();

        ;; Do not change the following code.
        governor = null();
        load_data();
        unpack_extension();

        throw_unless(err::access_denied, equal_slice_bits(src, governor));

        builder excess = begin_cell()
            .store_uint(op::gas_excess, 32)
            .store_uint(query_id, 64);
        send_msg(false, return_excess.to_builder(), null(), excess, 0, send::remaining_value + send::ignore_errors);

        throw(0);
    }
    ```

2. Run the `upgradeCode.ts` script.

3. Reset the `upgrade_data` function and `upgradeCode.ts` script and deploy again to bring
   treasury back to the released code hash.

4. Verify with `showState.ts`: the exchange rate is unchanged, `total_coins` grew by
   exactly 10 GRAM, and `total_tokens` grew by `muldiv(10 GRAM, total_tokens, total_coins)`
   (computed on the pre-migration values).

## Add a New Bill Code

> **This procedure no longer works as written and must be redesigned before its next use.** It
> passes the bill code through `new_data` as _data_, and that field is now `migrate_code`, which
> the treasury executes. Passing a plain data cell there fails the upgrade — safely, but it fails.
>
> Rewriting it as a migrator runs into one open problem: FunC has no cell-literal syntax, so a
> migrator cannot embed an already-compiled cell such as `Bill` in its source. Solving that needs
> either a payload channel alongside the migrator, or a migrator that reads a ref attached to its
> own cell. Neither is built. Steps below are kept for the sequencing, which is still correct.

1. Add the new code as a library using `addLibrary.ts` script:

    ```ts
    const code = await compile('Bill')
    ```

2. Add the new code as new data for the migrate process in `upgradeCode.ts`:

    ```ts
    const mainBillCode = await compile('Bill')
    const billCode = exportLibCode(mainBillCode)
    const newData = beginCell().storeRef(billCode).endCell()
    ```

3. Find the last `round_since` in a state after `open` using the `showState.ts` script. Add 1 to that value and use it in the next step instead of `X`.

4. Use a migrate code in `treasury.fc` like this:

    ```func
    () upgrade_data(slice src, int query_id, cell new_data, slice return_excess) impure method_id {
        ;; Add code for upgrading data here.

        ;; This is just a template, and will only run after upgrade_code.
        ;; If data is upgraded, remember to reset this code,
        ;; so that the next upgrade won't change data by mistake.
        slice s = new_data.begin_parse();
        cell bill_code = s~load_ref();
        s.end_parse();
        bill_codes~udict_set_ref(32, X, bill_code);
        pack_extension();
        save_data();

        ;; Do not change the following code.
        governor = null();
        load_data();
        unpack_extension();

        throw_unless(err::access_denied, equal_slice_bits(src, governor));

        builder excess = begin_cell()
            .store_uint(op::gas_excess, 32)
            .store_uint(query_id, 64);
        send_msg(false, return_excess.to_builder(), null(), excess, 0, send::remaining_value + send::ignore_errors);

        throw(0);
    }
    ```

5. Run the `upgradeCode.ts` script.

6. Reset the `upgrade_data` function and `upgradeCode.ts` script and deploy again to bring treasury back to previous code hash.

7. Log code hash for Bill.

8. Wait for last round used in finding `round_since` to finish.

9. Remove all old bill codes from `bill_codes` by upgrading treasury with this `upgrade_data` function:

    ```func
    () upgrade_data(slice src, int query_id, cell new_data, slice return_excess) impure method_id {
        ;; Add code for upgrading data here.

        ;; This is just a template, and will only run after upgrade_code.
        ;; If data is upgraded, remember to reset this code,
        ;; so that the next upgrade won't change data by mistake.
        ( _, cell bill_code, int f? ) = bill_codes.udict_get_max_ref?(32);
        throw_unless(err::invalid_parameters, f?);
        bill_codes = new_dict().udict_set_ref(32, 0, bill_code);
        pack_extension();
        save_data();

        ;; Do not change the following code.
        governor = null();
        load_data();
        unpack_extension();

        throw_unless(err::access_denied, equal_slice_bits(src, governor));

        builder excess = begin_cell()
            .store_uint(op::gas_excess, 32)
            .store_uint(query_id, 64);
        send_msg(false, return_excess.to_builder(), null(), excess, 0, send::remaining_value + send::ignore_errors);

        throw(0);
    }
    ```

10. Run steps 5 to upgrade treasury.

11. Run step 6 to reset treasury code hash.

12. Remove old library from librarian by executing `removeLibrary.ts` script.

## Borrower Fee

> **Already performed on mainnet.** Spec: `docs/specs/2026-08-31-borrower-fee-hpo-burn.md`. Kept as
> the record of what was run. The treasury now carries the borrower-fee layout, and the fee itself
> has been set by governance rather than being left at the zero the migrator seeds. Do not re-run
> it: the migrator ends its parses with `end_parse()`, so a second run throws and reverts the whole
> upgrade.
>
> The code this released is captured as `tests/fixtures/treasury-borrower-fee-era-code.boc`, hash
> `200e562398228a563957dbac54f6c8fc869b5b93f247d4f6e5b32059b4bd626e`. That is what a treasury on
> chain should be running until the round-duration upgrade below lands; check it with
> `showCodeHashes.ts`.

Adds the borrower fee, widens `borrower_reward_share` to 16 bits, and snapshots the fee rate into
each loan request. Three stored layouts change together and the migrator converts all three in one
transaction:

1. the extension gains `borrower_fee` (`uint16`) after `governance_fee`, at zero
2. every request gains a 16-bit `borrower_reward_share` (from `share8 * 257`, exact) and a 16-bit
   `request_fee` (zero — those loans were committed before the fee existed and recover untaxed)
3. every participation's `sorted` dict is rekeyed from 112 to 120 bits

The migrator is `wrappers/upgrade-code-test/add_borrower_fee.fc`, exercised in
`tests/BorrowerFeeMigration.spec.ts` against storage built in the deployed shape and upgraded from
the deployed code, which the test compiles out of git rather than the working tree.

### Before sending

1. **Confirm the burner.** `burner::addr` is
   `EQAGPJMxJ73OLpHUgQhI5YeQe2ZuAuUQ-4f_zfN4rV2Fl6Jp`, the deployed burner from the sibling `burner`
   repository. It treats `op::take_borrower_fee` as a payment rather than a known op, so nothing on
   its side has to change; check that it is still active and still that code before enabling the fee.
2. **Send while `total_borrowers_stake` is zero.** Read it with `showState.ts`. Zero means no
   pending requests, so `requests` and `sorted` are empty on every participation and step 3 above is
   a no-op — only the records in `staked` and `recovering` need converting, which is about four.
   The migrator's cost scales with the number of stored requests, so check the count rather than
   assuming it.
3. **Upgrade the treasury BEFORE the borrowers, not after.** This is a breaking change to
   `op::request_loan`: `borrower_reward_share` is now a `uint16` out of 65535. Both orderings have a
   window in which requests bounce, so the question is which window you control.

   - Borrowers first: they send 16 bits to a treasury that reads 8, leaving 8 bits over at
     `end_parse()`. It throws. Every request bounces from the moment they are upgraded until the
     treasury is, and that gap is bounded only by how long you wait for
     `total_borrowers_stake == 0`.
   - Treasury first: old borrowers send 8 bits where 16 are read, which underflows and throws. They
     bounce only until you roll the binaries — and the deploy condition itself
     (`total_borrowers_stake == 0`) already puts you between request windows, so the gap is a window
     you chose rather than one you are waiting out.

   Nothing is lost either way. `request_loan` is bounceable, so the collateral returns; the cost is a
   missed round. Port an existing bid by multiplying by 257 — a share of 8 becomes 2056, identical
   economics.

### How long the window is

`total_borrowers_stake` drops to zero when a round's requests are consumed by
`participate_in_election`, and stays there until the validator set rotates and borrowers begin
requesting for the round after. That is the whole gap, and it recurs every round period — 65536 s,
about 18 h 12 m.

The borrower's request loop has a one-minute floor, so it fires within about a minute of a round
opening. Do not plan on borrowing time from the far end of the window.

Read the exact edge before starting: `showState.ts` gives `total_borrowers_stake` and the
participation states, and the round the treasury is about to rotate into is the largest `round_since`
in `participations`. On 2026-09-05 the gap ran until 17:19:04 UTC, roughly 1 h 50 m from when it was
measured.

### Running it

1. In `scripts/upgradeCode.ts`, set:

    ```ts
    const migratorName: string | null = 'upgrade-code-test/AddBorrowerFee'
    ```

2. Run the script. It prints the migrator hash and its full source and requires the hash typed back.

   **The dry run will not show a field diff for this upgrade.** `dryRunUpgrade` reads state through
   `get_treasury_state`, and this upgrade adds a field to it, so neither side can be itemised by a
   single wrapper. It reports `STATE DIFF: not readable across this upgrade`, and the code hash, data
   hash and cell size still hold. Read the migrator, not the diff.

3. Set `migratorName` back to `null` once it has landed.

4. Verify with `showState.ts`: `borrower_fee` reads `0 (0.00% of borrower reward) disabled`, and
   `total_coins`, `total_tokens`, `parent`, `governor`, `halter` and the exchange rate are unchanged.
   The code hash should equal the plain `Treasury` build.

5. Enable the fee as a **separate** governance action once the upgrade is confirmed healthy:

    ```
    npx blueprint run setBorrowerFee
    ```

   `32767` is half of each borrower's contractual share of a round's reward. The script prints the
   current rate, the share every borrower currently in the book bid, and what the new rate would take
   from each — the same rate is a different deal for each of them, which the number alone hides — and
   then asks for the value to be typed a second time.

   `0` remains the kill switch, and it disables the `fee::min_burn` floor along with the rate. The
   rate is snapshotted into each request, so setting it never reprices a loan already requested; it
   applies from the next request onwards.

## Round Duration

> **Already performed on mainnet, 2026-09-06.** Spec: `docs/specs/2026-09-06-round-duration.md`.
> Kept as the record of what was run. `get_treasury_state` returns 24 fields on chain and
> `get_deficit` answers with exit code 11. Do not re-run it: the migrator ends its parses with
> `end_parse()`, so a second run throws and reverts the whole upgrade.

Adds `round_duration` and `last_settled_round` (`uint32` each) to the extension, immediately after
`current_rate`. They record the interval the rate pair grew over, so an APY can be computed from a
single `get_treasury_state` call and stays correct when the protocol skips rounds. No other layout
changes, and `participations` is moved as an opaque dict.

**This release also changes the shape of `get_treasury_state`,** which is a separate matter from the
storage migration and does not involve the migrator at all. `deficit`, `round_duration` and
`last_settled_round` are returned in their storage positions rather than appended, so the tuple goes
from 21 values to 24 and every reader that indexes it by position must be updated. Plan that as part
of the rollout, not after it:

The release also **removes the `get_deficit` method**, for the same reason: the tuple now covers
everything stored, so the standalone getter had nothing left to add. Anything calling it gets a
failed get method rather than a wrong answer.

- **Ours, to deploy alongside** and **upstream, needing merged PRs:** see
  _Changing the shape of a getter_ above. The gauge additionally calls `get_deficit`, so it needs
  the getter removal as well as the reordering.
- Old readers fail loudly rather than quietly: the first inserted field arrives where an address is
  expected, so they throw instead of reporting wrong numbers.
- **`borrower` was left off this list when the release went out, and that is what the checklist
  above exists to prevent.** It reads `participations` at what is now `parent`, so it panicked on
  every cycle: two validators missed round `1788759816` and a stake sat in the elector about six
  hours past `stake_held_until`, because nothing else sends `finish_participation`. `hipostat` and `driver`
  were found stale in the same sweep, and both have since been retired. Naming the readers the requester
  happens to remember is not the same as enumerating them.

The migrator is `wrappers/upgrade-code-test/add_round_duration.fc`, exercised in
`tests/TreasuryMigration.spec.ts` against the captured mainnet account, chained through the deficit
and borrower-fee migrations so each migrator is tested against the layout it was written for.

Unlike the borrower-fee migration, this one's cost does not scale with anything stored, so it does
**not** need a window with `total_borrowers_stake` at zero.

### Before sending

1. **Confirm the starting layout.** This migrator reads the borrower-fee layout, which is what is on
   chain: the borrower-fee migration above has already run. So this upgrade goes out on its own, with
   nothing to chain ahead of it. Confirm before sending anyway, since it is one command —
   `showCodeHashes.ts` should report
   `200e562398228a563957dbac54f6c8fc869b5b93f247d4f6e5b32059b4bd626e` for the treasury. Against a
   pre-borrower-fee treasury this migrator reverts, which is the safe failure but a wasted
   transaction.
2. **Check the seeds.** The migrator reads config params 15 and 34 and seeds `round_duration` with
   `validators_elected_for` and `last_settled_round` with the current round's start. The dry run
   prints both: `round_duration` should be the network's round length in seconds (~65536) and
   `last_settled_round` a plausible recent timestamp. `0 -> 0` on either means the migrator did not
   run.

### Sending

1. In `scripts/upgradeCode.ts`, set:

    ```ts
    const migratorName: string | null = 'upgrade-code-test/AddRoundDuration'
    ```

2. Run the script. It prints the migrator hash and its full source, and requires the hash typed back
   before sending. Read the source at that prompt; it is the last point before signing.

3. Set `migratorName` back to `null` once the migration has landed.

4. Verify with `showState.ts`: `round_duration` and `last settled` are populated, the `deficit` line
   still reads (it comes from the state tuple now, not from `get_deficit`), the APY line still reads
   sensibly, and `total_coins`, `total_tokens`, `parent`, `governor`, `halter`, the exchange rate and
   `borrower_fee` are all unchanged. `borrower_fee` is the one to read closely — it is live,
   so it carries a real rate rather than zero, and the migrator rewriting the extension around it is
   the only thing standing between that rate and a silent reset. The dry run prints it before and
   after. The code hash should equal the plain `Treasury` build.

### After it lands

`round_duration` is nominal until the first round settles under the new code, at which point it
becomes a real measurement. Consumers can move to it immediately — the seed is the right answer for
a protocol that is validating every round — but the value is only load-bearing after that first
settlement.

Both temporary cross-version reads are gone, removed after the upgrade landed and the chain was
checked rather than assumed: `get_treasury_state` returns 24 fields on mainnet, `get_deficit` answers
with exit code 11, and `round_duration` and `last_settled_round` came back seeded at 65536 and the
current round. What went with them: the 21-value branch in `getTreasuryState` and its `getDeficit`
fallback, the `getDeficit` wrapper method itself, `showState`'s `duration === 0` fallback to
`getTimes`, and the test that read a pre-upgrade treasury through the released wrapper.

The migration specs still assert on pre-upgrade state, and they read it off the storage cell now --
`parseBorrowerFeeEraState` in `BorrowerFeeMigration.spec.ts` and `readEraExtension` in
`TreasuryMigration.spec.ts` -- which is what the fixture-reading helpers in those files already did.
A migration spec whose subject is an older layout cannot go through a wrapper that tracks the
current one, and pretending otherwise is what the tolerance was papering over.

The downstream updates are the other half of this rollout. Ours go out with the upgrade; the two
DefiLlama PRs are opened once the new shape is live on chain, since the adapters have to read the
tuple as it actually is.

## Two-Round Rate Window

> **Already performed on mainnet, 2026-09-07.** Spec: `docs/specs/2026-09-07-two-round-rate-window.md`.
> Kept as the record of what was run. Verified on chain rather than assumed: `get_treasury_state`
> returns **26** values, the deployed code hash is
> `430d16608514e5b924e6abc8621820dc4b5328baab456a71fc114e2e6d978dd6` (the plain `Treasury` build),
> `mid_rate` came back at `1163839627` equal to `previous_rate`, `mid_round` at `1788628744` equal to
> `last_settled_round - window_duration`, and `borrower_fee` survived the extension rewrite at `32767`.
> Do not re-run it: the migrator ends its parses with `end_parse()`, so a second run throws and reverts
> the whole upgrade.

Two changes to what the treasury publishes about its own growth, and one layout change to carry them.

- The rate window is measured in `burn_ready_participations`, once per barrier release, instead of in
  `recover_stake_result` at settlement. Settlement is not ordered, so the old placement paired a delta
  from one event with an interval from another; at the barrier the pairing is exact by construction.
- The window spans **two** releases instead of one, which cancels the round-to-round oscillation
  `rounds_imbalance` produces. `round_duration` is renamed `window_duration` — same position, same
  width, and about twice the value.
- `mid_rate` (`store_coins`) and `mid_round` (`uint32`) are stored after `last_settled_round`, with
  the pair they describe, and **appended** to the getter tuple, which goes from 24 values to 26.

### This one does not break any reader

Deliberately, and it is the point of the design. Positions 0–23 are untouched and the three window
fields keep their meaning — start rate, end rate, span — so anything that annualises by dividing by
the span keeps working with no change and simply stops seeing a sawtooth. Verified against the code,
not assumed: `dimension-adapters` (`stack[1]`, `[12]`, `[13]`, `[14]`, `[19]`), `yield-server`
(`stack[12]`, `[13]`, `[14]`), `DefiLlama-Adapters` (`result[0]`, `[2]`), `hpo-trader` and
`website/scripts/hipo-fund-snapshot.mjs` (both `0`, `1`) all keep working untouched. **No upstream PR
is needed.**

What does need updating is ours, and only for the rename, which is a compile error rather than a
silent break: `wrappers/Treasury.ts`, `wrappers/migrationDryRun.ts`, `scripts/showState.ts` in this
repo, then `sdk` and everything downstream of it. Announce the widened window in the release notes so
nobody reads a doubled `window_duration` as a bug.

**Done 2026-09-08**: `sdk@6.0.0`, then `website`, `mcp`, `sdk-example` and `HipoGang/webapp` (rebuilt
into `HipoFinance/club`). One trap surfaced there and it is the reason to read a rename rather than
apply it: the website's `roundsPerYear` counts HPO reward payouts and needs a **round length**, not
this window. Renaming it mechanically would have said rounds take ~36h and halved every HPO figure on
the page. The treasury no longer publishes a round length at all, so anything that needs one must
take it from `get_times` or a constant — grep for round-length uses separately from APY uses.

`vesting`, `club`, `dune` and `burner` were broken by the *previous* release and were all fixed on
2026-09-07, after this one landed. `gauge` was broken by *this* release, through a field-count
assertion rather than an index — see _Appending is not free either_ above.

### The migrator

`wrappers/upgrade-code-test/add_two_round_window.fc`, exercised in `tests/TreasuryMigration.spec.ts`
against the captured mainnet account, chained through the deficit, borrower-fee and round-duration
migrations so each migrator keeps being tested against the layout it was written for.

Unlike `add_round_duration.fc` it **reads no network config**. The seeds come from state the treasury
already holds — `mid_rate = previous_rate` and `mid_round = last_settled_round - round_duration` —
which reconstructs the observation one release back, because that is exactly what the old pair and its
interval describe. So the published window is unchanged on landing and becomes a genuine two-round
window at the first release after the upgrade, with no warm-up.

It asserts `round_duration > 0` and `last_settled_round > round_duration` before seeding. Both hold on
chain today (65536 and `1788694280`), and a violation would publish a nonsense span with nothing on
chain saying so.

Its cost does not scale with anything stored, so it needs **no** quiet window with
`total_borrowers_stake` at zero.

### Before sending

1. **Confirm the starting layout.** This migrator reads the round-duration layout, which is what is on
   chain. `showCodeHashes.ts` should report the round-duration release's treasury hash, and
   `get_treasury_state` should return 24 values. Against any earlier treasury it reverts, which is the
   safe failure but a wasted transaction.
2. **Check the seeds in the dry run.** `mid_rate` should equal the `previous_rate` printed beside it,
   and `mid_round` should equal `last_settled_round` minus `window_duration`. `0 -> 0` on either means
   the migrator did not run.
3. **Read `window_duration` on the before side.** It is the value the migrator carries through and the
   one `mid_round` is derived from, so a wrong value here propagates.

### Sending

1. In `scripts/upgradeCode.ts`, set:

    ```ts
    const migratorName: string | null = 'upgrade-code-test/AddTwoRoundWindow'
    ```

2. Run the script. It prints the migrator hash and its full source, and requires the hash typed back
   before sending. Read the source at that prompt; it is the last point before signing.

3. Set `migratorName` back to `null` once the migration has landed.

4. Verify with `showState.ts`: `mid_rate` and `mid_round` are populated where they read zero before,
   `window_duration` and `last settled` are unchanged, the APY line reads the same as it did (the
   window has not widened yet — that happens at the first release), and `total_coins`, `total_tokens`,
   `parent`, `governor`, `halter`, the exchange rate, `deficit` and `borrower_fee` are all unchanged.
   The code hash should equal the plain `Treasury` build.

5. **Then remove the cross-version read.** Done, after the chain was checked rather than assumed.
   `getTreasuryState` had branched on a stack length of 24 so it could read a pre-upgrade treasury —
   without it `showState` and the dry run cannot read the chain *before* this upgrade, which is when
   they are needed, and both threw `EOF` until it was added. Gone with it: the branch, the
   `midRate`/`midRound` zero fallbacks, and the cross-version case in `tests/TreasuryMigration.spec.ts`.

   Note for next time: this was **missed in the first release commit** and only surfaced when the
   upgrade script was run. The two releases before it both carried the same branch, so it belongs on
   the checklist rather than in anyone's memory — if a release changes the tuple's length in either
   direction, the wrapper needs to read both sides of it until the chain has caught up.

### After it lands

The first barrier release after the upgrade publishes the first genuine two-round window, at which
point `window_duration` doubles and the APY figure stops alternating. That is expected, not a
regression — watch for it rather than being surprised by it, and check that `last_settled_round`
advances with it.

**The APY itself must not move materially.** `window_duration` doubling is not a halving of the
published rate: `previous_rate` rolls back to the observation two releases ago at the same moment, so
the window covers two rounds of reward over two rounds of time and both halves of the ratio scale
together. A reading that actually halves means the two halves came from different events, which is
the defect this release removed — treat it as a bug and not as the new normal.

For this release the numbers were known in advance, because no release had happened yet when the
upgrade landed. **It fired on 2026-09-08 and every predicted value matched**, which is the proof the
migrator seeded the mid slot correctly and that the roll in `burn_ready_participations` reads each
old value before overwriting it:

| field                | before     | predicted  | observed on chain |
| -------------------- | ---------- | ---------- | ----------------- |
| `window_duration`    | 65536      | 131072     | **131072**        |
| `last_settled_round` | 1788694280 | 1788759816 | 1788759816        |
| `mid_rate`           | 1163839627 | 1164156495 | 1164156495        |
| `mid_round`          | 1788628744 | 1788694280 | 1788694280        |
| `previous_rate`      | 1163839627 | unchanged  | 1163839627        |

`current_rate` came out at `1164402398`, so the published APY is **12.33%** — normal, and not the
~6% a genuine halving would have shown. Worth recording what the *old* code would have published
from the same release: **10.70%**, annualising the newest observation alone. The 1.6-point gap is
exactly the round-to-round noise this release exists to remove, so that spread is the feature
working rather than a discrepancy to chase.

If `window_duration` is ever back at 65536 well after a round's `stake_held_until`, something did
not release.

Watch also for the change this makes to *when* the pair moves: nothing is published while an older
round still owes its reward. In the elector-rejection case that is about a round of silence where
there used to be a spurious 0%. A stale `last_settled_round` with a healthy `participations` list is
the expected shape there, not a wedge.
