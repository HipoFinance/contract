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
