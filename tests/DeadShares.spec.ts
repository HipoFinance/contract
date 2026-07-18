import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, toNano } from '@ton/core'
import { bodyOp, updateFeeConfig } from './helper'
import { err, op } from '../wrappers/common'
import {
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Dead Shares', () => {
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell
    let mintDeadSharesCode: Cell

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        parentCode = await compile('Parent')
        const mainWalletCode = await compile('Wallet')
        const mainCollectionCode = await compile('Collection')
        const mainBillCode = await compile('Bill')
        const mainLoanCode = await compile('Loan')
        walletCode = exportLibCode(mainWalletCode)
        collectionCode = exportLibCode(mainCollectionCode)
        billCode = exportLibCode(mainBillCode)
        loanCode = exportLibCode(mainLoanCode)
        blockchainLibs = buildBlockchainLibraries([mainWalletCode, mainCollectionCode, mainBillCode, mainLoanCode])
        mintDeadSharesCode = await compile('upgrade-code-test/MintDeadShares')
    })

    let blockchain: Blockchain
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let treasury: SandboxContract<Treasury>
    let parent: SandboxContract<Parent>
    let fees: TreasuryFees
    const treasuryStorage = toNano('10')
    const deadShares = toNano('10')

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        updateFeeConfig(blockchain)
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
                    totalCoins: deadShares,
                    totalTokens: deadShares,
                    totalStaking: 0n,
                    totalUnstaking: 0n,
                    totalBorrowersStake: 0n,
                    parent: null,
                    participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                    roundsImbalance: 255n,
                    stopped: false,
                    instantMint: false,
                    loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        loanCode,
                    ),
                    previousRate: 1_000_000_000n,
                    currentRate: 1_000_000_000n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        collectionCode,
                    ),
                    billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        billCode,
                    ),
                    oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
                },
                treasuryCode,
            ),
        )
        parent = blockchain.openContract(
            Parent.createFromConfig(
                {
                    totalTokens: 0n,
                    treasury: treasury.address,
                    walletCode,
                    content: Cell.EMPTY,
                },
                parentCode,
            ),
        )

        const deployer = await blockchain.treasury('deployer')
        await treasury.sendDeploy(deployer.getSender(), { value: '11' })
        await parent.sendDeploy(deployer.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), { value: '1', newParent: parent.address })

        fees = await treasury.getTreasuryFees(0n)

        await treasury.sendWithdrawSurplus(governor.getSender(), {
            value: '1',
            destination: governor.address,
        })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue(treasuryStorage)
    })

    it('should start with dead shares and mint 1:1 for the first depositor', async () => {
        const state0 = await treasury.getTreasuryState()
        expect(state0.totalCoins).toBeTonValue(deadShares)
        expect(state0.totalTokens).toBeTonValue(deadShares)

        const amount = toNano('5')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: amount + fees.depositCoinsFee })

        const state1 = await treasury.getTreasuryState()
        expect(state1.totalCoins).toBeTonValue(deadShares + amount)
        expect(state1.totalTokens).toBeTonValue(deadShares + amount)

        const [tokens] = await wallet.getWalletState()
        expect(tokens).toBeTonValue(amount)

        // dead shares are treasury-only accounting: the jetton supply excludes them
        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeTonValue(amount)
    })

    it('should accept gifts when only dead shares exist and price later deposits at the higher rate', async () => {
        const someone = await blockchain.treasury('someone')
        const result = await treasury.sendGiftCoins(someone.getSender(), {
            value: toNano('10.1'),
            coins: toNano('10'),
        })
        expect(result.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })

        // rate is now 20 / 10 = 2.0
        const state1 = await treasury.getTreasuryState()
        expect(state1.totalCoins).toBeTonValue(deadShares + toNano('10'))
        expect(state1.totalTokens).toBeTonValue(deadShares)

        const amount = toNano('6')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: amount + fees.depositCoinsFee })

        const [tokens] = await wallet.getWalletState()
        expect(tokens).toBeTonValue((amount * state1.totalTokens) / state1.totalCoins) // 3 tokens at rate 2.0

        // a dust deposit that would mint zero tokens still bounces
        const result2 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('0.1') + fees.depositCoinsFee,
            coins: 1n,
        })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            body: bodyOp(op.depositCoins),
            success: false,
            exitCode: err.depositTooSmall,
        })
    })

    it('should make rate inflation through gifts strictly unprofitable', async () => {
        const attacker = await blockchain.treasury('attacker')
        const victim = await blockchain.treasury('victim')

        // attacker inflates the rate to 1010 / 10 = 101 while holding zero tokens
        await treasury.sendGiftCoins(attacker.getSender(), {
            value: toNano('1000') + toNano('0.1'),
            coins: toNano('1000'),
        })

        const deposit = toNano('10')
        await treasury.sendDepositCoins(victim.getSender(), { value: deposit + fees.depositCoinsFee })

        const walletAddress = await parent.getWalletAddress(victim.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const [tokens] = await wallet.getWalletState()
        expect(tokens).toBeGreaterThan(0n)

        // victim exits immediately; the payout must be within rounding of the deposit
        const stateBefore = await treasury.getTreasuryState()
        const walletFees = await wallet.getWalletFees()
        await wallet.sendUnstakeTokens(victim.getSender(), { value: walletFees.unstakeTokensFee, tokens })
        const stateAfter = await treasury.getTreasuryState()

        const paid = stateBefore.totalCoins - stateAfter.totalCoins
        const rate = stateBefore.totalCoins / stateBefore.totalTokens + 1n
        expect(paid).toBeLessThanOrEqual(deposit)
        expect(deposit - paid).toBeLessThanOrEqual(2n * rate) // one rounding at mint, one at burn

        // the attacker holds no tokens: the gift is locked in the pool, mostly accrued to dead shares
        expect(stateAfter.totalTokens).toBeTonValue(deadShares)
        expect(stateAfter.totalCoins).toBeGreaterThanOrEqual(deadShares + toNano('1000'))
    })

    it('should keep accepting deposits after all stakers unstake everything', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await treasury.sendDepositCoins(staker1.getSender(), { value: toNano('5') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('7') + fees.depositCoinsFee })

        for (const staker of [staker1, staker2]) {
            const walletAddress = await parent.getWalletAddress(staker.address)
            const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
            const [tokens] = await wallet.getWalletState()
            const walletFees = await wallet.getWalletFees()
            await wallet.sendUnstakeTokens(staker.getSender(), { value: walletFees.unstakeTokensFee, tokens })
        }

        // totals return exactly to the dead-share baseline (rate stayed 1.0, so no dust)
        const state1 = await treasury.getTreasuryState()
        expect(state1.totalCoins).toBeTonValue(deadShares)
        expect(state1.totalTokens).toBeTonValue(deadShares)

        // and a fresh deposit still works — no division by zero on an "emptied" pool
        const staker3 = await blockchain.treasury('staker3')
        const result = await treasury.sendDepositCoins(staker3.getSender(), {
            value: toNano('3') + fees.depositCoinsFee,
        })
        expect(result.transactions).toHaveTransaction({
            from: staker3.address,
            to: treasury.address,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        const state2 = await treasury.getTreasuryState()
        expect(state2.totalCoins).toBeTonValue(deadShares + toNano('3'))
        expect(state2.totalTokens).toBeTonValue(deadShares + toNano('3'))
    })

    it('should not let the governor withdraw the dead-share backing', async () => {
        const surplus = await treasury.getSurplus()
        expect(surplus).toBeTonValue('0')

        await treasury.sendWithdrawSurplus(governor.getSender(), {
            value: '0.2',
            destination: governor.address,
        })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue(treasuryStorage)
    })

    it('should migrate an old-style state by minting dead shares at the current rate', async () => {
        // mainnet-like pre-migration state: no dead shares, rate 1200 / 1000 = 1.2
        const oldCoins = toNano('1200')
        const oldTokens = toNano('1000')
        const state = await treasury.getTreasuryState()
        state.totalCoins = oldCoins
        state.totalTokens = oldTokens
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: treasuryStorage + oldCoins,
            }),
        )

        // the documented two-step procedure: upgrade to the one-off migration code, then back
        const result1 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: mintDeadSharesCode,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            body: bodyOp(op.gasExcess),
            success: true,
        })
        const result2 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: treasuryCode,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            body: bodyOp(op.gasExcess),
            success: true,
        })

        const migrated = await treasury.getTreasuryState()
        const deadTokens = (treasuryStorage * oldTokens) / oldCoins
        expect(migrated.totalCoins).toEqual(oldCoins + treasuryStorage)
        expect(migrated.totalTokens).toEqual(oldTokens + deadTokens)

        // existing holders are not diluted: the rate did not decrease (muldiv rounds down)
        expect(migrated.totalCoins * oldTokens).toBeGreaterThanOrEqual(oldCoins * migrated.totalTokens)

        // deposits work at the preserved rate
        const amount = toNano('6')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: amount + fees.depositCoinsFee })
        const [tokens] = await wallet.getWalletState()
        expect(tokens).toEqual((amount * migrated.totalTokens) / migrated.totalCoins)
    })
})
