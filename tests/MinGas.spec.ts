import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, toNano } from '@ton/core'
import { bodyOp, createVset, emptyNewStakeMsg, setConfig } from './helper'
import { config, err, op } from '../wrappers/common'
import { Treasury, TreasuryFees, emptyDictionaryValue, participationDictionaryValue } from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Wallet } from '../wrappers/Wallet'

describe('Min Gas', () => {
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell
    let mainWalletCode: Cell
    let mainCollectionCode: Cell
    let mainBillCode: Cell
    let mainLoanCode: Cell

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        parentCode = await compile('Parent')
        mainWalletCode = await compile('Wallet')
        mainCollectionCode = await compile('Collection')
        mainBillCode = await compile('Bill')
        mainLoanCode = await compile('Loan')
        walletCode = exportLibCode(mainWalletCode)
        collectionCode = exportLibCode(mainCollectionCode)
        billCode = exportLibCode(mainBillCode)
        loanCode = exportLibCode(mainLoanCode)
        blockchainLibs = buildBlockchainLibraries([mainWalletCode, mainCollectionCode, mainBillCode, mainLoanCode])
    })

    let blockchain: Blockchain
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let treasury: SandboxContract<Treasury>
    let parent: SandboxContract<Parent>
    let fees: TreasuryFees

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
                    totalCoins: 0n,
                    totalTokens: 0n,
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
                    lastStaked: 0n,
                    lastRecovered: 0n,
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
        const deployTreasuryResult = await treasury.sendDeploy(deployer.getSender(), { value: '1' })
        const deployParentResult = await parent.sendDeploy(deployer.getSender(), { value: '1' })
        const setParentResult = await treasury.sendSetParent(governor.getSender(), {
            value: '1',
            newParent: parent.address,
        })
        expect(deployTreasuryResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployTreasuryResult.transactions).toHaveLength(2)
        expect(deployParentResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: parent.address,
            value: toNano('1'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployParentResult.transactions).toHaveLength(2)
        expect(setParentResult.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.setParent),
            success: true,
            outMessagesCount: 1,
        })
        expect(setParentResult.transactions).toHaveLength(3)

        fees = await treasury.getTreasuryFees(0n)

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10' })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue('10')
    })

    it('should require min gas fee in treasury', async () => {
        const staker = await blockchain.treasury('staker')

        const result1 = await treasury.sendDepositCoins(staker.getSender(), { value: fees.depositCoinsFee })
        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await treasury.sendDepositCoins(staker.getSender(), { value: fees.depositCoinsFee + 1n })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.depositCoinsFee + 1n,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })

        const result3 = await treasury.sendMessage(staker.getSender(), {
            value: fees.unstakeAllTokensFee - 1n,
            body: 'w',
        })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.unstakeAllTokensFee - 1n,
            body: bodyOp(0),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await treasury.sendMessage(staker.getSender(), { value: fees.unstakeAllTokensFee, body: 'w' })
        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.unstakeAllTokensFee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000))
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const minStake = toNano('300000')
        const maxPunishment = await treasury.getMaxPunishment(0n)
        const newStakeConfirmation = toNano('1')

        const result5 = await treasury.sendRequestLoan(staker.getSender(), {
            value: maxPunishment + fees.requestLoanFee - 1n,
            loanAmount: minStake - maxPunishment + newStakeConfirmation,
            minPayment: 0n,
            borrowerRewardShare: 0n,
            newStakeMsg: emptyNewStakeMsg,
            roundSince: until,
        })
        expect(result5.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: maxPunishment + fees.requestLoanFee - 1n,
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode: err.insufficientFunds,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await treasury.sendRequestLoan(staker.getSender(), {
            value: maxPunishment + fees.requestLoanFee,
            loanAmount: minStake - maxPunishment + newStakeConfirmation,
            minPayment: 0n,
            borrowerRewardShare: 0n,
            newStakeMsg: emptyNewStakeMsg,
            roundSince: until,
        })
        expect(result6.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: maxPunishment + fees.requestLoanFee,
            body: bodyOp(op.requestLoan),
            success: true,
            outMessagesCount: 0,
        })
    })

    it('should require min gas fee in wallet', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') })
        const walletFees = await wallet.getWalletFees()

        const result1 = await wallet.sendSendTokens(staker.getSender(), {
            value: toNano('0.030'),
            tokens: '7',
            recipient: halter.address,
            forwardTonAmount: 1n,
        })
        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.030'),
            body: bodyOp(op.sendTokens),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await wallet.sendSendTokens(staker.getSender(), {
            value: toNano('0.031'),
            tokens: '7',
            recipient: halter.address,
            forwardTonAmount: 1n,
        })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.031'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })

        const result3 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee - 1n,
            tokens: '1',
        })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.unstakeTokensFee - 1n,
            body: bodyOp(op.unstakeTokens),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
        })
        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.unstakeTokensFee,
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })

        const result5 = await wallet.sendUpgradeWallet(staker.getSender(), { value: walletFees.upgradeWalletFee - 1n })
        expect(result5.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.upgradeWalletFee - 1n,
            body: bodyOp(op.upgradeWallet),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await wallet.sendUpgradeWallet(staker.getSender(), { value: walletFees.upgradeWalletFee })
        expect(result6.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.upgradeWalletFee,
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
    })
})
