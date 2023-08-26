import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Cell, Dictionary, fromNano, toNano } from 'ton-core'
import { between, bodyOp, printFees, totalFees } from './helper'
import { op } from '../wrappers/common'
import { Fees, Treasury, participationDictionaryValue, rewardDictionaryValue } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'

describe('Text Interface', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell

    afterAll(async () => {
        console.log(fromNano(totalFees))
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
        treasury = blockchain.openContract(Treasury.createFromConfig({
            totalCoins: 0n,
            totalTokens: 0n,
            totalStaking: 0n,
            totalUnstaking: 0n,
            totalValidatorsStake: 0n,
            participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
            balancedRounds: false,
            stopped: false,
            walletCode,
            loanCode,
            driver: driver.address,
            halter: halter.address,
            governor: governor.address,
            proposedGovernor: null,
            governanceFee: 4096n,
            rewardsHistory: Dictionary.empty(Dictionary.Keys.BigUint(32), rewardDictionaryValue),
            content: Cell.EMPTY,
        }, treasuryCode))

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
        expect(deployResult.transactions).toHaveLength(2);

        fees = await treasury.getFees()

        await treasury.sendTopUp(deployer.getSender(), { value: fees.treasuryStorage })
    })

    it('should deploy treasury', async () => {
    })

    it('should deposit coins for comment d', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendMessage(staker.getSender(), { value: '10', body: 'd' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10'),
            body: bodyOp(0),
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
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeTonValue(treasuryState.totalStaking)
        expect(unstaking).toBeTonValue('0')

        printFees(result.transactions)
    })

    it('should stake coins for comment s', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendMessage(staker.getSender(), { value: '0.2', body: 's' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('0.2'),
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.stakeFirstCoins),
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
            to: staker.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(7)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue(treasuryState.totalTokens)
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')

        printFees(result.transactions)
    })

    it('should unstake all tokens for comment w', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const result = await treasury.sendMessage(staker.getSender(), { value: '0.2', body: 'w' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('0.2'),
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.unstakeAllTokens),
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
            to: staker.address,
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
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.8', '19.9')
        expect(treasuryState.totalCoins).toBeBetween('9.8', '9.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue(treasuryState.totalTokens)

        printFees(result.transactions)
    })

    it('should withdraw tokens for comment u', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.2', tokens: '7' })
        const result = await treasury.sendMessage(staker.getSender(), { value: '0.2', body: 'u' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('0.2'),
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.withdrawTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', '0.2'),
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
            to: staker.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('12.8', '12.9')
        expect(treasuryState.totalCoins).toBeBetween('2.8', '2.9')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeBetween('2.8', '2.9')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')

        printFees(result.transactions)
    })
})
