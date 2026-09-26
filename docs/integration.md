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

1. `previous_rate`: The exchange rate at the start of the published window, multiplied by one billion.

1. `current_rate`: The exchange rate at the end of it, multiplied by one billion.

1. `window_duration`: The number of seconds `previous_rate` took to grow into `current_rate`. This is **not** the length of a round. The window spans **two** of the treasury's rate observations, so in normal operation it is about two rounds long, and it widens further across rounds in which nothing was lent. Use it as the denominator when annualising the rate pair — see *Calculating APY of hGRAM* below. Formerly named `round_duration`, when the window was one observation wide.

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

1. `mid_rate`: The exchange rate at the middle of the three observations the window slides over, multiplied by one billion. Bookkeeping rather than something to publish: it is what lets `previous_rate` lag two observations instead of one. Most readers should ignore it. It is returned here, at the end, even though the treasury stores it next to the rate pair — this list is append-only, and where a field sits in storage does not decide where it appears in the tuple.

1. `mid_round`: The start time of the validation round that middle observation was taken on.

> **This list is append-only.** A field is never inserted into it and never moved, so an index that means something today means the same thing forever. That rule is newer than the list: `deficit`, `round_duration` and `last_settled_round` were once *inserted* at their positions above so the list would mirror the treasury's storage layout, which shifted every reader indexing by position and broke several. `mid_rate` and `mid_round` were therefore **appended** — the list went from 24 values to 26, positions 0–23 are exactly what they were, and a reader that divides by the interval field keeps working with no change and simply sees a steadier number. The list is also complete: everything the treasury stores is here, which is why the `get_deficit` method was removed when `deficit` joined it.

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

The GRAM rewards paid to validators change in each round of validation, because of different runtime conditions, like for example, the number of transactions in that round. As a result, APY is only an estimate.

To calculate it, use the `current_rate`, `previous_rate` and `window_duration` fields returned from the `get_treasury_state` method:

```
growth = current_rate / previous_rate
apy    = growth ^ (365 * 24 * 60 * 60 / window_duration) - 1
```

All three come from the same call, so the whole calculation needs one get method and one snapshot of state.

Use `window_duration` rather than a round length worked out from `get_times`. The two never agree — the window is about two rounds long — and they diverge further exactly when liquidity falls: the rate pair only moves when the treasury releases a settled round, so if only every other round is lent into, the growth per window holds while a round length does not. Annualising by a round length would report roughly double the truth, and would keep reporting an unchanged APY for a pool whose true rate of growth had halved. `window_duration` is the span those two rates actually describe, so it stays correct in every case and needs no adjustment if the network's round length changes.

**Why the window is two observations wide.** The treasury lends through two interleaved chains of rounds, and `rounds_imbalance` lets one chain lend more than the other, so the reward booked per observation alternates. A window one observation wide inherits that alternation and sawtooths every round. Two observations always cover one of each, so the published figure is level. A consequence worth knowing: the pair is published when a settled round is *released*, which can be a round or so after it settles if an older round is still owed its reward — so the figure is deliberately a little behind, and `last_settled_round` tells you how far.

Here is an [example implementation](https://github.com/HipoFinance/sdk-example/blob/c165c95350b7df19b30f42e037d882cec2d4b865/src/Model.ts#L304), written before any of these fields existed and still using `get_times`.

## Explorer Actions

Explorers and indexers that classify transaction traces into high-level actions can use
the trace patterns below to display Hipo operations as single actions instead of raw
message chains. Op-codes are defined in `contracts/schema.tlb`; the contribution plan for
specific explorers is in `docs/specs/2026-08-04-explorer-actions.md`.

Three rules that a classifier gets wrong easily, each learned from a real defect:

1. **Show both sides.** Every stake and unstake exchanges GRAM for hGRAM or back. An
   action shape that carries only one currency hides the other, so the second amount needs
   somewhere to live — a companion mint/burn action is the shape that works today. The
   figures are in the proxied messages, never in the attached value: `proxy_tokens_minted`
   and `tokens_minted` carry both `coins` (GRAM) and `tokens` (hGRAM),
   `proxy_reserve_tokens` carries the hGRAM being unstaked, and `withdrawal_notification`
   carries both. In particular `deposit_coins.coins` is **zero** when the depositor means
   "stake everything after fees"; only the treasury resolves it.
2. **Read the owner out of the message, not off the envelope.** `unstake_all` makes the
   wallet send `unstake_tokens` to *itself*, so the burn's sender is the jetton wallet, not
   the holder. Every proxied message names the real owner; use that.
3. **Anchor on an address only Hipo can send from.** These op-codes are public and they
   name the holder they credit, so a classifier that acts on one without checking the
   sender can be made to report hGRAM moving in or out of a stranger's wallet. Anchor on
   the treasury where possible — its address never changes — and on the parent for the
   messages only the jetton master may send. Note that `reserve_tokens` really is sent
   straight to the treasury by ordinary wallets on mainnet, and is answered with a
   rollback, so a chain ending at the treasury is not by itself proof of a genuine unstake.

- **Comment flows**: the treasury also accepts a plain GRAM transfer whose body is a text
  comment — `d` deposits (equivalent to `deposit_coins` with `coins` = 0) and `w` unstakes
  the sender's whole balance (`send_unstake_all#45baeda9`). Case is ignored. This is the
  method recommended to wallets that cannot attach a custom payload, multisigs above all,
  so it carries real deposits; a classifier keyed only on the `deposit_coins` op-code
  misses them and shows a bare GRAM transfer. Everything below the treasury is identical
  to the corresponding flow.

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

- **Unstake postponed**: at round end `burn_tokens#7cffe1ee` may find the treasury short of
  liquid GRAM while a later round is still open. It then mints a fresh bill against that
  round — `mint_bill#4b2d7871` → `assign_bill#3275dfc2` → `ownership_assigned` — instead of
  paying out. The unstake is still pending, now against a different bill, so a classifier
  that pairs a request with its completion through the bill address has to follow the
  hand-over or the two halves stop matching. Displaying nothing here makes the unstake
  disappear between the round that could not pay and the one that finally does.

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

  > **Breaking change for borrowers.** `borrower_reward_share` has been **removed from
  > `request_loan`**. It is set by the protocol for every loan — read it from
  > `get_treasury_state` — and snapshotted into each request, so a later `set_reward_share`
  > cannot reprice a loan already committed. A request in the old format carries 16 bits of share
  > before its ref, which `end_parse` rejects; the message is bounceable, so the collateral comes
  > back and nothing is lost, but the request does not land and the borrower misses the round.
  >
  > The bid is now one number: `min_payment`. The pool receives
  > `max(min_payment, reward × (65535 − reward_share) / 65535)`, so a bid at `min_payment` 0 still
  > pays the pool its full contractual share, and anything above the clamp is the borrower
  > competing for rank. See `docs/specs/2026-09-19-protocol-set-reward-share.md`.

  > **Since 2026-09-26 (announced 2026-09-23): `min_payment` is priced per GRAM staked.** When a round's leftover accrues to a loan, its `min_payment` is scaled to
  > `min_payment × (loan_amount + accrue_amount) / loan_amount` — the rate you bid, applied to
  > everything your loan stakes. Price `min_payment / loan_amount` as the rate you are willing to pay
  > on your whole stake, not on the loan you request. The loan log's `min_payment` is the scaled
  > amount. If what you owe exceeds the round's reward, the difference comes out of your collateral;
  > the pool collects at most the reward plus your collateral. No message, field or getter changes.
  > See `docs/specs/2026-09-22-price-accrual-at-bid-rate.md`.
  >
  > Price for the elector's cap: it pays nothing on stake above `max_factor` times the smallest
  > elected stake, but the scaling charges your rate on everything the treasury lends you. A loan
  > accepted alone takes the whole pool; if the pool is larger than the cap, a `min_payment` at the
  > pool's contractual share then binds on stake that earns nothing. Since 2026-09-26, set
  > `max_stake` (below) to the cap instead; without it, keep the rate below `cap / pool` of
  > break-even while the pool is larger than the cap.
  >
  > **Breaking, since 2026-09-26 (treasury code `54d84afc…`): `request_loan` requires
  > `max_stake:Coins` right after `min_payment`.** It is the most your loan will stake in
  > total: loan + accrue + collateral, where collateral is everything you send less the request fee,
  > so any stake of your own is included. Your accrual stops there, so you are never lent stake the
  > elector will not pay on, and you can price on the loan you request again. Set it to the cap you
  > expect the elector to apply to your validator, or 0 for no cap. A cap below `loan_amount` +
  > collateral is refused and bounced. What a capped loan does not take stays in the treasury, not
  > with the other borrowers. `get_loan_request` returns it as a ninth value.
  >
  > A body without the field is refused and the collateral bounced. The reference borrower,
  > `HipoFinance/borrower` v2.1.1 and later, sends it and takes the cap as `borrow.max_stake`. See
  > `docs/specs/2026-09-26-request-stake-cap.md`.

## Calculating Remaining Time Until Withdrawal

You have to first find the `current_round_since` by calling the `get_times` method. Then you have to send it to the `get_participation` method. It will return `stake_held_until` which is the time after which the validation round will be finalized. Here is the [full implementation in Hipo's webapp](https://github.com/HipoFinance/webapp/blob/a11a575fe231def9015ff480e1b7959c893121e2/src/Model.ts#L420).
