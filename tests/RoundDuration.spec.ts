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

// `round_duration` is the interval `previous_rate` -> `current_rate` grew over, and it is NOT the
// length of a round. Both are written in the same `if` in recover_stake_result, so the two halves of
// an APY can never describe different periods: a round in which nothing was lent never reaches that
// branch at all -- process_loan_requests hands it straight to ready_to_burn -- so a skipped round
// widens the interval instead of being invisible.
//
// It is measured as the gap between the `round_since` of the two most recently settled rounds, which
// is why it needs no clock: round_since is the validator set's real utime_since, so a prolonged round
// and a changed round length both land in the number without any special handling.
//
// These tests drive recover_stake_result directly, the same synthetic-state technique
// Deficit.spec.ts and Ordering.spec.ts use: push the treasury into a state where one borrower is
// still `recovering` for a chosen round, deliver the recover_stake_result its loan contract would
// send, and read the two fields back off get_treasury_state.
describe('Round Duration', () => {
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
            roundDuration: 0n,
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

    // Drops the treasury into "these rounds are staked and being recovered", with `lastSettledRound`
    // seeded to whatever the scenario needs. `rounds` maps a round_since to the borrowers still
    // outstanding in it.
    async function setUp(lastSettledRound: bigint, rounds: Map<bigint, Address[]>): Promise<void> {
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
        let totalStaked = 0n
        let loans = 0
        for (const [roundSince, borrowers] of rounds) {
            participations.set(roundSince, makeParticipation(borrowers))
            totalStaked += BigInt(borrowers.length) * (loanAmount + accrueAmount)
            loans += borrowers.length
        }

        // The pool has to be at least as big as everything it has lent out, so it scales with the
        // number of outstanding loans rather than being a fixed figure.
        const totalCoins = totalStaked + deadShares

        const state = await treasury.getTreasuryState()
        state.participations = participations
        state.totalCoins = totalCoins
        state.totalTokens = totalCoins // start at rate 1.0 so any rate move is easy to read
        state.totalBorrowersStake = 0n // collateral already left with the loan in process_loan_requests
        state.currentRate = 1_000_000_000n
        state.previousRate = 1_000_000_000n
        state.lastSettledRound = lastSettledRound
        // A sentinel, not a plausible duration: every assertion below that expects this value back is
        // asserting the contract left the field alone, and a real measurement could never be 7.
        state.roundDuration = 7n

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
    // repayment fat enough to make the round profitable.
    async function settle(borrower: Address, roundSince: bigint) {
        const loanAddress = await treasury.getLoanAddress(borrower, roundSince)
        const result = await treasury.sendMessage(blockchain.sender(loanAddress), {
            value: loanAmount + accrueAmount + stakeAmount + toNano('1000'),
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

    it('should measure one round when consecutive rounds settle', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(previousRound, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.roundDuration).toEqual(roundLength)
        expect(state.lastSettledRound).toEqual(round)
        // and the rate really did move, so the interval above describes a growth that happened
        expect(state.currentRate).toBeGreaterThan(1_000_000_000n)
        expect(state.previousRate).toEqual(1_000_000_000n)
    })

    it('should widen to two rounds when a round in between was skipped', async () => {
        // The pool lent nothing in the round between these two, so that round never settled and never
        // moved the rate pair. The reward booked here is therefore two rounds' worth of elapsed time,
        // and reporting one round length instead is what would overstate the APY.
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(round - 2n * roundLength, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.roundDuration).toEqual(2n * roundLength)
        expect(state.lastSettledRound).toEqual(round)
    })

    it('should span the whole idle stretch when nothing settled for days', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        const idleRounds = 9n // ~a week at mainnet round lengths
        await setUp(round - idleRounds * roundLength, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.roundDuration).toEqual(idleRounds * roundLength)
    })

    it('should leave both fields alone until the round has fully settled', async () => {
        // Two borrowers in one round: recovering the first leaves the second in the dict, so the
        // branch that moves the rate pair does not run and neither field may move either.
        const first = (await blockchain.treasury('borrower-1')).address
        const second = (await blockchain.treasury('borrower-2')).address
        await setUp(previousRound, new Map([[round, [first, second]]]))

        await settle(first, round)

        const midway = await treasury.getTreasuryState()
        expect(midway.roundDuration).toEqual(7n)
        expect(midway.lastSettledRound).toEqual(previousRound)
        expect(midway.currentRate).toEqual(1_000_000_000n)

        await settle(second, round)

        const settled = await treasury.getTreasuryState()
        expect(settled.roundDuration).toEqual(roundLength)
        expect(settled.lastSettledRound).toEqual(round)
        expect(settled.currentRate).toBeGreaterThan(1_000_000_000n)
    })

    it('should leave both fields alone when an older round settles out of order', async () => {
        // recover_stake_result's own comment describes this: a round whose stake the elector rejects
        // instantly can finish ahead of an older round still validating. The older round still books
        // its reward into the rate pair -- but the interval it belongs to has already been measured,
        // so neither field may move.
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(round + roundLength, new Map([[round, [borrower]]]))

        await settle(borrower, round)

        const state = await treasury.getTreasuryState()
        expect(state.roundDuration).toEqual(7n)
        expect(state.lastSettledRound).toEqual(round + roundLength)
        // the rates moved even though the interval did not
        expect(state.currentRate).toBeGreaterThan(1_000_000_000n)
    })

    it('should measure one round after an out-of-order pair, not two', async () => {
        // The whole reason last_settled_round only moves forwards. Settlement order is R+1, R, R+2
        // while round order is R, R+1, R+2. By the time R+2 settles, both R+1 and R are already in
        // current_rate, so R+2's settlement books one round's reward -- and letting last_settled_round
        // walk backwards to R would measure that as two rounds and halve the reported rate.
        const one = (await blockchain.treasury('borrower-1')).address
        const two = (await blockchain.treasury('borrower-2')).address
        const three = (await blockchain.treasury('borrower-3')).address
        const next = round + roundLength
        const afterNext = round + 2n * roundLength
        await setUp(
            previousRound,
            new Map([
                [round, [one]],
                [next, [two]],
                [afterNext, [three]],
            ]),
        )

        await settle(two, next)
        const afterFirst = await treasury.getTreasuryState()
        expect(afterFirst.roundDuration).toEqual(2n * roundLength)
        expect(afterFirst.lastSettledRound).toEqual(next)

        await settle(one, round)
        const afterLate = await treasury.getTreasuryState()
        expect(afterLate.roundDuration).toEqual(2n * roundLength) // unchanged
        expect(afterLate.lastSettledRound).toEqual(next) // and it did not walk backwards

        await settle(three, afterNext)
        const afterLast = await treasury.getTreasuryState()
        expect(afterLast.roundDuration).toEqual(roundLength)
        expect(afterLast.lastSettledRound).toEqual(afterNext)
    })

    it('should survive a treasury upgrade, since the fields are stored and not derived', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(previousRound, new Map([[round, [borrower]]]))
        await settle(borrower, round)

        const before = await treasury.getTreasuryState()
        await treasury.sendUpgradeCode(governor.getSender(), { value: '1', newCode: treasuryCode })

        const after = await treasury.getTreasuryState()
        expect(after.roundDuration).toEqual(before.roundDuration)
        expect(after.lastSettledRound).toEqual(before.lastSettledRound)
    })
})
