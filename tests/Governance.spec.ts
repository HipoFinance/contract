import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton-community/sandbox'
import { Cell, Dictionary, beginCell, toNano } from 'ton-core'
import { between, bodyOp, createVset, emptyNewStakeMsg, logTotalFees, accumulateFees, setConfig } from './helper'
import { config, op } from '../wrappers/common'
import {
    Fees,
    Participation,
    ParticipationState,
    Treasury,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'

describe('Treasury', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell
    let onlyUpgradeCode: Cell
    let resetDataCode: Cell

    afterAll(() => {
        logTotalFees()
    })

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
        loanCode = await compile('Loan')
        onlyUpgradeCode = await compile('upgrade-code-test/OnlyUpgrade')
        resetDataCode = await compile('upgrade-code-test/ResetData')
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
        expect(Math.abs(proposedGovernor.loadUint(32) - after) <= 1).toBeTruthy()
        expect(proposedGovernor.loadAddress().equals(newGovernor.address)).toBeTruthy()
        expect(treasuryState.governor.equals(governor.address)).toBeTruthy()

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
        expect(treasuryState.governor.equals(newGovernor.address)).toBeTruthy()
        expect(treasuryState.proposedGovernor == null).toBeTruthy()

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
        expect(treasuryState.halter.equals(newHalter.address)).toBeTruthy()

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
        expect(treasuryState.stopped).toBeTruthy()

        const staker = await blockchain.treasury('staker')
        const result2 = await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10'),
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: between('9.9', '10'),
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

        const validator = await blockchain.treasury('validator')
        const result3 = await treasury.sendRequestLoan(validator.getSender(), {
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result3.transactions).toHaveTransaction({
            from: validator.address,
            to: treasury.address,
            value: toNano('151.9'),
            body: bodyOp(op.requestLoan),
            success: false,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator.address,
            value: between('151.8', '151.9'),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        await treasury.sendSetStopped(halter.getSender(), { value: '0.1', newStopped: false })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result4 = await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10'),
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: wallet.address,
            value: between(fees.walletStorage, '0.12'),
            body: bodyOp(op.saveCoins),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(4)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
    })

    it('should set driver', async () => {
        const newDriver = await blockchain.treasury('newDriver')
        const result = await treasury.sendSetDriver(halter.getSender(), { value: '0.1', newDriver: newDriver.address })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setDriver),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: halter.address,
            value: between('0', '0.1'),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.driver.equals(newDriver.address)).toBeTruthy()

        accumulateFees(result.transactions)
    })

    it('should set content', async () => {
        const newContent = beginCell().storeUint(0, 9).endCell()
        const result = await treasury.sendSetContent(governor.getSender(), { value: '0.1', newContent: newContent })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setContent),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.content.equals(newContent)).toBeTruthy()

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
        const validator = await blockchain.treasury('validator')
        const loanAddress = await treasury.getLoanAddress(validator.address, 0n)
        const message = beginCell().storeUint(op.sendRecoverStake, 32).storeUint(1, 64).endCell()
        const result = await treasury.sendSendMessageToLoan(halter.getSender(), {
            value: '1',
            validator: validator.address,
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
            body: bodyOp(op.sendRecoverStake),
            success: false, // loan is a dummy account and is not deployed
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should send process loan requests', async () => {
        const state = await treasury.getTreasuryState()
        const participation = {
            state: ParticipationState.Distribution,
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

        const result = await treasury.sendSendProcessLoanRequests(halter.getSender(), {
            value: '1',
            roundSince: 0n,
        })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.sendProcessLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size === 0).toBeTruthy()

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

        const result4 = await treasury.sendDepositCoins(governor.getSender(), { value: '10' })
        expect(result4.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('10'),
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

        const result6 = await treasury.sendDepositCoins(governor.getSender(), { value: '10' })
        expect(result6.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('10'),
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
        expect(oldState.state.type === 'active').toBeTruthy()
        expect(oldState.state.type == newState.state.type).toBeTruthy()
        if (oldState.state.type === 'active' && newState.state.type === 'active') {
            expect(oldState.state.data?.toString('base64') === newState.state.data?.toString('base64')).toBeTruthy()
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
            size: 5n,
            totalStaked: toNano('1000000'),
            totalRecovered: toNano('1001000'),
        }
        const participation2: Participation = {
            size: 10n,
            totalStaked: toNano('500000'),
            totalRecovered: 0n,
        }
        const participation3: Participation = {
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
        state.totalValidatorsStake = toNano('300000')
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10') + toNano('801000') + 16n * toNano('0.9') + toNano('20'),
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
            value: between('20.1', '20.2'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })
})
