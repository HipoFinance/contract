# Hipo

Hipo is a **decentralized**, **permission-less**, **open-source** liquid staking protocol on TON blockchain. Visit [Hipo.Finance](https://hipo.finance) for more information or read the [docs](https://docs.hipo.finance).

Hipo consists of these components:

- **Contract**: The smart contract codes that are running on-chain. The source code is available here on this repository.
- **[Webapp](https://github.com/HipoFinance/webapp)**: The web application that helps users in staking and unstaking.
- **[Borrower](https://github.com/HipoFinance/borrower)**: The application that helps validators in borrowing from the protocol and validating blocks, thereby generating a yield for the whole protocol.

## Smart Contracts

There are different smart contracts involved in the protocol. Here is a quick recap.

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

Some of the above contracts are implemented using the library feature of Ton blockchain. Librarian is used to help with their deployments, and paying for their storage.

## Users

There are two groups of users who would be interested in using Hipo: stakers and borrowers.

### Stakers

Stakers are users who have some TON and want to earn staking rewards on their TON. In normal staking, a staker must have a large sum of TON (like at least 300,000 TON) before being able to participate in validation. Most users don't have access to such a big amount, but with a liquid staking protocol like Hipo, they can earn rewards on any TON amount.

When stakers deposit their TON, they will receive hTON jettons (a token in TON blockchain) as a receipt. Stakers can keep it or send it to other users or use it in other DeFi protocols. Whoever brings it back to the protocol, can receive the corresponding amount in TON by burning it.

Meanwhile, protocol puts staked TON from all stakers to use and will give it as a loan to validators. In turn they'll receive a reward and share it with the protocol and stakers. So over time, each hTON will have more TON value, and stakers can burn their hTON jettons to receive TON.

### Borrowers

Borrowers are node operators who have the technical knowledge of running a validator server, and have access to such a server. However, they might not have access to the minimum amount required for staking. They can ask for a loan from Hipo, to receive a loan and participate in validation and earn rewards. After earning rewards, they share it with the protocol and stakers.

Loans are given to borrowers in a safe way. Borrowers can't withdraw the loan. They can only use it for staking in TON blockchain. Any punishment will be deducted from the borrower's staked amount, so they'll pay for their own misbehavior, and stakers are not punished in such cases.

## Graphs

Both stakers and borrowers use different flows for different tasks. There are Graphviz graphs available for each flow in the [graphs/img](https://github.com/HipoFinance/contract/tree/main/graphs/img) folder. If you want to learn the internals of the protocol, it's recommended to first look at the graph of each flow to better understand them, and then read the code of smart contracts.

Requirements:

1. [Docker](https://docs.docker.com/get-docker/)
2. make

How to generate:

1. `make build_graphviz`
2. `make graphs`

## Development

Hipo is written in FunC, using the Blueprint toolset. It also has a large number of test cases, testing different aspects of the protocol.

- Install dependencies: `npm install`
- Build: `npx blueprint build`
- Test: `npx blueprint test`
- Deploy: `npx blueprint run`
