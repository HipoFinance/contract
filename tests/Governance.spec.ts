import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { between, bodyOp, createVset, emptyNewStakeMsg, logTotalFees, accumulateFees, setConfig } from './helper'
import { config, op } from '../wrappers/common'
import {
    Participation,
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Governance', () => {
    let onlyUpgradeCode: Cell
    let resetDataCode: Cell
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
        onlyUpgradeCode = await compile('upgrade-code-test/OnlyUpgrade')
        resetDataCode = await compile('upgrade-code-test/ResetData')
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

    it('should propose governor', async () => {
        const newGovernor = await blockchain.treasury('newGovernor')
        const result = await treasury.sendProposeGovernor(governor.getSender(), {
            value: '0.1',
            newGovernor: newGovernor.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proposeGovernor),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        const proposedGovernor = (treasuryState.proposedGovernor ?? Cell.EMPTY).beginParse()
        const after = Math.floor(Date.now() / 1000) + 60 * 60 * 24
        expect(Math.abs(proposedGovernor.loadUint(32) - after)).toBeLessThanOrEqual(1)
        expect(proposedGovernor.loadAddress()).toEqualAddress(newGovernor.address)
        expect(treasuryState.governor).toEqualAddress(governor.address)

        accumulateFees(result.transactions)
    })

    it('should accept governance', async () => {
        const newGovernor = await blockchain.treasury('newGovernor')
        await treasury.sendProposeGovernor(governor.getSender(), { value: '0.1', newGovernor: newGovernor.address })
        const before = Math.floor(Date.now() / 1000) - 60 * 60 * 24
        const state = await treasury.getTreasuryState()
        state.proposedGovernor = beginCell().storeUint(before, 32).storeAddress(newGovernor.address).endCell()
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10'),
            }),
        )
        const result = await treasury.sendAcceptGovernance(newGovernor.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: newGovernor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.acceptGovernance),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: newGovernor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.governor).toEqualAddress(newGovernor.address)
        expect(treasuryState.proposedGovernor).toBeNull()

        accumulateFees(result.transactions)
    })

    it('should set halter', async () => {
        const newHalter = await blockchain.treasury('newHalter')
        const result = await treasury.sendSetHalter(governor.getSender(), {
            value: '0.1',
            newHalter: newHalter.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setHalter),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.halter).toEqualAddress(newHalter.address)

        accumulateFees(result.transactions)
    })

    it('should set stopped', async () => {
        const result1 = await treasury.sendSetStopped(halter.getSender(), { value: '0.1', newStopped: true })

        expect(result1.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setStopped),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: halter.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.stopped).toEqual(true)

        const staker = await blockchain.treasury('staker')
        const result2 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: between('10', toNano('10') + fees.depositCoinsFee),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(3)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const borrower = await blockchain.treasury('borrower')
        const result3 = await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result3.transactions).toHaveTransaction({
            from: borrower.address,
            to: treasury.address,
            value: toNano('151') + fees.requestLoanFee,
            body: bodyOp(op.requestLoan),
            success: false,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: borrower.address,
            value: between('151', toNano('151') + fees.requestLoanFee),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        await treasury.sendSetStopped(halter.getSender(), { value: '0.1', newStopped: false })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result4 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.tokensMinted),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.stakeNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(5)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
    })

    it('should proxy set content', async () => {
        const newContent = beginCell().storeUint(0, 9).endCell()
        const result = await treasury.sendProxySetContent(governor.getSender(), {
            value: '0.1',
            destination: parent.address,
            newContent: newContent,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxySetContent),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', '0.1'),
            body: bodyOp(op.setContent),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: governor.address,
            value: between('0', '0.1'),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const content = (await parent.getJettonData())[3]
        expect(content).toEqualCell(newContent)

        accumulateFees(result.transactions)
    })

    it('should set reward share', async () => {
        const result = await treasury.sendSetGovernanceFee(governor.getSender(), {
            value: '0.1',
            newGovernanceFee: 8192n,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setGovernanceFee),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.governanceFee).toBe(8192n)

        accumulateFees(result.transactions)
    })

    it('should set rounds imbalance', async () => {
        const result = await treasury.sendSetRoundsImbalance(governor.getSender(), {
            value: '0.1',
            newRoundsImbalance: 128n,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setRoundsImbalance),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.roundsImbalance).toEqual(128n)

        accumulateFees(result.transactions)
    })

    it('should send message to loan', async () => {
        const borrower = await blockchain.treasury('borrower')
        const loanAddress = await treasury.getLoanAddress(borrower.address, 0n)
        const message = beginCell().storeUint(op.proxyRecoverStake, 32).storeUint(1, 64).endCell()
        const result = await treasury.sendSendMessageToLoan(halter.getSender(), {
            value: '1',
            borrower: borrower.address,
            roundSince: 0n,
            message,
        })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.sendMessageToLoan),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loanAddress,
            value: between('0', '1'),
            body: bodyOp(op.proxyRecoverStake),
            success: false, // loan is not deployed
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loanAddress,
            to: treasury.address,
            value: between('0', '1'),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        accumulateFees(result.transactions)
    })

    it('should send process loan requests', async () => {
        const state = await treasury.getTreasuryState()
        const participation = {
            state: ParticipationState.Distributing,
        }
        state.participations.set(0n, participation)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10'),
            }),
        )

        const result = await treasury.sendRetryDistribute(halter.getSender(), {
            value: '1',
            roundSince: 0n,
        })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.retryDistribute),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size).toEqual(0)

        accumulateFees(result.transactions)
    })

    it('should upgrade code', async () => {
        const oldState = await treasury.getState()
        const someone = await blockchain.treasury('someone')

        // Reject upgrade since not sent by governor
        const result1 = await treasury.sendUpgradeCode(someone.getSender(), {
            value: '0.1',
            newCode: onlyUpgradeCode,
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: false,
            outMessagesCount: 1,
        })

        // Reject upgrade since governor is not the same after upgrade
        const result2 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: onlyUpgradeCode,
            newData: beginCell().storeAddress(someone.address).endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: false,
            outMessagesCount: 1,
        })

        const result3 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: onlyUpgradeCode,
            newData: beginCell().storeAddress(governor.address).endCell(),
        })

        expect(result3.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await treasury.sendDepositCoins(governor.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })
        expect(result4.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })

        const result5 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: resetDataCode,
        })

        expect(result5.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await treasury.sendDepositCoins(governor.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })
        expect(result6.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })

        const result7 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: treasuryCode,
        })

        expect(result7.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: true,
            outMessagesCount: 1,
        })
        expect(result7.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result7.transactions).toHaveLength(3)

        const newState = await treasury.getState()
        expect(oldState.state.type).toEqual('active')
        expect(oldState.state.type).toEqual(newState.state.type)
        if (oldState.state.type === 'active' && newState.state.type === 'active') {
            expect(oldState.state.data?.toString('base64')).toEqual(newState.state.data?.toString('base64'))
        }

        accumulateFees(result1.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        accumulateFees(result6.transactions)
        accumulateFees(result7.transactions)
    })

    it('should withdraw surplus', async () => {
        const state = await treasury.getTreasuryState()
        const participation1: Participation = {
            state: ParticipationState.Held,
            size: 5n,
            totalStaked: toNano('1000000'),
            totalRecovered: toNano('1001000'),
        }
        const participation2: Participation = {
            state: ParticipationState.Validating,
            size: 10n,
            totalStaked: toNano('500000'),
            totalRecovered: 0n,
        }
        const participation3: Participation = {
            state: ParticipationState.Staked,
            size: 1n,
            totalStaked: 0n,
            totalRecovered: 0n,
        }
        state.participations.set(1n, participation1)
        state.participations.set(2n, participation2)
        state.participations.set(3n, participation3)
        state.totalCoins = toNano('900000')
        state.totalTokens = toNano('800000')
        state.totalStaking = toNano('100000')
        state.totalUnstaking = toNano('200000')
        state.totalBorrowersStake = toNano('300000')
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10') + toNano('801000') + 16n * fees.requestLoanFee + toNano('20'),
            }),
        )
        const result = await treasury.sendWithdrawSurplus(governor.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('20', '20.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should gift coins', async () => {
        const someone = await blockchain.treasury('someone')
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('1') })

        const totalCoinsBefore1 = (await treasury.getTreasuryState()).totalCoins
        const result1 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: 0n })
        const totalCoinsAfter1 = (await treasury.getTreasuryState()).totalCoins

        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveLength(3)
        expect(totalCoinsAfter1).toEqual(totalCoinsBefore1)

        const totalCoinsBefore2 = (await treasury.getTreasuryState()).totalCoins
        const result2 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: 1n })
        const totalCoinsAfter2 = (await treasury.getTreasuryState()).totalCoins

        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveLength(3)
        expect(totalCoinsAfter2).toEqual(totalCoinsBefore2 + 1n)

        const totalCoinsBefore3 = (await treasury.getTreasuryState()).totalCoins
        const result3 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.08') })
        const totalCoinsAfter3 = (await treasury.getTreasuryState()).totalCoins

        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveLength(3)
        expect(totalCoinsAfter3).toEqual(totalCoinsBefore3 + toNano('0.08'))

        const totalCoinsBefore4 = (await treasury.getTreasuryState()).totalCoins
        const result4 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.087') })
        const totalCoinsAfter4 = (await treasury.getTreasuryState()).totalCoins

        expect(result4.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(2)
        expect(totalCoinsAfter4).toEqual(totalCoinsBefore4 + toNano('0.087'))

        const totalCoinsBefore5 = (await treasury.getTreasuryState()).totalCoins
        const result5 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.088') })
        const totalCoinsAfter5 = (await treasury.getTreasuryState()).totalCoins

        expect(result5.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: false,
            actionResultCode: 37,
        })
        expect(result5.transactions).toHaveLength(2)
        expect(totalCoinsAfter5).toEqual(totalCoinsBefore5)

        await treasury.sendMessage(staker.getSender(), { value: fees.unstakeAllTokensFee, body: 'w' })
        const totalCoinsBefore6 = (await treasury.getTreasuryState()).totalCoins
        const result6 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.08') })
        const totalCoinsAfter6 = (await treasury.getTreasuryState()).totalCoins

        expect(result6.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result6.transactions).toHaveLength(3)
        expect(totalCoinsAfter6).toEqual(totalCoinsBefore6)
    })
})
