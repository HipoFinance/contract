import { compile } from '@ton/blueprint'
import { Blockchain, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, Cell, Dictionary, DictionaryValue, Slice, beginCell, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { Treasury, emptyDictionaryValue, requestDictionaryValue, sortedDictionaryValue } from '../wrappers/Treasury'

// The borrower-fee upgrade changes three stored layouts at once, and all three have to be converted
// by the migrator in the same transaction:
//
//   1. the extension gains borrower_fee after governance_fee
//   2. every request carries a 16-bit borrower_reward_share and a 16-bit request_fee
//   3. every participation's sorted dict is rekeyed from 112 to 120 bits
//
// The mainnet fixture used by TreasuryMigration.spec.ts predates the deficit field, so it cannot
// stand in for the pre-borrower-fee layout. State is built here in the shape the deployed contract
// actually holds today: post-deficit root, pre-borrower-fee extension and requests.
//
// The point of most of this file is the third rule in scripts/upgrade_treasury.md: a migrator cannot
// call into the treasury, so it carries its own copy of the record layout and its own sort key, and
// those copies can silently drift from the contract's. Everything below is a check that they have
// not.

const treasuryAddress = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')

describe('Borrower Fee Migration', () => {
    let treasuryCode: Cell
    let deployedCode: Cell
    let migratorCode: Cell

    let governor: Address
    let halter: Address

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        // The upgrade has to start from the code that is actually on chain, not from anything built
        // out of this tree: upgrade_code unpacks the extension before handing over to the migrator,
        // and it must do that with the OLD parser. Starting from the new code fails on the old
        // extension with exit 9 and proves nothing.
        //
        // That is the captured mainnet code, byte for byte. Compiling "the previous version" from git
        // was the earlier approach and is a trap -- it means "before my uncommitted changes", which
        // silently stops being true the moment the change is committed.
        deployedCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-2026-09-05-code.boc'))[0]
        migratorCode = await compile('upgrade-code-test/AddBorrowerFee')
        // Distinct from treasuryAddress: upgrade_data replies with gas_excess to the caller, and a
        // treasury addressed to itself would reject its own reply as an unknown op.
        governor = Address.parse('EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w')
        halter = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')
    })

    // ---- the layout as it exists on chain today -------------------------------------------------

    interface OldRequest {
        minPayment: bigint
        borrowerRewardShare: bigint // 8 bits, out of 255
        loanAmount: bigint
        accrueAmount: bigint
        stakeAmount: bigint
        newStakeMsg: Cell
    }

    const oldRequestValue = {
        serialize: (src: OldRequest, b: ReturnType<typeof beginCell>) => {
            b.storeCoins(src.minPayment)
                .storeUint(src.borrowerRewardShare, 8)
                .storeCoins(src.loanAmount)
                .storeCoins(src.accrueAmount)
                .storeCoins(src.stakeAmount)
                .storeRef(src.newStakeMsg)
        },
        parse: (): OldRequest => {
            throw new Error('write-only')
        },
    }

    // Mirrors request_sort_key before the widening: share at 8 bits, key at 112.
    function oldSortKey(minPayment: bigint, borrowerRewardShare: bigint, loanAmount: bigint): bigint {
        const treasuryRewardShare = 255n - borrowerRewardShare
        const minPaymentRound = minPayment >> 30n
        const loanAmountRound = loanAmount >> 40n > 0n ? loanAmount >> 40n : 1n
        const comp = (1n << 80n) - loanAmountRound
        const raw = (minPaymentRound * 1000n) / loanAmountRound
        const efficiency = raw < (1n << 24n) - 1n ? raw : (1n << 24n) - 1n
        return (efficiency << (8n + 80n)) + (treasuryRewardShare << 80n) + comp
    }

    // Mirrors request_sort_key after the widening: share at 16 bits, key at 120. Independent of the
    // contract and of the migrator, so agreeing with both means something.
    function newSortKey(minPayment: bigint, borrowerRewardShare: bigint, loanAmount: bigint): bigint {
        const treasuryRewardShare = 65535n - borrowerRewardShare
        const minPaymentRound = minPayment >> 30n
        const loanAmountRound = loanAmount >> 40n > 0n ? loanAmount >> 40n : 1n
        const comp = (1n << 80n) - loanAmountRound
        const raw = (minPaymentRound * 1000n) / loanAmountRound
        const efficiency = raw < (1n << 24n) - 1n ? raw : (1n << 24n) - 1n
        return (efficiency << (16n + 80n)) + (treasuryRewardShare << 80n) + comp
    }

    const emptyNewStakeMsg = beginCell()
        .storeUint(0, 256 + 32 + 32 + 256)
        .storeRef(beginCell().storeUint(0, 512).endCell())
        .endCell()

    function oldRequest(minPayment: string, share: bigint, loanAmount: string): OldRequest {
        return {
            minPayment: toNano(minPayment),
            borrowerRewardShare: share,
            loanAmount: toNano(loanAmount),
            accrueAmount: 0n,
            stakeAmount: toNano('1000'),
            newStakeMsg: emptyNewStakeMsg,
        }
    }

    // Two borrowers with different bids, so ordering has something to order.
    const borrowerA = 0x1111111111111111111111111111111111111111111111111111111111111111n
    const borrowerB = 0x2222222222222222222222222222222222222222222222222222222222222222n
    const bidA = oldRequest('50', 102n, '300000') // 40% under the old scale
    const bidB = oldRequest('80', 8n, '900000') // 3.1%, what mainnet actually bids

    function oldRequestDict(entries: [bigint, OldRequest][]) {
        const d = Dictionary.empty(Dictionary.Keys.BigUint(256), oldRequestValue)
        for (const [addr, r] of entries) d.set(addr, r)
        return d
    }

    function oldParticipation(opts: { state: number; open: boolean }): Cell {
        const requests = opts.open ? oldRequestDict([[borrowerA, bidA], [borrowerB, bidB]]) : null
        const staked = opts.open ? null : oldRequestDict([[borrowerA, bidA], [borrowerB, bidB]])

        // sorted is only populated while the round is open, keyed at the old 112 bits
        const sorted = Dictionary.empty(Dictionary.Keys.BigUint(112), sortedDictionaryValue)
        if (opts.open) {
            for (const [addr, r] of [
                [borrowerA, bidA],
                [borrowerB, bidB],
            ] as [bigint, OldRequest][]) {
                const bucket = Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue)
                bucket.set(addr, Buffer.from([]))
                sorted.set(oldSortKey(r.minPayment, r.borrowerRewardShare, r.loanAmount), bucket)
            }
        }

        const b = beginCell()
            .storeUint(opts.state, 4)
            .storeUint(2, 16)
            .storeDict(sorted)
            .storeDict(requests)
            .storeDict(null) // rejected
            .storeDict(null) // accepted
            .storeDict(null) // accrued
            .storeDict(staked)
            .storeDict(null) // recovering
            .storeCoins(toNano('4000000'))
            .storeCoins(0)
            .storeUint(0, 256)
            .storeUint(65536, 32)
            .storeUint(0, 32)
        return b.endCell()
    }

    function oldStorage(): Cell {
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), {
            serialize: (src: Cell, b: ReturnType<typeof beginCell>) => b.storeSlice(src.beginParse()),
            parse: (): Cell => {
                throw new Error('write-only')
            },
        })
        participations.set(1000n, oldParticipation({ state: 2, open: false })) // staked
        participations.set(2000n, oldParticipation({ state: 0, open: true })) // open, has sorted

        // extension, pre-borrower-fee: no uint16 after governance_fee
        const codes = Dictionary.empty(Dictionary.Keys.BigUint(32), {
            serialize: (src: Cell, b: ReturnType<typeof beginCell>) => b.storeRef(src),
            parse: (): Cell => {
                throw new Error('write-only')
            },
        })
        codes.set(0n, beginCell().endCell())
        const extension = beginCell()
            .storeCoins(1_000_000_000n)
            .storeCoins(1_160_000_000n)
            .storeAddress(halter)
            .storeAddress(governor)
            .storeMaybeRef(null)
            .storeUint(0, 16) // governance_fee
            .storeRef(beginCell().storeDictDirect(codes))
            .storeRef(beginCell().storeDictDirect(codes))
            .storeDict(null)
            .endCell()

        return beginCell()
            .storeCoins(toNano('8000000'))
            .storeCoins(toNano('6900000'))
            .storeCoins(0)
            .storeCoins(0)
            .storeCoins(toNano('2000'))
            .storeCoins(0) // deficit, already migrated
            .storeAddress(halter)
            .storeDict(participations)
            .storeUint(128, 8)
            .storeBit(false)
            .storeBit(true)
            .storeRef(beginCell().storeDictDirect(codes))
            .storeRef(extension)
            .endCell()
    }

    async function stand(code: Cell) {
        const blockchain = await Blockchain.create()
        await blockchain.setShardAccount(
            treasuryAddress,
            createShardAccount({
                workchain: 0,
                address: treasuryAddress,
                code,
                data: oldStorage(),
                balance: toNano('100'),
            }),
        )
        return { blockchain, treasury: blockchain.openContract(Treasury.createFromAddress(treasuryAddress)) }
    }

    async function migrated() {
        const { blockchain, treasury } = await stand(deployedCode)
        const result = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: '0.1',
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        expect(result.transactions).not.toHaveTransaction({ to: treasuryAddress, success: false })
        return { blockchain, treasury }
    }

    // ---- what the migration has to produce ------------------------------------------------------

    it('should leave the fee disabled, so the upgrade alone changes no economics', async () => {
        const { treasury } = await migrated()
        const state = await treasury.getTreasuryState()
        expect(state.borrowerFee).toEqual(0n)
        expect(state.governanceFee).toEqual(0n)
    })

    it('should preserve every root and extension field it does not own', async () => {
        const { treasury } = await migrated()
        const state = await treasury.getTreasuryState()
        expect(state.totalCoins).toEqual(toNano('8000000'))
        expect(state.totalTokens).toEqual(toNano('6900000'))
        expect(state.totalBorrowersStake).toEqual(toNano('2000'))
        expect(state.governor.toString()).toEqual(governor.toString())
        expect(state.halter.toString()).toEqual(halter.toString())
        expect(state.currentRate).toEqual(1_160_000_000n)
        expect(state.roundsImbalance).toEqual(128n)
    })

    it('should carry every request across at the widened share and an untaxed rate', async () => {
        const { treasury } = await migrated()

        // The loans in flight were committed before the fee existed, so they must recover untaxed
        // whatever borrower_fee is set to afterwards.
        for (const [round, dict] of [
            [1000n, 'staked'],
            [2000n, 'requests'],
        ] as [bigint, 'staked' | 'requests'][]) {
            const p = await treasury.getParticipation(round)
            const requests = p[dict]
            expect(requests?.size).toEqual(2)

            const a = requests?.get(borrowerA)
            expect(a?.borrowerRewardShare).toEqual(102n * 257n)
            expect(a?.requestFee).toEqual(0n)
            expect(a?.minPayment).toEqual(toNano('50'))
            expect(a?.loanAmount).toEqual(toNano('300000'))
            expect(a?.stakeAmount).toEqual(toNano('1000'))

            const b = requests?.get(borrowerB)
            expect(b?.borrowerRewardShare).toEqual(8n * 257n)
            expect(b?.requestFee).toEqual(0n)
            expect(b?.minPayment).toEqual(toNano('80'))
        }
    })

    it('should map shares so the economics of an in-flight loan do not move', async () => {
        const { treasury } = await migrated()
        const p = await treasury.getParticipation(1000n)
        const a = p.staked?.get(borrowerA)

        // 255 * 257 = 65535 exactly, so share/255 and (share * 257)/65535 are the same rational
        // number and treasury_reward is unchanged for the same reward.
        expect((a?.borrowerRewardShare ?? 0n) * 255n).toEqual(102n * 65535n)
    })

    it('should rebuild sorted at the new key width', async () => {
        const { treasury } = await migrated()
        const p = await treasury.getParticipation(2000n)
        const sorted = p.sorted

        expect(sorted?.size).toEqual(2)
        const keys = sorted?.keys() ?? []
        for (const k of keys) expect(k).toBeLessThan(1n << 120n)

        // Derived independently of both contract and migrator.
        const expected = [
            newSortKey(bidA.minPayment, bidA.borrowerRewardShare * 257n, bidA.loanAmount),
            newSortKey(bidB.minPayment, bidB.borrowerRewardShare * 257n, bidB.loanAmount),
        ].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
        expect(keys).toEqual(expected)

        // Each key still points at the borrower whose bid produced it.
        for (const [addr, r] of [
            [borrowerA, bidA],
            [borrowerB, bidB],
        ] as [bigint, OldRequest][]) {
            const key = newSortKey(r.minPayment, r.borrowerRewardShare * 257n, r.loanAmount)
            expect(sorted?.get(key)?.has(addr)).toBe(true)
        }
    })

    it('should produce records identical to ones the contract packs itself', async () => {
        // The migrator carries its own copy of the request layout because it cannot call
        // pack_request. This is the check that the two have not drifted: re-serialising the migrated
        // record through the wrapper's codec must reproduce it bit for bit.
        const { treasury } = await migrated()
        const p = await treasury.getParticipation(1000n)
        const a = p.staked?.get(borrowerA)
        if (a == null) throw new Error('missing request')

        const repacked = beginCell()
        requestDictionaryValue.serialize(a, repacked)
        const fresh = beginCell()
        requestDictionaryValue.serialize(
            {
                minPayment: toNano('50'),
                borrowerRewardShare: 102n * 257n,
                loanAmount: toNano('300000'),
                accrueAmount: 0n,
                stakeAmount: toNano('1000'),
                requestFee: 0n,
                newStakeMsg: emptyNewStakeMsg,
            },
            fresh,
        )
        expect(repacked.endCell().hash().toString('hex')).toEqual(fresh.endCell().hash().toString('hex'))
    })

    it('should throw and revert the whole upgrade when run a second time', async () => {
        // The end_parse() calls are the re-run guard: against storage already in the new layout the
        // request parses have bits left over. Without this a second upgrade would silently double
        // the shares.
        const { blockchain, treasury } = await migrated()
        const before = await treasury.getTreasuryState()

        const again = await treasury.sendUpgradeCode(blockchain.sender(governor), {
            value: '0.1',
            newCode: treasuryCode,
            migrateCode: migratorCode,
        })
        expect(again.transactions).toHaveTransaction({ to: treasuryAddress, success: false })

        const after = await treasury.getTreasuryState()
        expect(after.totalCoins).toEqual(before.totalCoins)
        const p = await treasury.getParticipation(1000n)
        expect(p.staked?.get(borrowerA)?.borrowerRewardShare).toEqual(102n * 257n)
    })

    // ---- the same migration, against the bytes actually on chain ---------------------------------
    //
    // The synthetic cases above cover paths mainnet does not currently exhibit -- a populated
    // `sorted`, requests still pending -- but the whole risk of a migration is that the deployed
    // layout is not what it assumes. This replays the real account: code and storage captured from
    // the treasury on 2026-09-05 at lt 101503764000014.
    describe('against captured mainnet state', () => {
        const mainnetAddress = Address.parse('EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ')

        let mainnetCode: Cell
        let mainnetData: Cell

        beforeAll(() => {
            mainnetCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-2026-09-05-code.boc'))[0]
            mainnetData = Cell.fromBoc(readFileSync(__dirname + '/fixtures/treasury-mainnet-2026-09-05-state.boc'))[0]
        })

        // Participations and the request dicts inside them are stored inline, not as refs.
        const inlineSlice: DictionaryValue<Slice> = {
            serialize: () => {
                throw new Error('read-only')
            },
            parse: (src: Slice) => {
                const copy = src.clone()
                src.skip(src.remainingBits)
                while (src.remainingRefs > 0) src.loadRef()
                return copy
            },
        }

        // Reads the shares the deployed treasury is actually holding, on the old 0-255 scale, so the
        // assertions below compare against real bids rather than numbers written into this file.
        function sharesBefore(): Map<string, number> {
            const s = mainnetData.beginParse()
            for (let i = 0; i < 6; i++) s.loadCoins()
            s.loadAddress()
            const participations = s.loadMaybeRef()
            if (participations == null) throw new Error('no participations in the fixture')

            const out = new Map<string, number>()
            const rounds = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), inlineSlice, participations)
            for (const round of rounds.keys()) {
                const p = rounds.get(round)
                if (p == null) continue
                p.loadUint(4)
                p.loadUint(16)
                // sorted, requests, rejected, accepted, accrued, staked, recovering
                for (let i = 0; i < 5; i++) p.loadMaybeRef()
                const staked = p.loadMaybeRef()
                if (staked == null) continue
                const requests = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), inlineSlice, staked)
                for (const borrower of requests.keys()) {
                    const r = requests.get(borrower)
                    if (r == null) continue
                    r.loadCoins() // min_payment
                    out.set(round.toString() + ':' + borrower.toString(), r.loadUint(8))
                }
            }
            return out
        }

        function mainnetGovernor(): Address {
            const ext = mainnetData.refs[mainnetData.refs.length - 1].beginParse()
            ext.loadCoins()
            ext.loadCoins()
            ext.loadAddress()
            return ext.loadAddress()
        }

        async function migratedMainnet() {
            const blockchain = await Blockchain.create()
            await blockchain.setShardAccount(
                mainnetAddress,
                createShardAccount({
                    workchain: 0,
                    address: mainnetAddress,
                    code: mainnetCode,
                    data: mainnetData,
                    balance: toNano('100'),
                }),
            )
            const treasury = blockchain.openContract(Treasury.createFromAddress(mainnetAddress))
            const result = await treasury.sendUpgradeCode(blockchain.sender(mainnetGovernor()), {
                value: '0.1',
                newCode: treasuryCode,
                migrateCode: migratorCode,
            })
            // The gas_excess refund is addressed to the real governor, which is not an account in this
            // sandbox, so it lands uninitialised and reports as aborted. Judge the treasury only.
            expect(result.transactions).not.toHaveTransaction({ to: mainnetAddress, success: false })
            return { blockchain, treasury }
        }

        it('should not be the code this upgrade releases', () => {
            // The point of the capture is to be the OTHER side of the upgrade. If it ever equals the
            // released build, the fixture has been refreshed past the migration it exists to exercise
            // and every assertion below is testing a no-op.
            expect(mainnetCode.hash().toString('hex')).not.toEqual(treasuryCode.hash().toString('hex'))
        })

        it('should be a capture taken before the borrower fee, with requests to convert', () => {
            const shares = sharesBefore()
            expect(shares.size).toBeGreaterThan(0)

            // The extension must still parse under the OLD layout, or the capture is already migrated
            // and proves nothing.
            const ext = mainnetData.refs[mainnetData.refs.length - 1].beginParse()
            ext.loadCoins()
            ext.loadCoins()
            ext.loadAddress()
            ext.loadAddress()
            ext.loadMaybeRef()
            ext.loadUint(16) // governance_fee, and nothing after it but the refs
            ext.loadRef()
            ext.loadRef()
            ext.loadMaybeRef()
            ext.endParse()
        })

        it('should carry the real requests across at share * 257, untaxed', async () => {
            const before = sharesBefore()
            const { treasury } = await migratedMainnet()

            let checked = 0
            for (const [key, oldShare] of before) {
                const [round, borrower] = key.split(':')
                const participation = await treasury.getParticipation(BigInt(round))
                const request = participation.staked?.get(BigInt(borrower))
                expect(request).toBeDefined()
                // 255 * 257 = 65535, so this is the same rational number and treasury_reward is
                // unchanged for the same reward.
                expect(request?.borrowerRewardShare).toEqual(BigInt(oldShare) * 257n)
                // Committed before the fee existed, so they must recover untaxed whatever the rate is
                // set to afterwards.
                expect(request?.requestFee).toEqual(0n)
                checked += 1
            }
            expect(checked).toEqual(before.size)
        })

        it('should leave the fee disabled and every other field untouched', async () => {
            const { treasury } = await migratedMainnet()
            const state = await treasury.getTreasuryState()

            expect(state.borrowerFee).toEqual(0n)

            // Read straight from the capture: the pre-upgrade account cannot be read through the
            // wrapper, so these come from the cell.
            const s = mainnetData.beginParse()
            const totalCoins = s.loadCoins()
            const totalTokens = s.loadCoins()
            expect(state.totalCoins).toEqual(totalCoins)
            expect(state.totalTokens).toEqual(totalTokens)
            expect(state.governor.toString()).toEqual(mainnetGovernor().toString())
            expect(state.governanceFee).toEqual(0n)
        })

    })
})
