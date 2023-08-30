import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Address, Cell, Dictionary, beginCell, fromNano, toNano } from 'ton-core'
import { bodyOp, createVset, emptyNewStakeMsg, getElector, printFees, setConfig, totalFees } from './helper'
import { config, op } from '../wrappers/common'
import { Fees, Participation, ParticipationState, Treasury, participationDictionaryValue, requestDictionaryValue, rewardDictionaryValue, sortedDictionaryValue, treasuryConfigToCell } from '../wrappers/Treasury'

describe('Large number of loan requests', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell
    let electorCode: Cell

    afterAll(async () => {
        console.log('total fees: %s', fromNano(totalFees))
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

        electorAddress = getElector(blockchain)
    })

    it('should deploy treasury', async () => {
    })

    it('should handle large number of loan requests', async () => {
        const maxValidators = beginCell()
            .storeUint(65535, 16)
            .storeUint(65535, 16)
            .storeUint(65535, 16)
            .endCell()
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
            stakeAmount: toNano('1000'),
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
        state.totalValidatorsStake = toNano('1000') * (count1 + count2 + count3)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(treasury.address, createShardAccount({
            workchain: 0,
            address: treasury.address,
            code: treasuryCode,
            data: fakeData,
            balance: toNano('1001.72') * (count1 + count2 + count3) + toNano('300000') * count3,
        }))

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        let sendNewStakeCount = 0n
        let requestRejectedCount = 0n
        for (let i = 0; i < result.transactions.length; i += 1) {
            const bodyOp = result.transactions[i].inMessage?.body.beginParse().loadUint(32)
            if (bodyOp === op.sendNewStake) {
                sendNewStakeCount += 1n
            } else if (bodyOp === op.requestRejected) {
                requestRejectedCount += 1n
            }
        }
        expect(sendNewStakeCount === count3).toBeTruthy()
        expect(requestRejectedCount === count1 + count2).toBeTruthy()

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
            outMessagesCount: 30,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.requestRejected),
            aborted: true, // validator account is dummy and not initialized
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.sendNewStake),
            success: true,
            outMessagesCount: 1,
        })

        const p = await treasury.getParticipation(until1)
        expect(p.size === 0n).toBeTruthy()
        expect(p.sorted?.size === 0).toBeTruthy()
        expect(p.requests?.size === 0).toBeTruthy()
        expect(p.rejected?.size === 0).toBeTruthy()
        expect(p.accepted?.size === 0).toBeTruthy()
        expect(p.accrued?.size === 0).toBeTruthy()
        expect(p.staked?.size === 0).toBeTruthy()
        expect(p.recovering?.size === 0).toBeTruthy()

        printFees(result.transactions)
    })
})
