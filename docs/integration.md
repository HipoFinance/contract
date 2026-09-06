# Hipo Integration

Hipo liquid staking protocol can be integrated in other tools and applications like Ton wallets and other protocols.

## Smart Contracts

There are different smart contracts involved in the protocol, so let's first have a quick recap.

### Treasury

This is the main smart contract of the protocol. All GRAM coins are deposited here and then given as loans to borrowers. Treasury address:

> `EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ`

### Parent

This is the jetton parent/minter/master smart contract. All communication between wallets and treasury go through this smart contract. Current parent address:

> `EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w`

### Wallet

It's a jetton wallet implementation with some custom behavior and extra data fields. Each user has its own instance of wallet, deployed at a separate address.

### Loan

Loans are given to borrowers using this smart contract which safeguards the loans. New instances of it are deployed on masterchain for each round of validation.

### Bill

Some operations cannot happen instantly. For example, unstaking hGRAM while funds are already staked in the Elector smart contract must wait until the end of the validation round. In these cases, an SBT, which is a non-transferrable NFT, is created and assigned to the user.

### Collection

Each bill is a child of an NFT collection, which is also created for each round of validation.

### Librarian

Some of the above contracts are implemented using the library feature of Ton blockchain. Librarian is used to help with their deployments, and paying for their storage.

## Deposit and Stake

To earn staking rewards, a user must deposit some GRAM coins which are then automatically staked from the next round. Here is the TL-B description:

```tlb
deposit_coins#3d3761a6
    query_id:uint64
    owner:MsgAddress
    coins:Coins
    ownership_assigned_amount:Coins
    referrer:MsgAddress
        = InternalMsgBody;
```

This message must be sent to the **treasury** contract.

- `owner`: The address of the receiver of hGRAM tokens. Wallets can set it as `addr_none$00` which will use the address of the sender. Other protocols integrating with Hipo can specify the address for the user that will receive the hGRAM tokens.

- `coins`: The GRAM amount to deposit. If it's set to zero, the stake fee is automatically deducted from the incoming value and the rest will be used for deposit. Wallets can set this amount to the entered value in the interface to be more precise and return the excess gas to the user.

- `ownership_assigned_amount`: Currently deposit and stake operation is done instantly and no SBT is generated, so this field is not used and can be set to zero.

- `referrer`: An address that may receive referral rewards at some future date. Can be set to `addr_none$00`.

So, the simplest message to deposit and stake is 0x3d3761a6 followed by 64+2+4+4+2 zeros. Attach some GRAM coins and as long as the attached value is enough to cover fees, the operation will succeed.

Note that a deposit too small to mint at least one token nano-unit at the current exchange rate (i.e. `coins * total_tokens / total_coins` rounding down to zero) is rejected with exit code `110` (`deposit_too_small`); the message bounces and the attached value returns to the sender.

## Unstake and Withdraw

To unstake hGRAM and receive the corresponding GRAM, the owner must send an unstake message:

```tlb
unstake_tokens#595f07bc // originally named 'burn'
    query_id:uint64
    tokens:Coins
    return_excess:MsgAddress
    custom_payload:(Maybe ^Cell)
        = InternalMsgBody;
```

This is the `burn` message in TEP-74, and it must be sent to jetton **wallets** of the owning users, by themselves.

- `tokens`: The amount to unstake. Must be greater than zero and less than or equal to hGRAM balance.

- `return_excess`: The extra gas will return to this address. It must be either set to the address of the `owner` or set to `addr_none$00`. No other address will be accepted here, it has more restrictions than TEP-74.

- `custom_payload`: Can be `nothing$0` to use the default configurations, or can be set to `just$1` a cell with 2 fields:

  - `mode:uint4`: The unstake mode. Can be `0`, `1`, or `2`:
    - `0`: Auto: If funds are available, the withdrawal will be done instantly, otherwise, it will be done after the current round of validation.
    - `1`: Instant: If funds are available, the withdrawal will be done instantly, otherwise, it will be rolled back.
    - `2`: Best: The withdrawal will always happen after the current round of validation finishes to maximize earned rewards.

  - `ownership_assigned_amount:Coins`: The amount to forward when an SBT is assigned to the user. If set to zero, no `ownership_assigned` notification message will be sent.

## Reading Deposit Fee

In Hipo, fees are calculated dynamically, using the current network configuration. To find the current deposit fee, use the get method of **treasury** `get_treasury_fees`. It takes a parameter for `ownership_assigned_amount` which is currently not used and can be replaced with zero. It returns three integers:

1. `loan_fee`: The minimum fee required for requesting a loan.

1. `deposit_fee`: The minimum fee required for deposit and stake.

1. `unstake_all_fee`: The fee needed for the text-based interface to unstake all tokens.

Alternatively, you may just send a fixed amount as long as it's greater than the current deposit fee. The remaining gas value will return to the user's wallet.

## Reading Unstake Fee

To find the current unstake fee, use the get method `get_wallet_fees` of **wallet** with no parameters, which returns:

1. `send_tokens_fee`: Minimum fee for sending hGRAM to another user, with an empty payload.

1. `unstake_tokens_fee`: Minimum fee required for sending an unstake request.

1. `upgrade_wallet_fee`: Minimum fee required when trying to upgrade the wallet to the latest version.

1. `wallet_storage_fee`: Minimum storage fee required for storing the wallet.

Alternatively, you may just send a fixed amount as long as it's greater than the current unstake fee. The remaining gas value will return to the user's wallet.

## Reading Wallet Address

To find the address for an hGRAM wallet address, use the get method `get_wallet_address` of **parent** and send the user address as the only parameter.

## Reading hGRAM Balance and Unstake Amount in Progress

Use the get method `get_wallet_state` of **wallet** with no parameters, which returns:

1. `tokens`: Balance of hGRAM tokens.

1. `staking`: A dictionary for staking in progress (which is currently not used).

1. `unstaking`: Total amount of unstaking tokens in progress, waiting for the end of the validation round.

## Reading Current State of Treasury

Use the get method `get_treasury_state` of **treasury** with no parameters, which returns these fields in this order:

1. `total_coins`: Total GRAM coins staked in the protocol. Includes 10 GRAM backing the protocol's permanently locked *dead shares*, so it is always positive.

1. `total_tokens`: Total hGRAM tokens issued in the protocol. Includes the dead shares: tokens worth 10 GRAM (at the rate they were minted) owned by no wallet and never burnable, so it is always positive and permanently exceeds the jetton total supply reported by **parent**'s `get_jetton_data` (which counts only wallet-held tokens).

1. `total_staking`: Total GRAM coins that are in the process of being staked. Currently, because of instant staking, it is always zero.

1. `total_unstaking`: Total hGRAM tokens that are in the process of being unstaked. These will be processed after the current round of validation is finished.

1. `total_borrowers_stake`: Total GRAM coins that borrowers provided to take a loan.

1. `deficit`: Total GRAM that defaulting borrowers walked away with, since the governor last cleared the counter. The exchange rate never moves down for a loss, so this is where an uncovered shortfall is recorded instead; `total_coins` keeps its full claim and the governor tops the treasury back up by hand.

1. `parent`: The address of the current hGRAM parent/minter/master contract.

1. `participations`: A dictionary containing data for active participation in election and validation rounds.

1. `rounds_imbalance`: A value to change the balance of GRAM coins dedicated to odd and even rounds of validation.

1. `stopped`: Whether the protocol is stopped or not. When stopped, no new loans or deposits will be accepted, however, unstakes and finalizing of rounds will happen as always.

1. `instant_mint`: Whether deposits are immediately staked and hGRAM tokens issued or postponed to the end of the validation round.

1. `loan_codes`: The codes of loan smart contracts. It's a dictionary to gradually upgrade the codes while already participating in previous rounds.

1. `previous_rate`: Exchange rate before last round, multiplied by one billion.

1. `current_rate`: Exchange rate after last round, multiplied by one billion.

1. `round_duration`: The number of seconds that `previous_rate` took to grow into `current_rate`, measured on chain as the gap between the start times of the two most recently settled validation rounds. This is **not** the length of a round: the protocol only updates the rate pair when a round it lent into settles, so a round in which nothing was lent widens this interval instead of passing unnoticed. Use it as the denominator when annualising the rate pair — see *Calculating APY of hGRAM* below.

1. `last_settled_round`: The start time of the most recent validation round whose reward is included in `current_rate`. Compare it against the current round to tell how fresh the rate pair is; it only ever moves forward.

1. `halter`: The address of the halter who can stop the protocol, i.e. setting the stopped flag.

1. `governor`: The address of the governor who can upgrade the protocol, and will receive the protocol fees.

1. `proposed_governor`: An optional cell containing the time and the address of a newly proposed governor, who can accept governance after the specified time.

1. `governance_fee`: The governance fee, taken after each round of validation.

1. `borrower_fee`: The borrower fee, out of 65535 of each borrower's contractual share of a
   round's reward (`reward * borrower_reward_share / 65535`). It is charged **on top of** what the
   pool receives, out of the borrower's own funds, so it never reduces `treasury_reward` and never
   affects the exchange rate. Zero disables it. The rate in force is snapshotted into each request
   when it is made, so changing it never reprices a loan already committed.

1. `collection_codes`: The codes of collection smart contracts. It's a dictionary to gradually upgrade the codes while already participating in previous rounds.

1. `bill_codes`: The codes of bill smart contracts. It's a dictionary to gradually upgrade the codes while already participating in previous rounds.

1. `old_parents`: The list of old parent/minter/master smart contract addresses, which the treasury will accept to upgrade their wallets to the latest/current parent.

> **Breaking change.** `deficit`, `round_duration` and `last_settled_round` were added to this list at the positions above, not at the end, so that it mirrors the treasury's storage layout and one call returns everything the contract stores. Readers that index this tuple by position — rather than by name — must be updated for the release that introduced them. The list went from 21 values to 24. The same release **removed the `get_deficit` method**: this tuple now covers everything the treasury stores, so it was the only reader of that getter's reason to exist.

## Reading Times

Calling the get method `get_times` of **treasury** with no parameters, returns a list of important times (in UNIX seconds) for the protocol in this order:

1. `current_round_since`: The start time of the current validation round.

1. `participate_since`: The start time that a message to trigger participation in elections can be sent.

1. `participate_until`: The end time that a message to trigger participation in elections can be sent.

1. `next_round_since`: The potential start time of the next validation round.

1. `next_round_until`: The potential end time of the next validation round.

1. `stake_held_for`: The duration that the staked amount will be held to process complaints.

## Reading Participation Data

To read data related to a specific participation, use get method `get_participation` of **treasury** which takes the round start time (in UNIX seconds) as a parameter, and returns these fields:

1. `state`: The state of this participation, one of these:

    - `open` (0): Accepting loan requests.

    - `distributing` (1): Deciding on loans and distributing GRAM coins to validators.

    - `staked` (2): Staked funds in the upcoming validation round.

    - `validating` (3): Validating in the current validation round.

    - `held` (4): Waiting for the hold period to finish.

    - `recovering` (5): In the process of recovering funds from given loans.

    - `ready_to_burn` (6): Settled and its reward is booked, but it keeps holding its bills until every older round has booked its reward too, so deferred deposits cannot mint at a rate that excludes those rewards.

    - `burning` (7): In the process of burning SBTs and sending the relevant GRAM coins to owners.

1. `size`: The number of requests/loans in this participation.

1. `sorted`: A sorted dictionary of loan requests.

1. `requests`: A dictionary of all loan requests.

1. `rejected`: A dictionary of all rejected loans.

1. `accepted`: A dictionary of all accepted loans.

1. `accrued`: A dictionary of all accepted loans that are given the accrued amount.

1. `staked`: A dictionary of all given loans.

1. `recovering`: A dictionary of all loans waiting to be recovered.

1. `total_staked`: Total GRAM coins staked in this participation.

1. `total_recovered`: Total GRAM coins currently recovered.

1. `current_vset_hash`: The hash of participation in the current validation round.

1. `stake_held_for`: The duration to hold stake for this participation.

1. `stake_held_until`: The time to keep stake before trying to recover funds.

## Calculating Exchange Rate of hGRAM in GRAM

Call get method `get_treasury_state` on **treasury** and then divide `total_coins` by `total_tokens`. Check [example implementation](https://github.com/HipoFinance/sdk-example/blob/c165c95350b7df19b30f42e037d882cec2d4b865/src/Model.ts#L290).

Both totals include the protocol's dead shares (unowned tokens and their backing coins). This is intentional: the exchange rate is defined over all shares, dead or not, so do not subtract them when computing it.

## Calculating APY of hGRAM

The GRAM rewards paid to validators change in each round of validation, because of different runtime conditions, like for example, the number of transactions in that round. As a result, APY is only an estimate and can be calculated based on the performance of the last validation round.

To calculate it, use the `current_rate`, `previous_rate` and `round_duration` fields returned from the `get_treasury_state` method:

```
growth = current_rate / previous_rate
apy    = growth ^ (365 * 24 * 60 * 60 / round_duration) - 1
```

All three come from the same call, so the whole calculation needs one get method and one snapshot of state.

Use `round_duration` rather than a round length worked out from `get_times`. The two agree while the protocol lends into every round, but they diverge exactly when it does not: the rate pair only moves when a round the protocol lent into settles, so if liquidity falls and only every other round is used, the growth per update roughly doubles while a round length does not — annualising by the round length would report an unchanged APY for a pool whose true rate of growth had halved. The same applies after an idle stretch. `round_duration` is the interval those two rates actually describe, so it stays correct in both cases and needs no adjustment if the network's round length changes.

Here is an [example implementation](https://github.com/HipoFinance/sdk-example/blob/c165c95350b7df19b30f42e037d882cec2d4b865/src/Model.ts#L304), written before `round_duration` existed and still using `get_times`.

## Explorer Actions

Explorers and indexers that classify transaction traces into high-level actions can use
the trace patterns below to display Hipo operations as single actions instead of raw
message chains. Op-codes are defined in `contracts/schema.tlb`; the contribution plan for
specific explorers is in `docs/specs/2026-08-04-explorer-actions.md`. Classifiers should
key on the treasury address where possible: the parent address can change in a future
upgrade, the treasury cannot.

- **Stake (instant)**: `deposit_coins#3d3761a6` → treasury → `proxy_tokens_minted#5be57626`
  → parent → `tokens_minted#5445efee` → wallet → `transfer_notification#7362d09c` → owner.
  Display the deposited GRAM and the minted hGRAM amount from `tokens_minted`.

- **Stake (deferred)**: `deposit_coins` → treasury, which sends both
  `proxy_save_coins#47daa10f` → parent → `save_coins#4cce0e74` → wallet, and
  `mint_bill#4b2d7871` → collection → `assign_bill#3275dfc2` → bill →
  `ownership_assigned#05138d91` → owner. Display as a pending stake; tokens arrive when
  the round is finalized: collection → `burn_bill#6f89f5e3` → bill → `bill_burned#840f6369`
  → collection → `mint_tokens#42684479` → treasury → `proxy_tokens_minted` →
  `tokens_minted` → `transfer_notification`.

- **Unstake (instant)**: `unstake_tokens#595f07bc` (the TEP-74 `burn` op-code) → wallet →
  `proxy_reserve_tokens#688b0213` → parent → `reserve_tokens#386a358b` → treasury →
  `proxy_tokens_burned#4476fde0` → parent → `tokens_burned#5b512e25` → wallet →
  `withdrawal_notification#f0fa223b` → owner, with the withdrawn GRAM attached to the last
  two messages. Classifiers that already recognize TEP-74 burns should upgrade this trace
  to an unstake action rather than showing a plain jetton burn.

- **Unstake (deferred)**: same head through `reserve_tokens`, then `mint_bill` →
  `assign_bill` → `ownership_assigned`. Display as an unstake request; payout happens when
  the round is finalized: `burn_bill` → `bill_burned` → `burn_tokens#7cffe1ee` → treasury
  → `proxy_tokens_burned` → `tokens_burned` → `withdrawal_notification` with the GRAM
  attached.

- **Unstake rollback**: `proxy_rollback_unstake#32b67194` → `rollback_unstake#1b77fd1a`
  appears when an unstake cannot be served; it restores the tokens and must not be
  classified as a withdrawal. It arises in two places: from `reserve_tokens`, when an
  instant-mode unstake cannot be paid right away, and at the tail of a deferred unstake's
  burn trace, when `burn_tokens` finds the treasury short of GRAM and no later round left
  to postpone the bill to. In the second case a `burn_bill` → `bill_burned` →
  `burn_tokens#7cffe1ee` trace ends in a rollback instead of a `withdrawal_notification`,
  so an earlier unstake request in that trace stays outstanding rather than completing.

- **Borrower flows**: `request_loan#36335da9` (borrower → treasury), and at round end
  `recover_stake_result#0fca4c86` → treasury → `loan_result#faaa8366` (borrower's stake
  plus reward share), `take_borrower_fee#5e2d81f4` (the borrower fee, to the burner) and
  `take_profit` (governance fee).

  > **Breaking change for borrowers.** `borrower_reward_share` in `request_loan` is now a
  > `uint16` out of 65535, not a `uint8` out of 255. An old-format request carries only 8 bits
  > there and throws on cell underflow; the message is bounceable, so the collateral comes back
  > and nothing is lost, but the request does not land and the borrower misses the round. Port an
  > existing bid exactly by multiplying by 257 — `255 * 257 = 65535`, so a share of 8 becomes 2056
  > with identical economics. The widening exists because one step of the old scale moved a
  > borrower's own take by `1/share`, which at the shares actually bid was over 12%.

## Calculating Remaining Time Until Withdrawal

You have to first find the `current_round_since` by calling the `get_times` method. Then you have to send it to the `get_participation` method. It will return `stake_held_until` which is the time after which the validation round will be finalized. Here is the [full implementation in Hipo's webapp](https://github.com/HipoFinance/webapp/blob/a11a575fe231def9015ff480e1b7959c893121e2/src/Model.ts#L420).
