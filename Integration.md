# Hipo Integration

Hipo liquid staking protocol can be integrated in other tools and applications like Ton wallets and other protocols.

## Smart Contracts

There are different smart contracts involved in the protocol, so let's first have a quick recap.

### Treasury

This is the main smart contract of the protocol. All TON coins are deposited here and then given as loans to borrowers. Treasury address:

> `EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ`

### Parent

This is the jetton parent/minter/master smart contract. All communication between wallets and treasury go through this smart contract. Current parent address:

> `EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w`

### Wallet

It's a jetton wallet implementation with some custom behavior and extra data fields. Each user has its own instance of wallet, deployed at a separate address.

### Loan

Loans are given to borrowers using this smart contract which safeguards the loans. New instances of it are deployed on masterchain for each round of validation.

### Bill

Some operations cannot happen instantly. For example, unstaking hTON while funds are already staked in the Elector smart contract must wait until the end of the validation round. In these cases, an SBT, which is a non-transferrable NFT, is created and assigned to the user.

### Collection

Each bill is a child of an NFT collection, which is also created for each round of validation.

### Librarian

Some of the above contracts are implemented using the library feature of Ton blockchain. Librarian is used to help with their deployments.

## Deposit and Stake

To earn staking rewards, a user must deposit some TON coins which are then automatically staked from the next round. Here is the TL-B description:

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

- `owner`: The address of the receiver of hTON tokens. Wallets can set it as `addr_none$00` which will use the address of the sender. Other protocols integrating with Hipo can specify the address for the user that will receive the hTON tokens.

- `coins`: The TON amount to deposit. If it's set to zero, the stake fee is automatically deducted from the incoming value and the rest will be used for deposit. Wallets can set this amount to the entered value in the interface to be more precise and return the excess gas to the user.

- `ownership_assigned_amount`: Currently deposit and stake operation is done instantly and no SBT is generated, so this field is not used and can be set to zero.

- `referrer`: An address that may receive referral rewards at some future date. Can be set to `addr_none$00`.

So, the simplest message to deposit and stake is 0x3d3761a6 followed by 64+2+4+4+2 zeros. Attach some TON coins and as long as the attached value is enough to cover fees, the operation will succeed.

## Unstake and Withdraw

To unstake hTON and receive the corresponding TON, the owner must send an unstake message:

```tlb
unstake_tokens#595f07bc // originally named 'burn'
    query_id:uint64
    tokens:Coins
    return_excess:MsgAddress
    custom_payload:(Maybe ^Cell)
        = InternalMsgBody;
```

This is the `burn` message in TEP-74, and it must be sent to jetton **wallets** of the owning users, by themselves.

- `tokens`: The amount to unstake. Must be greater than zero and less than or equal to hTON balance.

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

1. `send_tokens_fee`: Minimum fee for sending hTON to another user, with an empty payload.

1. `unstake_tokens_fee`: Minimum fee required for sending an unstake request.

1. `upgrade_wallet_fee`: Minimum fee required when trying to upgrade the wallet to the latest version.

1. `wallet_storage_fee`: Minimum storage fee required for storing the wallet.

Alternatively, you may just send a fixed amount as long as it's greater than the current unstake fee. The remaining gas value will return to the user's wallet.

## Reading Wallet Address

To find the address for an hTON wallet address, use the get method `get_wallet_address` of **parent** and send the user address as the only parameter.

## Reading hTON Balance and Unstake Amount in Progress

Use the get method `get_wallet_state` of **wallet** with no parameters, which returns:

1. `tokens`: Balance of hTON tokens.

1. `staking`: A dictionary for staking in progress (which is currently not used).

1. `unstaking`: Total amount of unstaking tokens in progress, waiting for the end of the validation round.

## Reading Current State of Treasury

Use the get method `get_treasury_state` of **treasury** with no parameters, which returns these fields in this order:

1. `total_coins`: Total TON coins staked in the protocol.

1. `total_tokens`: Total hTON tokens issued in the protocol.

1. `total_staking`: Total TON coins that are in the process of being staked. Currently, because of instant staking, it is always zero.

1. `total_unstaking`: Total hTON tokens that are in the process of being unstaked. These will be processed after the current round of validation is finished.

1. `total_borrowers_stake`: Total TON coins that borrowers provided to take a loan.

1. `parent`: The address of the current hTON parent/minter/master contract.

1. `participations`: A dictionary containing data for active participation in election and validation rounds.

1. `rounds_imbalance`: A value to change the balance of TON coins dedicated to odd and even rounds of validation.

1. `stopped`: Whether the protocol is stopped or not. When stopped, no new loans or deposits will be accepted, however, unstakes and finalizing of rounds will happen as always.

1. `instant_mint`: Whether deposits are immediately staked and hTON tokens issued or postponed to the end of the validation round.

1. `loan_codes`: The codes of loan smart contracts. It's a dictionary to gradually upgrade the codes while already participating in previous rounds.

1. `last_staked`: Total TON coins staked in the last finished round.

1. `last_recovered`: Total TON coins recovered after the last finished round.

1. `halter`: The address of the halter who can stop the protocol, i.e. setting the stopped flag.

1. `governor`: The address of the governor who can upgrade the protocol, and will receive the protocol fees.

1. `proposed_governor`: An optional cell containing the time and the address of a newly proposed governor, who can accept governance after the specified time.

1. `governance_fee`: The governance fee, taken after each round of validation.

1. `collection_codes`: The codes of collection smart contracts. It's a dictionary to gradually upgrade the codes while already participating in previous rounds.

1. `bill_codes`: The codes of bill smart contracts. It's a dictionary to gradually upgrade the codes while already participating in previous rounds.

1. `old_parents`: The list of old parent/minter/master smart contract addresses, which the treasury will accept to upgrade their wallets to the latest/current parent.

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

    - `open`: Accepting loan requests.

    - `distributing`: Deciding on loans and distributing TON coins to validators.

    - `staked`: Staked funds in the upcoming validation round.

    - `validating`: Validating in the current validation round.

    - `held`: Waiting for the hold period to finish.

    - `recovering`: In the process of recovering funds from given loans.

    - `burning`: In the process of burning SBTs and sending the relevant TON coins to owners.

1. `size`: The number of requests/loans in this participation.

1. `sorted`: A sorted dictionary of loan requests.

1. `requests`: A dictionary of all loan requests.

1. `rejected`: A dictionary of all rejected loans.

1. `accepted`: A dictionary of all accepted loans.

1. `accrued`: A dictionary of all accepted loans that are given the accrued amount.

1. `staked`: A dictionary of all given loans.

1. `recovering`: A dictionary of all loans waiting to be recovered.

1. `total_staked`: Total TON coins staked in this participation.

1. `total_recovered`: Total TON coins currently recovered.

1. `current_vset_hash`: The hash of participation in the current validation round.

1. `stake_held_for`: The duration to hold stake for this participation.

1. `stake_held_until`: The time to keep stake before trying to recover funds.

## Calculating Exchange Rate of hTON in TON

Call get method `get_treasury_state` on **treasury** and then divide `total_coins` by `total_tokens`. Check example implementation [here](https://github.com/HipoFinance/sdk-example/blob/d97098d716d43ca4b56a15bce41bcc99720403d7/src/Model.ts#L290).

## Calculating APY of hTON

The TON rewards paid to validators change in each round of validation, because of different runtime conditions, like for example, the number of transactions in that round. As a result, APY is only an estimate and can be calculated based on the performance of the last validation round.

To calculate it, use the `last_recovered` and `last_staked` fields returned from the `get_treasury_state` method. You may also use the `get_times` method to calculate the duration of the last round, so that in case of a change in network configuration, there is no need to update the calculation code. Here is an [example implementation](https://github.com/HipoFinance/sdk-example/blob/d97098d716d43ca4b56a15bce41bcc99720403d7/src/Model.ts#L303).

## Calculating Remaining Time Until Withdrawal

You have to first find the `current_round_since` by calling the `get_times` method. Then you have to send it to the `get_participation` method. It will return `stake_held_until` which is the time after which the validation round will be finalized. Here is the [full implementation in Hipo's webapp](https://github.com/HipoFinance/webapp/blob/a11a575fe231def9015ff480e1b7959c893121e2/src/Model.ts#L420).
