import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Cell, Dictionary, toNano } from 'ton-core'
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

    it('should getters work', async () => {
        const maxPunishment = await treasury.getMaxPunishment(1n)
        expect(maxPunishment).toEqual(101000000000n)

        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        const [allTokens, , , ,] = await treasury.getJettonData()
        expect(allTokens).toBeBetween(10000000000n, 9000000000n)

        const [tokens, ownerAddress, treasuryAddress,] = await wallet.getWalletData()
        expect(tokens).toBeBetween(10000000000n, 9000000000n)
        expect(ownerAddress.toString()).toEqual(staker.address.toString())
        expect(treasuryAddress.toString()).toEqual(treasury.address.toString())
    })
})