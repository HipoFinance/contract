import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton-community/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from 'ton-core'
import {
    between,
    bodyOp,
    createNewStakeMsg,
    createVset,
    emptyNewStakeMsg,
    getElector,
    logTotalFees,
    accumulateFees,
    setConfig,
    logComputeGas,
} from './helper'
import { config, op } from '../wrappers/common'
import { Loan } from '../wrappers/Loan'
import {
    Fees,
    Participation,
    ParticipationState,
    Treasury,
    participationDictionaryValue,
    requestDictionaryValue,
    sortedDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'

describe('Loan', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell
    let electorCode: Cell

    afterAll(() => {
        logTotalFees()
    })

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
        loanCode = await compile('Loan')
        electorCode = await compile('elector-test/Elector')
    })

    let blockchain: Blockchain
    let treasury: SandboxContract<Treasury>
    let driver: SandboxContract<TreasuryContract>
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let fees: Fees
    let electorAddress: Address

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

        electorAddress = getElector(blockchain)
    })

    it('should deploy treasury', () => {
        return
    })

    it('should save a loan request', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const validator = await blockchain.treasury('validator')
        const result = await treasury.sendRequestLoan(validator.getSender(), {
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result.transactions).toHaveTransaction({
            from: validator.address,
            to: treasury.address,
            value: toNano('151.9'),
            body: bodyOp(op.requestLoan),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(2)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('161.8', '161.9')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeBetween('151', '151.1')

        accumulateFees(result.transactions)
    })

    it('should participate in election', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.9', // 101 (max punishment) + 60 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.9', // 101 (max punishment) + 70 (min payment) + 0.9 (fee)
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
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('699999', '700000'),
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('699999', '700000'),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3 + 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('350161', '350162'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('350171', '350172'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: toNano('1'),
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: toNano('1'),
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(10)
        expect(result.externals).toHaveLength(2)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('11', '12')
        expect(treasuryState.totalCoins).toBeBetween('699999', '700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size === 1).toBeTruthy()

        accumulateFees(result.transactions)
    })

    it('should change vset', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.9', // 101 (max punishment) + 60 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.9', // 101 (max punishment) + 70 (min payment) + 0.9 (fee)
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

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        const result1 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result1.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.vsetChanged),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(1)

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        const result2 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result2.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.vsetChanged),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(1)

        const vset5 = createVset(2n, 3n)
        setConfig(blockchain, config.currentValidators, vset5)
        try {
            // For the third case, an internal message is sent to avoid error message for external messages in console.
            // await treasury.sendVsetChanged({ roundSince: until1 })
            await treasury.sendMessage(driver.getSender(), {
                value: '0.1',
                body: beginCell().storeUint(op.vsetChanged, 32).storeUint(until1, 32).endCell(),
            })
            fail()
        } catch (e) {
            // ignore
        }

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('11', '12')
        expect(treasuryState.totalCoins).toBeBetween('699999', '700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
    })

    it('should finish participation', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.9', // 101 (max punishment) + 60 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.9', // 101 (max punishment) + 70 (min payment) + 0.9 (fee)
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

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan2.address.toRawString().split(':')[1]), toNano('350260'))
        credits.set(BigInt('0x' + loan3.address.toRawString().split(':')[1]), toNano('350270'))
        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
                balance: toNano('350260') + toNano('350270') + toNano('1'),
            }),
        )

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        await treasury.sendVsetChanged({ roundSince: until1 })

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        await treasury.sendVsetChanged({ roundSince: until1 })

        const state = await treasury.getTreasuryState()
        const participation = state.participations.get(until1) ?? {}
        participation.stakeHeldUntil = 0n // set stake_held_until to zero
        state.participations.set(until1, participation)
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
        const result = await treasury.sendFinishParticipation({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.finishParticipation),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('0.8', '0.9'),
            body: bodyOp(op.recoverStakes),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('0.2', '0.3'),
            body: bodyOp(op.sendRecoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('0.2', '0.3'),
            body: bodyOp(op.sendRecoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('0.1', '0.2'),
            body: bodyOp(op.recoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('0.1', '0.2'),
            body: bodyOp(op.recoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: between('350260', '350261'),
            body: bodyOp(op.recoverStakeOk),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: between('350270', '350271'),
            body: bodyOp(op.recoverStakeOk),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: treasury.address,
            value: between('350261', '350262'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: (x) => x === 2 + 1 || x === 2 + 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: treasury.address,
            value: between('350271', '350272'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: (x) => x === 2 + 1 || x === 2 + 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('201', '202'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('201', '202'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('3', '4'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('4', '5'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(14)
        expect(result.externals).toHaveLength(3)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700131', '700132')
        expect(treasuryState.totalCoins).toBeBetween('700121', '700122')
        expect(treasuryState.totalTokens).toBeBetween('699999', '700000')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.lastStaked).toBeBetween('699999', '700000')
        expect(treasuryState.lastRecovered).toBeBetween('700121', '700122')

        accumulateFees(result.transactions)
    })

    it('should remove participation when all loan requests are rejected', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.9', // 101 (max punishment) + 60 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.9', // 101 (max punishment) + 70 (min payment) + 0.9 (fee)
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
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('699999', '700000'),
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('699999', '700000'),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3 + 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('350161', '350162'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('350171', '350172'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.newStakeError),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.newStakeError),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: treasury.address,
            value: between('350161', '350162'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: (x) => x === 2 + 1 || x === 2 + 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: treasury.address,
            value: between('350171', '350172'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: (x) => x === 2 + 1 || x === 2 + 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('101.2', '101.3'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('101.2', '101.3'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('3.7', '3.8'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('4.3', '4.4'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(16)
        expect(result.externals).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700133', '700134')
        expect(treasuryState.totalCoins).toBeBetween('700121', '700122')
        expect(treasuryState.totalTokens).toBeBetween('699999', '700000')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.lastStaked).toBeBetween('699999', '700000')
        expect(treasuryState.lastRecovered).toBeBetween('700121', '700122')
        expect(treasuryState.participations.size === 0).toBeTruthy()

        accumulateFees(result.transactions)
        logComputeGas('recover_stake_result', op.recoverStakeResult, result.transactions[10])
        logComputeGas('new_stake_error', op.newStakeError, result.transactions[9])
    })

    it('should remove participation when there is no funds available to give loans', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.9', // 101 (max punishment) + 60 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.9', // 101 (max punishment) + 70 (min payment) + 0.9 (fee)
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
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: fees.requestLoanFee * 3n,
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between(fees.requestLoanFee * 2n, fees.requestLoanFee * 3n),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('161', '161.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('171', '171.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('12', '13')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.lastStaked).toBeTonValue('0')
        expect(treasuryState.lastRecovered).toBeTonValue('0')
        expect(treasuryState.participations.size === 0).toBeTruthy()

        accumulateFees(result.transactions)
    })

    it('should participate in election with balanced rounds', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        await treasury.sendSetRoundsImbalance(halter.getSender(), { value: '0.1', newRoundsImbalance: 0n })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.9', // 101 (max punishment) + 60 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.9', // 101 (max punishment) + 70 (min payment) + 0.9 (fee)
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
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('351000', '352000'),
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('351000', '352000'),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3 + 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('161', '161.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('351000', '352000'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('351000', '352000'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: toNano('1'),
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(8)
        expect(result.externals).toHaveLength(1)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('348000', '349000')
        expect(treasuryState.totalCoins).toBeBetween('699999', '700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size === 1).toBeTruthy()

        accumulateFees(result.transactions)
    })

    it('should handle a single loan request to log compute gas', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '300001' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
                balance: toNano('1'),
            }),
        )

        const validator = await blockchain.treasury('validator')
        const loanAddress = await treasury.getLoanAddress(validator.address, until1)
        const loan = blockchain.openContract(Loan.createFromAddress(loanAddress))
        const newStakeMsg = await createNewStakeMsg(loan.address, until1)
        const result1 = await treasury.sendRequestLoan(validator.getSender(), {
            value: '1151.9', // 1000 (stake) + 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result2 = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan.address,
            value: between('301152', '301153'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan.address.toRawString().split(':')[1]), toNano('350260'))
        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
                balance: toNano('350260') + toNano('350270') + toNano('1'),
            }),
        )

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        const result3 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result3.transactions).toHaveLength(1)

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        const result4 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result4.transactions).toHaveLength(1)

        const state = await treasury.getTreasuryState()
        const participation = state.participations.get(until1) ?? {}
        participation.stakeHeldUntil = 0n // set stake_held_until to zero
        state.participations.set(until1, participation)
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
        const result5 = await treasury.sendFinishParticipation({ roundSince: until1 })

        expect(result5.transactions).toHaveLength(8)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        logComputeGas('request_loan', op.requestLoan, result1.transactions[1])
        logComputeGas('participate_in_election', op.participateInElection, result2.transactions[0])
        logComputeGas('decide_loan_requests', op.decideLoanRequests, result2.transactions[1])
        logComputeGas('process_loan_requests', op.processLoanRequests, result2.transactions[2])
        logComputeGas('send_new_stake', op.sendNewStake, result2.transactions[3])
        logComputeGas('vset_changed', op.vsetChanged, result3.transactions[0])
        logComputeGas('finish_participation', op.finishParticipation, result5.transactions[0])
        logComputeGas('recover_stakes', op.recoverStakes, result5.transactions[1])
        logComputeGas('send_recover_stake', op.sendRecoverStake, result5.transactions[2])
        logComputeGas('recover_stake_result', op.recoverStakeResult, result5.transactions[5])
        logComputeGas('new_stake', op.newStake, result2.transactions[4])
        logComputeGas('new_stake_ok', op.newStakeOk, result2.transactions[5])
        logComputeGas('recover_stake', op.recoverStake, result5.transactions[3])
        logComputeGas('recover_stake_ok', op.recoverStakeOk, result5.transactions[4])
    })

    it('should handle loan request edge cases', async () => {
        const count = 10n
        const maxValidators = beginCell().storeUint(count, 16).storeUint(count, 16).storeUint(count, 16).endCell()
        setConfig(blockchain, config.validators, maxValidators)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const sorted = Dictionary.empty(Dictionary.Keys.BigUint(112), sortedDictionaryValue)
        const requests = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        const request = {
            minPayment: toNano('50'),
            validatorRewardShare: 102n,
            loanAmount: toNano('300000'),
            accrueAmount: 0n,
            stakeAmount: toNano('1000'),
            newStakeMsg: emptyNewStakeMsg,
        }
        for (let i = 0n; i < count; i += 1n) {
            const bucketSingle = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Buffer(0))
            sorted.set(i + 1n, bucketSingle.set(i, Buffer.from([])))
            requests.set(i, request)
        }
        const participation1: Participation = {
            state: ParticipationState.Open,
            size: count,
            sorted,
            requests,
        }

        const state1 = await treasury.getTreasuryState()
        state1.participations.set(until1, participation1)
        state1.participations.set(1n, { totalStaked: toNano('1000000') })
        state1.roundsImbalance = 0n
        state1.totalValidatorsStake = toNano('1000') * count
        const fakeData1 = treasuryConfigToCell(state1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: toNano('10') + toNano('1001.72') * count,
            }),
        )

        const validator = await blockchain.treasury('validator')
        const result1 = await treasury.sendRequestLoan(validator.getSender(), {
            value: '1151.9', // 1000 (stake) + 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        // should reject last worst request, and replace it with the new better request
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            value: between('1000', '1000.1'),
            body: bodyOp(op.requestRejected),
            success: false, // fake account used is not initialized, and success will be false
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(3)

        // should update previous request
        const result2 = await treasury.sendRequestLoan(validator.getSender(), {
            value: '1.9', // 0.9 (fee)
            roundSince: until1,
            loanAmount: '400000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result2.transactions).toHaveLength(2)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
    })

    it('should handle dense election spans', async () => {
        const electedFor = 120n
        const electionsStartBefore = 60n
        const electionsEndBefore = 30n
        const stakeHeldFor = 60n
        const since = BigInt(Math.floor(Date.now() / 1000))
        const until = since + electedFor

        const election = beginCell()
            .storeUint(electedFor, 32)
            .storeUint(electionsStartBefore, 32)
            .storeUint(electionsEndBefore, 32)
            .storeUint(stakeHeldFor, 32)
            .endCell()
        setConfig(blockchain, config.election, election)

        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const times = await treasury.getTimes()
        expect(times.currentRoundSince).toEqual(since)
        expect(times.nextRoundSince).toEqual(until)
        expect(times.nextRoundUntil).toEqual(until + electedFor)
        expect(times.stakeHeldFor).toEqual(stakeHeldFor)
        expect(times.participateSince).toBeGreaterThanOrEqual(since + electedFor - electionsStartBefore)
        expect(times.participateSince).toBeLessThanOrEqual(since + electedFor - electionsEndBefore)
        expect(times.participateUntil).toBeLessThanOrEqual(since + electedFor - electionsEndBefore)
        expect(times.participateUntil).toBeGreaterThanOrEqual(times.participateSince)
    })

    it('should correctly set sort keys', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '102.9', // 101 (max punishment) + 1 (min payment) + 0.9 (fee)
            roundSince: until,
            loanAmount: '5000000000',
            minPayment: '1',
            validatorRewardShare: 255n, // 100%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '320101.9', // 101 (max punishment) + 20000 (min payment) + 0.9 (fee)
            roundSince: until,
            loanAmount: '1000',
            minPayment: '20000',
            validatorRewardShare: 0n, // 0%
            newStakeMsg: emptyNewStakeMsg,
        })

        const participation = await treasury.getParticipation(until)
        const sorted = participation.sorted ?? Dictionary.empty(Dictionary.Keys.BigUint(112), sortedDictionaryValue)
        const keys = sorted.keys()
        expect(keys).toHaveLength(3)
        expect(keys[0]).toEqual((1n << 80n) - (toNano('5000000000') >> 40n))
        expect(keys[1]).toEqual((169n << (80n + 8n)) + ((255n - 102n) << 80n) + ((1n << 80n) - 272n))
        expect(keys[2]).toEqual((1n << 112n) - 1n)
    })
})
