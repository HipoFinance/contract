import { compile } from '@ton/blueprint'
import { Cell, Dictionary, toNano } from '@ton/core'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { bodyOp, updateFeeConfig } from './helper'
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

// The participation-ordering-barrier fix renumbered the participation states: `recovering` stayed
// 5, but the old `burning` = 6 became `ready_to_burn` = 6 / `burning` = 7. upgrade_data() carries a
// one-off migration that walks the stored participations dict and rewrites any entry whose raw
// stored state is still 6 (the pre-upgrade meaning of `burning`) to 7, leaving states 0..5 alone.
// These tests drive that migration directly: they push a treasury into synthetic pre-upgrade data
// via setShardAccount, send upgrade_code, and assert on the resulting participations dict.
describe('Migration', () => {
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell

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
        await treasury.sendDeploy(deployer.getSender(), { value: '1' })
        await parent.sendDeploy(deployer.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), { value: '1', newParent: parent.address })
    })

    // Overwrites the treasury's participations dictionary with a synthetic one, keeping every other
    // field (codes, halter, governor, rates, ...) as already deployed. Same treasuryConfigToCell +
    // setShardAccount technique used by MaxGas.spec.ts, MinGas.spec.ts and Ordering.spec.ts to drop a
    // treasury straight into a state that would otherwise take many messages to reach -- here it
    // lets us write a raw stored state of 6 that, before the renumbering, meant `burning`.
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

    it('should migrate an in-flight burning round to the renumbered burning state', async () => {
        const round = 1_000_000n

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(round, {
            // ParticipationState.ReadyToBurn === 6 in the post-renumbering TS enum, but this data
            // is meant to simulate what a pre-upgrade contract has on disk, where the raw stored
            // value 6 meant `burning` (there was no `ready_to_burn` state yet).
            state: ParticipationState.ReadyToBurn,
        })
        await setParticipations(participations)

        const result = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: treasuryCode,
        })
        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.upgradeCode),
            success: true,
            exitCode: 0,
        })

        const participation = await treasury.getParticipation(round)
        expect(participation.state).toEqual(ParticipationState.Burning)
    })

    it('should leave rounds in states 0..5 untouched while migrating only the raw-6 round', async () => {
        const untouchedStates = [
            ParticipationState.Open,
            ParticipationState.Distributing,
            ParticipationState.Staked,
            ParticipationState.Validating,
            ParticipationState.Held,
            ParticipationState.Recovering,
        ]

        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
        const rounds = untouchedStates.map((state, index) => {
            const round = BigInt(1_000_000 + index * 100_000)
            participations.set(round, { state })
            return round
        })
        const burningRound = 2_000_000n
        participations.set(burningRound, {
            // Raw stored 6, the pre-upgrade meaning of `burning` -- see the comment in the test above.
            state: ParticipationState.ReadyToBurn,
        })
        await setParticipations(participations)

        const result = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: treasuryCode,
        })
        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.upgradeCode),
            success: true,
            exitCode: 0,
        })

        for (const [index, round] of rounds.entries()) {
            const participation = await treasury.getParticipation(round)
            expect(participation.state).toEqual(untouchedStates[index])
        }

        const migrated = await treasury.getParticipation(burningRound)
        expect(migrated.state).toEqual(ParticipationState.Burning)
    })

    it('should preserve every other field of a migrated participation across the upgrade', async () => {
        const round = 1_000_000n
        const borrower = (await blockchain.treasury('borrower')).address

        const recovering = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        recovering.set(BigInt('0x' + borrower.hash.toString('hex')), {
            minPayment: toNano('0.1'),
            borrowerRewardShare: 42n,
            loanAmount: toNano('123'),
            accrueAmount: toNano('4'),
            stakeAmount: toNano('120'),
            newStakeMsg: Cell.EMPTY,
        })

        const beforeUpgrade: Participation = {
            // Raw stored 6, the pre-upgrade meaning of `burning` -- see the comment in the first test.
            state: ParticipationState.ReadyToBurn,
            size: 1n,
            recovering,
            totalStaked: toNano('456'),
            totalRecovered: toNano('78'),
            currentVsetHash: 999_999_999_999n,
            stakeHeldFor: 3600n,
            stakeHeldUntil: 1_700_000_000n,
        }
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue).set(
            round,
            beforeUpgrade,
        )
        await setParticipations(participations)

        const result = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: treasuryCode,
        })
        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.upgradeCode),
            success: true,
            exitCode: 0,
        })

        const afterUpgrade = await treasury.getParticipation(round)
        // Only the state changed, from the raw pre-upgrade 6 (burning) to the renumbered 7.
        expect(afterUpgrade.state).toEqual(ParticipationState.Burning)
        expect(afterUpgrade.size).toEqual(beforeUpgrade.size)
        expect(afterUpgrade.totalStaked).toEqual(beforeUpgrade.totalStaked)
        expect(afterUpgrade.totalRecovered).toEqual(beforeUpgrade.totalRecovered)
        expect(afterUpgrade.currentVsetHash).toEqual(beforeUpgrade.currentVsetHash)
        expect(afterUpgrade.stakeHeldFor).toEqual(beforeUpgrade.stakeHeldFor)
        expect(afterUpgrade.stakeHeldUntil).toEqual(beforeUpgrade.stakeHeldUntil)
        expect(afterUpgrade.recovering?.size).toEqual(1)
        const migratedRequest = afterUpgrade.recovering?.get(BigInt('0x' + borrower.hash.toString('hex')))
        const originalRequest = recovering.get(BigInt('0x' + borrower.hash.toString('hex')))
        expect(migratedRequest).toBeDefined()
        expect(originalRequest).toBeDefined()
        expect(migratedRequest?.minPayment).toEqual(originalRequest?.minPayment)
        expect(migratedRequest?.borrowerRewardShare).toEqual(originalRequest?.borrowerRewardShare)
        expect(migratedRequest?.loanAmount).toEqual(originalRequest?.loanAmount)
        expect(migratedRequest?.accrueAmount).toEqual(originalRequest?.accrueAmount)
        expect(migratedRequest?.stakeAmount).toEqual(originalRequest?.stakeAmount)
        expect(migratedRequest?.newStakeMsg.equals(originalRequest?.newStakeMsg ?? Cell.EMPTY)).toBe(true)
    })
})
