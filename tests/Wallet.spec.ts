import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Cell, Dictionary, beginCell, toNano } from 'ton-core'
import { between, bodyOp, logComputeGas, logTotalFees, accumulateFees } from './helper'
import { err, op } from '../wrappers/common'
import {
    Fees,
    ParticipationState,
    Treasury,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet, walletConfigToCell } from '../wrappers/Wallet'

describe('Wallet', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell

    afterAll(() => {
        logTotalFees()
    })

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
        loanCode = await compile('Loan')
    })

    let blockchain: Blockchain
    let treasury: SandboxContract<Treasury>
    let driver: SandboxContract<TreasuryContract>
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let fees: Fees

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        driver = await blockchain.treasury('driver')
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
                    totalCoins: 0n,
                    totalTokens: 0n,
                    totalStaking: 0n,
                    totalUnstaking: 0n,
                    totalValidatorsStake: 0n,
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                    roundsImbalance: 255n,
                    stopped: false,
                    walletCode,
                    loanCode,
                    driver: driver.address,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    content: Cell.EMPTY,
                },
                treasuryCode,
            ),
        )

        const deployer = await blockchain.treasury('deployer')
        const deployResult = await treasury.sendDeploy(deployer.getSender(), { value: '0.01' })

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: treasury.address,
            value: toNano('0.01'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployResult.transactions).toHaveLength(2)

        fees = await treasury.getFees()

        await treasury.sendTopUp(deployer.getSender(), { value: fees.treasuryStorage })
    })

    it('should deploy treasury', () => {
        return
    })

    it('should deposit coins', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10'),
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.walletStorage, '0.2'),
            body: bodyOp(op.saveCoins),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeTonValue(treasuryState.totalStaking)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
        logComputeGas('deposit_coins', op.depositCoins, result.transactions[1])
    })

    it('should deposit coins in addition to previous ongoing staking', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '5' })
        const result = await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10'),
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.walletStorage, '0.2'),
            body: bodyOp(op.saveCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.11'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('24.6', '24.7')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeBetween('14.6', '14.7')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeTonValue(treasuryState.totalStaking)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
        logComputeGas('save_coins', op.saveCoins, result.transactions[2])
    })

    it('should deposit coins with a referrer field', async () => {
        const referrer = await blockchain.treasury('referrer')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendDepositCoins(staker.getSender(), { value: '10', referrer: referrer.address })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10'),
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.walletStorage, '0.2'),
            body: bodyOp(op.saveCoins),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeTonValue(treasuryState.totalStaking)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
    })

    it('should stake coins', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })

        expect(result.transactions).toHaveTransaction({
            from: driver.address,
            to: wallet.address,
            value: toNano('0.11'),
            body: bodyOp(op.stakeCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.mintTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.1'),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue(treasuryState.totalTokens)
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
        logComputeGas('stake_coins', op.stakeCoins, result.transactions[1])
        logComputeGas('mint_tokens', op.mintTokens, result.transactions[2])
    })

    it('should send tokens to another new wallet', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await treasury.sendDepositCoins(staker1.getSender(), { value: '10' })
        const wallet1Address = await treasury.getWalletAddress(staker1.address)
        const wallet2Address = await treasury.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        await wallet1.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: '0.13',
            tokens: '9',
            recipient: staker2.address,
            returnExcess: staker1.address,
            forwardTonAmount: '0.01',
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: toNano('0.13'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0.01', '0.11'),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker2.address,
            value: toNano('0.01'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens1).toBeBetween('0.8', '0.9')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeTonValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens2).toBeTonValue('9')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeTonValue('0')

        accumulateFees(result.transactions)
    })

    it('should send tokens to another existing wallet', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await treasury.sendDepositCoins(staker1.getSender(), { value: '10' })
        await treasury.sendDepositCoins(staker2.getSender(), { value: '5' })
        const wallet1Address = await treasury.getWalletAddress(staker1.address)
        const wallet2Address = await treasury.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        await wallet1.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        await wallet2.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        const forwardPayload = beginCell().storeUint(0, 256).storeUint(0, 56).endCell().beginParse()
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: '0.13',
            tokens: '9',
            recipient: staker2.address,
            returnExcess: staker1.address,
            forwardTonAmount: '0.01',
            forwardPayload,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: toNano('0.13'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0.01', '0.11'),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker2.address,
            value: toNano('0.01'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('24.6', '24.7')
        expect(treasuryState.totalCoins).toBeBetween('14.6', '14.7')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens1).toBeBetween('0.8', '0.9')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeTonValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens2).toBeBetween('13.8', '13.9')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeTonValue('0')

        accumulateFees(result.transactions)
        logComputeGas('receive_tokens', op.receiveTokens, result.transactions[2])
        logComputeGas('send_tokens', op.sendTokens, result.transactions[1])
        logComputeGas('transfer_notification', op.transferNotification, result.transactions[3])
    })

    it('should unstake tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        const result = await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.2', tokens: '7' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.2'),
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.2'),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: driver.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('7')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeBetween('2.8', '2.9')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('7')

        accumulateFees(result.transactions)
        logComputeGas('unstake_tokens', op.unstakeTokens, result.transactions[1])
        logComputeGas('reserve_tokens', op.reserveTokens, result.transactions[2])
    })

    it('should withdraw tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.2', tokens: '7' })
        const result = await wallet.sendWithdrawTokens(driver.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: driver.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.burnTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: toNano('7'),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('12.8', '12.9')
        expect(treasuryState.totalCoins).toBeBetween('2.8', '2.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue(treasuryState.totalTokens)
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
        logComputeGas('withdraw_tokens', op.withdrawTokens, result.transactions[1])
        logComputeGas('burn_tokens', op.burnTokens, result.transactions[2])
        logComputeGas('withdrawal_notification', op.withdrawalNotification, result.transactions[3])
        logComputeGas('gas_excess', op.gasExcess, result.transactions[4])
    })

    it('should respond with wallet address', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const queryId = BigInt(Math.floor(Math.random() * Math.pow(2, 64)))
        const expectedBody = beginCell()
            .storeUint(op.takeWalletAddress, 32)
            .storeUint(queryId, 64)
            .storeAddress(walletAddress)
            .storeMaybeRef(beginCell().storeAddress(staker.address))
            .endCell()
        const result = await treasury.sendProvideWalletAddress(staker.getSender(), {
            value: '0.1',
            queryId: queryId,
            owner: staker.address,
            includeAddress: true,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.provideWalletAddress),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: expectedBody,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should provide current quote', async () => {
        const state = await treasury.getTreasuryState()
        state.totalCoins = toNano('22000')
        state.totalTokens = toNano('21000')
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: await treasury.getBalance(),
            }),
        )
        const dex = await blockchain.treasury('dex')
        const queryId = BigInt(Math.floor(Math.random() * Math.pow(2, 64)))
        const customPayload = beginCell().storeAddress(dex.address).endCell()
        const expectedBody = beginCell()
            .storeUint(op.takeCurrentQuote, 32)
            .storeUint(queryId, 64)
            .storeUint(toNano('22000'), 128)
            .storeUint(toNano('21000'), 128)
            .storeMaybeRef(customPayload)
            .endCell()
        const result = await treasury.sendProvideCurrentQuote(dex.getSender(), { value: '0.1', queryId, customPayload })

        expect(result.transactions).toHaveTransaction({
            from: dex.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.provideCurrentQuote),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: dex.address,
            value: between('0', '0.1'),
            body: expectedBody,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })

    it('should reject staking coins', async () => {
        const times = await treasury.getTimes()
        const roundSince = times.currentRoundSince
        const state = await treasury.getTreasuryState()
        const fakeParticipation = { state: ParticipationState.Staked }
        state.participations.set(roundSince, fakeParticipation)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: await treasury.getBalance(),
            }),
        )
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await wallet.sendStakeCoins(staker.getSender(), { value: '0.2', roundSince })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.2'),
            body: bodyOp(op.stakeCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.2'),
            body: bodyOp(op.mintTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.saveCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue(treasuryState.totalTokens)
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(roundSince)).toBeTonValue(treasuryState.totalStaking)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
    })

    it('should reject withdrawing tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.2', tokens: '7' })
        const state = await treasury.getTreasuryState()
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('5') + toNano('10'),
            }),
        )
        const result = await wallet.sendWithdrawTokens(staker.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.burnTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.1'),
            body: bodyOp(op.burnFailed),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: bodyOp(op.withdrawFailed),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeTonValue('15')
        expect(treasuryState.totalCoins).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('7')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeBetween('2.8', '2.9')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('7')

        accumulateFees(result.transactions)
        logComputeGas('burn_failed', op.burnFailed, result.transactions[3])
        logComputeGas('withdraw_failed', op.withdrawFailed, result.transactions[4])
    })

    it('should withdraw surplus', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendTopUp(staker.getSender(), { value: '20' })
        const result = await wallet.sendWithdrawSurplus(staker.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('20', '20.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should withdraw wrongly sent jettons', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const childWallet = await blockchain.treasury('childWallet')
        const result = await wallet.sendWithdrawJettons(staker.getSender(), {
            value: '0.1',
            childWallet: childWallet.address,
            tokens: 100n,
            customPayload: Cell.EMPTY,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawJettons),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: childWallet.address,
            value: between('0', '0.1'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })

    it('should upgrade a wallet to itself when there is no new version', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })

        const [tokens1, staking1, unstaking1] = await wallet.getWalletState()
        expect(tokens1).toBeBetween('9', '10')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toEqual(0n)

        const result1 = await wallet.sendUpgradeWallet(driver.getSender(), { value: '0.1' })
        expect(result1.transactions).toHaveTransaction({
            from: driver.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeWallet),
            success: false,
            exitCode: err.accessDenied,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await wallet.sendUpgradeWallet(staker.getSender(), { value: '0.1' })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeWallet),
            success: false,
            exitCode: err.insufficientFee,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await wallet.sendUpgradeWallet(staker.getSender(), { value: '0.21' })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.21'),
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.23'),
            body: bodyOp(op.convertWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.20'),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.15'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(5)

        const [tokens2, staking2, unstaking2] = await wallet.getWalletState()
        expect(tokens2).toBeBetween('9', '10')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toEqual(0n)

        await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.2', tokens: tokens2 })
        await treasury.sendTopUp(driver.getSender(), { value: '1' })
        await wallet.sendWithdrawTokens(driver.getSender(), { value: '0.1' })

        const [tokens3, staking3, unstaking3] = await wallet.getWalletState()
        expect(tokens3).toBeTonValue('0')
        expect(staking3.keys()).toHaveLength(0)
        expect(unstaking3).toEqual(0n)

        const result4 = await wallet.sendUpgradeWallet(staker.getSender(), { value: '0.21' })
        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.21'),
            body: bodyOp(op.upgradeWallet),
            success: false,
            exitCode: err.insufficientFunds,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveLength(3)

        const staking = Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4))
        staking.set(0n, toNano('12'))
        for (let i = 1n; i < 10n; i += 1n) {
            staking.set(i, i * toNano('1'))
        }
        const fakeData = walletConfigToCell({
            owner: staker.address,
            treasury: treasury.address,
            tokens: toNano('20'),
            staking,
            unstaking: toNano('30'),
            walletCode,
        })
        await blockchain.setShardAccount(
            wallet.address,
            createShardAccount({
                workchain: 0,
                address: wallet.address,
                code: walletCode,
                data: fakeData,
                balance: 0n,
            }),
        )

        const result5 = await wallet.sendUpgradeWallet(staker.getSender(), { value: '0.21' })
        expect(result5.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.21'),
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.20'),
            body: bodyOp(op.convertWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.15'),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.10'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result5.transactions).toHaveLength(5)

        const [tokens4, staking4, unstaking4] = await wallet.getWalletState()
        expect(tokens4).toBeTonValue('20')
        expect(staking4.keys()).toHaveLength(10)
        expect(staking4.get(0n)).toBeTonValue('12')
        for (let i = 1n; i < 10n; i += 1n) {
            expect(staking4.get(i)).toEqual(i * toNano('1'))
        }
        expect(unstaking4).toBeTonValue('30')

        logComputeGas('upgrade_wallet', op.upgradeWallet, result5.transactions[1])
        logComputeGas('convert_wallet', op.convertWallet, result5.transactions[2])
        logComputeGas('merge_wallet', op.mergeWallet, result5.transactions[3])
    })
})
