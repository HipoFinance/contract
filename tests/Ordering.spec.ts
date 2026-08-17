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
    Treasury,
    emptyDictionaryValue,
    participationDictionaryValue,
    requestDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'

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
    async function setParticipations(participations: Dictionary<bigint, Participation>): Promise<void> {
        const state = await treasury.getTreasuryState()
        state.participations = participations
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
})
