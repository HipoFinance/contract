import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { bodyOp, createNewStakeMsg, createVset, getElector, logTotalFees, setConfig, updateFeeConfig } from './helper'
import { config, op } from '../wrappers/common'
import {
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

describe('Auction Floors', () => {
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

    // Deposits `deposit` (700000 unless a test needs room for more loans; config 17's min_stake keeps a
    // loan at 300000 or more) and sets up the round the test bids into.
    async function openRound(deposit = '700000') {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = nowSec()
        const until1 = since1 + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since1, until1))

        // a sandbox treasury starts with 1,000,000; give this one enough for the larger pools
        const staker = await blockchain.treasury('staker', { balance: toNano(deposit) + toNano('10') })
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano(deposit) + fees.depositCoinsFee })

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
        deposit = '700000',
    ) {
        const now = Math.floor(Date.now() / 1000)
        blockchain.now = now
        const round = await openRound(deposit)
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

    // request_efficiency, exactly as the contract computes it
    const efficiency = (minPayment: bigint, loan: bigint) => {
        const l = loan >> 40n
        const e = ((minPayment >> 30n) * 1000n) / (l > 0n ? l : 1n)
        return e < (1n << 24n) - 1n ? e : (1n << 24n) - 1n
    }

    async function setFloors(minEfficiency: bigint, minRequestStake: bigint, stakeCapFloor: bigint) {
        const result = await treasury.sendSetAuctionFloors(governor.getSender(), {
            value: '1',
            minEfficiency,
            minRequestStake,
            stakeCapFloor,
        })
        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.setAuctionFloors),
            success: true,
        })
        return result
    }

    // One request, straight to request_loan, for the refusal tests.
    async function requestOnce(
        round: Awaited<ReturnType<typeof openRound>>,
        name: string,
        bid: { loan: string; minPayment: string; collateral: string; maxStake?: string },
    ) {
        const borrower = await blockchain.treasury(name)
        const loan = await treasury.getLoanAddress(borrower.address, round.until1)
        const result = await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano(bid.collateral) + fees.requestLoanFee,
            roundSince: round.until1,
            loanAmount: bid.loan,
            minPayment: bid.minPayment,
            maxStake: bid.maxStake ?? '0',
            newStakeMsg: await createNewStakeMsg(loan, round.until1),
        })
        return { borrower, result }
    }

    function expectRefused(result: SendMessageResult, borrower: Address, exitCode: number) {
        expect(result.transactions).toHaveTransaction({
            from: borrower,
            to: treasury.address,
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode,
        })
        expect(result.transactions).toHaveTransaction({ from: treasury.address, to: borrower, inMessageBounced: true })
    }

    it('should start with every floor off, and let only the governor set them', async () => {
        const state = await treasury.getTreasuryState()
        expect([state.minEfficiency, state.minRequestStake, state.stakeCapFloor]).toEqual([0n, 0n, 0n])

        const stranger = await blockchain.treasury('stranger')
        const denied = await treasury.sendSetAuctionFloors(stranger.getSender(), {
            value: '1',
            minEfficiency: 1n,
            minRequestStake: 1n,
            stakeCapFloor: 1n,
        })
        expect(denied.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.setAuctionFloors),
            success: false,
            exitCode: 103, // err::access_denied
        })

        await setFloors(640n, 800000n, 2760000n)
        const after = await treasury.getTreasuryState()
        expect([after.minEfficiency, after.minRequestStake, after.stakeCapFloor]).toEqual([640n, 800000n, 2760000n])
        // the rest of the extension is untouched
        expect([after.rewardShare, after.governanceFee, after.borrowerFee]).toEqual([
            state.rewardShare,
            state.governanceFee,
            state.borrowerFee,
        ])

        // the largest values the fields hold round-trip
        await setFloors((1n << 24n) - 1n, (1n << 32n) - 1n, (1n << 32n) - 1n)
        const max = await treasury.getTreasuryState()
        expect([max.minEfficiency, max.minRequestStake, max.stakeCapFloor]).toEqual([
            (1n << 24n) - 1n,
            (1n << 32n) - 1n,
            (1n << 32n) - 1n,
        ])
    })

    it('should refuse a cap floor below the stake floor, but not a cap floor of 0', async () => {
        const refused = await treasury.sendSetAuctionFloors(governor.getSender(), {
            value: '1',
            minEfficiency: 0n,
            minRequestStake: 800000n,
            stakeCapFloor: 799999n,
        })
        expect(refused.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.setAuctionFloors),
            success: false,
            exitCode: 109, // err::invalid_parameters
        })
        await setFloors(0n, 800000n, 0n)
        await setFloors(0n, 800000n, 800000n)
    })

    it('should read an extension packed before the floors as every floor off', async () => {
        // the extension exactly as the previous code packed it: nothing between reward_share and the refs
        const state = await treasury.getTreasuryState()
        const data = treasuryConfigToCell(state).beginParse()
        const root = beginCell()
        for (let i = 0; i < 7; i++) root.storeCoins(data.loadCoins())
        root.storeAddress(data.loadMaybeAddress())
        root.storeMaybeRef(data.loadMaybeRef())
        root.storeUint(data.loadUint(8), 8).storeBit(data.loadBit()).storeBit(data.loadBit())
        root.storeRef(data.loadRef())
        const ext = data.loadRef().beginParse()
        const old = beginCell()
            .storeCoins(ext.loadCoins())
            .storeCoins(ext.loadCoins())
            .storeUint(ext.loadUint(32), 32)
            .storeUint(ext.loadUint(32), 32)
            .storeCoins(ext.loadCoins())
            .storeUint(ext.loadUint(32), 32)
            .storeAddress(ext.loadAddress())
            .storeAddress(ext.loadAddress())
            .storeMaybeRef(ext.loadMaybeRef())
            .storeUint(ext.loadUint(16), 16)
            .storeUint(ext.loadUint(16), 16)
            .storeUint(ext.loadUint(16), 16)
        ext.skip(24 + 32 + 32)
        old.storeRef(ext.loadRef()).storeRef(ext.loadRef()).storeMaybeRef(ext.loadMaybeRef())
        root.storeRef(old.endCell())
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: root.endCell(),
                balance: await treasury.getBalance(),
            }),
        )

        const read = await treasury.getTreasuryState()
        expect([read.minEfficiency, read.minRequestStake, read.stakeCapFloor]).toEqual([0n, 0n, 0n])
        expect(read.rewardShare).toEqual(state.rewardShare)
        expect(read.collectionCodes.size).toEqual(state.collectionCodes.size)

        // an op that repacks the extension writes the new layout, and the floors can then be set
        await treasury.sendSetRewardShare(governor.getSender(), { value: '1', newRewardShare: 2000n })
        await setFloors(640n, 800000n, 2760000n)
        const after = await treasury.getTreasuryState()
        expect([after.rewardShare, after.minEfficiency, after.minRequestStake, after.stakeCapFloor]).toEqual([
            2000n,
            640n,
            800000n,
            2760000n,
        ])
    })

    it('should refuse a bid below the efficiency floor, and accept one at it', async () => {
        const round = await openRound()
        const at = efficiency(toNano('400'), toNano('300000'))
        await setFloors(at + 1n, 0n, 0n)
        const low = await requestOnce(round, 'low', { loan: '300000', minPayment: '400', collateral: '501' })
        expectRefused(low.result, low.borrower.address, 109) // err::invalid_parameters
        expect(await treasury.getLoanRequest(round.until1, low.borrower.address)).toMatchObject({ found: false })
        expect((await treasury.getTreasuryState()).totalBorrowersStake).toEqual(0n)

        await setFloors(at, 0n, 0n)
        const ok = await requestOnce(round, 'ok', { loan: '300000', minPayment: '400', collateral: '501' })
        expect(ok.result.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: true })

        // 0 turns the floor off: a bid paying nothing is accepted again
        await setFloors(0n, 0n, 0n)
        const free = await requestOnce(round, 'free', { loan: '300000', minPayment: '0', collateral: '101' })
        expect(free.result.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: true })
    })

    it('should refuse a loan and collateral below the stake floor, and accept them at it', async () => {
        const round = await openRound()
        await setFloors(0n, 300501n, 0n)
        const short = await requestOnce(round, 'short', {
            loan: '300000',
            minPayment: '400',
            collateral: '500.999999999',
        })
        expectRefused(short.result, short.borrower.address, 102) // err::insufficient_funds
        const ok = await requestOnce(round, 'ok', { loan: '300000', minPayment: '400', collateral: '501' })
        expect(ok.result.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: true })
    })

    it('should raise a cap below the floor to it, and leave a higher cap and no cap alone', async () => {
        const round = await openRound()
        await setFloors(0n, 0n, 400000n)
        const low = await requestOnce(round, 'low', {
            loan: '300000',
            minPayment: '400',
            collateral: '501',
            maxStake: '300501',
        })
        const high = await requestOnce(round, 'high', {
            loan: '300000',
            minPayment: '400',
            collateral: '501',
            maxStake: '500000',
        })
        const none = await requestOnce(round, 'none', { loan: '300000', minPayment: '400', collateral: '501' })
        for (const r of [low, high, none]) {
            expect(r.result.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: true })
        }
        expect((await treasury.getLoanRequest(round.until1, low.borrower.address)).maxStake).toEqual(toNano('400000'))
        expect((await treasury.getLoanRequest(round.until1, high.borrower.address)).maxStake).toEqual(toNano('500000'))
        expect((await treasury.getLoanRequest(round.until1, none.borrower.address)).maxStake).toEqual(0n)

        // a cap that would be refused as below the loan and collateral is judged after the raise
        const raised = await requestOnce(round, 'raised', {
            loan: '300000',
            minPayment: '400',
            collateral: '501',
            maxStake: '1',
        })
        expect(raised.result.transactions).toHaveTransaction({ body: bodyOp(op.requestLoan), success: true })
        expect((await treasury.getLoanRequest(round.until1, raised.borrower.address)).maxStake).toEqual(
            toNano('400000'),
        )
    })

    it('should hand a capped loan’s excess to the uncapped loan beside it', async () => {
        const round = await openRound()
        const { staked } = await stake(round, [
            { name: 'capped', loan: '300000', minPayment: '60', collateral: '161', maxStake: '310000' },
            { name: 'free', loan: '350000', minPayment: '0', collateral: '101' },
        ])
        const capped = must(staked.get('capped'))
        const free = must(staked.get('free'))
        const participation = await treasury.getParticipation(round.until1)
        const lent = capped.loanAmount + capped.accrueAmount + free.loanAmount + free.accrueAmount

        expect(capped.accrueAmount).toEqual(toNano('310000') - toNano('300000') - toNano('161'))
        // nothing is left unlent: the free loan took the rest
        expect(must(participation.totalStaked)).toEqual(lent)
        const pool = toNano('700000')
        expect(lent).toBeGreaterThan(pool - toNano('1'))
        expect(free.minPayment).toEqual(0n)
        expect(capped.minPayment).toEqual(scaled(toNano('60'), capped.loanAmount, capped.accrueAmount))
    })

    it('should fill loans in order of their room, whatever order they arrive in', async () => {
        // two capped loans and one uncapped: the tighter cap binds first, the looser second, and the
        // uncapped loan takes what is left
        const round = await openRound('1500000')
        const { staked } = await stake(round, [
            { name: 'free', loan: '300000', minPayment: '0', collateral: '101' },
            { name: 'loose', loan: '300000', minPayment: '0', collateral: '101', maxStake: '500000' },
            { name: 'tight', loan: '300000', minPayment: '0', collateral: '101', maxStake: '310101' },
        ])
        const tight = must(staked.get('tight'))
        const loose = must(staked.get('loose'))
        const free = must(staked.get('free'))
        expect(tight.accrueAmount).toEqual(toNano('10000'))
        expect(loose.accrueAmount).toEqual(toNano('500000') - toNano('300000') - toNano('101'))
        const lent =
            tight.loanAmount +
            tight.accrueAmount +
            loose.loanAmount +
            loose.accrueAmount +
            free.loanAmount +
            free.accrueAmount
        const participation = await treasury.getParticipation(round.until1)
        expect(must(participation.totalStaked)).toEqual(lent)
        // and between them the three lent the whole pool
        expect(lent).toBeGreaterThan(toNano('1500000') - toNano('1'))
    })

    it('should share exactly in proportion while no cap binds', async () => {
        const round = await openRound('1000000')
        const { staked } = await stake(round, [
            { name: 'one', loan: '300000', minPayment: '0', collateral: '101', maxStake: '5000000' },
            { name: 'two', loan: '600000', minPayment: '0', collateral: '101' },
        ])
        const one = must(staked.get('one'))
        const two = must(staked.get('two'))
        // 1 : 2, to the rounding of each muldiv
        const diff = two.accrueAmount - 2n * one.accrueAmount
        expect(diff < 0n ? -diff : diff).toBeLessThan(10n)
        expect(one.accrueAmount).toBeGreaterThan(toNano('33000'))
    })

    it('should leave no capital idle in the round the capped bids targeted, once the floors are set', async () => {
        // round 1790529288's shape: two loans ranked first and capped at their own size, and a larger
        // one behind them that does not fit in what they leave
        const bids = [
            { name: 'r1', loan: '400000', minPayment: '280', collateral: '400', maxStake: '400700' },
            { name: 'r2', loan: '400000', minPayment: '280', collateral: '400', maxStake: '400700' },
            { name: 'big', loan: '800000', minPayment: '500', collateral: '700', maxStake: '1600000' },
        ]
        const [without, withFloors] = await fromSameState(
            [false, true],
            async (round, floors) => {
                if (floors) await setFloors(0n, 0n, 1000000n)
                const { staked } = await stake(round, bids)
                let lent = 0n
                for (const s of staked.values()) lent += s.loanAmount + s.accrueAmount
                return { lent, big: staked.has('big') }
            },
            '1500000',
        )
        // 'big' does not fit behind the two, and without the floor their caps leave most of the pool idle
        expect(without.big).toBe(false)
        expect(without.lent).toBeLessThan(toNano('801000'))
        // with the cap floor, the same two loans take the whole pool between them
        expect(withFloors.big).toBe(false)
        expect(withFloors.lent).toBeGreaterThan(toNano('1500000') - toNano('1'))
    })
})
