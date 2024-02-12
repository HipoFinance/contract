import { compile } from '@ton/blueprint'
import { Blockchain, EmulationError, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { bodyOp, createVset, emptyNewStakeMsg, logTotalFees, accumulateFees, setConfig } from './helper'
import { config, op } from '../wrappers/common'
import {
    Participation,
    ParticipationState,
    Treasury,
    emptyDictionaryValue,
    participationDictionaryValue,
    requestDictionaryValue,
    sortedDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Large', () => {
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

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10' })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue('10')
    })

    it('should send a big batch of messages to recover stakes', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const count = 100n
        const request = {
            minPayment: toNano('50'),
            validatorRewardShare: 102n,
            loanAmount: toNano('300000'),
            accrueAmount: 0n,
            stakeAmount: toNano('1000'),
            newStakeMsg: emptyNewStakeMsg,
        }
        const staked = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        for (let i = 0n; i < count; i += 1n) {
            staked.set(i, request)
        }
        const participation: Participation = {
            state: ParticipationState.Held,
            size: count,
            staked,
            stakeHeldUntil: 0n,
        }
        const state = await treasury.getTreasuryState()
        state.participations.set(until1, participation)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10') + toNano('1') * count,
            }),
        )

        const result = await treasury.sendFinishParticipation({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.recoverStakes),
            success: true,
            outMessagesCount: (x) => x >= 60 && x <= 255,
        })

        accumulateFees(result.transactions)
    })

    it('should handle large number of loan requests', async () => {
        const maxValidators = beginCell().storeUint(65535, 16).storeUint(65535, 16).storeUint(65535, 16).endCell()
        setConfig(blockchain, config.validators, maxValidators)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        // tested with (10000, 10000, 10000) but test takes more than 3 minutes to run
        const count1 = 500n
        const count2 = 500n
        const count3 = 500n
        const sorted = Dictionary.empty(Dictionary.Keys.BigUint(112), sortedDictionaryValue)
        const requests = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        const request = {
            minPayment: toNano('50'),
            validatorRewardShare: 102n,
            loanAmount: toNano('300000'),
            accrueAmount: 0n,
            stakeAmount: toNano('101'),
            newStakeMsg: emptyNewStakeMsg,
        }
        const bucket = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Buffer(0))
        for (let i = 0n; i < count1; i += 1n) {
            bucket.set(i, Buffer.from([]))
            requests.set(i, request)
        }
        sorted.set(0n, bucket)
        for (let i = 0n; i < count2; i += 1n) {
            const bucketSingle = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Buffer(0))
            sorted.set(i + 1n, bucketSingle.set(count1 + i, Buffer.from([])))
            requests.set(count1 + i, request)
        }
        for (let i = 0n; i < count3; i += 1n) {
            const bucketSingle = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Buffer(0))
            sorted.set(count1 + count2 + i, bucketSingle.set(count1 + count2 + i, Buffer.from([])))
            requests.set(count1 + count2 + i, request)
        }
        const participation: Participation = {
            state: ParticipationState.Open,
            size: count1 + count2 + count3,
            sorted,
            requests,
        }

        const state = await treasury.getTreasuryState()
        state.participations.set(until1, participation)
        state.totalValidatorsStake = toNano('101') * (count1 + count2 + count3)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10') + toNano('101.8') * (count1 + count2 + count3) + toNano('300000') * count3,
            }),
        )

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        let sendNewStakeCount = 0n
        let requestRejectedCount = 0n
        for (const transaction of result.transactions) {
            const bodyOp = transaction.inMessage?.body.beginParse().loadUint(32)
            if (bodyOp === op.proxyNewStake) {
                sendNewStakeCount += 1n
            } else if (bodyOp === op.requestRejected) {
                requestRejectedCount += 1n
            }
        }
        expect(sendNewStakeCount).toEqual(count3)
        expect(requestRejectedCount).toEqual(count1 + count2)

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
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: (x) => x >= 100 && x <= 255,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.requestRejected),
            aborted: true, // validator account is dummy and not initialized
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.proxyNewStake),
            success: true,
            outMessagesCount: 1,
        })

        try {
            await treasury.getParticipation(until1)
            throw new Error('failed')
        } catch (e) {
            expect((e as EmulationError).exitCode).toEqual(7)
        }

        accumulateFees(result.transactions)
    })
})
