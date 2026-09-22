import { compile } from '@ton/blueprint'
import { burnerAddress } from '../wrappers/burner'
import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, toNano } from '@ton/core'
import {
    bodyOp,
    createNewStakeMsg,
    createVset,
    getElector,
    logTotalFees,
    accumulateFees,
    setConfig,
    updateFeeConfig,
} from './helper'
import { config, op } from '../wrappers/common'
import {
    ParticipationState,
    Request,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Accrual Price', () => {
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
    let fees: TreasuryFees
    let electorAddress: Address

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        updateFeeConfig(blockchain)
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
                    totalCoins: toNano('10'), // dead shares
                    totalTokens: toNano('10'), // dead shares
                    totalStaking: 0n,
                    totalUnstaking: 0n,
                    totalBorrowersStake: 0n,
                    totalRequestFees: 0n,
                    deficit: 0n,
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
                    windowDuration: 0n,
                    lastSettledRound: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    borrowerFee: 0n,
                    rewardShare: 1799n,
                    collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        collectionCode,
                    ),
                    billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        billCode,
                    ),
                    oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
                    midRate: 1_000_000_000n,
                    midRound: 0n,
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

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10', destination: governor.address })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeGramValue('10')

        electorAddress = getElector(blockchain)
    })

    const burner = burnerAddress()
    const idOf = (a: Address) => BigInt('0x' + a.hash.toString('hex'))
    // min_payment scaled to the whole stake, exactly as decide_loan_requests computes it
    const scaled = (minPayment: bigint, loan: bigint, accrue: bigint) => (minPayment * (loan + accrue)) / loan

    interface Bid {
        name: string
        loan: string
        minPayment: string
        collateral: string
    }
    // the chain's clock when a test pins it, the wall clock otherwise
    const nowSec = () => BigInt(blockchain.now ?? Math.floor(Date.now() / 1000))

    // Deposits 700000 and sets up the round every test here bids into.
    async function openRound() {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = nowSec()
        const until1 = since1 + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since1, until1))

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
        return { times, electedFor, until1 }
    }

    // Sends the bids and runs the election; returns what each borrower was staked with.
    async function stake(round: Awaited<ReturnType<typeof openRound>>, bids: Bid[]) {
        const borrowers = new Map<string, SandboxContract<TreasuryContract>>()
        const loans = new Map<string, Address>()
        for (const bid of bids) {
            const borrower = await blockchain.treasury(bid.name)
            const loan = await treasury.getLoanAddress(borrower.address, round.until1)
            borrowers.set(bid.name, borrower)
            loans.set(bid.name, loan)
            await treasury.sendRequestLoan(borrower.getSender(), {
                value: toNano(bid.collateral) + fees.requestLoanFee,
                roundSince: round.until1,
                loanAmount: bid.loan,
                minPayment: bid.minPayment,
                newStakeMsg: await createNewStakeMsg(loan, round.until1),
            })
        }

        const since2 = nowSec() - round.times.participateSince + round.times.currentRoundSince
        setConfig(blockchain, config.currentValidators, createVset(since2, since2 + round.electedFor))
        setConfig(blockchain, config.nextValidators, null)
        const result = await treasury.sendParticipateInElection({ roundSince: round.until1 })

        const participation = await treasury.getParticipation(round.until1)
        const staked = new Map<string, Request>()
        for (const [name, borrower] of borrowers) {
            const request = participation.staked?.get(idOf(borrower.address))
            if (request != null) staked.set(name, request)
        }
        return { result, borrowers, loans, staked }
    }

    // Has the elector pay each loan back what it staked plus `reward`, then settles the round.
    async function recover(until1: bigint, loans: Map<string, Address>, staked: Map<string, Request>, reward: string) {
        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        let total = 0n
        for (const [name, loan] of loans) {
            const s = staked.get(name)
            if (s == null) continue
            const credit = s.loanAmount + s.accrueAmount + s.stakeAmount + toNano(reward)
            credits.set(idOf(loan), credit)
            total += credit
        }
        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
                balance: total + toNano('1'),
            }),
        )

        setConfig(blockchain, config.currentValidators, createVset(0n, 1n))
        await treasury.sendVsetChanged({ roundSince: until1 })
        setConfig(blockchain, config.currentValidators, createVset(1n, 2n))
        await treasury.sendVsetChanged({ roundSince: until1 })

        const state = await treasury.getTreasuryState()
        const participation = state.participations.get(until1) ?? {}
        participation.stakeHeldUntil = 0n
        state.participations.set(until1, participation)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: toNano('10'),
            }),
        )

        const before = await treasury.getTreasuryState()
        const result = await treasury.sendFinishParticipation({ roundSince: until1 })
        const after = await treasury.getTreasuryState()
        accumulateFees(result.transactions)
        return { result, before, after }
    }

    // what `to` received in this trace, in nano
    function paidTo(result: SendMessageResult, to: Address): bigint {
        const tx = result.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.toString() === to.toString(),
        )
        return tx?.inMessage?.info.type === 'internal' ? tx.inMessage.info.value.coins : 0n
    }
    // a value the test knows is there; fails the test rather than asserting it with `!`
    function must<T>(value: T | undefined): T {
        if (value === undefined) throw new Error('expected a value')
        return value
    }

    it('should price the accrued amount at the rate the borrower bid', async () => {
        const round = await openRound()
        const { result, staked } = await stake(round, [
            { name: 'priced', loan: '300000', minPayment: '60', collateral: '161' },
            { name: 'free', loan: '350000', minPayment: '0', collateral: '101' },
        ])

        const priced = must(staked.get('priced'))
        const free = must(staked.get('free'))
        // both fit in 700000, so the ~50000 left over is spread 6:7 between them, as it always was
        expect(priced.accrueAmount).toBeGreaterThan(toNano('20000'))
        expect(free.accrueAmount).toBeGreaterThan(toNano('20000'))
        expect(priced.accrueAmount * 350000n - free.accrueAmount * 300000n).toBeLessThan(toNano('1') * 350000n)
        expect(priced.accrueAmount * 350000n - free.accrueAmount * 300000n).toBeGreaterThan(-toNano('1') * 350000n)

        // what changed: the promise follows the stake
        expect(priced.minPayment).toEqual(scaled(toNano('60'), priced.loanAmount, priced.accrueAmount))
        expect(priced.minPayment).toBeGreaterThan(toNano('60'))
        // a zero promise stays zero
        expect(free.minPayment).toEqual(0n)

        // and the loan log reports the scaled amount, since that is what the borrower owes
        const logged = result.externals
            .map((e) => e.body.beginParse())
            .map((s) => {
                s.loadUint(32)
                const minPayment = s.loadCoins()
                s.loadUint(16)
                const loanAmount = s.loadCoins()
                return { minPayment, loanAmount }
            })
            .find((l) => l.loanAmount === toNano('300000'))
        expect(logged?.minPayment).toEqual(priced.minPayment)
    })

    it('should leave min_payment as bid when nothing accrues', async () => {
        // time is pinned so both runs pay identical storage fees and see an identical pool
        const now = Math.floor(Date.now() / 1000)
        blockchain.now = now
        const round = await openRound()
        const before = blockchain.snapshot()

        // learn exactly what the pool lends a lone borrower, then ask for all of it from the same state
        const probe = await stake(round, [{ name: 'borrower', loan: '300000', minPayment: '400', collateral: '501' }])
        const probed = must(probe.staked.get('borrower'))
        const whole = probed.loanAmount + probed.accrueAmount
        await blockchain.loadFrom(before)
        // the snapshot restores accounts, not the network config the probe's election advanced
        setConfig(blockchain, config.currentValidators, createVset(round.until1 - round.electedFor, round.until1))
        blockchain.now = now

        const { staked } = await stake(round, [
            { name: 'borrower', loan: (Number(whole) / 1e9).toFixed(9), minPayment: '400', collateral: '501' },
        ])
        const request = must(staked.get('borrower'))
        expect(request.loanAmount).toEqual(whole)
        expect(request.accrueAmount).toEqual(0n)
        expect(request.minPayment).toEqual(toNano('400'))
    })

    it('should collect the scaled payment out of collateral when the reward falls short of it', async () => {
        // A lone 300000 loan takes the whole 700000 pool: 400 as bid becomes ~933 on the whole stake.
        // The reward of ~500 does not cover it; the collateral makes up the difference.
        const round = await openRound()
        const { borrowers, loans, staked } = await stake(round, [
            { name: 'borrower', loan: '300000', minPayment: '400', collateral: '501' },
        ])
        const request = must(staked.get('borrower'))
        const owed = request.minPayment
        expect(owed).toBeBetween('933', '934')

        const { result, before, after } = await recover(round.until1, loans, staked, '500')

        // the pool books exactly the scaled min_payment, less the governance fee
        const governance = (owed * 4096n) / 65535n
        expect(after.totalCoins - before.totalCoins).toEqual(owed - governance)
        // the borrower gets back collateral + reward - owed. The reward reaches the treasury ~0.85 above
        // the 500 credited (the harness's elector returns the unspent confirmation with the stake), the
        // same on the old code and the new.
        const back = paidTo(result, must(borrowers.get('borrower')).address)
        expect(back).toBeGreaterThanOrEqual(request.stakeAmount + toNano('500') - owed)
        expect(back).toBeLessThan(request.stakeAmount + toNano('501') - owed)
        expect(after.totalBorrowersStake).toEqual(0n)
    })

    it('should collect at most the reward and the collateral, and still settle the round', async () => {
        // The same ~933 promise against a reward of ~100: reward plus collateral is ~601. Unbounded, the
        // borrower's balance would go negative and store_coins would throw, wedging the round.
        await treasury.sendSetBorrowerFee(governor.getSender(), { value: '0.1', newBorrowerFee: 32767n })
        const round = await openRound()
        const { borrowers, loans, staked } = await stake(round, [
            { name: 'borrower', loan: '300000', minPayment: '400', collateral: '502' },
        ])
        const request = must(staked.get('borrower'))
        expect(request.minPayment).toBeBetween('933', '934')

        const { result, before, after } = await recover(round.until1, loans, staked, '100')

        expect(result.transactions).toHaveTransaction({ body: bodyOp(op.recoverStakeResult), success: true })
        // nothing is left for the borrower, and the burner is paid from what is left -- nothing
        expect(result.transactions).not.toHaveTransaction({ to: must(borrowers.get('borrower')).address })
        expect(paidTo(result, burner)).toEqual(0n)
        // the pool collects the whole reward and the whole collateral, less the governance fee
        const collected = after.totalCoins - before.totalCoins
        // (~100.85 + 502) * (1 - 4096/65535); the 0.85 is the harness's, as in the test above
        expect(collected).toBeBetween('564.5', '565.5')
        expect(after.totalBorrowersStake).toEqual(0n)
        expect(after.participations.get(round.until1)?.state).not.toEqual(ParticipationState.Recovering)
    })
})
