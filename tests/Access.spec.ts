import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { between, bodyOp, createVset, logTotalFees, setConfig, createNewStakeMsg, getElector } from './helper'
import { config, err, op } from '../wrappers/common'
import {
    Fees,
    ParticipationState,
    Treasury,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Loan } from '../wrappers/Loan'
import { Wallet } from '../wrappers/Wallet'
import { Collection } from '../wrappers/Collection'
import { Bill } from '../wrappers/Bill'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'

describe('Access', () => {
    let electorCode: Cell
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell

    afterAll(() => {
        logTotalFees()
    })

    beforeAll(async () => {
        electorCode = await compile('elector-test/Elector')
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
    })

    let blockchain: Blockchain
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let treasury: SandboxContract<Treasury>
    let parent: SandboxContract<Parent>
    let fees: Fees
    let electorAddress: Address

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
                    totalValidatorsStake: 0n,
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

        fees = await treasury.getFees()

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10' })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue('10')

        electorAddress = getElector(blockchain)
    })

    it('should check access in treasury', async () => {
        const someone = await blockchain.treasury('someone')
        const mainchainWallet = await blockchain.treasury('wallet', { workchain: -1 })

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const maxBurnableTokens = await treasury.getMaxBurnableTokens()
        expect(maxBurnableTokens).toBeBetween(toNano('10') - 5n, '10')

        // Operations that are open to anyone:
        // - deposit_coins
        // - send_unstake_tokens
        // - provide_current_quote
        // - request_loan
        // - participate_in_election
        // - vset_changed
        // - finish_participation

        const result1 = await treasury.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.reserveTokens, 32)
                .storeUint(0, 64)
                .storeCoins(1n)
                .storeAddress(someone.address)
                .storeUint(0, 4)
                .storeCoins(0n)
                .endCell(),
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: someone.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyRollbackUnstake),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await treasury.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.mintTokens, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeAddress(parent.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.mintTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await treasury.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.burnTokens, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeAddress(parent.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.burnTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await treasury.sendRequestLoan(mainchainWallet.getSender(), {
            value: '1000',
            loanAmount: '350000',
            minPayment: '100',
            roundSince: 1n,
            validatorRewardShare: 102n,
            newStakeMsg: await createNewStakeMsg(mainchainWallet.address, 1n),
        })
        expect(result4.transactions).toHaveTransaction({
            from: mainchainWallet.address,
            to: treasury.address,
            value: toNano('1000'),
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result4.transactions).toHaveLength(3)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const validator1 = await blockchain.treasury('validator1')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })

        const result5 = await treasury.sendMessage(someone.getSender(), {
            value: '1',
            body: beginCell().storeUint(op.decideLoanRequests, 32).storeUint(0, 64).storeUint(until1, 32).endCell(),
        })
        expect(result5.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.decideLoanRequests),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await treasury.sendMessage(someone.getSender(), {
            value: '1',
            body: beginCell().storeUint(op.processLoanRequests, 32).storeUint(0, 64).storeUint(until1, 32).endCell(),
        })
        expect(result6.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.processLoanRequests),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result6.transactions).toHaveLength(3)

        const result7 = await treasury.sendMessage(someone.getSender(), {
            value: '1',
            body: beginCell().storeUint(op.recoverStakes, 32).storeUint(0, 64).storeUint(until1, 32).endCell(),
        })
        expect(result7.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.recoverStakes),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result7.transactions).toHaveLength(3)

        const result8 = await treasury.sendMessage(mainchainWallet.getSender(), {
            value: '1000',
            body: beginCell()
                .storeUint(op.recoverStakeResult, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeAddress(mainchainWallet.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result8.transactions).toHaveTransaction({
            from: mainchainWallet.address,
            to: treasury.address,
            value: toNano('1000'),
            body: bodyOp(op.recoverStakeResult),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result8.transactions).toHaveLength(3)

        const result9 = await treasury.sendMessage(someone.getSender(), {
            value: '1',
            body: beginCell().storeUint(op.lastBillBurned, 32).storeUint(0, 64).storeUint(0, 32).endCell(),
        })
        expect(result9.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.lastBillBurned),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result9.transactions).toHaveLength(3)

        const result10 = await treasury.sendProposeGovernor(halter.getSender(), {
            value: '0.1',
            newGovernor: someone.address,
        })
        expect(result10.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proposeGovernor),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result10.transactions).toHaveLength(3)

        const result11 = await treasury.sendProposeGovernor(governor.getSender(), {
            value: '0.1',
            newGovernor: someone.address,
        })
        expect(result11.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proposeGovernor),
            success: true,
            outMessagesCount: 1,
        })
        expect(result11.transactions).toHaveLength(3)

        const result12 = await treasury.sendAcceptGovernance(halter.getSender(), {
            value: '0.1',
        })
        expect(result12.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.acceptGovernance),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result12.transactions).toHaveLength(3)

        const result13 = await treasury.sendAcceptGovernance(someone.getSender(), {
            value: '0.1',
        })
        expect(result13.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.acceptGovernance),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result13.transactions).toHaveLength(3)

        const result14 = await treasury.sendSetHalter(someone.getSender(), {
            value: '0.1',
            newHalter: someone.address,
        })
        expect(result14.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setHalter),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result14.transactions).toHaveLength(3)

        const result15 = await treasury.sendSetStopped(someone.getSender(), {
            value: '0.1',
            newStopped: true,
        })
        expect(result15.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setStopped),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result15.transactions).toHaveLength(3)

        const result16 = await treasury.sendSetInstantMint(someone.getSender(), {
            value: '0.1',
            newInstantMint: true,
        })
        expect(result16.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setInstantMint),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result16.transactions).toHaveLength(3)

        const result17 = await treasury.sendSetGovernanceFee(someone.getSender(), {
            value: '0.1',
            newGovernanceFee: 2048n,
        })
        expect(result17.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setGovernanceFee),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result17.transactions).toHaveLength(3)

        const result18 = await treasury.sendSetRoundsImbalance(someone.getSender(), {
            value: '0.1',
            newRoundsImbalance: 0n,
        })
        expect(result18.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setRoundsImbalance),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result18.transactions).toHaveLength(3)

        const result19 = await treasury.sendSendMessageToLoan(someone.getSender(), {
            value: '0.1',
            validator: validator1.address,
            roundSince: until1,
            message: Cell.EMPTY,
        })
        expect(result19.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.sendMessageToLoan),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result19.transactions).toHaveLength(3)

        const result20 = await treasury.sendRetryDistribute(someone.getSender(), {
            value: '0.1',
            roundSince: until1,
        })
        expect(result20.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.retryDistribute),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result20.transactions).toHaveLength(3)

        const result21 = await treasury.sendRetryRecoverStakes(someone.getSender(), {
            value: '0.1',
            roundSince: until1,
        })
        expect(result21.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.retryRecoverStakes),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result21.transactions).toHaveLength(3)

        const result22 = await treasury.sendRetryBurnAll(someone.getSender(), {
            value: '0.1',
            roundSince: until1,
            startIndex: 0n,
        })
        expect(result22.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.retryBurnAll),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result22.transactions).toHaveLength(3)

        const result23 = await treasury.sendSetParent(halter.getSender(), {
            value: '0.1',
            newParent: someone.address,
        })
        expect(result23.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setParent),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result23.transactions).toHaveLength(3)

        const result24 = await treasury.sendProxySetContent(halter.getSender(), {
            value: '0.1',
            destination: parent.address,
            newContent: Cell.EMPTY,
        })
        expect(result24.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxySetContent),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result24.transactions).toHaveLength(3)

        const result25 = await treasury.sendWithdrawSurplus(halter.getSender(), {
            value: '0.1',
            returnExcess: halter.address,
        })
        expect(result25.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result25.transactions).toHaveLength(3)

        const result26 = await treasury.sendProxyWithdrawSurplus(halter.getSender(), {
            value: '0.1',
            destination: parent.address,
        })
        expect(result26.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyWithdrawSurplus),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result26.transactions).toHaveLength(3)

        const result27 = await treasury.sendUpgradeCode(halter.getSender(), {
            value: '0.1',
            newCode: Cell.EMPTY,
        })
        expect(result27.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result27.transactions).toHaveLength(3)

        const result28 = await treasury.sendProxyUpgradeCode(halter.getSender(), {
            value: '0.1',
            destination: parent.address,
            newCode: Cell.EMPTY,
        })
        expect(result28.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyUpgradeCode),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result28.transactions).toHaveLength(3)

        const result29 = await treasury.sendSendProxyUpgradeWallet(someone.getSender(), {
            value: '0.1',
            destination: parent.address,
            owner: someone.address,
        })
        expect(result29.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.sendProxyUpgradeWallet),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result29.transactions).toHaveLength(3)

        const result30 = await treasury.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.migrateWallet, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result30.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.migrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result30.transactions).toHaveTransaction({
            from: treasury.address,
            to: someone.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyMergeWallet),
            success: true,
            outMessagesCount: 0,
        })
        expect(result30.transactions).toHaveLength(3)

        const result31 = await treasury.sendProxySetLibrary(halter.getSender(), {
            value: '0.1',
            destination: someone.address,
            mode: 2n,
            code: Cell.EMPTY,
        })
        expect(result31.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxySetLibrary),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result31.transactions).toHaveLength(3)
    })

    it('should check access in parent', async () => {
        const someone = await blockchain.treasury('someone')

        // Operations that are open to anyone:
        // - provide_wallet_address

        const result1 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyTokensMinted, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyTokensMinted),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxySaveCoins, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxySaveCoins),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyReserveTokens, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeUint(0, 4)
                .storeCoins(0n)
                .endCell(),
        })
        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyReserveTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyRollbackUnstake, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result4.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyRollbackUnstake),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result4.transactions).toHaveLength(3)

        const result5 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyTokensBurned, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result5.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyTokensBurned),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyUnstakeTokens, 32)
                .storeUint(0, 64)
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result6.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyUnstakeTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result6.transactions).toHaveLength(3)

        const result7 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyUpgradeWallet, 32)
                .storeUint(0, 64)
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result7.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyUpgradeWallet),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result7.transactions).toHaveLength(3)

        const result8 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyMigrateWallet, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result8.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyMigrateWallet),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result8.transactions).toHaveLength(3)

        const result9 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proxyMergeWallet, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result9.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyMergeWallet),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result9.transactions).toHaveLength(3)

        const result10 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.setContent, 32)
                .storeUint(0, 64)
                .storeAddress(someone.address)
                .storeRef(Cell.EMPTY)
                .endCell(),
        })
        expect(result10.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.setContent),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result10.transactions).toHaveLength(3)

        const result11 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.withdrawSurplus, 32)
                .storeUint(0, 64)
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result11.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result11.transactions).toHaveLength(3)

        const result12 = await parent.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.upgradeCode, 32)
                .storeUint(0, 64)
                .storeRef(Cell.EMPTY)
                .storeMaybeRef(Cell.EMPTY)
                .storeAddress(someone.address)
                .endCell(),
        })
        expect(result12.transactions).toHaveTransaction({
            from: someone.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result12.transactions).toHaveLength(3)
    })

    it('should check access in wallet', async () => {
        const someone = await blockchain.treasury('someone')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        const result1 = await wallet.sendSendTokens(someone.getSender(), {
            value: '0.1',
            tokens: '1',
            recipient: someone.address,
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.sendTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await wallet.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.receiveTokens, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeAddress(someone.address)
                .storeCoins(0)
                .storeBit(0)
                .endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.receiveTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await wallet.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.tokensMinted, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.tokensMinted),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await wallet.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.saveCoins, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeAddress(someone.address)
                .storeUint(0, 32)
                .endCell(),
        })
        expect(result4.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.saveCoins),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result4.transactions).toHaveLength(3)

        const result5 = await wallet.sendUnstakeTokens(someone.getSender(), {
            value: '0.1',
            tokens: '1',
        })
        expect(result5.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.unstakeTokens),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await wallet.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.rollbackUnstake, 32).storeUint(0, 64).storeCoins(toNano('1')).endCell(),
        })
        expect(result6.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.rollbackUnstake),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result6.transactions).toHaveLength(3)

        const result7 = await wallet.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.tokensBurned, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeCoins(toNano('1'))
                .endCell(),
        })
        expect(result7.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.tokensBurned),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result7.transactions).toHaveLength(3)

        const result8 = await wallet.sendUpgradeWallet(someone.getSender(), {
            value: '0.1',
        })
        expect(result8.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeWallet),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result8.transactions).toHaveLength(3)

        const result9 = await wallet.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.mergeWallet, 32).storeUint(0, 64).storeCoins(toNano('1')).endCell(),
        })
        expect(result9.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.mergeWallet),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result9.transactions).toHaveLength(3)

        const result10 = await wallet.sendWithdrawSurplus(someone.getSender(), {
            value: '0.1',
        })
        expect(result10.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result10.transactions).toHaveLength(3)

        const result11 = await wallet.sendWithdrawJettons(someone.getSender(), {
            value: '0.1',
            childWallet: wallet.address,
            tokens: toNano('1'),
        })
        expect(result11.transactions).toHaveTransaction({
            from: someone.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawJettons),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result11.transactions).toHaveLength(3)
    })

    it('should check access in collection', async () => {
        const roundSince = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: await treasury.getBalance(),
            }),
        )

        const someone = await blockchain.treasury('someone')
        const staker = await blockchain.treasury('staker')
        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const collection = blockchain.openContract(Collection.createFromAddress(collectionAddress))
        await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        const result1 = await collection.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.mintBill, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeBit(0)
                .storeAddress(someone.address)
                .storeAddress(parent.address)
                .storeCoins(0n)
                .endCell(),
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: collection.address,
            value: toNano('0.1'),
            body: bodyOp(op.mintBill),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await collection.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.billBurned, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeBit(0)
                .storeAddress(someone.address)
                .storeAddress(parent.address)
                .storeUint(0, 64)
                .endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: collection.address,
            value: toNano('0.1'),
            body: bodyOp(op.billBurned),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await collection.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.burnAll, 32).storeUint(0, 64).storeUint(0, 64).endCell(),
        })
        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: collection.address,
            value: toNano('0.1'),
            body: bodyOp(op.burnAll),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result3.transactions).toHaveLength(3)
    })

    it('should check access in bill', async () => {
        const roundSince = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: await treasury.getBalance(),
            }),
        )

        const someone = await blockchain.treasury('someone')
        const staker = await blockchain.treasury('staker')
        const billAddress = await treasury.getBillAddress(roundSince, 0n)
        const bill = blockchain.openContract(Bill.createFromAddress(billAddress))
        await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        // Operations that are open to anyone:
        // - request_owner
        // - get_static_data

        const result1 = await bill.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.assignBill, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('1'))
                .storeBit(0)
                .storeAddress(someone.address)
                .storeAddress(parent.address)
                .storeCoins(0n)
                .endCell(),
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: bill.address,
            value: toNano('0.1'),
            body: bodyOp(op.assignBill),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await bill.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.burnBill, 32).storeUint(0, 64).endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: bill.address,
            value: toNano('0.1'),
            body: bodyOp(op.burnBill),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await bill.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell()
                .storeUint(op.proveOwnership, 32)
                .storeUint(0, 64)
                .storeAddress(someone.address)
                .storeRef(Cell.EMPTY)
                .storeBit(0)
                .endCell(),
        })
        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: bill.address,
            value: toNano('0.1'),
            body: bodyOp(op.proveOwnership),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result3.transactions).toHaveLength(3)
    })

    it('should check access in loan', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: 0n }) }),
                balance: toNano('1'),
            }),
        )

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: toNano('161') + fees.requestLoanFee, // 101 (max punishment) + 60 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: toNano('171') + fees.requestLoanFee, // 101 (max punishment) + 70 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)

        await treasury.sendParticipateInElection({ roundSince: until1 })

        const someone = await blockchain.treasury('someone')
        const loanAddress = await treasury.getLoanAddress(validator2.address, until1)
        const loan = blockchain.openContract(Loan.createFromAddress(loanAddress))

        const result1 = await loan.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.proxyNewStake, 32).storeUint(0, 64).storeRef(Cell.EMPTY).endCell(),
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: loan.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyNewStake),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await loan.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.proxyRecoverStake, 32).storeUint(0, 64).endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: loan.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxyRecoverStake),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

        const result3 = await loan.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.newStakeError, 32).storeUint(0, 64).endCell(),
        })
        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: loan.address,
            value: toNano('0.1'),
            body: bodyOp(op.newStakeError),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await loan.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.recoverStakeError, 32).storeUint(0, 64).endCell(),
        })
        expect(result4.transactions).toHaveTransaction({
            from: someone.address,
            to: loan.address,
            value: toNano('0.1'),
            body: bodyOp(op.recoverStakeError),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result4.transactions).toHaveLength(3)

        const result5 = await loan.sendMessage(someone.getSender(), {
            value: '0.1',
            body: beginCell().storeUint(op.recoverStakeOk, 32).storeUint(0, 64).endCell(),
        })
        expect(result5.transactions).toHaveTransaction({
            from: someone.address,
            to: loan.address,
            value: toNano('0.1'),
            body: bodyOp(op.recoverStakeOk),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result5.transactions).toHaveLength(3)
    })
})
