import { compile } from '@ton/blueprint'
import {
    Blockchain,
    BlockchainTransaction,
    SandboxContract,
    SendMessageResult,
    TreasuryContract,
    createShardAccount,
} from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, external, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import {
    bodyOp,
    createNewStakeMsg,
    createVset,
    emptyNewStakeMsg,
    getElector,
    logTotalFees,
    setConfig,
    updateFeeConfig,
} from './helper'
import { config, op } from '../wrappers/common'
import { Treasury, TreasuryFees, emptyDictionaryValue, participationDictionaryValue } from '../wrappers/Treasury'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

// The soft close of the loan auction: docs/specs/2026-11-17-soft-close-four-hours.md.
// B = D - 14400, W = 900, D = participate_since from get_times.
const W = 900
const FOUR_HOURS = 14400
const NOT_ACCEPTING = 201 // err::not_accepting_loan_requests

const TIMEOUT = 300000
jest.setTimeout(TIMEOUT)

describe('Soft Close', () => {
    let electorCode: Cell
    let treasuryCode: Cell
    let migratorCode: Cell
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
        migratorCode = await compile('upgrade-code-test/AddAuctionFloors')
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
    }, TIMEOUT)

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
        await treasury.sendDeploy(deployer.getSender(), { value: '1' })
        await parent.sendDeploy(deployer.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), { value: '1', newParent: parent.address })

        fees = await treasury.getTreasuryFees(0n)

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10', destination: governor.address })
        electorAddress = getElector(blockchain)
    }, TIMEOUT)

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    const idOf = (a: Address) => BigInt('0x' + a.hash.toString('hex'))
    const G = (gram: number | string) => toNano(gram)

    // request_sort_key, exactly as utils.fc computes it (payment >> 30, loan >> 40, smaller loan higher)
    function keyOf(minPayment: bigint, loan: bigint, borrowerRewardShare: bigint) {
        const pr = minPayment >> 30n
        const lr = loan >> 40n > 1n ? loan >> 40n : 1n
        const comp = (1n << 80n) - lr
        let eff = (pr * 1000n) / lr
        if (eff > (1n << 24n) - 1n) eff = (1n << 24n) - 1n
        return (eff << 96n) + ((65535n - borrowerRewardShare) << 80n) + comp
    }
    const SHARE = 1799n // rewardShare the treasury is deployed with, snapshotted into every request

    interface Round {
        until1: bigint
        since1: bigint
        electedFor: bigint
        D: number
        B: number
        stakeHeldFor: bigint
        nextRoundUntil: bigint
    }

    // Pins the chain's clock, deposits `deposit` and opens the round the tests bid into.
    async function setup(deposit = '700000'): Promise<Round> {
        blockchain.now = Math.floor(Date.now() / 1000)
        const times0 = await treasury.getTimes()
        const electedFor = times0.nextRoundSince - times0.currentRoundSince
        const since1 = BigInt(blockchain.now)
        const until1 = since1 + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since1, until1))

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
        const times = await treasury.getTimes()
        const D = Number(times.participateSince)
        const round = {
            until1: times.nextRoundSince,
            since1,
            electedFor,
            D,
            B: D - FOUR_HOURS,
            stakeHeldFor: times.stakeHeldFor,
            nextRoundUntil: times.nextRoundUntil,
        }
        // the tests place requests relative to B, so B has to lie in the future
        expect(round.B - W - 10).toBeGreaterThan(blockchain.now)
        return round
    }

    // One request straight to request_loan at chain time `at`. `collateral` is what is sent on top of the
    // fee: a replacement that keeps its stake sends '0'.
    async function req(
        r: Round,
        name: string,
        loan: bigint,
        minPayment: bigint,
        at: number,
        opts: { collateral?: string; maxStake?: bigint } = {},
    ) {
        blockchain.now = at
        const borrower = await blockchain.treasury(name)
        const loanAddress = await treasury.getLoanAddress(borrower.address, r.until1)
        const collateral = opts.collateral ?? String(Number(minPayment / G(1)) + 1500)
        const value = toNano(collateral) + fees.requestLoanFee
        const result = await treasury.sendRequestLoan(borrower.getSender(), {
            value,
            roundSince: r.until1,
            loanAmount: loan,
            minPayment,
            maxStake: opts.maxStake ?? 0n,
            newStakeMsg: await createNewStakeMsg(loanAddress, r.until1),
        })
        return { borrower, result, value }
    }

    function accepted(result: SendMessageResult, borrower: Address) {
        expect(result.transactions).toHaveTransaction({
            from: borrower,
            to: treasury.address,
            body: bodyOp(op.requestLoan),
            success: true,
        })
    }

    function expectRefused(result: SendMessageResult, borrower: Address) {
        expect(result.transactions).toHaveTransaction({
            from: borrower,
            to: treasury.address,
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode: NOT_ACCEPTING,
        })
        expect(result.transactions).toHaveTransaction({ from: treasury.address, to: borrower, inMessageBounced: true })
    }

    async function storageHash() {
        const contract = await blockchain.getContract(treasury.address)
        const state = contract.account.account?.storage.state
        if (state?.type !== 'active' || state.state.data == null) throw new Error('treasury is not active')
        return state.state.data.hash().toString('hex')
    }

    // S: the open round keeps the close in its stake_held_until slot
    async function storedS(r: Round) {
        return Number((await treasury.getParticipation(r.until1)).stakeHeldUntil)
    }

    // Everything a refused request must leave alone: the whole stored state (participation cell
    // included) and the two counters, compared before and after.
    async function snapshotState() {
        const s = await treasury.getTreasuryState()
        return { hash: await storageHash(), stake: s.totalBorrowersStake, fees: s.totalRequestFees }
    }

    // Borrower names sorted by address, ascending, so a test can choose who holds the lower address.
    async function namesByAddress(count = 6) {
        const list: { name: string; id: bigint }[] = []
        for (let i = 0; i < count; i++) {
            const name = `sc${String(i)}`
            list.push({ name, id: idOf((await blockchain.treasury(name)).address) })
        }
        list.sort((a, b) => (a.id < b.id ? -1 : 1))
        return list.map((x) => x.name)
    }

    function getConfigCell(index: bigint): Cell {
        const dict = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
        const cell = dict.get(index)
        if (cell == null) throw new Error(`no config ${String(index)}`)
        return cell
    }

    function setElectionsEndBefore(endBefore: bigint) {
        const s = getConfigCell(config.election).beginParse()
        const electedFor = s.loadUint(32)
        const startBefore = s.loadUint(32)
        s.loadUint(32)
        const heldFor = s.loadUint(32)
        setConfig(
            blockchain,
            config.election,
            beginCell()
                .storeUint(electedFor, 32)
                .storeUint(startBefore, 32)
                .storeUint(endBefore, 32)
                .storeUint(heldFor, 32)
                .endCell(),
        )
    }
    function getElectionsEndBefore() {
        const s = getConfigCell(config.election).beginParse()
        s.loadUint(32)
        s.loadUint(32)
        return BigInt(s.loadUint(32))
    }

    function setMaxValidators(n: number) {
        setConfig(
            blockchain,
            config.validators,
            beginCell().storeUint(n, 16).storeUint(n, 16).storeUint(n, 16).endCell(),
        )
    }

    // participate_in_election at chain time `at`, with the next round elected or not.
    async function participate(r: Round, at: number, elected = false) {
        blockchain.now = at
        setConfig(blockchain, config.nextValidators, elected ? createVset(r.until1, r.until1 + r.electedFor) : null)
        return treasury.sendParticipateInElection({ roundSince: r.until1 })
    }

    // The bids the shrink tests share. X stands with the first, shrinks to the second at the exact price.
    const L0 = G(400000)
    const P0 = G(600)
    const L1 = G(300000)
    const P1 = G(450) // 450 * 400000 == 600 * 300000
    const early = (r: Round) => r.B - 1000 // before the extension zone, so S stays 0

    // ---------------------------------------------------------------------------------------------
    // Normal requests and the close
    // ---------------------------------------------------------------------------------------------

    it('should accept a request before the extension zone and leave S at 0', async () => {
        const r = await setup()
        expect((await treasury.getAuctionClose(r.until1)).status).toEqual(0n)
        const a = await req(r, 'a', L0, P0, r.B - W - 1)
        accepted(a.result, a.borrower.address)
        expect(await storedS(r)).toEqual(0)
        const close = await treasury.getAuctionClose(r.until1)
        expect([close.status, close.close, close.baseClose, close.participateSince]).toEqual([
            1n,
            BigInt(r.B),
            BigInt(r.B),
            BigInt(r.D),
        ])
    })

    it('should move S for a request in the zone, and again for one inside the new window', async () => {
        const r = await setup()
        const first = await req(r, 'first', L0, P0, r.B - 600)
        accepted(first.result, first.borrower.address)
        expect(await storedS(r)).toEqual(r.B + 300)
        const second = await req(r, 'second', L0, P0, r.B + 200)
        accepted(second.result, second.borrower.address)
        expect(await storedS(r)).toEqual(r.B + 1100)
        expect((await treasury.getAuctionClose(r.until1)).close).toEqual(BigInt(r.B + 1100))
    })

    it('should refuse a new borrower at t = E, return the value and leave the state byte-identical', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, early(r))
        accepted(a.result, a.borrower.address)
        const before = await snapshotState()
        const late = await req(r, 'late', L0, P0, r.B) // E = B
        expectRefused(late.result, late.borrower.address)
        expect(late.result.transactions).toHaveTransaction({
            from: treasury.address,
            to: late.borrower.address,
            inMessageBounced: true,
            value: (v) => v != null && v > late.value - toNano('0.1'),
        })
        expect(await snapshotState()).toEqual(before)
    })

    it('should accept a new borrower one second before E', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, early(r))
        accepted(a.result, a.borrower.address)
        const ok = await req(r, 'ok', L0, P0, r.B - 1)
        accepted(ok.result, ok.borrower.address)
        expect(await storedS(r)).toEqual(r.B - 1 + W)
    })

    it('should never lower S when D moves earlier, refuse requests after the new D, and never close before the new B when D moves later', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, r.B - 600)
        accepted(a.result, a.borrower.address)
        const S = r.B + 300
        expect(await storedS(r)).toEqual(S)

        // D moves earlier, to 50 s below S
        const newD = S - 50
        setElectionsEndBefore(getElectionsEndBefore() + BigInt(r.D - newD))
        expect(Number((await treasury.getTimes()).participateSince)).toEqual(newD)
        // a zone request: t >= S - W, t < newD < S
        const b = await req(r, 'b', L0, P0, S - 100)
        accepted(b.result, b.borrower.address)
        expect(await storedS(r)).toEqual(S) // max(S, min(t + W, newD)) = S
        // after the new D every request is refused, though t < S
        const c = await req(r, 'c', L0, P0, newD)
        expectRefused(c.result, c.borrower.address)
        const d = await req(r, 'd', L0, P0, newD + 10)
        expectRefused(d.result, d.borrower.address)
        // and the standing borrower's replacement (still before S, so a normal one) is refused too
        const e = await req(r, 'a', L0, P0, newD + 10, { collateral: '0' })
        expectRefused(e.result, e.borrower.address)
        expect(await storedS(r)).toEqual(S)

        // D moves later (elections_end_before 0): E is never earlier than the new base close
        setElectionsEndBefore(0n)
        const times = await treasury.getTimes()
        const laterD = Number(times.participateSince)
        expect(laterD).toBeGreaterThan(r.D)
        const close = await treasury.getAuctionClose(r.until1)
        expect(close.baseClose).toEqual(BigInt(laterD - FOUR_HOURS))
        expect(close.close).toEqual(BigInt(laterD - FOUR_HOURS))
        expect(close.close).toBeGreaterThanOrEqual(BigInt(S))
        expect(close.participateSince).toEqual(BigInt(laterD))
    })

    it('should accept a new borrower between the old S and the new B after D moves later', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, r.B - 600)
        accepted(a.result, a.borrower.address)
        const S = r.B + 300
        expect(await storedS(r)).toEqual(S)
        // D moves later, so the new base close lies well after S
        setElectionsEndBefore(0n)
        const laterD = Number((await treasury.getTimes()).participateSince)
        const laterB = laterD - FOUR_HOURS
        expect(laterB).toBeGreaterThan(S + 2 * W)
        const t = S + 100 // after the old S, long before the new B
        const b = await req(r, 'b', L0, P0, t)
        accepted(b.result, b.borrower.address)
        expect((await treasury.getLoanRequest(r.until1, b.borrower.address)).found).toBe(true)
        expect(await storedS(r)).toEqual(S) // not in the zone of the new close, so S stays
        expect((await treasury.getAuctionClose(r.until1)).close).toEqual(BigInt(laterB))
    })

    it('should move S for a request at exactly E - W and leave it for one a second earlier', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, early(r))
        accepted(a.result, a.borrower.address)
        const book = blockchain.snapshot()

        const at = await req(r, 'at', L0, P0, r.B - W) // t = E - W
        accepted(at.result, at.borrower.address)
        expect(await storedS(r)).toEqual(r.B)

        await blockchain.loadFrom(book)
        setConfig(blockchain, config.currentValidators, createVset(r.since1, r.until1))
        const before = await req(r, 'before', L0, P0, r.B - W - 1)
        accepted(before.result, before.borrower.address)
        expect(await storedS(r)).toEqual(0)
    })

    it('should let a new request that evicts itself at once still move S', async () => {
        const r = await setup()
        setMaxValidators(1)
        const top = await req(r, 'top', L0, P0, early(r))
        accepted(top.result, top.borrower.address)
        // lowest key in the book: it is evicted at once
        const low = await req(r, 'low', L0, G(300), r.B - 600)
        accepted(low.result, low.borrower.address)
        expect((await treasury.getLoanRequest(r.until1, low.borrower.address)).found).toBe(false)
        expect((await treasury.getLoanRequest(r.until1, top.borrower.address)).found).toBe(true)
        expect((await treasury.getParticipation(r.until1)).size).toEqual(1n)
        expect(await storedS(r)).toEqual(r.B + 300)
    })

    it('should never push S past D under chained requests, and refuse a request and a shrink at t = D', async () => {
        const r = await setup()
        const first = await req(r, 'chain', L0, P0, r.B - 600)
        accepted(first.result, first.borrower.address)
        let S = await storedS(r)
        expect(S).toEqual(r.B + 300)
        let steps = 0
        while (S < r.D) {
            // each replacement lands one second before the current close
            const next = await req(r, 'chain', L0, P0, S - 1, { collateral: '0' })
            accepted(next.result, next.borrower.address)
            const after = await storedS(r)
            expect(after).toBeGreaterThanOrEqual(S)
            expect(after).toBeLessThanOrEqual(r.D)
            expect(after).toEqual(Math.min(S - 1 + W, r.D))
            S = after
            steps++
            expect(steps).toBeLessThan(40)
        }
        expect(S).toEqual(r.D)
        expect(steps).toBeGreaterThanOrEqual(15)

        const before = await snapshotState()
        const newcomer = await req(r, 'newcomer', L0, P0, r.D)
        expectRefused(newcomer.result, newcomer.borrower.address)
        // a valid shrink at t = D
        const shrink = await req(r, 'chain', L1, P1, r.D, { collateral: '0' })
        expectRefused(shrink.result, shrink.borrower.address)
        expect(await snapshotState()).toEqual(before)
    })

    it('should set S = D for the first request of an empty auction at D - 100', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, r.D - 100)
        accepted(a.result, a.borrower.address)
        expect(await storedS(r)).toEqual(r.D)
        const b = await req(r, 'b', L0, P0, r.D)
        expectRefused(b.result, b.borrower.address)
    })

    it('should open a window for the first request of an empty auction after B', async () => {
        const r = await setup()
        const t1 = r.B + 3600
        const a = await req(r, 'a', L0, P0, t1)
        accepted(a.result, a.borrower.address)
        expect(await storedS(r)).toEqual(t1 + 900)
        const b = await req(r, 'b', L0, P0, t1 + 899)
        accepted(b.result, b.borrower.address)
        expect(await storedS(r)).toEqual(t1 + 1799)
        const before = await snapshotState()
        const c = await req(r, 'c', L0, P0, t1 + 1799)
        expectRefused(c.result, c.borrower.address)
        expect(await snapshotState()).toEqual(before)
    })

    // ---------------------------------------------------------------------------------------------
    // Shrink revisions
    // ---------------------------------------------------------------------------------------------

    it('should accept a shrink with L1 < L0 and k1 <= k0, update the stake as a replacement does, and keep S', async () => {
        const r = await setup()
        // 399500 and 400000 share a loan unit (>> 40), so the same payment gives the same key
        const loan1 = G(399500)
        expect(keyOf(P0, loan1, SHARE)).toEqual(keyOf(P0, L0, SHARE))
        const x = await req(r, 'x', L0, P0, early(r))
        accepted(x.result, x.borrower.address)
        const stakeBefore = (await treasury.getTreasuryState()).totalBorrowersStake
        const feesBefore = (await treasury.getTreasuryState()).totalRequestFees
        const Sbefore = await storedS(r)

        const shrink = await req(r, 'x', loan1, P0, r.B + 10, { collateral: '1' })
        accepted(shrink.result, shrink.borrower.address)
        const request = await treasury.getLoanRequest(r.until1, x.borrower.address)
        expect(request.loanAmount).toEqual(loan1)
        expect(request.minPayment).toEqual(P0)
        const state = await treasury.getTreasuryState()
        expect(state.totalBorrowersStake).toEqual(stakeBefore + toNano('1'))
        expect(state.totalRequestFees).toEqual(feesBefore)
        expect(await storedS(r)).toEqual(Sbefore)
        expect(Sbefore).toEqual(0)
    })

    // a standing X with the shrinkable bid, optional rivals, then the shrink at B
    interface Refusal {
        label: string
        // rivals placed before the close: [nameIndex, loan, payment]
        rivals?: { who: 'hi' | 'lo'; loan: bigint; pay: bigint }[]
        standing?: { loan: bigint; pay: bigint; maxStake?: bigint }
        shrink: { loan: bigint; pay: bigint; maxStake?: bigint }
        check?: (names: { x: string; rival: string }) => void
    }
    const refusals: Refusal[] = [
        { label: 'L1 > L0', shrink: { loan: G(410000), pay: G(700) } },
        { label: 'L1 = L0 with P1 < P0 (a price cut)', shrink: { loan: L0, pay: G(599) } },
        {
            label: 'L1 < L0 with P1 * L0 < P0 * L1, by one nanoGRAM',
            shrink: { loan: G(399500), pay: (P0 * G(399500)) / L0 - 1n },
        },
        {
            label: 'a key that rises past another request’s key',
            // R sits strictly between k0 and k1
            rivals: [{ who: 'hi', loan: L0, pay: 559n << 30n }],
            shrink: { loan: L1, pay: P1 },
        },
        {
            label: 'a new key equal to a rival’s key where the rival has a higher address',
            rivals: [{ who: 'hi', loan: L1, pay: P1 }],
            shrink: { loan: L1, pay: P1 },
        },
        {
            label: 'a rise out of a bucket in which an equal-key peer has a lower address',
            rivals: [{ who: 'lo', loan: L0, pay: P0 }],
            shrink: { loan: L1, pay: P1 },
        },
        {
            label: 'M1 > M0',
            standing: { loan: L0, pay: P0, maxStake: G(450000) },
            shrink: { loan: L1, pay: P1, maxStake: G(460000) },
        },
        {
            label: 'M0 != 0 and M1 = 0',
            standing: { loan: L0, pay: P0, maxStake: G(450000) },
            shrink: { loan: L1, pay: P1, maxStake: 0n },
        },
    ]

    for (const refusal of refusals) {
        it('should refuse a shrink after E with ' + refusal.label + ', leaving the state byte-identical', async () => {
            const r = await setup()
            const [lowName, highName] = await namesByAddress()
            // X holds the lower address of the pair when a rival with a higher address matters
            const xName = refusal.rivals?.[0]?.who === 'lo' ? highName : lowName
            const rivalName = refusal.rivals?.[0]?.who === 'lo' ? lowName : highName
            const standing = refusal.standing ?? { loan: L0, pay: P0 }
            const x = await req(r, xName, standing.loan, standing.pay, early(r), { maxStake: standing.maxStake })
            accepted(x.result, x.borrower.address)
            for (const rival of refusal.rivals ?? []) {
                const rv = await req(r, rivalName, rival.loan, rival.pay, early(r))
                accepted(rv.result, rv.borrower.address)
            }
            if (refusal.label.startsWith('a key that rises past')) {
                const k0 = keyOf(P0, L0, SHARE)
                const k1 = keyOf(P1, L1, SHARE)
                const kr = keyOf(559n << 30n, L0, SHARE)
                expect(k0 < kr && kr < k1).toBe(true)
            }
            const before = await snapshotState()
            const shrink = await req(r, xName, refusal.shrink.loan, refusal.shrink.pay, r.B, {
                collateral: '0',
                maxStake: refusal.shrink.maxStake,
            })
            expectRefused(shrink.result, shrink.borrower.address)
            expect(await snapshotState()).toEqual(before)
            // the old request stands
            const request = await treasury.getLoanRequest(r.until1, x.borrower.address)
            expect(request.loanAmount).toEqual(standing.loan)
            expect(request.minPayment).toEqual(standing.pay)
        })
    }

    it('should refuse a shrink whose max_stake is raised to a stake_cap_floor above M0, leaving the state byte-identical', async () => {
        const r = await setup()
        const M0 = G(450000)
        const x = await req(r, 'x', L0, P0, early(r), { maxStake: M0 })
        accepted(x.result, x.borrower.address)
        const book = blockchain.snapshot()

        // control: with no floor the same shrink (M1 <= M0) is accepted
        const control = await req(r, 'x', L1, P1, r.B + 10, { collateral: '0', maxStake: G(440000) })
        accepted(control.result, control.borrower.address)

        await blockchain.loadFrom(book)
        setConfig(blockchain, config.currentValidators, createVset(r.since1, r.until1))
        blockchain.now = r.B
        const floors = await treasury.sendSetAuctionFloors(governor.getSender(), {
            value: '1',
            minEfficiency: 0n,
            minRequestStake: 0n,
            stakeCapFloor: 460000n, // whole GRAM, above M0
        })
        expect(floors.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.setAuctionFloors),
            success: true,
        })
        const before = await snapshotState()
        const shrink = await req(r, 'x', L1, P1, r.B + 10, { collateral: '0', maxStake: G(440000) })
        expectRefused(shrink.result, shrink.borrower.address)
        expect(await snapshotState()).toEqual(before)
        expect((await treasury.getLoanRequest(r.until1, x.borrower.address)).maxStake).toEqual(M0)
    })

    it('should accept a shrink at the exact price whose key rises but passes nobody', async () => {
        const r = await setup()
        const [name] = await namesByAddress()
        expect(keyOf(P1, L1, SHARE) > keyOf(P0, L0, SHARE)).toBe(true)
        const x = await req(r, name, L0, P0, early(r))
        accepted(x.result, x.borrower.address)
        // one rival far above both keys, one far below
        const hi = await req(r, 'hi', L0, G(900), early(r))
        const lo = await req(r, 'lo', L0, G(300), early(r))
        accepted(hi.result, hi.borrower.address)
        accepted(lo.result, lo.borrower.address)
        expect(keyOf(G(900), L0, SHARE) > keyOf(P1, L1, SHARE)).toBe(true)
        expect(keyOf(G(300), L0, SHARE) < keyOf(P0, L0, SHARE)).toBe(true)

        const shrink = await req(r, name, L1, P1, r.B + 5, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        const participation = await treasury.getParticipation(r.until1)
        const k1 = keyOf(P1, L1, SHARE)
        expect(participation.sorted?.get(k1)?.has(idOf(x.borrower.address))).toBe(true)
        expect(participation.sorted?.has(keyOf(P0, L0, SHARE))).toBe(false)
        expect((await treasury.getLoanRequest(r.until1, x.borrower.address)).loanAmount).toEqual(L1)
    })

    it('should accept a shrink that leaves a bucket in which every peer has a higher address', async () => {
        const r = await setup()
        const [lowName, highName] = await namesByAddress()
        const x = await req(r, lowName, L0, P0, early(r))
        const y = await req(r, highName, L0, P0, early(r)) // same bid, same key, higher address
        accepted(x.result, x.borrower.address)
        accepted(y.result, y.borrower.address)
        expect(idOf(x.borrower.address) < idOf(y.borrower.address)).toBe(true)
        expect(keyOf(P1, L1, SHARE) > keyOf(P0, L0, SHARE)).toBe(true)
        const shrink = await req(r, lowName, L1, P1, r.B + 5, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        const participation = await treasury.getParticipation(r.until1)
        expect(participation.sorted?.get(keyOf(P1, L1, SHARE))?.has(idOf(x.borrower.address))).toBe(true)
        expect(participation.sorted?.get(keyOf(P0, L0, SHARE))?.has(idOf(y.borrower.address))).toBe(true)
    })

    it('should keep the old share and request fee on a no-op shrink after the governor changed them', async () => {
        const r = await setup()
        // The stake covers exactly payment + punishment: with the carried fee 0 there is no burn floor to
        // meet, with the governor's new fee there is (1 GRAM).
        const stake = P0 + G(101)
        expect(await treasury.getMaxPunishment(L0 + stake)).toEqual(G(101))
        const x = await req(r, 'x', L0, P0, early(r), { collateral: String(Number(stake / G(1))) })
        accepted(x.result, x.borrower.address)
        const old = await treasury.getLoanRequest(r.until1, x.borrower.address)
        expect(old.found).toBe(true)
        expect(old.requestFee).toEqual(0n)
        expect(old.borrowerRewardShare).toEqual(SHARE)

        await treasury.sendSetRewardShare(governor.getSender(), { value: '0.1', newRewardShare: 26214n })
        await treasury.sendSetBorrowerFee(governor.getSender(), { value: '0.1', newBorrowerFee: 3277n })
        const state = await treasury.getTreasuryState()
        expect([state.rewardShare, state.borrowerFee]).toEqual([26214n, 3277n])

        // a normal request before E takes the governor's current values, as today
        const fresh = await req(r, 'fresh', L0, P0, early(r) + 5)
        accepted(fresh.result, fresh.borrower.address)
        const freshRequest = await treasury.getLoanRequest(r.until1, fresh.borrower.address)
        expect(freshRequest.borrowerRewardShare).toEqual(26214n)
        expect(freshRequest.requestFee).toEqual(3277n)

        const noop = await req(r, 'x', L0, P0, r.B + 10, { collateral: '0' })
        accepted(noop.result, noop.borrower.address) // the carried fee's min_burn (0) was used
        const after = await treasury.getLoanRequest(r.until1, x.borrower.address)
        expect(after.borrowerRewardShare).toEqual(SHARE)
        expect(after.requestFee).toEqual(0n)
        expect(after.loanAmount).toEqual(L0)
        const participation = await treasury.getParticipation(r.until1)
        expect(participation.sorted?.get(keyOf(P0, L0, SHARE))?.has(idOf(x.borrower.address))).toBe(true)
    })

    it('should accept a shrink after config 16 lowered max_validators below size, and evict nobody', async () => {
        const r = await setup()
        const a = await req(r, 'a', L0, P0, early(r))
        const b = await req(r, 'b', L0, G(500), early(r))
        const c = await req(r, 'c', L0, G(400), early(r))
        for (const q of [a, b, c]) accepted(q.result, q.borrower.address)
        expect((await treasury.getParticipation(r.until1)).size).toEqual(3n)
        setMaxValidators(1)
        const shrink = await req(r, 'a', L1, P1, r.B + 10, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        expect((await treasury.getParticipation(r.until1)).size).toEqual(3n)
        for (const q of [a, b, c]) {
            expect((await treasury.getLoanRequest(r.until1, q.borrower.address)).found).toBe(true)
        }
        // nothing was refunded
        expect(shrink.result.transactions).not.toHaveTransaction({
            from: treasury.address,
            to: b.borrower.address,
        })
        expect(shrink.result.transactions).not.toHaveTransaction({
            from: treasury.address,
            to: c.borrower.address,
        })
    })

    // ---------------------------------------------------------------------------------------------
    // Ordering and decisions
    // ---------------------------------------------------------------------------------------------

    it('should let a shrink make a skipped request fit, and never let a key rise past another after E', async () => {
        // pool 1,000,000: A 500k > B 600k > C 400k in rank. B is skipped behind A; if A shrinks to 300k, B fits
        // and C no longer does.
        const A0 = G(500000)
        const PA0 = G(1000)
        const A1 = G(300000)
        const PA1 = G(600) // the same price per GRAM
        const PB = G(1100)
        const LB = G(600000)
        const LC = G(400000)
        const PC = G(600)
        expect(keyOf(PA0, A0, SHARE) > keyOf(PB, LB, SHARE)).toBe(true)
        expect(keyOf(PB, LB, SHARE) > keyOf(PC, LC, SHARE)).toBe(true)
        expect(keyOf(PA1, A1, SHARE) > keyOf(PB, LB, SHARE)).toBe(true) // the shrink does not pass B

        const r = await setup('1000000')
        const a = await req(r, 'a', A0, PA0, early(r), { collateral: '1500' })
        const b = await req(r, 'b', LB, PB, early(r), { collateral: '1500' })
        const c = await req(r, 'c', LC, PC, early(r), { collateral: '1500' })
        for (const q of [a, b, c]) accepted(q.result, q.borrower.address)
        const book = blockchain.snapshot()

        async function run(shrinkA: boolean) {
            await blockchain.loadFrom(book)
            setConfig(blockchain, config.currentValidators, createVset(r.since1, r.until1))
            if (shrinkA) {
                const s = await req(r, 'a', A1, PA1, r.B + 10, { collateral: '0' })
                accepted(s.result, s.borrower.address)
                // no key rose past another's
                const sorted = (await treasury.getParticipation(r.until1)).sorted
                const keys = [...(sorted?.keys() ?? [])].sort((p, q) => (p < q ? 1 : -1))
                expect(keys).toEqual([keyOf(PA1, A1, SHARE), keyOf(PB, LB, SHARE), keyOf(PC, LC, SHARE)])
            }
            await participate(r, r.D)
            const staked = (await treasury.getParticipation(r.until1)).staked
            return {
                a: staked?.get(idOf(a.borrower.address)),
                b: staked?.get(idOf(b.borrower.address)),
                c: staked?.get(idOf(c.borrower.address)),
            }
        }

        const without = await run(false)
        // A and C are lent, B is skipped: its loan exceeded the room left behind A (pool 1,000,000 bounds it)
        expect(without.a).toBeDefined()
        expect(without.b).toBeUndefined()
        expect(without.c).toBeDefined()
        expect(LB).toBeGreaterThan(G(1000000) - A0)

        const withShrink = await run(true)
        expect(withShrink.a).toBeDefined()
        expect(withShrink.b).toBeDefined()
        expect(withShrink.c).toBeUndefined()
        expect(LC).toBeGreaterThan(G(1000000) - A1 - LB)
    })

    it('should let the outranked borrower answer a late equal-efficiency smaller request within W, and rank the answer', async () => {
        const [lowName, highName] = await namesByAddress()
        const r = await setup('1000000')
        // X (higher address) and Y (lower) tie; the sniper Z sends a smaller loan at the same price
        const y = await req(r, lowName, L0, P0, early(r))
        const x = await req(r, highName, L0, P0, early(r))
        accepted(y.result, y.borrower.address)
        accepted(x.result, x.borrower.address)
        const kx = keyOf(P0, L0, SHARE)
        const kz = keyOf(P1, L1, SHARE)
        expect(kz > kx).toBe(true) // the snipe outranks both
        const z = await req(r, 'sniper', L1, P1, r.B - 300)
        accepted(z.result, z.borrower.address)
        expect(await storedS(r)).toEqual(r.B + 600)

        // X answers inside the new window with a higher price, a normal request
        const answerPay = G(610)
        const ka = keyOf(answerPay, L0, SHARE)
        expect(ka > kz).toBe(true)
        const answer = await req(r, highName, L0, answerPay, r.B + 599, { collateral: '0' })
        accepted(answer.result, answer.borrower.address)
        expect(await storedS(r)).toEqual(r.B + 599 + W)
        const sorted = (await treasury.getParticipation(r.until1)).sorted
        expect([...(sorted?.keys() ?? [])].sort((p, q) => (p < q ? 1 : -1))).toEqual([ka, kz, kx])

        // the decision ranks the answer: X (answer) and Z are lent, Y (400k) no longer fits
        await participate(r, r.D)
        const staked = (await treasury.getParticipation(r.until1)).staked
        expect(staked?.has(idOf(x.borrower.address))).toBe(true)
        expect(staked?.has(idOf(z.borrower.address))).toBe(true)
        expect(staked?.has(idOf(y.borrower.address))).toBe(false)
    })

    describe('distribute with S set', () => {
        async function openWithS() {
            const r = await setup()
            const a = await req(r, 'a', L0, P0, r.B - 600)
            accepted(a.result, a.borrower.address)
            const b = await req(r, 'b', L0, G(500), r.B + 100)
            accepted(b.result, b.borrower.address)
            expect(await storedS(r)).not.toEqual(0)
            return r
        }

        // Runs participate_in_election and stops after its own transaction, where distribute has already
        // written the slot; the rest of the chain (which deletes a round whose requests were all refunded)
        // is drained afterwards.
        async function participateAndLook(r: Round, at: number, elected: boolean) {
            blockchain.now = at
            setConfig(blockchain, config.nextValidators, elected ? createVset(r.until1, r.until1 + r.electedFor) : null)
            const body = beginCell()
                .storeUint(op.participateInElection, 32)
                .storeUint(0, 64)
                .storeUint(r.until1, 32)
                .endCell()
            const iter = await blockchain.sendMessageIter(external({ to: treasury.address, body }))
            const first = await iter.next()
            expect(first.done).toBe(false)
            const participation = await treasury.getParticipation(r.until1)
            expect(participation.stakeHeldUntil).toEqual(r.nextRoundUntil + r.stakeHeldFor + 60n)
            expect(participation.stakeHeldUntil).not.toEqual(BigInt(storedSFrom()))
            const close = await treasury.getAuctionClose(r.until1)
            expect([close.status, close.close]).toEqual([2n, 0n])
            const rest: BlockchainTransaction[] = []
            for (let n = await iter.next(); !n.done; n = await iter.next()) rest.push(n.value)
            return rest
        }
        // what S was, kept by openWithS
        let sBefore = 0
        const storedSFrom = () => sBefore

        it('should leave next_round_until + stake_held_for + 60 in the decide branch', async () => {
            const r = await openWithS()
            sBefore = await storedS(r)
            const rest = await participateAndLook(r, r.D, false)
            expect(rest.some((t) => bodyOp(op.decideLoanRequests)(t.inMessage?.body ?? Cell.EMPTY))).toBe(true)
        })

        it('should leave next_round_until + stake_held_for + 60 in the elected branch', async () => {
            const r = await openWithS()
            sBefore = await storedS(r)
            const rest = await participateAndLook(r, r.D, true)
            expect(rest.some((t) => bodyOp(op.decideLoanRequests)(t.inMessage?.body ?? Cell.EMPTY))).toBe(false)
            expect(rest.some((t) => bodyOp(op.processLoanRequests)(t.inMessage?.body ?? Cell.EMPTY))).toBe(true)
        })

        it('should leave next_round_until + stake_held_for + 60 in the too-late branch', async () => {
            const r = await openWithS()
            sBefore = await storedS(r)
            const rest = await participateAndLook(r, r.D + 700, false)
            expect(rest.some((t) => bodyOp(op.decideLoanRequests)(t.inMessage?.body ?? Cell.EMPTY))).toBe(false)
            expect(rest.some((t) => bodyOp(op.processLoanRequests)(t.inMessage?.body ?? Cell.EMPTY))).toBe(true)
        })
    })

    it('should refuse a new borrower and accept a valid shrink after an upgrade from the older stake-cap fixture, with its migrator', async () => {
        // The live treasury (stake-cap release, captured 2026-09-28) holds an open round with a standing
        // request; it is upgraded to this code with the real migrator, and the soft close governs it.
        const liveCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-code.boc'))[0]
        const liveData = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-state.boc'))[0]
        const liveAddress = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')
        const bc = await Blockchain.create()
        await bc.setShardAccount(
            liveAddress,
            createShardAccount({
                workchain: 0,
                address: liveAddress,
                code: liveCode,
                data: liveData,
                balance: toNano('100'),
            }),
        )
        const live = bc.openContract(Treasury.createFromAddress(liveAddress))
        const liveGovernor = (() => {
            const ext = liveData.refs[liveData.refs.length - 1].beginParse()
            ext.loadCoins()
            ext.loadCoins()
            ext.loadUint(32)
            ext.loadUint(32)
            ext.loadCoins()
            ext.loadUint(32)
            ext.loadAddress() // halter
            return ext.loadAddress()
        })()

        bc.now = Math.floor(Date.now() / 1000)
        const times0 = await live.getTimes()
        const electedFor = times0.nextRoundSince - times0.currentRoundSince
        const since1 = BigInt(bc.now)
        setConfig(bc, config.currentValidators, createVset(since1, since1 + electedFor))
        const times = await live.getTimes()
        const D = Number(times.participateSince)
        const B = D - FOUR_HOURS
        expect(B).toBeGreaterThan(bc.now + 1000)
        const roundSince = times.nextRoundSince

        // the migrator seeds min_request_stake = 680,000 GRAM, which every request (a shrink too) must meet,
        // so this round bids larger than the others do
        const liveLoan = G(800000)
        const livePay = G(1200)
        const shrunkLoan = G(700000)
        const shrunkPay = G(1050) // the same price per GRAM
        const standingBorrower = await bc.treasury('standing')
        const liveRequest = await live.sendRequestLoan(standingBorrower.getSender(), {
            value: G(1500) + G(2),
            roundSince,
            loanAmount: liveLoan,
            minPayment: livePay,
            maxStake: 0n,
            newStakeMsg: emptyNewStakeMsg,
        })
        expect(liveRequest.transactions).toHaveTransaction({
            from: standingBorrower.address,
            to: liveAddress,
            body: bodyOp(op.requestLoan),
            success: true,
        })

        const upgrade = await live.sendUpgradeCode(bc.sender(liveGovernor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        expect(upgrade.transactions).toHaveTransaction({
            to: liveAddress,
            body: bodyOp(op.upgradeCode),
            success: true,
        })
        const close = await live.getAuctionClose(roundSince)
        expect([close.status, close.close]).toEqual([1n, BigInt(B)])
        expect((await live.getParticipation(roundSince)).stakeHeldUntil).toEqual(0n)

        bc.now = B + 100
        const newcomer = await bc.treasury('newcomer')
        const refused = await live.sendRequestLoan(newcomer.getSender(), {
            value: G(1500) + G(2),
            roundSince,
            loanAmount: liveLoan,
            minPayment: livePay,
            maxStake: 0n,
            newStakeMsg: emptyNewStakeMsg,
        })
        expect(refused.transactions).toHaveTransaction({
            from: newcomer.address,
            to: liveAddress,
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode: NOT_ACCEPTING,
        })
        expect(refused.transactions).toHaveTransaction({
            from: liveAddress,
            to: newcomer.address,
            inMessageBounced: true,
        })

        // this blockchain has the sandbox's default prices, so the fee is the upgraded code's own
        const liveFees = await live.getTreasuryFees(0n)
        const shrink = await live.sendRequestLoan(standingBorrower.getSender(), {
            value: liveFees.requestLoanFee,
            roundSince,
            loanAmount: shrunkLoan,
            minPayment: shrunkPay,
            maxStake: 0n,
            newStakeMsg: emptyNewStakeMsg,
        })
        expect(shrink.transactions).toHaveTransaction({
            from: standingBorrower.address,
            to: liveAddress,
            body: bodyOp(op.requestLoan),
            success: true,
        })
        expect((await live.getLoanRequest(roundSince, standingBorrower.address)).loanAmount).toEqual(shrunkLoan)
    })

    it('should refuse a new borrower and accept a valid shrink after a no-migrator upgrade from the live floors code', async () => {
        const liveCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-floors-code.boc'))[0]
        expect(liveCode.hash().toString('hex').startsWith('36179377')).toBe(true)
        const r = await setup()

        // put the live code under the deployed treasury: same storage layout, same account
        const contract = await blockchain.getContract(treasury.address)
        const state = contract.account.account?.storage.state
        if (state?.type !== 'active' || state.state.data == null) throw new Error('treasury is not active')
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: liveCode,
                data: state.state.data,
                balance: contract.account.account?.storage.balance.coins ?? 0n,
            }),
        )

        const x = await req(r, 'x', L0, P0, early(r))
        accepted(x.result, x.borrower.address)
        expect((await treasury.getParticipation(r.until1)).stakeHeldUntil).toEqual(0n)

        blockchain.now = early(r) + 10
        const upgrade = await treasury.sendUpgradeCode(governor.getSender(), { value: '1', newCode: treasuryCode })
        expect(upgrade.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.upgradeCode),
            success: true,
        })
        const after = await blockchain.getContract(treasury.address)
        const afterState = after.account.account?.storage.state
        expect(afterState?.type === 'active' ? afterState.state.code?.hash().toString('hex') : 'none').toEqual(
            treasuryCode.hash().toString('hex'),
        )

        expect((await treasury.getParticipation(r.until1)).stakeHeldUntil).toEqual(0n)
        const close = await treasury.getAuctionClose(r.until1)
        expect([close.status, close.close]).toEqual([1n, BigInt(r.B)])

        const newcomer = await req(r, 'newcomer', L0, P0, r.B + 100)
        expectRefused(newcomer.result, newcomer.borrower.address)
        const shrink = await req(r, 'x', L1, P1, r.B + 200, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        expect((await treasury.getLoanRequest(r.until1, x.borrower.address)).loanAmount).toEqual(L1)
    })

    // ---------------------------------------------------------------------------------------------
    // Getters and gas
    // ---------------------------------------------------------------------------------------------

    it('should report status 0, 1 and 2 from get_auction_close', async () => {
        const r = await setup()
        const none = await treasury.getAuctionClose(r.until1)
        expect([none.status, none.close, none.baseClose, none.participateSince]).toEqual([
            0n,
            BigInt(r.B),
            BigInt(r.B),
            BigInt(r.D),
        ])
        // a past, a far and a zero round_since do not throw
        for (const unknown of [0n, r.until1 - 1n, r.until1 - r.electedFor, r.until1 + r.electedFor]) {
            const past = await treasury.getAuctionClose(unknown)
            expect([past.status, past.close]).toEqual([2n, 0n])
        }
        const a = await req(r, 'a', L0, P0, r.B - 600)
        accepted(a.result, a.borrower.address)
        const open = await treasury.getAuctionClose(r.until1)
        expect([open.status, open.close, open.baseClose, open.participateSince]).toEqual([
            1n,
            BigInt(r.B + 300),
            BigInt(r.B),
            BigInt(r.D),
        ])
        const other = await treasury.getAuctionClose(r.until1 + r.electedFor)
        expect([other.status, other.close]).toEqual([2n, 0n])

        await participate(r, r.D)
        const done = await treasury.getAuctionClose(r.until1)
        expect([done.status, done.close]).toEqual([2n, 0n])
    })

    function computeGas(result: SendMessageResult, from: Address) {
        const tx = result.transactions.find(
            (t) =>
                t.inMessage?.info.type === 'internal' &&
                t.inMessage.info.src.equals(from) &&
                t.inMessage.info.dest.equals(treasury.address),
        )
        if (tx == null) throw new Error('no request_loan transaction')
        const phase = tx.description.type === 'generic' ? tx.description.computePhase : undefined
        if (phase?.type !== 'vm') throw new Error('no compute phase')
        return phase.gasUsed
    }

    function declaredRequestLoanGas() {
        const source = readFileSync(__dirname + '/../contracts/imports/constants.fc', 'utf-8')
        const m = /^\s*const int gas::request_loan\s*=\s*(\d+);/m.exec(source)
        if (m == null) throw new Error('gas::request_loan not found')
        return BigInt(m[1])
    }

    it('should keep request_loan gas below gas::request_loan on a shrink with a key rise check', async () => {
        const r = await setup()
        const [name] = await namesByAddress()
        const x = await req(r, name, L0, P0, early(r))
        accepted(x.result, x.borrower.address)
        // rivals above the old key, so the key rise check walks the sorted dictionary
        for (let i = 0; i < 6; i++) {
            const q = await req(r, `rv${String(i)}`, L0, G(700 + i * 20), early(r))
            accepted(q.result, q.borrower.address)
        }
        expect(keyOf(P1, L1, SHARE) > keyOf(P0, L0, SHARE)).toBe(true)
        const shrink = await req(r, name, L1, P1, r.B + 5, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        const gas = computeGas(shrink.result, shrink.borrower.address)
        console.log('request_loan gas, shrink with key rise check:', gas)
        expect(gas).toBeLessThan(declaredRequestLoanGas())
    })

    it('should keep request_loan gas below gas::request_loan on a zone request that takes the eviction', async () => {
        const r = await setup()
        setMaxValidators(7)
        for (let i = 0; i < 7; i++) {
            const q = await req(r, `rv${String(i)}`, L0, G(300 + i * 20), early(r))
            accepted(q.result, q.borrower.address)
        }
        expect((await treasury.getParticipation(r.until1)).size).toEqual(7n)
        // in the zone, above the lowest key: the lowest request is evicted and refunded
        const zone = await req(r, 'zone', L0, G(900), r.B - 300)
        accepted(zone.result, zone.borrower.address)
        const evicted = await blockchain.treasury('rv0')
        expect(zone.result.transactions).toHaveTransaction({ from: treasury.address, to: evicted.address })
        expect((await treasury.getParticipation(r.until1)).size).toEqual(7n)
        expect(await storedS(r)).toEqual(r.B + 600)
        const gas = computeGas(zone.result, zone.borrower.address)
        console.log('request_loan gas, zone request with eviction:', gas)
        expect(gas).toBeLessThan(declaredRequestLoanGas())
    })

    // A book of `count` requests, each from its own borrower, at `early`.
    async function fillBook(r: Round, prefix: string, count: number, pay: (i: number) => bigint) {
        const out: { name: string; borrower: SandboxContract<TreasuryContract> }[] = []
        for (let i = 0; i < count; i++) {
            const name = prefix + String(i)
            const q = await req(r, name, L0, pay(i), early(r))
            accepted(q.result, q.borrower.address)
            out.push({ name, borrower: q.borrower })
        }
        return out
    }

    it('should keep request_loan gas below gas::request_loan with 100 requests in the book', async () => {
        const r = await setup()
        setMaxValidators(100)
        // payments 300, 305, ... 795: distinct keys; borrower 60 holds P0 = 600
        const book = await fillBook(r, 'fb', 100, (i) => G(300 + i * 5))
        expect((await treasury.getParticipation(r.until1)).size).toEqual(100n)
        const snap = blockchain.snapshot()
        const limit = declaredRequestLoanGas()

        // (b) a zone request that takes the eviction, in the full book
        const zone = await req(r, 'zone', L0, G(900), r.B - 300)
        accepted(zone.result, zone.borrower.address)
        expect(zone.result.transactions).toHaveTransaction({ from: treasury.address, to: book[0].borrower.address })
        expect((await treasury.getParticipation(r.until1)).size).toEqual(100n)
        const zoneGas = computeGas(zone.result, zone.borrower.address)
        console.log('request_loan gas, 100 requests, zone request with eviction:', zoneGas)

        // (a) a shrink with a key-rise check, in the full book
        await blockchain.loadFrom(snap)
        setConfig(blockchain, config.currentValidators, createVset(r.since1, r.until1))
        expect(keyOf(P1, L1, SHARE) > keyOf(P0, L0, SHARE)).toBe(true)
        const shrink = await req(r, book[60].name, L1, P1, r.B + 5, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        const shrinkGas = computeGas(shrink.result, shrink.borrower.address)
        console.log('request_loan gas, 100 requests, shrink with key rise check:', shrinkGas)

        expect(zoneGas).toBeLessThan(limit)
        expect(shrinkGas).toBeLessThan(limit)
    })

    it('should keep request_loan gas below gas::request_loan with 100 requests in one bucket', async () => {
        const r = await setup()
        setMaxValidators(100)
        const book = await fillBook(r, 'ob', 100, () => P0)
        const bucket = (await treasury.getParticipation(r.until1)).sorted?.get(keyOf(P0, L0, SHARE))
        expect(bucket?.size).toEqual(100)
        const byAddress = [...book].sort((a, b) => (idOf(a.borrower.address) < idOf(b.borrower.address) ? -1 : 1))
        const snap = blockchain.snapshot()
        const limit = declaredRequestLoanGas()

        // the highest address leaves a bucket with 99 lower peers: refused, the walk is the same
        const refused = await req(r, byAddress[99].name, L1, P1, r.B + 5, { collateral: '0' })
        expectRefused(refused.result, refused.borrower.address)
        const refusedGas = computeGas(refused.result, refused.borrower.address)
        console.log('request_loan gas, one bucket of 100, refused shrink:', refusedGas)

        // the lowest address leaves with no lower peer: accepted
        await blockchain.loadFrom(snap)
        setConfig(blockchain, config.currentValidators, createVset(r.since1, r.until1))
        const shrink = await req(r, byAddress[0].name, L1, P1, r.B + 5, { collateral: '0' })
        accepted(shrink.result, shrink.borrower.address)
        const shrinkGas = computeGas(shrink.result, shrink.borrower.address)
        console.log('request_loan gas, one bucket of 100, accepted shrink:', shrinkGas)

        // (b) in the zone, a request in the same bucket with the eviction taken: the new request has the
        // top key and the bottom bucket's highest-address member is evicted
        await blockchain.loadFrom(snap)
        setConfig(blockchain, config.currentValidators, createVset(r.since1, r.until1))
        const zone = await req(r, 'zone', L0, G(900), r.B - 300)
        accepted(zone.result, zone.borrower.address)
        const zoneGas = computeGas(zone.result, zone.borrower.address)
        console.log('request_loan gas, one bucket of 100, zone request with eviction:', zoneGas)

        expect(refusedGas).toBeLessThan(limit)
        expect(shrinkGas).toBeLessThan(limit)
        expect(zoneGas).toBeLessThan(limit)
    })
})
