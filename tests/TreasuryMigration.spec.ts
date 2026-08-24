import { compile } from '@ton/blueprint'
import { Blockchain, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, Cell, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { bodyOp } from './helper'
import { op } from '../wrappers/common'
import { Treasury } from '../wrappers/Treasury'

// The live treasury account captured from mainnet: its code as deployed, and its storage cell in the
// pre-deficit layout. The upgrade this branch ships inserts a `deficit` field into root storage between
// total_borrowers_stake and parent, so every existing treasury needs its storage rewritten.
//
// That migration is the part of the deploy with no second chance. upgrade_code runs set_c3 before
// calling upgrade_data, so the migration executes under the NEW code against the OLD cell, and the
// access check guarding the whole operation reads a governor that only parses if the layout was right.
// Synthetic state would prove little, so this replays the actual bytes on chain.
//
// It follows the two-step procedure in scripts/upgrade_treasury.md: upgrade to the one-off migration
// code, then upgrade back to the released treasury code. wrappers/upgrade-code-test/add_deficit.fc is
// the testable copy of the upgrade_data body that the real deploy pastes into contracts/treasury.fc,
// which is why treasury.fc itself stays a pristine template here.
const treasuryAddress = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')

describe('Treasury Migration', () => {
    let treasuryCode: Cell
    let addDeficitCode: Cell
    let mainnetCode: Cell
    let mainnetData: Cell

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        addDeficitCode = await compile('upgrade-code-test/AddDeficit')
        mainnetCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-code.boc'))[0]
        mainnetData = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-state.boc'))[0]
    })

    // Reads the captured cell in the layout the deployed code uses, so the test states its own
    // expectation of what mainnet looks like rather than letting the migration define it.
    function parsePreDeficit(data: Cell) {
        const s = data.beginParse()
        const parsed = {
            totalCoins: s.loadCoins(),
            totalTokens: s.loadCoins(),
            totalStaking: s.loadCoins(),
            totalUnstaking: s.loadCoins(),
            totalBorrowersStake: s.loadCoins(),
            parent: s.loadAddress(),
            participations: s.loadMaybeRef(),
            roundsImbalance: s.loadUint(8),
            stopped: s.loadBit(),
            instantMint: s.loadBit(),
            loanCodes: s.loadRef(),
            extension: s.loadRef(),
        }
        s.endParse() // no deficit field yet, and nothing left over
        return parsed
    }

    async function readStorage(blockchain: Blockchain, address: Address): Promise<Cell> {
        const contract = await blockchain.getContract(address)
        const state = contract.account.account?.storage.state
        if (state?.type !== 'active' || state.state.data == null) {
            throw new Error('treasury account is not active')
        }
        return state.state.data
    }

    it('should have captured a mainnet cell that is still in the pre-deficit layout', () => {
        const before = parsePreDeficit(mainnetData)
        expect(before.parent.toString()).toEqual('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
        expect(before.totalCoins).toBeGreaterThan(0n)
        expect(before.totalTokens).toBeGreaterThan(0n)
    })

    async function stand() {
        const blockchain = await Blockchain.create()
        await blockchain.setShardAccount(
            treasuryAddress,
            createShardAccount({
                workchain: 0,
                address: treasuryAddress,
                code: mainnetCode,
                data: mainnetData,
                balance: toNano('100'),
            }),
        )
        const treasury = blockchain.openContract(Treasury.createFromAddress(treasuryAddress))
        // The governor lives in the extension cell, so take it from the live state rather than
        // hardcoding it; the upgrade is access-checked against exactly this address.
        const state = await treasury.getTreasuryState()
        return { blockchain, treasury, governor: state.governor }
    }

    // Scoped to the treasury on purpose. The gas_excess refund is addressed to the real mainnet
    // governor, which exists on chain but not in this sandbox, so it lands on an uninitialized account
    // and shows as aborted. That is an artifact of replaying mainnet state locally, and the send
    // carries send::ignore_errors regardless.
    function expectTreasurySucceeded(transactions: Parameters<typeof expect>[0]) {
        expect(transactions).not.toHaveTransaction({ to: treasuryAddress, success: false })
        expect(transactions).not.toHaveTransaction({ to: treasuryAddress, exitCode: -14 })
    }

    it('should migrate the live mainnet treasury and preserve every field', async () => {
        const before = parsePreDeficit(mainnetData)
        const { blockchain, treasury, governor } = await stand()
        const stateBefore = await treasury.getTreasuryState()

        // Step one: upgrade to the one-off migration code.
        const migrate = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: addDeficitCode,
        })
        expect(migrate.transactions).toHaveTransaction({
            to: treasuryAddress,
            body: bodyOp(op.upgradeCode),
            success: true,
        })
        expectTreasurySucceeded(migrate.transactions)
        expect(migrate.transactions).toHaveTransaction({ from: treasuryAddress, body: bodyOp(op.gasExcess) })

        // Step two: upgrade back to the released treasury code, which must leave the data alone.
        const restore = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
        })
        expectTreasurySucceeded(restore.transactions)

        // The treasury must end on exactly the released code, not the migration code.
        const finalCode = (await blockchain.getContract(treasuryAddress)).account.account?.storage.state
        expect(finalCode?.type).toEqual('active')
        if (finalCode?.type === 'active') {
            expect(finalCode.state.code?.hash().toString('hex')).toEqual(treasuryCode.hash().toString('hex'))
        }

        // The new field exists and starts clean.
        expect(await treasury.getDeficit()).toEqual(0n)

        // Everything that existed before must survive exactly. Accounting first, since a layout slip
        // shows up here as a plausible-looking wrong number rather than as a crash.
        const stateAfter = await treasury.getTreasuryState()
        expect(stateAfter.totalCoins).toEqual(before.totalCoins)
        expect(stateAfter.totalTokens).toEqual(before.totalTokens)
        expect(stateAfter.totalStaking).toEqual(before.totalStaking)
        expect(stateAfter.totalUnstaking).toEqual(before.totalUnstaking)
        expect(stateAfter.totalBorrowersStake).toEqual(before.totalBorrowersStake)
        expect(stateAfter.parent?.toString()).toEqual(before.parent.toString())
        expect(stateAfter.roundsImbalance).toEqual(BigInt(before.roundsImbalance))
        expect(stateAfter.stopped).toEqual(before.stopped)
        expect(stateAfter.instantMint).toEqual(before.instantMint)

        // And the extension, which the migration moves as an opaque ref but which carries the governor
        // the access check just depended on.
        expect(stateAfter.governor.toString()).toEqual(stateBefore.governor.toString())
        expect(stateAfter.halter.toString()).toEqual(stateBefore.halter.toString())
        expect(stateAfter.governanceFee).toEqual(stateBefore.governanceFee)
        expect(stateAfter.previousRate).toEqual(stateBefore.previousRate)
        expect(stateAfter.currentRate).toEqual(stateBefore.currentRate)
        expect(stateAfter.participations.size).toEqual(stateBefore.participations.size)
    })

    it('should reject the migration from anyone but the governor', async () => {
        const { blockchain, treasury } = await stand()
        const someone = await blockchain.treasury('someone')

        const result = await treasury.sendUpgradeCode(someone.getSender(), {
            value: toNano('1'),
            newCode: addDeficitCode,
        })
        expect(result.transactions).toHaveTransaction({ to: treasuryAddress, success: false })

        // Storage must be untouched, so a rejected attempt cannot leave a half-migrated cell. It still
        // has to parse as the OLD layout, which it would not if the migration had run.
        const after = parsePreDeficit(await readStorage(blockchain, treasuryAddress))
        expect(after.totalCoins).toEqual(parsePreDeficit(mainnetData).totalCoins)
        expect(after.parent.toString()).toEqual(parsePreDeficit(mainnetData).parent.toString())
    })

    // Running the migration twice must not corrupt anything. The old-layout parse ends with end_parse(),
    // so a cell that already carries a deficit leaves bits over, throws, and reverts the whole upgrade.
    it('should refuse to run the migration a second time', async () => {
        const { blockchain, treasury, governor } = await stand()
        await treasury.sendUpgradeCode(blockchain.sender(governor), { value: toNano('1'), newCode: addDeficitCode })
        await treasury.sendUpgradeCode(blockchain.sender(governor), { value: toNano('1'), newCode: treasuryCode })
        const migrated = await treasury.getTreasuryState()
        expect(await treasury.getDeficit()).toEqual(0n)

        const again = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: addDeficitCode,
        })
        expect(again.transactions).toHaveTransaction({ to: treasuryAddress, success: false })

        // State must be exactly as the first migration left it.
        const after = await treasury.getTreasuryState()
        expect(after.totalCoins).toEqual(migrated.totalCoins)
        expect(after.totalTokens).toEqual(migrated.totalTokens)
        expect(after.governor.toString()).toEqual(migrated.governor.toString())
        expect(await treasury.getDeficit()).toEqual(0n)
    })
})
