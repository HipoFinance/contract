import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { beginCell, Cell, Dictionary, toNano } from 'ton-core'
import { between, bodyOp, logTotalFees } from './helper'
import { op } from '../wrappers/common'
import { Fees, Treasury, participationDictionaryValue, rewardDictionaryValue } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'

describe('Getters', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell

    afterAll(async () => {
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
    let deployer: SandboxContract<TreasuryContract>

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

        deployer = await blockchain.treasury('deployer')
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

    it('should return max punishment value', async () => {
        const maxPunishment = await treasury.getMaxPunishment(1n)
        expect(maxPunishment).toEqual(101000000000n)
    })

    it('should return jetton data', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const newContent = beginCell().storeUint(0, 9).endCell()
        await treasury.sendSetContent(governor.getSender(), { value: '0.1', newContent: newContent })

        const [allTokens, mintable, adminAddress, jettonContent, jettonWalletCode] = await treasury.getJettonData()
        expect(allTokens).toBeBetween(10000000000n, 9000000000n)
        expect(mintable).toEqual(true)
        expect(adminAddress.toString()).toEqual("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c")
        expect(jettonContent.toString()).toEqual(newContent.toString())
        expect(jettonWalletCode.toString()).toEqual(walletCode.toString())
    })

    it('should return wallet data', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        const [tokens, ownerAddress, treasuryAddress, walletDataCode] = await wallet.getWalletData()
        expect(tokens).toBeBetween(10000000000n, 9000000000n)
        expect(ownerAddress.toString()).toEqual(staker.address.toString())
        expect(treasuryAddress.toString()).toEqual(treasury.address.toString())
        expect(walletDataCode.toString()).toEqual(walletCode.toString())
    })

    it('should return treasury state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const newContent = beginCell().storeUint(0, 9).endCell()
        await treasury.sendSetContent(governor.getSender(), { value: '0.1', newContent: newContent })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.balancedRounds).toEqual(false)
        expect(treasuryState.content.toString()).toEqual(newContent.toString())
        expect(treasuryState.driver.toString()).toEqual(driver.address.toString())
        expect(treasuryState.governanceFee).toEqual(4096n)
        expect(treasuryState.governor.toString()).toEqual(governor.address.toString())
        expect(treasuryState.halter.toString()).toEqual(halter.address.toString())
        expect(treasuryState.loanCode.toString()).toEqual(loanCode.toString())
        expect(treasuryState.participations.keys()).toHaveLength(0)
        expect(treasuryState.proposedGovernor).toEqual(null)
        expect(treasuryState.rewardsHistory.keys()).toHaveLength(0)
        expect(treasuryState.stopped).toEqual(false)
        expect(treasuryState.totalCoins).toBeBetween(10000000000n, 9000000000n)
        expect(treasuryState.totalStaking).toEqual(0n)
        expect(treasuryState.totalTokens).toBeBetween(10000000000n, 9000000000n)
        expect(treasuryState.totalUnstaking).toEqual(0n)
        expect(treasuryState.totalValidatorsStake).toEqual(0n)
        expect(treasuryState.walletCode.toString()).toEqual(walletCode.toString())
    })

    it('should return wallet state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(tokens).toEqual(0n)
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeBetween(10000000000n, 9000000000n)
        expect(unstaking).toBeTonValue('0')

        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const [tokensAfterStake, stakingAfterStake, unstakingAfterStake] = await wallet.getWalletState()
        expect(tokensAfterStake).toBeBetween(10000000000n, 9000000000n)
        expect(stakingAfterStake.keys()).toHaveLength(0)
        expect(unstakingAfterStake).toBeTonValue('0')
    })
})