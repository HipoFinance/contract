# Upgrade Treasury

## Add Deficit Field

One-off migration for the deficit counter. It inserts a `deficit` field into root storage
between `total_borrowers_stake` and `parent`, starting at zero. Ship it in the same
`upgrade_code` that deploys the treasury carrying the deficit counter and the borrower
refund fix.

Tested end to end against a snapshot of the live mainnet account in
`tests/TreasuryMigration.spec.ts`, using `wrappers/upgrade-code-test/add_deficit.fc` as the
testable copy of the body below. If you change the body, change that file too and re-run the
spec — it is the only thing checking this against real state.

1. Use this migrate code in `treasury.fc`:

    ```func
    () upgrade_data(slice src, int query_id, cell new_data, slice return_excess) impure method_id {
        ;; Add code for upgrading data here.

        ;; This is just a template, and will only run after upgrade_code.
        ;; If data is upgraded, remember to reset this code,
        ;; so that the next upgrade won't change data by mistake.
        slice old = get_data().begin_parse();
        int old_total_coins = old~load_coins();
        int old_total_tokens = old~load_coins();
        int old_total_staking = old~load_coins();
        int old_total_unstaking = old~load_coins();
        int old_total_borrowers_stake = old~load_coins();
        slice old_parent = old~load_msg_addr();
        cell old_participations = old~load_dict();
        int old_rounds_imbalance = old~load_uint(8);
        int old_stopped = old~load_int(1);
        int old_instant_mint = old~load_int(1);
        cell old_loan_codes = old~load_ref();
        cell old_extension = old~load_ref();
        old.end_parse();

        begin_cell()
            .store_coins(old_total_coins)
            .store_coins(old_total_tokens)
            .store_coins(old_total_staking)
            .store_coins(old_total_unstaking)
            .store_coins(old_total_borrowers_stake)
            .store_coins(0) ;; deficit
            .store_slice(old_parent)
            .store_dict(old_participations)
            .store_uint(old_rounds_imbalance, 8)
            .store_int(old_stopped, 1)
            .store_int(old_instant_mint, 1)
            .store_ref(old_loan_codes)
            .store_ref(old_extension)
            .end_cell()
            .set_data();

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

    It parses the old cell by hand rather than calling `load_data()`. `upgrade_code` has
    already run `set_c3`, so `load_data()` here is the **new** parser: it would read the
    leading bits of `parent`'s address as a coins value and desync everything after it,
    including the governor the access check depends on. A layout mistake would then surface
    as a denied upgrade rather than an obvious one.

    The trailing `end_parse()` is what makes a second run safe. Against a cell that already
    carries a deficit there are bits left over, so it throws and the whole upgrade reverts,
    leaving the treasury on its previous code rather than half-migrated.

2. Run the `upgradeCode.ts` script.

3. Reset the `upgrade_data` function and deploy again to bring treasury back to the released
   code hash.

4. Verify with `showState.ts`: `get_deficit()` returns 0, and `total_coins`, `total_tokens`,
   `parent`, `governor`, `halter` and the exchange rate are all unchanged.

## Mint Dead Shares

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
