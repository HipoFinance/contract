import { compile } from '@ton/blueprint'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { bodyOp, logTotalFees, updateFeeConfig } from './helper'
import { op } from '../wrappers/common'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Parent } from '../wrappers/Parent'
import {
    Participation,
    ParticipationState,
    Request,
    Treasury,
    TreasuryConfig,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    requestDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'

// `window_duration` is the span `previous_rate` -> `current_rate` grew over, and it is NOT the length
// of a round. The window covers TWO barrier releases rather than one settlement, which is what
// cancels the round-to-round oscillation `rounds_imbalance` produces: each window holds one high
// chain and one low chain, so their difference averages out instead of sawtoothing.
//
// All four fields are written in one place, `burn_ready_participations`, once per scan. That is what
// makes the pairing exact: a round only reaches ready_to_burn with its own reward already in
// total_coins, and the barrier guarantees no round under the released run still owes one, so the
// growth across a release is exactly the reward of the rounds it released and the span is exactly
// theirs. Measuring at settlement instead is what let the two come apart, because settlement is not
// ordered.
//
// The window slides over three observations -- previous (oldest), mid, current (newest) -- and a
// release rolls them forward by one. `mid_rate`/`mid_round` exist only to make that roll possible;
// they are appended to the extension and the getter so no positional reader moved.
//
// These tests drive recover_stake_result directly, the same synthetic-state technique
// Deficit.spec.ts and Ordering.spec.ts use: push the treasury into a state where one borrower is
// still `recovering` for a chosen round, deliver the recover_stake_result its loan contract would
// send, and read the fields back off get_treasury_state.
describe('Rate Window', () => {
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
    let fees: TreasuryFees

    const deadShares = toNano('10')

    // A round length, in seconds. Nothing in the contract reads a round length -- it only ever
    // subtracts one round_since from another -- so this is just a spacing for the synthetic rounds
    // below, chosen to look like mainnet's ~18h.
    const roundLength = 65536n

    // The round the settlements below are for, and the one settled before it. Far enough from zero
    // that "one round earlier" is still a positive round_since.
    const round = 1_700_000_000n
    const previousRound = round - roundLength

    // A plain profitable loan. The exact reward does not matter here -- only that the settlement
    // reaches the branch that moves the rate pair -- so this is one borrower, no collateral games.
    const loanAmount = toNano('300000')
    const accrueAmount = toNano('400000')
    const stakeAmount = toNano('180')
    const minPayment = toNano('80')

    function makeConfig(halterAddress: Address, governorAddress: Address): TreasuryConfig {
        return {
            totalCoins: deadShares,
            totalTokens: deadShares,
            totalStaking: 0n,
            totalUnstaking: 0n,
            totalBorrowersStake: 0n,
            deficit: 0n,
            parent: null,
            participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
            roundsImbalance: 255n,
            stopped: false,
            instantMint: false,
            loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, loanCode),
            previousRate: 1_000_000_000n,
            currentRate: 1_000_000_000n,
            windowDuration: 0n,
            lastSettledRound: 0n,
            halter: halterAddress,
            governor: governorAddress,
            proposedGovernor: null,
            governanceFee: 4096n,
            borrowerFee: 0n,
            collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                0n,
                collectionCode,
            ),
            billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, billCode),
            oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
            midRate: 1_000_000_000n,
            midRound: 0n,
        }
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        updateFeeConfig(blockchain)
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(makeConfig(halter.address, governor.address), treasuryCode),
        )
        parent = blockchain.openContract(
            Parent.createFromConfig(
                { totalTokens: 0n, treasury: treasury.address, walletCode, content: Cell.EMPTY },
                parentCode,
            ),
        )

        const deployer = await blockchain.treasury('deployer')
        await treasury.sendDeploy(deployer.getSender(), { value: '1' })
        await parent.sendDeploy(deployer.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), { value: '1', newParent: parent.address })
        fees = await treasury.getTreasuryFees(0n)
    })

    function makeRequest(): Request {
        return {
            minPayment,
            borrowerRewardShare: 0n,
            loanAmount,
            accrueAmount,
            stakeAmount,
            requestFee: 0n,
            newStakeMsg: Cell.EMPTY,
        }
    }

    // One participation sitting in `recovering`, with a request per borrower.
    function makeParticipation(borrowers: Address[]): Participation {
        const recovering = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        for (const borrower of borrowers) {
            recovering.set(BigInt('0x' + borrower.hash.toString('hex')), makeRequest())
        }
        return {
            state: ParticipationState.Recovering,
            size: BigInt(borrowers.length),
            recovering,
            totalStaked: BigInt(borrowers.length) * (loanAmount + accrueAmount),
            totalRecovered: 0n,
        }
    }

    // A round that reached ready_to_burn without lending anything. process_loan_requests hands such a
    // round straight to the barrier, so it is released by the same scan as a settled one and counts
    // toward the window exactly like it -- with a zero delta, which over a two-release window is the
    // honest reading rather than a dilution.
    function makeIdleParticipation(): Participation {
        return {
            state: ParticipationState.ReadyToBurn,
            size: 0n,
            totalStaked: 0n,
            totalRecovered: 0n,
        }
    }

    interface Seed {
        /** The round of the middle observation -- the one `previous_rate` will roll onto next. */
        midRound: bigint
        /** The round of the newest observation. */
        lastSettledRound: bigint
        /** Distinct from `currentRate` so a test can prove the roll took mid and not current. */
        midRate?: bigint
        /** Rounds that reached the barrier without lending, seeded straight into ready_to_burn. */
        idleRounds?: bigint[]
        /** Fixes the pool size, so two scenarios with different loan counts stay comparable. */
        totalCoins?: bigint
    }

    // A sentinel, not a plausible span: every assertion that expects this value back is asserting the
    // contract left the field alone, and a real measurement could never be 7.
    const untouched = 7n

    // Drops the treasury into "these rounds are staked and being recovered", with the window's three
    // observations seeded to whatever the scenario needs. `rounds` maps a round_since to the
    // borrowers still outstanding in it.
    async function setUp(seed: Seed, rounds: Map<bigint, Address[]>): Promise<void> {
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
        let totalStaked = 0n
        let loans = 0
        for (const [roundSince, borrowers] of rounds) {
            participations.set(roundSince, makeParticipation(borrowers))
            totalStaked += BigInt(borrowers.length) * (loanAmount + accrueAmount)
            loans += borrowers.length
        }
        for (const roundSince of seed.idleRounds ?? []) {
            participations.set(roundSince, makeIdleParticipation())
        }

        // The pool has to be at least as big as everything it has lent out, so it scales with the
        // number of outstanding loans unless a scenario pins it.
        const totalCoins = seed.totalCoins ?? totalStaked + deadShares

        const state = await treasury.getTreasuryState()
        state.participations = participations
        state.totalCoins = totalCoins
        state.totalTokens = totalCoins // start at rate 1.0 so any rate move is easy to read
        state.totalBorrowersStake = 0n // collateral already left with the loan in process_loan_requests
        state.currentRate = 1_000_000_000n
        state.previousRate = 1_000_000_000n
        state.midRate = seed.midRate ?? 1_000_000_000n
        state.midRound = seed.midRound
        state.lastSettledRound = seed.lastSettledRound
        state.windowDuration = untouched

        const balance = totalCoins - totalStaked + BigInt(loans) * fees.requestLoanFee
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

    // Sends the recover_stake_result the loan contract for (borrower, roundSince) would send, with a
    // repayment fat enough to make the round profitable. `reward` sets how fat.
    async function settle(borrower: Address, roundSince: bigint, reward = toNano('1000')) {
        const loanAddress = await treasury.getLoanAddress(borrower, roundSince)
        const result = await treasury.sendMessage(blockchain.sender(loanAddress), {
            value: loanAmount + accrueAmount + stakeAmount + reward,
            body: beginCell()
                .storeUint(op.recoverStakeResult, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeAddress(borrower)
                .storeUint(roundSince, 32)
                .endCell(),
        })
        expect(result.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        return result
    }

    // Continuous growth per second, which is what an APY annualises. Comparing this across two
    // windows is how a test says "the published rate did not move" without pinning exact nanocoins.
    function growthPerSecond(state: TreasuryConfig): number {
        return Math.log(Number(state.currentRate) / Number(state.previousRate)) / Number(state.windowDuration)
    }

    // The same figure over the newest release alone -- the window this design replaced. The mid slots
    // carry exactly the observation needed to reconstruct it, which lets a test show the sawtooth that
    // used to be published side by side with the level reading that replaced it.
    function oneReleaseGrowthPerSecond(state: TreasuryConfig): number {
        return (
            Math.log(Number(state.currentRate) / Number(state.midRate)) /
            Number(state.lastSettledRound - state.midRound)
        )
    }

    // Relative, not absolute. These figures are ~1e-9 per second, so an absolute tolerance says
    // nothing; and they are never exactly equal, because the recovery fee is a fixed cost that does
    // not scale with the reward and because each window compounds on a slightly larger pool than the
    // one before it. Both effects are worth well under a percent.
    function relativeDifference(a: number, b: number): number {
        return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b))
    }

    it('should span two releases, not one, in steady state', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp({ midRound: round - 2n * roundLength, lastSettledRound: previousRound }, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.windowDuration).toEqual(2n * roundLength)
        expect(state.lastSettledRound).toEqual(round)
        // and the rate really did move, so the span above describes a growth that happened
        expect(state.currentRate).toBeGreaterThan(1_000_000_000n)
    })

    it('should roll the three observations forward by one on each release', async () => {
        // previous <- mid, mid <- current. Seeding midRate distinctly is what proves the roll took
        // the middle observation and not the newest one, which is the difference between a two-round
        // window and the one-round window this replaced.
        const borrower = (await blockchain.treasury('borrower')).address
        const distinctMidRate = 900_000_000n
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound, midRate: distinctMidRate },
            new Map([[round, [borrower]]]),
        )

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.previousRate).toEqual(distinctMidRate)
        expect(state.midRate).toEqual(1_000_000_000n) // the old current
        expect(state.midRound).toEqual(previousRound) // the old last_settled_round
        expect(state.lastSettledRound).toEqual(round)
    })

    it('should widen when a round in between never participated', async () => {
        // No participation was ever created for the round in between, so nothing released for it and
        // the span stretches across it. Reporting two rounds' elapsed time against one round's reward
        // is the honest reading; a nominal round length would overstate the APY.
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp({ midRound: round - 3n * roundLength, lastSettledRound: previousRound }, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.windowDuration).toEqual(3n * roundLength)
        expect(state.lastSettledRound).toEqual(round)
    })

    it('should span the whole idle stretch when nothing released for days', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        const idle = 9n // ~a week at mainnet round lengths
        await setUp({ midRound: round - idle * roundLength, lastSettledRound: previousRound }, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        expect((await treasury.getTreasuryState()).windowDuration).toEqual(idle * roundLength)
    })

    it('should leave the window alone until the round has fully settled', async () => {
        // Two borrowers in one round: recovering the first leaves the second in the dict, so the round
        // never reaches ready_to_burn, the scan releases nothing and no field may move.
        const first = (await blockchain.treasury('borrower-1')).address
        const second = (await blockchain.treasury('borrower-2')).address
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound },
            new Map([[round, [first, second]]]),
        )

        await settle(first, round)

        const midway = await treasury.getTreasuryState()
        expect(midway.windowDuration).toEqual(untouched)
        expect(midway.lastSettledRound).toEqual(previousRound)
        expect(midway.currentRate).toEqual(1_000_000_000n)

        await settle(second, round)

        const settled = await treasury.getTreasuryState()
        expect(settled.windowDuration).toEqual(2n * roundLength)
        expect(settled.lastSettledRound).toEqual(round)
        expect(settled.currentRate).toBeGreaterThan(1_000_000_000n)
    })

    it('should publish nothing while an older round still owes its reward', async () => {
        // The elector-rejection case, and the defect this design fixes. A newer round finishes ahead
        // of an older one still validating; it parks at the barrier. Under the old settlement-time
        // snapshot it published a 0% reading against a two-round interval that sat on the dashboard
        // for about a round. Now it publishes nothing at all until the barrier lets it through.
        const older = (await blockchain.treasury('borrower-older')).address
        const newer = (await blockchain.treasury('borrower-newer')).address
        const next = round + roundLength
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound },
            new Map([
                [round, [older]],
                [next, [newer]],
            ]),
        )

        await settle(newer, next)

        const parked = await treasury.getTreasuryState()
        expect(parked.windowDuration).toEqual(untouched)
        expect(parked.lastSettledRound).toEqual(previousRound)
        expect(parked.currentRate).toEqual(1_000_000_000n) // no spurious reading of any kind
        // ...even though the reward is already in the pool, which is exactly why the snapshot has to
        // wait rather than the reward.
        expect(parked.totalCoins).toBeGreaterThan(parked.totalTokens)

        await settle(older, round)

        const released = await treasury.getTreasuryState()
        expect(released.lastSettledRound).toEqual(next) // the batch's highest, not the round just settled
        expect(released.windowDuration).toEqual(3n * roundLength) // mid at round-2 through next
        expect(released.currentRate).toBeGreaterThan(1_000_000_000n)
    })

    it('should advance the window exactly once for a batch release, not once per round', async () => {
        // Two rounds come off the barrier in one scan. If the update ran per released round instead
        // of per scan, mid_round would end up at the first of them; once per scan leaves it at the
        // observation that was newest before the batch.
        const older = (await blockchain.treasury('borrower-older')).address
        const newer = (await blockchain.treasury('borrower-newer')).address
        const next = round + roundLength
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound },
            new Map([
                [round, [older]],
                [next, [newer]],
            ]),
        )

        await settle(newer, next)
        await settle(older, round)

        const state = await treasury.getTreasuryState()
        expect(state.midRound).toEqual(previousRound)
        expect(state.lastSettledRound).toEqual(next)
    })

    it('should count a round that reached the barrier without lending', async () => {
        // The idle round is released in the same scan as the round before it, so it is the batch's
        // highest and the window ends on it.
        const borrower = (await blockchain.treasury('borrower')).address
        const idle = round + roundLength
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound, idleRounds: [idle] },
            new Map([[round, [borrower]]]),
        )

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.lastSettledRound).toEqual(idle)
        expect(state.windowDuration).toEqual(3n * roundLength)
    })

    it('should stay level when the two round chains lend unequally', async () => {
        // The reason the window is two releases wide. rounds_imbalance lets one chain lend more than
        // the other, so the reward booked per release alternates -- live, 3.02M against 3.52M GRAM.
        // A one-release window sawtoothed by that ratio every ~18h. Two releases hold one high chain
        // and one low chain each, so consecutive windows read the same.
        const borrowers = await Promise.all(
            [0, 1, 2, 3].map(async (i) => (await blockchain.treasury('borrower-' + String(i))).address),
        )
        const rounds = borrowers.map((_, i) => round + BigInt(i) * roundLength)
        const pool = toNano('4000000')
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound, totalCoins: pool },
            new Map(rounds.map((r, i) => [r, [borrowers[i]]])),
        )

        const high = toNano('1400')
        const low = toNano('600')
        await settle(borrowers[0], rounds[0], high)
        await settle(borrowers[1], rounds[1], low)
        const first = await treasury.getTreasuryState()
        await settle(borrowers[2], rounds[2], high)
        const second = await treasury.getTreasuryState()
        await settle(borrowers[3], rounds[3], low)
        const third = await treasury.getTreasuryState()

        // Each window holds one high and one low, so all three read the same rate of growth.
        expect(relativeDifference(growthPerSecond(second), growthPerSecond(first))).toBeLessThan(0.01)
        expect(relativeDifference(growthPerSecond(third), growthPerSecond(first))).toBeLessThan(0.01)

        // And the sawtooth really was there to remove: over the newest release alone, which is what
        // the old one-settlement window published, consecutive readings differ by more than half.
        // Without this the test above would pass just as happily on a pool that never alternated.
        expect(
            relativeDifference(oneReleaseGrowthPerSecond(third), oneReleaseGrowthPerSecond(second)),
        ).toBeGreaterThan(0.4)
    })

    it('should report the same rate when only every other round lends', async () => {
        // rounds_imbalance at 100% concentrates the pool into alternate rounds: the same capital is
        // deployed either way, since the two chains interleave validate-then-hold, so halving the
        // number of lending rounds doubles what each one lends. The published rate must not move.
        const pool = toNano('4000000')
        const perRound = toNano('700')

        const spread = await Promise.all(
            [0, 1, 2, 3].map(async (i) => (await blockchain.treasury('spread-' + String(i))).address),
        )
        const spreadRounds = spread.map((_, i) => round + BigInt(i) * roundLength)
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound, totalCoins: pool },
            new Map(spreadRounds.map((r, i) => [r, [spread[i]]])),
        )
        for (const [i, r] of spreadRounds.entries()) {
            await settle(spread[i], r, perRound)
        }
        const everyRound = await treasury.getTreasuryState()

        // Same pool, same total reward over the same four rounds -- but concentrated into two of
        // them, with the other two idle at the barrier.
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        updateFeeConfig(blockchain)
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(makeConfig(halter.address, governor.address), treasuryCode),
        )
        const deployer = await blockchain.treasury('deployer')
        await treasury.sendDeploy(deployer.getSender(), { value: '1' })

        const packed = await Promise.all(
            [0, 1].map(async (i) => (await blockchain.treasury('packed-' + String(i))).address),
        )
        const lending = [round, round + 2n * roundLength]
        const idle = [round + roundLength, round + 3n * roundLength]
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound, totalCoins: pool, idleRounds: idle },
            new Map(lending.map((r, i) => [r, [packed[i]]])),
        )
        for (const [i, r] of lending.entries()) {
            await settle(packed[i], r, perRound * 2n)
        }
        const everyOtherRound = await treasury.getTreasuryState()

        // Four rounds of elapsed time and the same total reward in both, so the same rate of growth.
        expect(everyOtherRound.windowDuration).toBeGreaterThan(everyRound.windowDuration)
        expect(relativeDifference(growthPerSecond(everyOtherRound), growthPerSecond(everyRound))).toBeLessThan(0.01)
    })

    it('should publish from a governance re-scan, which packs the extension on its own path', async () => {
        // retry_burn_ready calls the scan without ever calling pack_extension itself -- only
        // recover_stake_result used to, and only for the write that has now moved. That is why the
        // scan packs inside its own branch. Without it this update is dropped on this path entirely.
        const borrower = (await blockchain.treasury('borrower')).address
        const parked = round + roundLength
        await setUp(
            { midRound: round - 2n * roundLength, lastSettledRound: previousRound, idleRounds: [parked] },
            new Map([[round, [borrower]]]),
        )

        // Settle the older round first so the idle one is the only thing left at the barrier, then
        // reach it with nothing but the governance re-scan.
        await settle(borrower, round)
        const beforeRescan = await treasury.getTreasuryState()

        const later = parked + roundLength
        const state = await treasury.getTreasuryState()
        state.participations = state.participations.set(later, makeIdleParticipation())
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: toNano('100000'),
            }),
        )

        await treasury.sendRetryBurnReady(governor.getSender(), { value: '1' })

        const after = await treasury.getTreasuryState()
        expect(after.lastSettledRound).toEqual(later)
        expect(after.lastSettledRound).toBeGreaterThan(beforeRescan.lastSettledRound)
        expect(after.windowDuration).toEqual(later - beforeRescan.midRound)
    })

    it('should survive a treasury upgrade, since the fields are stored and not derived', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp({ midRound: round - 2n * roundLength, lastSettledRound: previousRound }, new Map([[round, [borrower]]]))
        await settle(borrower, round)

        const before = await treasury.getTreasuryState()
        await treasury.sendUpgradeCode(governor.getSender(), { value: '1', newCode: treasuryCode })

        const after = await treasury.getTreasuryState()
        expect(after.windowDuration).toEqual(before.windowDuration)
        expect(after.lastSettledRound).toEqual(before.lastSettledRound)
        expect(after.midRate).toEqual(before.midRate)
        expect(after.midRound).toEqual(before.midRound)
    })
})
