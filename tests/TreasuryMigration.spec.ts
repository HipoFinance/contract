import { compile } from '@ton/blueprint'
import { Blockchain, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, Cell, Slice, beginCell, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { bodyOp } from './helper'
import { op } from '../wrappers/common'
import { Treasury } from '../wrappers/Treasury'
import { dryRunUpgrade, formatDryRun } from '../wrappers/migrationDryRun'

// The live treasury account captured from mainnet: its code as deployed, and its storage cell in the
// pre-deficit layout. The deficit counter inserts a field into root storage, so every existing
// treasury needs its storage rewritten during the upgrade.
//
// That migration runs as a `migrate_code` cell carried inside the upgrade message: upgrade_code
// installs the new code, the treasury blesses the migrator and executes it once, and then the
// template's own load_data() + governor check prove the result is readable and still ours. Nothing
// one-off is ever stored on chain and the released hash stays the hash of the plain contract.
//
// Testing it against synthetic state would prove little, since the whole risk is that the deployed
// layout is not what the migration assumes. This replays the actual bytes on chain.
const treasuryAddress = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')

// The id the treasury enters a migrator at, matching `run_migrator` in treasury.fc.
const migrateMethodId = 0x6d67

describe('Treasury Migration', () => {
    let treasuryCode: Cell
    let migratorCode: Cell
    let mainnetCode: Cell
    let mainnetData: Cell

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        migratorCode = await compile('upgrade-code-test/AddDeficit')
        mainnetCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-code.boc'))[0]
        mainnetData = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-state.boc'))[0]
    })

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

    async function readCodeHash(blockchain: Blockchain, address: Address): Promise<string> {
        const contract = await blockchain.getContract(address)
        const state = contract.account.account?.storage.state
        if (state?.type !== 'active') throw new Error('treasury account is not active')
        return state.state.code?.hash().toString('hex') ?? 'none'
    }

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
    // governor, which exists on chain but not in this sandbox, so it lands on an uninitialized
    // account and shows as aborted. That is an artifact of replaying mainnet state locally, and the
    // send carries send::ignore_errors regardless.
    function expectTreasurySucceeded(transactions: Parameters<typeof expect>[0]) {
        expect(transactions).not.toHaveTransaction({ to: treasuryAddress, success: false })
        expect(transactions).not.toHaveTransaction({ to: treasuryAddress, exitCode: -14 })
    }

    it('should have captured a mainnet cell that is still in the pre-deficit layout', () => {
        const before = parsePreDeficit(mainnetData)
        expect(before.parent.toString()).toEqual('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
        expect(before.totalCoins).toBeGreaterThan(0n)
        expect(before.totalTokens).toBeGreaterThan(0n)
    })

    // ---------------------------------------------------------------------------------------------
    // Mechanical guardrails on the migrator itself.
    //
    // A migrator runs with the treasury's full authority, and exactly two things it could do would
    // survive a failure and cause lasting damage. Both are single opcodes, so both are checked here
    // rather than left to review discipline.
    // ---------------------------------------------------------------------------------------------

    // Walks the method dictionary out of a compiled contract. FunC puts the id -> procedure hashmap in
    // the first ref of the code cell, keyed by signed 19-bit ids. The values are inline slices rather
    // than refs, so the generic Dictionary parser cannot read it and only the keys are recovered here.
    function methodIds(code: Cell, keyLen = 19): number[] {
        const out: number[] = []
        if (code.refs.length === 0) return out

        const walk = (slice: Slice, left: number, prefix: string) => {
            // Each bit is read once and kept, because the reads are stateful and the branches are not
            // interchangeable even though they look alike.
            let label = ''
            const long = slice.loadBit()
            if (!long) {
                // hml_short: unary length, then that many bits
                let n = 0
                while (slice.loadBit()) n++
                for (let i = 0; i < n; i++) label += slice.loadBit() ? '1' : '0'
            } else {
                const same = slice.loadBit()
                const width = Math.ceil(Math.log2(left + 1))
                if (!same) {
                    // hml_long: a counted run of bits
                    const n = slice.loadUint(width)
                    for (let i = 0; i < n; i++) label += slice.loadBit() ? '1' : '0'
                } else {
                    // hml_same: one bit repeated
                    const bit = slice.loadBit() ? '1' : '0'
                    label = bit.repeat(slice.loadUint(width))
                }
            }
            const rest = left - label.length
            if (rest === 0) {
                const bits = prefix + label
                let value = parseInt(bits, 2)
                if (bits.startsWith('1')) value -= 1 << bits.length // ids are signed
                out.push(value)
            } else {
                walk(slice.loadRef().beginParse(), rest - 1, prefix + label + '0')
                walk(slice.loadRef().beginParse(), rest - 1, prefix + label + '1')
            }
        }
        walk(code.refs[0].beginParse(), keyLen, '')
        return out.sort((a, b) => a - b)
    }

    it('should read method dictionaries correctly, checked against the treasury', () => {
        // Guards the walker itself. The treasury's ids fall in two bands: small sequential procedure
        // ids, and name-derived get methods at (crc16(name) & 0xffff) | 0x10000, hence >= 65536.
        const ids = methodIds(treasuryCode)
        expect(ids).toContain(0)
        expect(ids.filter((id) => id > 1 && id < 65536).length).toBeGreaterThan(0)
        expect(ids.filter((id) => id >= 65536).length).toBeGreaterThan(0)
        // 0x6d67 sits in the gap between those bands, which is why it cannot collide with a get method.
        expect(ids).not.toContain(migrateMethodId)
    })

    it('should compile the migrator to exactly the entry point and nothing else', () => {
        // EXECUTE does not set c3, so c3 still holds the TREASURY's code while a migrator runs. A
        // non-inlined function in the migrator compiles to CALLDICT and would dispatch into the
        // treasury's own dictionary — silently running a treasury internal with wrong arguments.
        // Exactly two ids means everything is inlined and that cannot happen.
        expect(methodIds(migratorCode)).toEqual([0, migrateMethodId])
    })

    it('should compile the migrator without COMMIT or SETCODE', () => {
        // COMMIT locks in c4 and the already-queued set_code action, which makes the checks after the
        // migration decorative: a migrator that commits and then writes an unparseable cell leaves
        // the treasury on the new code with storage it cannot read, and recv_internal loads data
        // before dispatch, so no further upgrade can be received. Unrecoverable.
        //
        // SETCODE is appended after the set_code upgrade_code queued, and the last action wins, so a
        // migrator could redirect the treasury to code the upgrade message never named.
        const source = readFileSync(__dirname + '/../wrappers/upgrade-code-test/add_deficit.fc', 'utf8')
        // Comments are stripped first, or the explanation of this very rule would trip it.
        const code = source.replace(/;;.*$/gm, '')
        expect(code).not.toMatch(/\bcommit\s*\(/)
        expect(code).not.toMatch(/\bset_code\s*\(/)
        // A raw asm block could emit either opcode without naming the stdlib function, so migrators
        // are held to plain FunC. stdlib's own asm definitions are unaffected: they are inlined at
        // call sites, and an unused one emits nothing.
        expect(code).not.toMatch(/\basm\b/)
    })

    // ---------------------------------------------------------------------------------------------
    // The migration itself, against real mainnet bytes.
    // ---------------------------------------------------------------------------------------------

    it('should migrate in a single upgrade and land on the plain released code hash', async () => {
        const before = parsePreDeficit(mainnetData)
        const { blockchain, treasury, governor } = await stand()
        const stateBefore = await treasury.getTreasuryState()

        const result = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })

        expect(result.transactions).toHaveTransaction({
            to: treasuryAddress,
            body: bodyOp(op.upgradeCode),
            success: true,
        })
        expectTreasurySucceeded(result.transactions)
        expect(result.transactions).toHaveTransaction({ from: treasuryAddress, body: bodyOp(op.gasExcess) })

        // One transaction, and the code left behind is the plain contract with no one-off logic.
        expect(await readCodeHash(blockchain, treasuryAddress)).toEqual(treasuryCode.hash().toString('hex'))
        expect(await treasury.getDeficit()).toEqual(0n)

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
        expect(stateAfter.governor.toString()).toEqual(stateBefore.governor.toString())
        expect(stateAfter.halter.toString()).toEqual(stateBefore.halter.toString())
        expect(stateAfter.governanceFee).toEqual(stateBefore.governanceFee)
        expect(stateAfter.previousRate).toEqual(stateBefore.previousRate)
        expect(stateAfter.currentRate).toEqual(stateBefore.currentRate)
        expect(stateAfter.participations.size).toEqual(stateBefore.participations.size)
    })

    it('should leave data alone when no migrator is supplied', async () => {
        const { blockchain, treasury, governor } = await stand()
        await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        const migrated = await readStorage(blockchain, treasuryAddress)

        const plain = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
        })
        expectTreasurySucceeded(plain.transactions)
        expect((await readStorage(blockchain, treasuryAddress)).equals(migrated)).toBe(true)
        expect(await treasury.getDeficit()).toEqual(0n)
    })

    it('should reject an empty cell rather than treating it as no migrator', async () => {
        // Absent is the only way to say "no migration". An empty cell is not a second way: tolerating
        // it would let a value-only migration - one that changes numbers without changing the layout -
        // skip silently while the upgrade reported success, since load_data() would parse the
        // unmigrated cell fine. Older upgrade scripts sent one unconditionally, so this must fail
        // loudly rather than quietly do nothing.
        const { blockchain, treasury, governor } = await stand()
        const codeBefore = await readCodeHash(blockchain, treasuryAddress)
        const dataBefore = await readStorage(blockchain, treasuryAddress)

        const result = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: beginCell().endCell(),
        })
        expect(result.transactions).toHaveTransaction({ to: treasuryAddress, success: false })
        expect(await readCodeHash(blockchain, treasuryAddress)).toEqual(codeBefore)
        expect((await readStorage(blockchain, treasuryAddress)).equals(dataBefore)).toBe(true)
    })

    // ---------------------------------------------------------------------------------------------
    // Failure paths. Given a migrator with no COMMIT and no SETCODE, every failure must leave the
    // treasury exactly as it was — old code, old data.
    // ---------------------------------------------------------------------------------------------

    it('should reject the upgrade from anyone but the governor', async () => {
        const { blockchain, treasury } = await stand()
        const someone = await blockchain.treasury('someone')

        const result = await treasury.sendUpgradeCode(someone.getSender(), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        expect(result.transactions).toHaveTransaction({ to: treasuryAddress, success: false })

        // Storage still has to parse as the OLD layout, which it would not if the migrator had run.
        const after = parsePreDeficit(await readStorage(blockchain, treasuryAddress))
        expect(after.totalCoins).toEqual(parsePreDeficit(mainnetData).totalCoins)
        expect(after.parent.toString()).toEqual(parsePreDeficit(mainnetData).parent.toString())
    })

    it('should revert the whole upgrade when the migrator is not runnable code', async () => {
        const { blockchain, treasury, governor } = await stand()
        const codeBefore = await readCodeHash(blockchain, treasuryAddress)
        const dataBefore = await readStorage(blockchain, treasuryAddress)

        const result = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: beginCell().storeUint(0xdeadbeef, 32).endCell(),
        })
        expect(result.transactions).toHaveTransaction({ to: treasuryAddress, success: false })
        expect(await readCodeHash(blockchain, treasuryAddress)).toEqual(codeBefore)
        expect((await readStorage(blockchain, treasuryAddress)).equals(dataBefore)).toBe(true)
    })

    // ---------------------------------------------------------------------------------------------
    // The dry run in scripts/upgradeCode.ts. It replays the upgrade against live state and shows the
    // operator a field-level diff before they sign. A wrong diff would be worse than none, so it is
    // tested against the same real mainnet fixtures.
    // ---------------------------------------------------------------------------------------------

    it('should show a dry-run diff of exactly what the migration changes', async () => {
        const { governor } = await stand()
        const result = await dryRunUpgrade({
            address: treasuryAddress,
            currentCode: mainnetCode,
            currentData: mainnetData,
            newCode: treasuryCode,
            migrateCode: migratorCode,
            governor,
        })

        expect(result.ok).toBe(true)
        expect(result.after?.codeHash).toEqual(treasuryCode.hash().toString('hex'))

        // The deficit appearing is the whole point of this migration, and it must be the ONLY field
        // that moves. Anything else in this list would be an unintended change the operator should see.
        expect(result.changes.map((c) => c.field)).toEqual(['deficit'])
        expect(result.changes[0].before).toContain('absent')
        expect(result.changes[0].after).toEqual('0')

        // The storage cell itself must change even though no accounting value does.
        expect(result.after?.dataHash).not.toEqual(result.before.dataHash)

        const rendered = formatDryRun(result)
        expect(rendered).toContain('deficit')
        expect(rendered).toContain('1 field(s) would change')
    })

    it('should catch a forgotten migrator in the dry run', async () => {
        // Upgrading pre-deficit storage to code that expects a deficit, with no migrator, leaves the
        // new load_data() reading a layout that is one field short. This is the mistake most likely to
        // actually happen, and the operator sees it as a refusal rather than as a bricked treasury.
        const { governor } = await stand()
        const result = await dryRunUpgrade({
            address: treasuryAddress,
            currentCode: mainnetCode,
            currentData: mainnetData,
            newCode: treasuryCode,
            governor,
        })

        expect(result.ok).toBe(false)
        expect(result.failure).toMatch(/FAIL|skipped/)
        expect(formatDryRun(result)).toContain('Do not send this upgrade')
    })

    it('should refuse a migrator that would corrupt storage, in the dry run', async () => {
        const { governor } = await stand()
        const result = await dryRunUpgrade({
            address: treasuryAddress,
            currentCode: mainnetCode,
            currentData: mainnetData,
            newCode: treasuryCode,
            migrateCode: beginCell().storeUint(0xdeadbeef, 32).endCell(),
            governor,
        })

        expect(result.ok).toBe(false)
        expect(result.after).toBeUndefined()
        expect(result.changes).toHaveLength(0)
    })

    it('should refuse to run the migration a second time', async () => {
        const { blockchain, treasury, governor } = await stand()
        await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        const migrated = await treasury.getTreasuryState()
        const dataAfterFirst = await readStorage(blockchain, treasuryAddress)
        expect(await treasury.getDeficit()).toEqual(0n)

        // end_parse() in the migrator finds bits left over on an already-migrated cell.
        const again = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: toNano('1'),
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        expect(again.transactions).toHaveTransaction({ to: treasuryAddress, success: false })
        expect((await readStorage(blockchain, treasuryAddress)).equals(dataAfterFirst)).toBe(true)

        const after = await treasury.getTreasuryState()
        expect(after.totalCoins).toEqual(migrated.totalCoins)
        expect(after.governor.toString()).toEqual(migrated.governor.toString())
        expect(await treasury.getDeficit()).toEqual(0n)
    })
})
