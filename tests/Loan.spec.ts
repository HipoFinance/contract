import { compile } from '@ton/blueprint'
import { Blockchain, EmulationError, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
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
    storeComputeGas,
    logComputeGas,
} from './helper'
import { config, err, op } from '../wrappers/common'
import { Loan } from '../wrappers/Loan'
import {
    Fees,
    Participation,
    ParticipationState,
    Treasury,
    emptyDictionaryValue,
    participationDictionaryValue,
    requestDictionaryValue,
    sortedDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Loan', () => {
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
        logComputeGas([
            'request_loan',
            'participate_in_election',
            'decide_loan_requests',
            'process_loan_requests',
            'proxy_new_stake',
            'vset_changed',
            'finish_participation',
            'recover_stakes',
            'proxy_recover_stake',
            'recover_stake_result',
            'burn_all',
            'last_bill_burned',
            'new_stake',
            'new_stake_error',
            'new_stake_ok',
            'recover_stake',
            'recover_stake_ok',
        ])
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
                    loanCode,
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    collectionCode,
                    billCode,
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

    it('should save a loan request', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const validator = await blockchain.treasury('validator')
        const result = await treasury.sendRequestLoan(validator.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result.transactions).toHaveTransaction({
            from: validator.address,
            to: treasury.address,
            value: toNano('151') + fees.requestLoanFee,
            body: bodyOp(op.requestLoan),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(2)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('161.6', '161.7')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('151')

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
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

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
            value: toNano('151'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.proxyNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.proxyNewStake),
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
        expect(treasuryState.totalCoins).toBeTonValue('700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size).toEqual(1)

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
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

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
            await treasury.sendVsetChanged({ roundSince: until1 })
            throw new Error('failed')
        } catch (e) {
            expect((e as EmulationError).exitCode).toEqual(err.vsetNotChangeable)
        }

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('11', '12')
        expect(treasuryState.totalCoins).toBeTonValue('700000')
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
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

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

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan2.address.hash.toString('hex')), toNano('350260'))
        credits.set(BigInt('0x' + loan3.address.hash.toString('hex')), toNano('350270'))
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

        const collectionAddress = await treasury.getCollectionAddress(until1)
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
            value: between('0.6', '0.7'),
            body: bodyOp(op.recoverStakes),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('0.1', '0.2'),
            body: bodyOp(op.proxyRecoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('0.1', '0.2'),
            body: bodyOp(op.proxyRecoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('1', '1.1'),
            body: bodyOp(op.recoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('1', '1.1'),
            body: bodyOp(op.recoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: between('350261', '350262'),
            body: bodyOp(op.recoverStakeOk),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: between('350271', '350272'),
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
            outMessagesCount: (x) => x === 2 + 1 || x === 3 + 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: treasury.address,
            value: between('350271', '350272'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: (x) => x === 2 + 1 || x === 3 + 1,
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
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            value: between('0', '0.1'),
            body: bodyOp(op.burnAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.lastBillBurned),
            success: true,
            outMessagesCount: 0 + 1,
        })
        expect(result.transactions).toHaveLength(16)
        expect(result.externals).toHaveLength(3)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700131', '700132')
        expect(treasuryState.totalCoins).toBeBetween('700121', '700122')
        expect(treasuryState.totalTokens).toBeTonValue('700000')
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

        const collectionAddress = await treasury.getCollectionAddress(until1)
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
            value: toNano('151'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.proxyNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.proxyNewStake),
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
            outMessagesCount: (x) => x === 2 + 1 || x === 3 + 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: treasury.address,
            value: between('350171', '350172'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: (x) => x === 2 + 1 || x === 3 + 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('101.1', '101.2'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('101.1', '101.2'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('3.6', '3.7'),
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
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            value: between('0', '0.1'),
            body: bodyOp(op.burnAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.lastBillBurned),
            success: true,
            outMessagesCount: 0 + 1,
        })
        expect(result.transactions).toHaveLength(18)
        expect(result.externals).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700133', '700134')
        expect(treasuryState.totalCoins).toBeBetween('700121', '700122')
        expect(treasuryState.totalTokens).toBeTonValue('700000')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.lastStaked).toBeBetween('699999', '700000')
        expect(treasuryState.lastRecovered).toBeBetween('700121', '700122')
        expect(treasuryState.participations.size).toEqual(0)

        accumulateFees(result.transactions)
        storeComputeGas('recover_stake_result', op.recoverStakeResult, result.transactions[10])
        storeComputeGas('new_stake_error', op.newStakeError, result.transactions[9])
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
            value: toNano('151'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: toNano('161'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: toNano('171'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('11.9', '12')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.lastStaked).toBeTonValue('0')
        expect(treasuryState.lastRecovered).toBeTonValue('0')
        expect(treasuryState.participations.size).toEqual(0)

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
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

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
            value: toNano('151'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: toNano('161'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('351000', '352000'),
            body: bodyOp(op.proxyNewStake),
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
        expect(treasuryState.totalCoins).toBeTonValue('700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size).toEqual(1)

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
        await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('300000') + fees.depositCoinsFee + toNano('0.1'),
        })

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
            value: toNano('1151') + fees.requestLoanFee, // 1000 (stake) + 101 (max punishment) + 50 (min payment) + fee
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
            value: between('301151', '301152'),
            body: bodyOp(op.proxyNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan.address.hash.toString('hex')), toNano('350260'))
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

        expect(result5.transactions).toHaveLength(10)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        storeComputeGas('request_loan', op.requestLoan, result1.transactions[1])
        storeComputeGas('participate_in_election', op.participateInElection, result2.transactions[0])
        storeComputeGas('decide_loan_requests', op.decideLoanRequests, result2.transactions[1])
        storeComputeGas('process_loan_requests', op.processLoanRequests, result2.transactions[2])
        storeComputeGas('proxy_new_stake', op.proxyNewStake, result2.transactions[3])
        storeComputeGas('vset_changed', op.vsetChanged, result3.transactions[0])
        storeComputeGas('finish_participation', op.finishParticipation, result5.transactions[0])
        storeComputeGas('recover_stakes', op.recoverStakes, result5.transactions[1])
        storeComputeGas('proxy_recover_stake', op.proxyRecoverStake, result5.transactions[2])
        storeComputeGas('recover_stake_result', op.recoverStakeResult, result5.transactions[5])
        storeComputeGas('burn_all', op.burnAll, result5.transactions[6])
        storeComputeGas('last_bill_burned', op.lastBillBurned, result5.transactions[9])
        storeComputeGas('new_stake', op.newStake, result2.transactions[4])
        storeComputeGas('new_stake_ok', op.newStakeOk, result2.transactions[5])
        storeComputeGas('recover_stake', op.recoverStake, result5.transactions[3])
        storeComputeGas('recover_stake_ok', op.recoverStakeOk, result5.transactions[4])
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
                balance: toNano('10') + toNano('1001') * count,
            }),
        )

        const validator = await blockchain.treasury('validator')
        const result1 = await treasury.sendRequestLoan(validator.getSender(), {
            value: toNano('1151') + fees.requestLoanFee, // 1000 (stake) + 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        // should reject last worst request, and replace it with the new better request
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            value: toNano('1000'),
            body: bodyOp(op.requestRejected),
            success: false, // fake account used is not initialized, and success will be false
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(3)

        // should update previous request
        const result2 = await treasury.sendRequestLoan(validator.getSender(), {
            value: toNano('1') + fees.requestLoanFee, // fee
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
        const electedFor = 3600n
        const electionsStartBefore = 1800n
        const electionsEndBefore = 300n
        const stakeHeldFor = 1800n
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
        expect(times.participateSince).toEqual(until - electionsEndBefore - 900n)
        expect(times.participateUntil).toEqual(until - electionsEndBefore - 300n)
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
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: toNano('102') + fees.requestLoanFee, // 101 (max punishment) + 1 (min payment) + fee
            roundSince: until,
            loanAmount: '5000000000',
            minPayment: '1',
            validatorRewardShare: 255n, // 100%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: toNano('320101') + fees.requestLoanFee, // 101 (max punishment) + 20000 (min payment) + fee
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
