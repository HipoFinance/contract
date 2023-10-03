# hTON

hTON is a **decentralized**, **permission-less**, **open-source** liquid staking protocol on TON blockchain. Visit [Hipo.Finance](https://hipo.finance) for more information or read the [docs](https://docs.hipo.finance).

hTON consists of these components:

- **Contract**: The smart contract code that is running on-chain. The code is available here on this repository.
- **[Webapp](https://github.com/HipoFinance/webapp)**: The web application that helps users in staking and unstaking.
- **[Driver](https://github.com/HipoFinance/driver)**: The off-chain application that drives the protocol and helps users to receive their TON and hTON.
- **[Borrower](https://github.com/HipoFinance/borrower)**: The application that helps validators in borrowing from the protocol and validating blocks.

Last deployed contract on testnet:

> [kQAjvBlA6Gt0BZhvM9_PgBDVv1_EkRuMYZ3XxdaXlKRyCeaI](https://testnet.tonviewer.com/kQAjvBlA6Gt0BZhvM9_PgBDVv1_EkRuMYZ3XxdaXlKRyCeaI)

## Users

There are two groups of users who would be interested in using hTON: stakers and validators.

### Stakers

Stakers are users who have some TON and want to earn staking rewards on their TON. In normal staking, a staker must have a large sum of TON (like at-least 300,000 TON) before being able to participate in validation. Most users don't have access to such a big amount, but with a liquid staking protocol like hTON, they can earn rewards on any TON amount.

When stakers deposit their TON, they will receive hTON jettons (a token in TON blockchain) as a receipt. Stakers can keep it or send it to other users or use it in other DeFi protocols. Whoever brings it back to the protocol, can receive the corresponding amount in TON by burning it.

Meanwhile, protocol puts staked TON from all stakers to use and will give it as a loan to validators. In turn they'll receive a reward and share it with the protocol and stakers. So over time, each hTON will have more TON value, and stakers can burn their hTON jetton to receive TON.

### Validators

Validators are node operators who have the technical knowledge of running a validator server, and have access to such a server. However, they might not have access to the minimum amount required for staking. They can ask for a loan from the hTON protocol, to receive a loan and participate in validation and earn rewards. After earning rewards, they share it with the protocol and stakers.

Loans are given to validators in a safe way. Validators can't withdraw the loan. They can only use it for staking in TON blockchain. Any punishment will be deducted from the validator's staked amount, so they'll pay for their own misbehavior.

## Smart Contracts

There are 3 smart contracts in the hTON protocol: **Treasury**, **Wallet**, and **Loan**.

### Treasury

Treasury is the main smart contract which receives all stakers' TON, and lends it to interested validators. It's also the jetton minter, minting new hTON jetton for stakers. The jettons are stored in wallets.

### Wallet

Each staker will have a wallet that will store staker's jetton. Wallets receive jettons only from the treasury or from other wallets. They can also send jetton only to other wallets, or they can burn jetton by sending a request to the treasury.

### Loan

When a validator requests a loan and it's accepted, a loan smart contract is created for that validator, and only for that validation round. Loan amount is sent to this smart contract and it will automatically stake it for the validator. After the validation round finishes, the loan amount plus the reward is returned to the loan smart contract, which will forward it to the treasury. Then the treasury will calculate the reward share and distribute it between the validator and stakers.

## Flows

Both stakers and validators use different flows for different tasks. Here, each flow is described in more detail. **There are Graphviz graphs available for each flow in the `graphs` folder**. It's recommended to first look at the graph of each flow to better understand them.

## Staker Flows

Usually stakers use the web application available at [https://app.hipo.finance](https://app.hipo.finance) to send messages and talk to the protocol, but there is also an alternative. A simple text based interface is available which makes talking with the protocol easier for stakers who don't want to use the web application, or are using cold wallets and don't want to connect them to apps.

### Deposit Coins

When a staker wants to deposit some TON and receive hTON, he/she sends a `deposit_coins` message to the treasury with the TON amount.

> Alternatively a simple text message with the comment `d` may be sent to the treasury by the staker.

After this, the staker has sent the coins but will not receive hTON jetton yet. The reason is that there might be another validation round in progress, and the staker has to wait for that round to finish. When the in-progress round finishes, the staker can receive hTON jetton.

### Stake Coins

This step is usually handled by the **Driver** automatically. When the previous in-progress validation round finishes, the driver will send the `stake_coins` message for pending deposits.

> Alternatively a simple text message with the comment `s` may be sent to the treasury by the staker. Note that this most likely happens automatically, however it's available here to make the protocol permission-less: in the unlikely case that the driver doesn't work as expected, the user can drive the protocol forward.

### Send Tokens

Stakers can send hTON jetton to anyone. This is usually done through TON Wallet applications which send `send_tokens` message to the staker's hTON jetton wallet.

### Unstake Tokens

When a staker wants to burn hTON and withdraw some TON, he/she sends an `unstake_tokens` message to the hTON jetton wallet.

> Alternatively a simple text message with the comment `w` may be sent to the treasury by the staker. The choice of 'w' is intentional to match other similar protocols in the ecosystem.

After this, the staker has burned the tokens but will not receive TON yet. The reason is that there might be a validation round in progress and TON coins might be locked for the duration of the round. When the in-progress round finishes, the staker can receive TON coins.

### Withdraw Tokens

This step is usually handled by the **Driver** automatically. When funds are available, the driver will send the `withdraw_tokens` message for pending withdrawals.

> Alternatively a simple text message with the comment `u` may be sent to the treasury by the staker. Note that this most likely happens automatically, however it's available here to make the protocol permission-less: in the unlikely case that the driver doesn't work as expected, the user can drive the protocol forward.

## Validator Flows

Validators may use the **Borrower** application to talk to the protocol.

### Request Loan

A validator requests a loan by sending a `request_loan` message. The parameters include:

- loan amount: the minimum amount that the validator wants to borrow.
- min payment: the minimum payment that the validator will pay if the loan request is accepted.
- validator reward share: the share of the reward for the validator.
- round since: the validation round for the loan.
- new stake message: the signed message that will be sent to the Elector.

Notes:

1. The loan amount might be more than requested. If the treasury has more funds available, it may distribute it between accepted loans proportionally.
2. The min payment is a mechanism to select validators with the most reward returned for the loan amount requested. It's also a way to avoid draining funds by sending fake loan requests.
3. The validator reward share is the ratio to split reward. The reward is distributed by considering this ratio and also the final paid amount must be greater than min payment.

Validators that provide better return on investment (ROI) have a higher chance to win.

### Participate In Election

The message `participate_in_election` will start the process of deciding on loan requests and distributing funds. Rejected requests will receive back their staked amount and accepted requests will be given the loan and participate in the election automatically.

### Vset Changed

The message `vset_changed` gives a hint to the treasury that a round has passed. This is a way to wait for the correct time to accept the message to finish participation.

### Finish Participation

The message `finish_participation` asks the treasury to retrieve the loaned amount plus reward for each given loan and distribute rewards.

## Governance

There are 3 roles in the governance of the protocol:

- Governor: the top authority in the protocol.
- Halter: the one that can stop deposits to the treasury and also stops new loan requests.
- Driver: the account that receives the gas fee for driving the protocol.

## Governance Flows

- A new governor can be proposed.
- The new governor can accept governance.
- The halter can be changed.
- The halter can stop deposits to the treasury and also loan requests.
- The driver can be changed.
- The metadata of the protocol can be updated.
- The reward share of the protocol can be updated.
- The halter can send messages from the treasury to the loans in the emergency case.

## Development

- Install dependencies: `yarn`
- Build contracts: `yarn blueprint build`
- Deploy: `yarn blueprint run`
- Test: `yarn test`

### Graphs

Requirements:

1. [Docker](https://docs.docker.com/get-docker/)
2. make

How to generate:

1. `make build_graphviz`
2. `make graphs`

## License

MIT
