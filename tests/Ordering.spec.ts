import { compile } from '@ton/blueprint'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { bodyOp, logTotalFees, updateFeeConfig } from './helper'
import { err, op } from '../wrappers/common'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Parent } from '../wrappers/Parent'
import {
    Participation,
    ParticipationState,
    Treasury,
    emptyDictionaryValue,
    participationDictionaryValue,
    requestDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { UnstakeMode, Wallet } from '../wrappers/Wallet'

// A round that settles must not burn its bills (and hand out deferred deposits at a stale rate)
// while an older round is still validating and has not yet added its reward to total_coins. These
// tests drive that ordering barrier directly: they push a treasury into a synthetic state where a
// participation is one recover_stake_result away from settling, deliver that message from the loan
// address the treasury itself would derive, and assert on the resulting burn_all traffic.

describe('Ordering', () => {
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
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        collectionCode,
                    ),
                    billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        billCode,
                    ),
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
        })
        expect(deployParentResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: parent.address,
            value: toNano('1'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
        })
        expect(setParentResult.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.setParent),
            success: true,
        })
    })

    // Overwrites the treasury's participations dictionary with a synthetic one, keeping every other
    // field (codes, halter, governor, rates, ...) as already deployed. This is the same
    // treasuryConfigToCell + setShardAccount technique MaxGas.spec.ts and MinGas.spec.ts use to drop
    // a treasury straight into a state that would otherwise take many messages to reach.
    //
    // totalBorrowersStake defaults to 0n, matching this suite's synthetic participations, none of
    // which are backed by a real request_loan. Tests that stuff a `rejected` entry carrying real
    // stake collateral (see rejectedParticipation below) pass the matching amount, so the refund loop
    // in process_loan_requests doesn't drive it negative.
    async function setParticipations(
        participations: Dictionary<bigint, Participation>,
        totalBorrowersStake = 0n,
    ): Promise<void> {
        const state = await treasury.getTreasuryState()
        state.participations = participations
        state.totalBorrowersStake = totalBorrowersStake
        const data = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data,
                balance: toNano('10'),
            }),
        )
    }

    // A participation that is one recover_stake_result away from settling: exactly one borrower is
    // still in `recovering`, and nothing is left in `rejected` / `accepted` / `accrued` / `staked`.
    // Delivering the matching recover_stake_result below empties `recovering` too, so the round
    // settles in that single message, the same way a real request_loan -> ... -> recover_stakes ->
    // recover_stake_result flow would settle it.
    function recoveringParticipation(borrower: Address): Participation {
        const recovering = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        recovering.set(BigInt('0x' + borrower.hash.toString('hex')), {
            minPayment: 0n,
            borrowerRewardShare: 0n,
            loanAmount: 0n,
            accrueAmount: 0n,
            stakeAmount: 0n,
            newStakeMsg: Cell.EMPTY,
        })
        return { state: ParticipationState.Recovering, size: 1n, recovering }
    }

    // Sends the recover_stake_result that the loan contract for (borrower, roundSince) would send.
    // The access check in recover_stake_result only cares that the source address is the loan address
    // the treasury itself derives for that borrower and round, so impersonating it with
    // blockchain.sender is enough -- no real Loan contract needs to be deployed.
    async function settle(roundSince: bigint, borrower: Address) {
        const loanAddress = await treasury.getLoanAddress(borrower, roundSince)
        return treasury.sendMessage(blockchain.sender(loanAddress), {
            value: toNano('2'),
            body: beginCell()
                .storeUint(op.recoverStakeResult, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeAddress(borrower)
                .storeUint(roundSince, 32)
                .endCell(),
        })
    }

    // The collateral carried by the synthetic rejected request below. process_loan_requests refunds
    // this out of total_borrowers_stake, so callers pass the same amount to setParticipations to keep
    // that field from going negative.
    const rejectedStakeAmount = toNano('0.01')

    // A participation that made no loans: everything but `rejected` is empty, and `rejected` carries
    // one still-pending refund. This is the shape process_loan_requests sees for a round whose only
    // requests were rejected (too late to participate, or already elected) -- and, with `size: 0n`,
    // also the shape the OLD distribute() used to write for a freshly rejected round, before it was
    // fixed to keep the real size.
    function rejectedParticipation(borrower: Address, size: bigint, state: ParticipationState): Participation {
        const rejected = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        rejected.set(BigInt('0x' + borrower.hash.toString('hex')), {
            minPayment: 0n,
            borrowerRewardShare: 0n,
            loanAmount: 0n,
            accrueAmount: 0n,
            stakeAmount: rejectedStakeAmount,
            newStakeMsg: Cell.EMPTY,
        })
        return { state, size, rejected }
    }

    // Sends process_loan_requests the way the treasury sends it to itself from distribute() /
    // decide_loan_requests(): the access check requires src == my_address(), so impersonate the
    // treasury with blockchain.sender the same way settle() impersonates a loan.
    async function processLoanRequests(roundSince: bigint) {
        return treasury.sendMessage(blockchain.sender(treasury.address), {
            value: toNano('1'),
            body: beginCell()
                .storeUint(op.processLoanRequests, 32)
                .storeUint(0, 64)
                .storeUint(roundSince, 32)
                .endCell(),
        })
    }

    // Sends decide_loan_requests the way the treasury sends it to itself, either from distribute() or
    // as its own continuation. Same impersonation as processLoanRequests above.
    async function decideLoanRequests(roundSince: bigint) {
        return treasury.sendMessage(blockchain.sender(treasury.address), {
            value: toNano('1'),
            body: beginCell().storeUint(op.decideLoanRequests, 32).storeUint(0, 64).storeUint(roundSince, 32).endCell(),
        })
    }

    it('should hold a settled round while an older round is still validating', async () => {
        const older = 1_000_000n
        const later = 2_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
            .set(older, { state: ParticipationState.Validating })
            .set(later, recoveringParticipation(borrower))
        await setParticipations(participations)

        const laterCollection = await treasury.getCollectionAddress(later)
        const result = await settle(later, borrower)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({
            to: laterCollection,
            body: bodyOp(op.burnAll),
        })

        const participation = await treasury.getParticipation(later)
        expect(participation.state).toEqual(ParticipationState.ReadyToBurn)
    })

    it('should hold while any older round in distributing..recovering owes a reward', async () => {
        const owingStates = [
            ParticipationState.Distributing,
            ParticipationState.Staked,
            ParticipationState.Validating,
            ParticipationState.Held,
            ParticipationState.Recovering,
        ]

        for (const owingState of owingStates) {
            const older = 1_000_000n
            const later = 2_000_000n
            const borrower = (await blockchain.treasury('borrower_' + owingState.toString())).address

            const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
                .set(older, { state: owingState })
                .set(later, recoveringParticipation(borrower))
            await setParticipations(participations)

            const laterCollection = await treasury.getCollectionAddress(later)
            const result = await settle(later, borrower)

            expect(result.transactions).not.toHaveTransaction({ success: false })
            expect(result.transactions).not.toHaveTransaction({
                to: laterCollection,
                body: bodyOp(op.burnAll),
            })

            const participation = await treasury.getParticipation(later)
            expect(participation.state).toEqual(ParticipationState.ReadyToBurn)
        }
    })

    it('should release a held round once the older round finalizes', async () => {
        const older = 1_000_000n
        const later = 2_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        // `later` is already sitting behind the barrier, exactly as it would be left by the previous
        // test. `older` is one recover_stake_result away from settling.
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
            .set(older, recoveringParticipation(borrower))
            .set(later, { state: ParticipationState.ReadyToBurn })
        await setParticipations(participations)

        const olderCollection = await treasury.getCollectionAddress(older)
        const laterCollection = await treasury.getCollectionAddress(later)
        const result = await settle(older, borrower)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        // Finalizing the older round releases both itself and the round it was holding back.
        expect(result.transactions).toHaveTransaction({
            to: olderCollection,
            body: bodyOp(op.burnAll),
        })
        expect(result.transactions).toHaveTransaction({
            to: laterCollection,
            body: bodyOp(op.burnAll),
        })
    })

    it('should not release a round past a still-running middle round', async () => {
        const r1 = 1_000_000n
        const r2 = 2_000_000n
        const r3 = 3_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        // r3 already settled and is held behind the barrier. r2, an older round than r3, still owes a
        // reward. r1, older still, is one recover_stake_result away from settling.
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
            .set(r1, recoveringParticipation(borrower))
            .set(r2, { state: ParticipationState.Validating })
            .set(r3, { state: ParticipationState.ReadyToBurn })
        await setParticipations(participations)

        const r1Collection = await treasury.getCollectionAddress(r1)
        const r3Collection = await treasury.getCollectionAddress(r3)
        const result = await settle(r1, borrower)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        // r1 has nothing older than it, so finalizing it burns its own bills right away.
        expect(result.transactions).toHaveTransaction({
            to: r1Collection,
            body: bodyOp(op.burnAll),
        })
        // r2 still owes its reward, so the scan must stop there and never reach r3.
        expect(result.transactions).not.toHaveTransaction({
            to: r3Collection,
            body: bodyOp(op.burnAll),
        })

        const participationR2 = await treasury.getParticipation(r2)
        expect(participationR2.state).toEqual(ParticipationState.Validating)
        const participationR3 = await treasury.getParticipation(r3)
        expect(participationR3.state).toEqual(ParticipationState.ReadyToBurn)
    })

    it('should let governance release a stuck ready_to_burn round without a later duplicate burn_all', async () => {
        const stuck = 1_000_000n
        const other = 2_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
            .set(stuck, { state: ParticipationState.ReadyToBurn })
            .set(other, recoveringParticipation(borrower))
        await setParticipations(participations)

        const stuckCollection = await treasury.getCollectionAddress(stuck)
        const otherCollection = await treasury.getCollectionAddress(other)

        const retryResult = await treasury.sendRetryBurnAll(governor.getSender(), {
            value: toNano('0.1'),
            roundSince: stuck,
        })
        expect(retryResult.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.retryBurnAll),
            success: true,
        })
        expect(retryResult.transactions).toHaveTransaction({
            to: stuckCollection,
            body: bodyOp(op.burnAll),
        })

        // Settling an unrelated round now runs burn_ready_participations again. It must skip `stuck`
        // -- it is no longer ready_to_burn -- and only burn_all `other`.
        const laterResult = await settle(other, borrower)

        expect(laterResult.transactions).not.toHaveTransaction({ success: false })
        expect(laterResult.transactions).toHaveTransaction({
            to: otherCollection,
            body: bodyOp(op.burnAll),
        })
        expect(laterResult.transactions).not.toHaveTransaction({
            to: stuckCollection,
            body: bodyOp(op.burnAll),
        })
    })

    // process_loan_requests used to delete a participation outright once every one of its dicts went
    // empty. That stranded any deposit/unstake bill already minted into the round's collection --
    // nothing was left in the dict to route a later burn_all to. It must instead hand the round to
    // the ready_to_burn barrier, exactly like a round that made loans and later settled.
    it('should burn deposit bills of a round that made no loans', async () => {
        const round = 1_000_000n
        const staker = await blockchain.treasury('staker')
        const borrower = (await blockchain.treasury('borrower')).address

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(
            round,
            rejectedParticipation(borrower, 1n, ParticipationState.Distributing),
        )
        await setParticipations(participations, rejectedStakeAmount)

        const fees = await treasury.getTreasuryFees(0n)
        const collectionAddress = await treasury.getCollectionAddress(round)
        const billAddress = await treasury.getBillAddress(round, 0n)

        // instantMint is false in this suite's default config, so the deposit mints a bill into the
        // round's collection instead of minting tokens directly.
        const depositResult = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })
        expect(depositResult.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.mintBill),
            success: true,
        })

        const stateAfterDeposit = await treasury.getTreasuryState()
        expect(stateAfterDeposit.totalStaking > 0n).toBe(true)

        const result = await processLoanRequests(round)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.burnAll),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: billAddress,
            to: collectionAddress,
            body: bodyOp(op.billBurned),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.mintTokens),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
        })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.totalStaking).toEqual(0n)
        expect(treasuryState.participations.size).toEqual(0)
    })

    it('should burn unstake bills of a round that made no loans', async () => {
        const round = 1_000_000n
        const staker = await blockchain.treasury('staker')
        const borrower = (await blockchain.treasury('borrower')).address

        const fees = await treasury.getTreasuryFees(0n)

        // Deposit before any round holds bills, so this mints tokens directly (instantMint doesn't
        // matter here -- there is nothing in `participations` yet for deposit_coins to find).
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()

        // reserve_tokens (unlike deposit_coins) ignores instant_mint? altogether -- this is the
        // mainnet-live case, since instant_mint has been true since 2026-08-15.
        const treasuryState = await treasury.getTreasuryState()
        treasuryState.instantMint = true
        treasuryState.totalBorrowersStake = rejectedStakeAmount
        treasuryState.participations.set(round, rejectedParticipation(borrower, 1n, ParticipationState.Distributing))
        // burn_tokens only pays out once the treasury has enough liquid balance above its 10 GRAM
        // storage reserve to cover the unstake; otherwise it silently postpones to the next
        // bill-holding round, and there isn't one here.
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(treasuryState),
                balance: toNano('20'),
            }),
        )

        const collectionAddress = await treasury.getCollectionAddress(round)
        const billAddress = await treasury.getBillAddress(round, 0n)

        const unstakeResult = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.1'),
            tokens: '7',
            mode: UnstakeMode.Best,
        })
        expect(unstakeResult.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.mintBill),
            success: true,
        })

        const stateAfterUnstake = await treasury.getTreasuryState()
        expect(stateAfterUnstake.totalUnstaking > 0n).toBe(true)

        const result = await processLoanRequests(round)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.burnAll),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: billAddress,
            to: collectionAddress,
            body: bodyOp(op.billBurned),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.burnTokens),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
        })

        const finalState = await treasury.getTreasuryState()
        expect(finalState.totalUnstaking).toEqual(0n)
        expect(finalState.participations.size).toEqual(0)
    })

    it('should not burn bills while an older round still owes a reward', async () => {
        const older = 1_000_000n
        const later = 2_000_000n
        const staker = await blockchain.treasury('staker')
        const borrower = (await blockchain.treasury('borrower')).address

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
            .set(older, { state: ParticipationState.Validating })
            .set(later, rejectedParticipation(borrower, 1n, ParticipationState.Distributing))
        await setParticipations(participations, rejectedStakeAmount)

        const fees = await treasury.getTreasuryFees(0n)
        const olderCollection = await treasury.getCollectionAddress(older)
        const laterCollection = await treasury.getCollectionAddress(later)

        // Both `older` and `later` hold bills, so this deposit lands in the highest (later) round.
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const result = await processLoanRequests(later)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({
            to: laterCollection,
            body: bodyOp(op.burnAll),
        })

        const participation = await treasury.getParticipation(later)
        expect(participation.state).toEqual(ParticipationState.ReadyToBurn)

        // Settle the older round the same way the rest of this file does. `later` is left untouched
        // on-chain (already ready_to_burn from the call above).
        const stateBeforeSettle = await treasury.getTreasuryState()
        stateBeforeSettle.participations.set(older, recoveringParticipation(borrower))
        await setParticipations(stateBeforeSettle.participations)

        const settleResult = await settle(older, borrower)

        expect(settleResult.transactions).not.toHaveTransaction({ success: false })
        // Finalizing the older round releases both itself and the round it was holding back.
        expect(settleResult.transactions).toHaveTransaction({
            to: olderCollection,
            body: bodyOp(op.burnAll),
        })
        expect(settleResult.transactions).toHaveTransaction({
            to: laterCollection,
            body: bodyOp(op.burnAll),
        })
    })

    // Regression for the size decrement in the rejected-refund loop: max(0, size - 1) must not
    // underflow when a participation's size does not count its rejected requests, which is exactly
    // what the OLD distribute() (before its fix) wrote for a round rejected outright.
    it('should not underflow size when a round rejects every request', async () => {
        const round = 1_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(
            round,
            rejectedParticipation(borrower, 0n, ParticipationState.Distributing),
        )
        await setParticipations(participations, rejectedStakeAmount)

        const result = await processLoanRequests(round)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({ exitCode: 5 })
    })

    // available_ton (reserve_tokens / burn_tokens / get_max_burnable_tokens) is deliberately not
    // minus total_staking, even though deposit_coins' raw_reserve puts pending-deposit coins on the
    // balance too -- see the comments at those sites for the full argument. This is the regression
    // lock: an unstake bill minted before this round's deposit bills must still be paid out of a
    // balance the pending deposit is sitting on, not postponed or rolled back.
    it('should pay a matured unstake bill out of balance that pending deposits contributed', async () => {
        const round = 1_000_000n
        const staker = await blockchain.treasury('staker')
        const depositor = await blockchain.treasury('depositor')
        const borrower = (await blockchain.treasury('borrower')).address

        // Deposit before any round holds bills, so this mints tokens directly and gives the staker
        // something to unstake below.
        const depositFees = await treasury.getTreasuryFees(0n)
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + depositFees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()

        // Now put `round` in a bill-holding state, matching this suite's default instantMint = false,
        // which is what keeps a pending deposit's coins in total_staking instead of total_coins.
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(
            round,
            rejectedParticipation(borrower, 1n, ParticipationState.Distributing),
        )
        await setParticipations(participations, rejectedStakeAmount)

        const collectionAddress = await treasury.getCollectionAddress(round)

        // Unstake FIRST, so its bill gets the lower NFT index and therefore burns before the deposit
        // bill below. Mode.Best (not instant) with the round already holding bills sends this through
        // the mint-a-bill branch of reserve_tokens rather than paying immediately.
        const unstakeResult = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.1'),
            tokens: '7',
            mode: UnstakeMode.Best,
        })
        expect(unstakeResult.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.mintBill),
            success: true,
        })

        // Deposit SECOND, into the same round, so its bill gets a higher NFT index and total_staking
        // becomes nonzero while the unstake bill above is still unburned.
        const depositResult = await treasury.sendDepositCoins(depositor.getSender(), {
            value: toNano('5') + depositFees.depositCoinsFee,
        })
        expect(depositResult.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.mintBill),
            success: true,
        })

        const stateBeforeBurn = await treasury.getTreasuryState()
        expect(stateBeforeBurn.totalStaking > 0n).toBe(true)

        // The unstake bill's payout, computed the same way burn_tokens does: coins = tokens *
        // totalCoins / totalTokens at the current rate.
        const unstakeCoins = (toNano('7') * stateBeforeBurn.totalCoins) / stateBeforeBurn.totalTokens

        // Craft the balance so that available_ton (balance - fee::treasury_storage -
        // totalBorrowersStake) covers the unstake bill on its own, but would NOT cover it if
        // total_staking were also subtracted. This inequality is the entire point of the test: it
        // fails the moment anyone subtracts total_staking from available_ton in reserve_tokens or
        // burn_tokens.
        const balance = toNano('10.01') + unstakeCoins + stateBeforeBurn.totalStaking / 2n
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(stateBeforeBurn),
                balance,
            }),
        )

        const result = await processLoanRequests(round)

        expect(result.transactions).not.toHaveTransaction({ success: false })
        // The unstake bill (lower index) is checked while total_staking is still at its peak -- the
        // deposit bill (higher index) hasn't burned yet -- and must be paid, not postponed or rolled
        // back.
        expect(result.transactions).not.toHaveTransaction({ body: bodyOp(op.proxyRollbackUnstake) })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            body: bodyOp(op.proxyTokensBurned),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: walletAddress,
            body: bodyOp(op.tokensBurned),
            success: true,
        })

        const finalState = await treasury.getTreasuryState()
        expect(finalState.totalStaking).toEqual(0n)
        expect(finalState.totalUnstaking).toEqual(0n)
    })

    // decide_loan_requests and process_loan_requests are only ever driven by treasury -> treasury
    // self-messages queued while a round is distributing. There is no ordering guarantee between one
    // of those and a governor's retry_distribute, so a stale continuation could otherwise land after
    // the round has already moved on to burning and write its state back over it, re-satisfying
    // holds_bills? for a collection whose burn chain has already gone past the bills it would attach.
    it('should reject a stale decide_loan_requests / process_loan_requests once the round is burning', async () => {
        const round = 1_000_000n

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(round, {
            state: ParticipationState.Burning,
        })
        await setParticipations(participations)

        const decideResult = await decideLoanRequests(round)
        expect(decideResult.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.decideLoanRequests),
            success: false,
            exitCode: err.unableToParticipate,
        })

        const processResult = await processLoanRequests(round)
        expect(processResult.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.processLoanRequests),
            success: false,
            exitCode: err.unableToParticipate,
        })

        const participation = await treasury.getParticipation(round)
        expect(participation.state).toEqual(ParticipationState.Burning)
    })

    // Happy-path regression for the guard above: neither message may be rejected while the round is
    // still in the state this chain is actually driven from.
    it('should still accept decide_loan_requests / process_loan_requests while the round is distributing', async () => {
        const round = 1_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(
            round,
            rejectedParticipation(borrower, 1n, ParticipationState.Distributing),
        )
        await setParticipations(participations, rejectedStakeAmount)

        const decideResult = await decideLoanRequests(round)
        expect(decideResult.transactions).not.toHaveTransaction({ success: false })

        // decide_loan_requests's own cascade already carries this round through
        // process_loan_requests and into ready_to_burn (there is nothing to sort or accept), so put it
        // back in distributing to prove process_loan_requests independently still accepts it too.
        await setParticipations(participations, rejectedStakeAmount)

        const processResult = await processLoanRequests(round)
        expect(processResult.transactions).not.toHaveTransaction({ success: false })

        // Nothing was left to accept, sort, or stake, and the round's only request was rejected, so
        // process_loan_requests settles it straight into the ready_to_burn barrier. No bill was ever
        // minted into its collection, so burn_ready_participations' burn_all gets an immediate
        // last_bill_burned reply and the participation is removed from the dict entirely.
        const finalState = await treasury.getTreasuryState()
        expect(finalState.participations.size).toEqual(0)
    })
})
