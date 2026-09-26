import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
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

describe('Stake Cap', () => {
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

    const idOf = (a: Address) => BigInt('0x' + a.hash.toString('hex'))
    // min_payment scaled to the whole stake, exactly as decide_loan_requests computes it
    const scaled = (minPayment: bigint, loan: bigint, accrue: bigint) => (minPayment * (loan + accrue)) / loan

    interface Bid {
        name: string
        loan: string
        minPayment: string
        collateral: string
        maxStake?: string
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
                maxStake: bid.maxStake ?? '0',
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

    // Runs `run` against the same pinned state once per entry of `variants`, so each sees an identical
    // pool and pays identical storage fees.
    async function fromSameState<T, R>(
        variants: T[],
        run: (round: Awaited<ReturnType<typeof openRound>>, v: T) => Promise<R>,
    ) {
        const now = Math.floor(Date.now() / 1000)
        blockchain.now = now
        const round = await openRound()
        const before = blockchain.snapshot()
        const results: R[] = []
        for (const v of variants) {
            await blockchain.loadFrom(before)
            // the snapshot restores accounts, not the network config a previous run's election advanced
            setConfig(blockchain, config.currentValidators, createVset(round.until1 - round.electedFor, round.until1))
            blockchain.now = now
            results.push(await run(round, v))
        }
        return results
    }

    // Rewrites every request of the round as the previous code packed it: no trailing max_stake.
    async function stripCaps(roundSince: bigint) {
        const state = await treasury.getTreasuryState()
        const participation = must(state.participations.get(roundSince))
        for (const dict of [participation.requests, participation.staked]) {
            for (const [key, request] of dict ?? []) {
                delete request.maxStake
                dict?.set(key, request)
            }
        }
        state.participations.set(roundSince, participation)
        const balance = await treasury.getBalance()
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance,
            }),
        )
    }

    // Two runs from the same state differ in fees by a few hundred nano: a request carrying the field is a
    // longer message and a larger cell, which moves the pool's balance and so `available` by that much.
    // The decision itself is the same arithmetic on it; this compares everything but that dust and the
    // stake message, which createNewStakeMsg signs afresh each time.
    function expectSameDecision(a: Request, b: Request) {
        const dust = 10_000n
        expect(a.accrueAmount - b.accrueAmount).toBeLessThan(dust)
        expect(b.accrueAmount - a.accrueAmount).toBeLessThan(dust)
        expect(a.minPayment - b.minPayment).toBeLessThan(dust)
        expect(b.minPayment - a.minPayment).toBeLessThan(dust)
        expect([a.loanAmount, a.stakeAmount, a.borrowerRewardShare, a.requestFee]).toEqual([
            b.loanAmount,
            b.stakeAmount,
            b.borrowerRewardShare,
            b.requestFee,
        ])
    }

    it('should decide a request with no cap exactly as one whose cap does not bind', async () => {
        const runs = await fromSameState(['0', '10000000'], async (round, maxStake) => {
            const { staked } = await stake(round, [
                { name: 'borrower', loan: '300000', minPayment: '400', collateral: '501', maxStake },
            ])
            return must(staked.get('borrower'))
        })
        const [zero, loose] = runs
        // a lone loan takes the whole pool
        expect(zero.accrueAmount).toBeGreaterThan(toNano('399000'))
        expect(zero.maxStake).toEqual(0n)
        // a cap that does not bind changes nothing but the cap itself
        expect(loose.maxStake).toEqual(toNano('10000000'))
        expectSameDecision(loose, zero)
    })

    it('should stop the accrual at the cap and keep the excess in the treasury', async () => {
        const runs = await fromSameState(['0', '400000'], async (round, maxStake) => {
            const { staked } = await stake(round, [
                { name: 'borrower', loan: '300000', minPayment: '400', collateral: '501', maxStake },
            ])
            const participation = await treasury.getParticipation(round.until1)
            return {
                request: must(staked.get('borrower')),
                totalStaked: must(participation.totalStaked),
                balance: await treasury.getBalance(),
            }
        })
        const [uncapped, capped] = runs

        expect(capped.request.accrueAmount).toEqual(toNano('400000') - toNano('300000') - toNano('501'))
        expect(capped.request.loanAmount + capped.request.accrueAmount + capped.request.stakeAmount).toEqual(
            toNano('400000'),
        )
        expect(capped.request.minPayment).toEqual(
            scaled(toNano('400'), capped.request.loanAmount, capped.request.accrueAmount),
        )
        expect(capped.totalStaked).toEqual(capped.request.loanAmount + capped.request.accrueAmount)

        // what the capped loan did not take is still on the balance, to be counted next round
        const kept = uncapped.request.accrueAmount - capped.request.accrueAmount
        expect(kept).toBeGreaterThan(toNano('299000'))
        expect(capped.balance - uncapped.balance).toBeGreaterThan(kept - toNano('1'))
        expect(capped.balance - uncapped.balance).toBeLessThan(kept + toNano('1'))
    })

    it('should leave an uncapped loan beside a capped one accruing exactly as without the cap', async () => {
        const runs = await fromSameState(['0', '310000'], async (round, maxStake) => {
            const { staked } = await stake(round, [
                { name: 'capped', loan: '300000', minPayment: '60', collateral: '161', maxStake },
                { name: 'free', loan: '350000', minPayment: '0', collateral: '101' },
            ])
            return { capped: must(staked.get('capped')), free: must(staked.get('free')) }
        })
        const [before, after] = runs

        expect(after.capped.accrueAmount).toEqual(toNano('310000') - toNano('300000') - toNano('161'))
        expect(after.capped.accrueAmount).toBeLessThan(before.capped.accrueAmount)
        expectSameDecision(after.free, before.free)
    })

    it('should refuse a cap below the loan and collateral, and accept one equal to them', async () => {
        const round = await openRound()
        const borrower = await blockchain.treasury('borrower')
        const loan = await treasury.getLoanAddress(borrower.address, round.until1)
        const request = async (maxStake: string) =>
            treasury.sendRequestLoan(borrower.getSender(), {
                value: toNano('501') + fees.requestLoanFee,
                roundSince: round.until1,
                loanAmount: '300000',
                minPayment: '400',
                maxStake,
                newStakeMsg: await createNewStakeMsg(loan, round.until1),
            })

        const refused = await request('300500.999999999')
        expect(refused.transactions).toHaveTransaction({
            from: borrower.address,
            to: treasury.address,
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode: 109, // err::invalid_parameters
        })
        expect(refused.transactions).toHaveTransaction({
            from: treasury.address,
            to: borrower.address,
            inMessageBounced: true,
        })
        expect(await treasury.getLoanRequest(round.until1, borrower.address)).toMatchObject({ found: false })
        expect((await treasury.getTreasuryState()).totalBorrowersStake).toEqual(0n)

        const accepted = await request('300501')
        expect(accepted.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: true })

        const since2 = nowSec() - round.times.participateSince + round.times.currentRoundSince
        setConfig(blockchain, config.currentValidators, createVset(since2, since2 + round.electedFor))
        setConfig(blockchain, config.nextValidators, null)
        await treasury.sendParticipateInElection({ roundSince: round.until1 })
        const staked = must((await treasury.getParticipation(round.until1)).staked?.get(idOf(borrower.address)))
        expect(staked.accrueAmount).toEqual(0n)
        expect(staked.minPayment).toEqual(toNano('400'))
    })

    it('should refuse a request in the format before the cap, and bounce its collateral', async () => {
        const round = await openRound()
        const borrower = await blockchain.treasury('borrower')
        const loan = await treasury.getLoanAddress(borrower.address, round.until1)
        const result = await treasury.sendMessage(borrower.getSender(), {
            value: toNano('501') + fees.requestLoanFee,
            body: beginCell()
                .storeUint(op.requestLoan, 32)
                .storeUint(0, 64)
                .storeUint(round.until1, 32)
                .storeCoins(toNano('300000'))
                .storeCoins(toNano('400'))
                .storeRef(await createNewStakeMsg(loan, round.until1))
                .endCell(),
        })
        expect(result.transactions).toHaveTransaction({
            from: borrower.address,
            to: treasury.address,
            body: bodyOp(op.requestLoan),
            success: false,
        })
        expect(result.transactions).toHaveTransaction({ to: borrower.address, inMessageBounced: true })
        expect(await treasury.getLoanRequest(round.until1, borrower.address)).toMatchObject({ found: false })
        expect((await treasury.getTreasuryState()).totalBorrowersStake).toEqual(0n)
    })

    it('should still refuse the old share format, whatever the share', async () => {
        const round = await openRound()
        const borrower = await blockchain.treasury('borrower')
        // a 4-bit coins length of 0 leaves 12 bits, of 1 leaves 4, and of 2 or more runs out of bits
        for (const share of [0n, 0x1fffn, 0x2000n, 26214n, 0xffffn]) {
            const result = await treasury.sendMessage(borrower.getSender(), {
                value: toNano('501') + fees.requestLoanFee,
                body: beginCell()
                    .storeUint(op.requestLoan, 32)
                    .storeUint(0, 64)
                    .storeUint(round.until1, 32)
                    .storeCoins(toNano('300000'))
                    .storeCoins(toNano('400'))
                    .storeUint(share, 16)
                    .storeRef(await createNewStakeMsg(borrower.address, round.until1))
                    .endCell(),
            })
            expect(result.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: false })
            expect(result.transactions).toHaveTransaction({ to: borrower.address, inMessageBounced: true })
        }
        expect(await treasury.getLoanRequest(round.until1, borrower.address)).toMatchObject({ found: false })
        expect((await treasury.getTreasuryState()).totalBorrowersStake).toEqual(0n)
    })

    it('should let a replacement add, change and remove the cap', async () => {
        const round = await openRound()
        const borrower = await blockchain.treasury('borrower')
        const loan = await treasury.getLoanAddress(borrower.address, round.until1)
        const newStakeMsg = await createNewStakeMsg(loan, round.until1)
        const request = (value: bigint, maxStake?: string) =>
            treasury.sendRequestLoan(borrower.getSender(), {
                value,
                roundSince: round.until1,
                loanAmount: '300000',
                minPayment: '400',
                maxStake: maxStake ?? '0',
                newStakeMsg,
            })
        const cap = async () => (await treasury.getLoanRequest(round.until1, borrower.address)).maxStake

        await request(toNano('501') + fees.requestLoanFee)
        expect(await cap()).toEqual(0n)
        await request(fees.requestLoanFee, '400000')
        expect(await cap()).toEqual(toNano('400000'))
        await request(fees.requestLoanFee, '350000')
        expect(await cap()).toEqual(toNano('350000'))
        // too low for the collateral already staked: refused, and the standing request is untouched
        const refused = await request(fees.requestLoanFee, '300000')
        expect(refused.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: false })
        expect(await cap()).toEqual(toNano('350000'))
        await request(fees.requestLoanFee, '0')
        expect(await cap()).toEqual(0n)

        // the getter and the raw dict agree, and the collateral carried through every replacement
        const loanRequest = await treasury.getLoanRequest(round.until1, borrower.address)
        const raw = must((await treasury.getParticipation(round.until1)).requests?.get(idOf(borrower.address)))
        expect(raw.maxStake).toEqual(loanRequest.maxStake)
        expect(loanRequest.stakeAmount).toEqual(toNano('501'))
    })

    it('should read a request packed by the previous code as uncapped, standing or staked', async () => {
        // standing across the upgrade: the cap it was sent with is lost, and it is decided uncapped
        const now = Math.floor(Date.now() / 1000)
        blockchain.now = now
        const round = await openRound()
        const borrower = await blockchain.treasury('borrower')
        const loan = await treasury.getLoanAddress(borrower.address, round.until1)
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('501') + fees.requestLoanFee,
            roundSince: round.until1,
            loanAmount: '300000',
            minPayment: '400',
            maxStake: '400000',
            newStakeMsg: await createNewStakeMsg(loan, round.until1),
        })
        await stripCaps(round.until1)
        const standing = must((await treasury.getParticipation(round.until1)).requests?.get(idOf(borrower.address)))
        expect(standing.maxStake).toBeUndefined()
        expect(await treasury.getLoanRequest(round.until1, borrower.address)).toMatchObject({
            found: true,
            maxStake: 0n,
        })

        const since2 = nowSec() - round.times.participateSince + round.times.currentRoundSince
        setConfig(blockchain, config.currentValidators, createVset(since2, since2 + round.electedFor))
        setConfig(blockchain, config.nextValidators, null)
        await treasury.sendParticipateInElection({ roundSince: round.until1 })
        const staked = new Map<string, Request>()
        staked.set(
            'borrower',
            must((await treasury.getParticipation(round.until1)).staked?.get(idOf(borrower.address))),
        )
        expect(must(staked.get('borrower')).accrueAmount).toBeGreaterThan(toNano('399000'))

        // staked across the upgrade: recovers and settles as it always did
        await stripCaps(round.until1)
        const old = must((await treasury.getParticipation(round.until1)).staked?.get(idOf(borrower.address)))
        expect(old.maxStake).toBeUndefined()
        const loans = new Map([['borrower', loan]])
        const { result, before, after } = await recover(round.until1, loans, staked, '500')
        expect(result.transactions).toHaveTransaction({ body: bodyOp(op.recoverStakeResult), success: true })
        // the scaled promise (~933) is above the pool's contractual share of ~500, so it is what is booked
        const owed = old.minPayment
        expect(owed).toBeBetween('933', '934')
        const governance = (owed * 4096n) / 65535n
        expect(after.totalCoins - before.totalCoins).toEqual(owed - governance)
        expect(paidTo(result, borrower.address)).toBeGreaterThanOrEqual(old.stakeAmount + toNano('500') - owed)
        expect(after.totalBorrowersStake).toEqual(0n)
        expect(after.participations.get(round.until1)?.state).not.toEqual(ParticipationState.Recovering)
    })
})
