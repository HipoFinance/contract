import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, toNano } from '@ton/core'
import { between, bodyOp, logTotalFees, accumulateFees, logComputeGas, logCodeSizes } from './helper'
import { op } from '../wrappers/common'
import { Fees, Treasury, participationDictionaryValue } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { LibraryDeployer, buildBlockchainLibraries } from '../wrappers/LibraryDeployer'

describe('Text', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell

    afterAll(() => {
        logCodeSizes(treasuryCode, walletCode, loanCode)
        logTotalFees()
    })

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        const mainWalletCode = await compile('Wallet')
        walletCode = LibraryDeployer.exportLibCode(mainWalletCode)
        loanCode = await compile('Loan')
        blockchainLibs = buildBlockchainLibraries([mainWalletCode])
    })

    let blockchain: Blockchain
    let driver: SandboxContract<TreasuryContract>
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let treasury: SandboxContract<Treasury>
    let fees: Fees

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
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

    it('should deposit coins for comment d', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendMessage(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
            body: 'd',
        })
        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.walletStorage, fees.depositCoinsFee),
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
        expect(treasuryBalance).toBeBetween('19.9', '20')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeTonValue('10')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeTonValue(fees.walletStorage)
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeTonValue(treasuryState.totalStaking)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
    })

    it('should stake coins for comment m', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const fee = fees.stakeFirstCoinsFee + toNano('0.01') // 0.01 for processing on treasury
        const result = await treasury.sendMessage(staker.getSender(), { value: fee, body: 'm' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.stakeFirstCoinsFee, fees.stakeFirstCoinsFee + toNano('0.001')),
            body: bodyOp(op.stakeFirstCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', fees.stakeCoinsFee),
            body: bodyOp(op.mintTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', fees.stakeCoinsFee),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: 1n,
            body: bodyOp(op.transferNotification),
            success: false,
            outMessagesCount: 0,
            aborted: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.005'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(7)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.9', '20')
        expect(treasuryState.totalCoins).toBeTonValue('10')
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
        logComputeGas('stake_first_coins', op.stakeFirstCoins, result.transactions[2])
    })

    it('should unstake all tokens for comment w', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: fees.stakeCoinsFee, roundSince: 0n })
        const fee = fees.unstakeAllTokensFee + toNano('0.01') // 0.01 for processing on treasury
        const result = await treasury.sendMessage(staker.getSender(), { value: fee, body: 'w' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.unstakeAllTokensFee + toNano('0.001'), fees.unstakeAllTokensFee + toNano('0.002')),
            body: bodyOp(op.unstakeAllTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: treasury.address,
            value: between('0', fees.unstakeTokensFee),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: driver.address,
            value: between(fees.withdrawTokensFee, fees.withdrawTokensFee + toNano('0.001')),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: between('0', '0.001'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('19.9', '20')
        expect(treasuryState.totalCoins).toBeTonValue('10')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue(treasuryState.totalTokens)

        accumulateFees(result.transactions)
        logComputeGas('unstake_all_tokens', op.unstakeAllTokens, result.transactions[2])
    })

    it('should withdraw tokens for comment b', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: fees.stakeCoinsFee, roundSince: 0n })
        await wallet.sendUnstakeTokens(staker.getSender(), { value: fees.unstakeTokensFee, tokens: '7' })
        const result = await treasury.sendMessage(staker.getSender(), { value: '0.1', body: 'b' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between('0', '0.1'),
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
            to: staker.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('12.9', '13')
        expect(treasuryState.totalCoins).toBeTonValue('3')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeTonValue('3')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')

        accumulateFees(result.transactions)
    })
})
