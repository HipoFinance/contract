import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { beginCell, Cell, Dictionary, toNano } from 'ton-core'
import { bodyOp, logTotalFees } from './helper'
import { op } from '../wrappers/common'
import { Fees, Treasury, participationDictionaryValue, rewardDictionaryValue } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'

describe('Getters', () => {
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
                    rewardsHistory: Dictionary.empty(Dictionary.Keys.BigUint(32), rewardDictionaryValue),
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

    it('should return max punishment value', async () => {
        const maxPunishmentMin = await treasury.getMaxPunishment(1n)
        expect(maxPunishmentMin).toBeTonValue('101')

        const maxPunishmentMax = await treasury.getMaxPunishment(5000000000000000000n)
        expect(maxPunishmentMax).toBeTonValue('101')
    })

    it('should return jetton data', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const newContent = beginCell().storeUint(0, 9).endCell()
        await treasury.sendSetContent(governor.getSender(), { value: '0.1', newContent: newContent })

        const [totalTokens, mintable, adminAddress, content, code] = await treasury.getJettonData()
        expect(totalTokens).toBeBetween('9', '10')
        expect(mintable).toEqual(true)
        expect(adminAddress.toString()).toEqual('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c')
        expect(content.toBoc().toString('base64')).toEqual(newContent.toBoc().toString('base64'))
        expect(code.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
    })

    it('should return wallet data', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        const [tokens, ownerAddress, treasuryAddress, code] = await wallet.getWalletData()
        expect(tokens).toBeBetween('9', '10')
        expect(ownerAddress.toString()).toEqual(staker.address.toString())
        expect(treasuryAddress.toString()).toEqual(treasury.address.toString())
        expect(code.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
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
        expect(treasuryState.totalCoins).toBeBetween('9', '10')
        expect(treasuryState.totalTokens).toBeBetween('9', '10')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.keys()).toHaveLength(0)
        expect(treasuryState.roundsImbalance).toEqual(255n)
        expect(treasuryState.stopped).toEqual(false)
        expect(treasuryState.walletCode.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
        expect(treasuryState.loanCode.toBoc().toString('base64')).toEqual(loanCode.toBoc().toString('base64'))
        expect(treasuryState.driver.toString()).toEqual(driver.address.toString())
        expect(treasuryState.halter.toString()).toEqual(halter.address.toString())
        expect(treasuryState.governor.toString()).toEqual(governor.address.toString())
        expect(treasuryState.proposedGovernor).toEqual(null)
        expect(treasuryState.governanceFee).toEqual(4096n)
        expect(treasuryState.rewardsHistory.keys()).toHaveLength(0)
        expect(treasuryState.content.toBoc().toString('base64')).toEqual(newContent.toBoc().toString('base64'))
    })

    it('should return wallet state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeBetween('9', '10')
        expect(unstaking).toBeTonValue('0')

        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const [tokensAfterStake, stakingAfterStake, unstakingAfterStake] = await wallet.getWalletState()
        expect(tokensAfterStake).toBeBetween('9', '10')
        expect(stakingAfterStake.keys()).toHaveLength(0)
        expect(unstakingAfterStake).toBeTonValue('0')
    })
})
