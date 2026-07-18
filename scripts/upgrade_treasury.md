# Upgrade Treasury

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
