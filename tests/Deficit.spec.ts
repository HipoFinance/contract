import { compile } from '@ton/blueprint'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { between, bodyOp, logTotalFees, updateFeeConfig } from './helper'
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

// A loan that comes back short by more than the borrower's collateral is pool money that is gone:
// loan_amount + accrue_amount left the balance in process_loan_requests but was never taken out of
// total_coins. The treasury does NOT write total_coins down for it -- the exchange rate only ever
// goes up -- it records the uncovered part in the `deficit` counter and pages the governor, who tops
// the treasury back up and clears the counter with op::set_deficit.
//
// These tests drive recover_stake_result directly, the same synthetic-state technique
// Ordering.spec.ts uses: push the treasury into a state where one borrower is still `recovering`,
// deliver the recover_stake_result its loan contract would send with a chosen repayment amount, and
// assert on deficit, total_coins, current_rate and get_surplus afterwards.
//
// The governance fee is the mainnet 4096/65535 throughout, and every deficit figure below is still an
// exact integer, because a positive shortfall means the collateral was consumed whole -- leaving
// nothing for min_payment, so no treasury_reward and no fee to round. See the note on `settle`.

describe('Deficit', () => {
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
    const roundSince = 0n

    function makeConfig(halterAddress: Address, governorAddress: Address, governanceFee = 4096n): TreasuryConfig {
        return {
            totalCoins: deadShares,
            totalTokens: deadShares,
            totalStaking: 0n,
            totalUnstaking: 0n,
            totalBorrowersStake: 0n,
            parent: null,
            participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
            roundsImbalance: 255n,
            stopped: false,
            instantMint: false,
            loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, loanCode),
            previousRate: 1_000_000_000n,
            currentRate: 1_000_000_000n,
            halter: halterAddress,
            governor: governorAddress,
            proposedGovernor: null,
            governanceFee,
            borrowerFee: 0n,
            collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                0n,
                collectionCode,
            ),
            billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, billCode),
            oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
            deficit: 0n,
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

    interface Loan {
        borrower: Address
        loanAmount: bigint
        accrueAmount: bigint
        stakeAmount: bigint
        minPayment: bigint
    }

    // Builds the `recovering` half of a participation that has been staked and is being recovered:
    // one request per loan, total_staked carrying the pool money that left in process_loan_requests,
    // total_recovered still zero.
    function makeParticipation(loans: Loan[]): { participation: Participation; totalStaked: bigint } {
        const recovering = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        let totalStaked = 0n
        for (const loan of loans) {
            const request: Request = {
                minPayment: loan.minPayment,
                borrowerRewardShare: 0n,
                loanAmount: loan.loanAmount,
                accrueAmount: loan.accrueAmount,
                stakeAmount: loan.stakeAmount,
                requestFee: 0n,
                newStakeMsg: Cell.EMPTY,
            }
            recovering.set(BigInt('0x' + loan.borrower.hash.toString('hex')), request)
            totalStaked += loan.loanAmount + loan.accrueAmount
        }
        return {
            participation: {
                state: ParticipationState.Recovering,
                size: BigInt(loans.length),
                recovering,
                totalStaked,
                totalRecovered: 0n,
            },
            totalStaked,
        }
    }

    // Drops the treasury straight into "round staked, stakes are being recovered" with the given loans
    // outstanding. total_coins and the balance are picked so that the treasury starts at
    // get_surplus() == 0, which is the baseline every surplus assertion below is measured against.
    async function setUp(totalCoins: bigint, loans: Loan[], deficit = 0n): Promise<void> {
        const { participation, totalStaked } = makeParticipation(loans)
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
        participations.set(roundSince, participation)

        const state = await treasury.getTreasuryState()
        state.participations = participations
        state.totalCoins = totalCoins
        state.totalTokens = totalCoins // start at rate 1.0 so any rate move is easy to read
        state.totalBorrowersStake = 0n // collateral already left with the loan in process_loan_requests
        state.currentRate = 1_000_000_000n
        state.previousRate = 1_000_000_000n
        state.deficit = deficit

        // calculate_min_coins() == total_coins - total_staked + total_recovered + size * request_loan_fee
        const balance = totalCoins - totalStaked + BigInt(loans.length) * fees.requestLoanFee
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
        expect(await treasury.getSurplus()).toBeGramValue('0')
        expect(await treasury.getDeficit()).toBeGramValue(deficit)
    }

    // Sends the recover_stake_result that the loan contract for (borrower, roundSince) would send,
    // carrying `repayment` coins. The access check only compares the source against the loan address
    // the treasury derives itself, so impersonating it with blockchain.sender is enough.
    //
    // Note what the treasury computes from this:
    //     reward    = incoming_ton - loan_amount - accrue_amount - stake_amount - recover_stake_fee
    //     shortfall = - reward - min(stake_amount, - reward)
    //               = max(0, loan_amount + accrue_amount + recover_stake_fee - incoming_ton)
    // stake_amount cancels out of the second line, so a shortfall is exactly the gap between what the
    // round lent (plus the recovery fee it set aside) and what came back. It is also why the
    // governance fee can never touch this path: a positive shortfall means the collateral was consumed
    // whole, leaving nothing for min_payment and so no treasury_reward to take a fee out of.
    async function settle(borrower: Address, repayment: bigint) {
        const loanAddress = await treasury.getLoanAddress(borrower, roundSince)
        return treasury.sendMessage(blockchain.sender(loanAddress), {
            value: repayment,
            body: beginCell()
                .storeUint(op.recoverStakeResult, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeAddress(borrower)
                .storeUint(roundSince, 32)
                .endCell(),
        })
    }

    interface External {
        body: Cell
        info: { dest?: unknown }
    }

    function logs(externals: External[], topic: bigint): Cell[] {
        return externals
            .filter((ext) => (ext.info.dest as { value?: bigint } | undefined)?.value === topic)
            .map((ext) => ext.body)
    }

    const repaymentTopic = 0x2n
    const finishTopic = 0x3n
    const deficitTopic = 0x5n

    // log_repayment's repayment_amount field is incoming_ton verbatim, which is the only way to learn
    // the exact value the treasury saw after the sandbox took its forward fee out of `repayment`.
    function incomingTonOf(externals: External[]): bigint {
        const repayment = logs(externals, repaymentTopic)
        expect(repayment).toHaveLength(1)
        const s = repayment[0].beginParse()
        s.loadUint(32)
        return s.loadCoins()
    }

    // recover_stake_fee is a private component of request_loan_fee() -- get_treasury_fees only exposes
    // the total -- so measure it instead of hardcoding it. On an ordinary profitable settlement with
    // borrower_reward_share and governance_fee both zero the whole reward becomes new_coins, so
    //     total_coins delta == reward == incoming_ton - loan - accrue - stake - recover_stake_fee
    // and the fee falls out. It only depends on the gas/fee config, which updateFeeConfig pins, so one
    // measurement holds for the whole file.
    let cachedRecoverStakeFee: bigint | undefined

    async function recoverStakeFee(): Promise<bigint> {
        if (cachedRecoverStakeFee != null) {
            return cachedRecoverStakeFee
        }
        const bc = await Blockchain.create()
        bc.libs = blockchainLibs
        updateFeeConfig(bc)
        const h = await bc.treasury('halter')
        const g = await bc.treasury('governor')
        // governance_fee 0 so that the whole reward lands in new_coins with nothing rounded away
        const t = bc.openContract(Treasury.createFromConfig(makeConfig(h.address, g.address, 0n), treasuryCode))
        const borrower = (await bc.treasury('calibration-borrower')).address

        const loanAmount = toNano('300000')
        const accrueAmount = toNano('400000')
        const stakeAmount = toNano('180')
        const totalCoins = toNano('700010')
        const { participation, totalStaked } = makeParticipation([
            { borrower, loanAmount, accrueAmount, stakeAmount, minPayment: toNano('80') },
        ])
        const participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
        participations.set(roundSince, participation)
        const config = makeConfig(h.address, g.address, 0n)
        config.participations = participations
        config.totalCoins = totalCoins
        config.totalTokens = totalCoins
        await bc.setShardAccount(
            t.address,
            createShardAccount({
                workchain: 0,
                address: t.address,
                code: treasuryCode,
                data: treasuryConfigToCell(config),
                balance: totalCoins - totalStaked,
            }),
        )

        const loanAddress = await t.getLoanAddress(borrower, roundSince)
        const result = await t.sendMessage(bc.sender(loanAddress), {
            value: loanAmount + accrueAmount + stakeAmount + toNano('1000'), // a fat reward
            body: beginCell()
                .storeUint(op.recoverStakeResult, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeAddress(borrower)
                .storeUint(roundSince, 32)
                .endCell(),
        })
        expect(result.transactions).toHaveTransaction({
            to: t.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        expect(logs(result.externals, deficitTopic)).toHaveLength(0)

        const reward = (await t.getTreasuryState()).totalCoins - totalCoins
        cachedRecoverStakeFee = incomingTonOf(result.externals) - loanAmount - accrueAmount - stakeAmount - reward
        expect(cachedRecoverStakeFee).toBeGreaterThan(0n)
        return cachedRecoverStakeFee
    }

    it('leaves the deficit at zero when the collateral covers the miss', async () => {
        // reward < 0 but the borrower's stake absorbs all of it, so nothing is lost by the pool and
        // the treasury still takes min_payment out of what is left of the collateral. This is the
        // pre-existing branch, unchanged: total_coins goes UP, the rate goes UP, no deficit, no log.
        const totalCoins = toNano('700010')
        const loanAmount = toNano('300000')
        const accrueAmount = toNano('400000')
        const stakeAmount = toNano('180')
        const minPayment = toNano('80')
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(totalCoins, [{ borrower, loanAmount, accrueAmount, stakeAmount, minPayment }])

        // 50 GRAM short of principal + accrued: well inside the 180 of collateral, and leaving more
        // than min_payment of it behind so that the treasury takes min_payment in full.
        const result = await settle(borrower, loanAmount + accrueAmount + stakeAmount - toNano('50'))
        expect(result.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })

        const rsf = await recoverStakeFee()
        const incomingTon = incomingTonOf(result.externals)
        const compensation = loanAmount + accrueAmount + stakeAmount + rsf - incomingTon
        expect(compensation).toBeGreaterThan(0n) // reward really was negative
        expect(compensation).toBeLessThan(stakeAmount) // ... and the collateral really did cover it

        const state = await treasury.getTreasuryState()
        expect(await treasury.getDeficit()).toBeGramValue('0')
        expect(logs(result.externals, deficitTopic)).toHaveLength(0)

        // total_coins moved up by exactly min_payment less the governance fee, which is the whole of
        // the pre-existing behaviour on this branch.
        const governanceShare = (minPayment * 4096n) / 65535n
        expect(state.totalCoins).toBeGramValue(totalCoins + minPayment - governanceShare)
        expect(state.totalTokens).toBeGramValue(totalCoins)
        expect(state.currentRate).toEqual((state.totalCoins * 1_000_000_000n) / state.totalTokens)
        expect(state.currentRate).toBeGreaterThan(1_000_000_000n)

        // what is left of the collateral goes back to the borrower, less the forward fee
        const returned = stakeAmount - compensation - minPayment
        expect(returned).toBeGreaterThan(0n)
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: borrower,
            body: bodyOp(op.loanResult),
            value: between(returned - toNano('0.01'), returned),
        })
    })

    it('records the uncovered part of a loss that exceeds the collateral', async () => {
        const totalCoins = toNano('700010')
        const loanAmount = toNano('300000')
        const accrueAmount = toNano('400000')
        const stakeAmount = toNano('180')
        const repayment = toNano('200000') // the elector returned less than a third of the stake
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(totalCoins, [{ borrower, loanAmount, accrueAmount, stakeAmount, minPayment: toNano('80') }])

        const result = await settle(borrower, repayment)
        expect(result.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
            exitCode: 0,
        })
        expect(result.transactions).not.toHaveTransaction({ inMessageBounced: true })
        // the collateral is consumed whole, so the borrower gets nothing back
        expect(result.transactions).not.toHaveTransaction({ body: bodyOp(op.loanResult) })

        const rsf = await recoverStakeFee()
        const incomingTon = incomingTonOf(result.externals)
        // reward == incoming_ton - loan - accrue - stake - recover_stake_fee, compensation == stake
        const expectedDeficit = loanAmount + accrueAmount + rsf - incomingTon
        expect(expectedDeficit).toBeGreaterThan(0n)

        const deficit = await treasury.getDeficit()
        expect(deficit).toEqual(expectedDeficit)
        expect(deficit).toBeBetween(toNano('499990'), toNano('500010')) // ~ 700000 lent, 200000 back

        // the whole point: the rate does not move, and total_coins keeps its full claim
        const state = await treasury.getTreasuryState()
        expect(state.totalCoins).toBeGramValue(totalCoins)
        expect(state.totalTokens).toBeGramValue(totalCoins)
        expect(state.currentRate).toBe(1_000_000_000n)
        expect(state.previousRate).toBe(1_000_000_000n)

        // get_surplus is what actually reports the missing cash, and it does so without any help from
        // the deficit counter -- calculate_min_coins never looks at it, so there is no double count.
        // The two agree up to the request_loan_fee this settled round released back to the balance
        // minus the gas the settlement burned, which is the same small slack a healthy settlement
        // leaves behind.
        const surplus = await treasury.getSurplus()
        expect(surplus).toBeLessThan(0n)
        expect(surplus + deficit).toBeGreaterThan(0n)
        expect(surplus + deficit).toBeLessThan(fees.requestLoanFee + rsf)

        const deficitLogs = logs(result.externals, deficitTopic)
        expect(deficitLogs).toHaveLength(1)
        const log = deficitLogs[0].beginParse()
        expect(log.loadUint(32)).toEqual(Number(roundSince))
        expect(log.loadCoins()).toBeGramValue(loanAmount)
        expect(log.loadCoins()).toBeGramValue(accrueAmount)
        expect(log.loadCoins()).toEqual(incomingTon)
        expect(log.loadCoins()).toEqual(expectedDeficit) // shortfall
        expect(log.loadCoins()).toEqual(deficit) // running total after this loan
        expect(log.loadAddress().toString()).toEqual(borrower.toString())
        expect(log.remainingBits).toEqual(0)
    })

    it('accumulates two successive over-collateral losses', async () => {
        const totalCoins = toNano('700010')
        const loanAmount = toNano('300000')
        const stakeAmount = toNano('180')
        const first = (await blockchain.treasury('first')).address
        const second = (await blockchain.treasury('second')).address
        await setUp(totalCoins, [
            { borrower: first, loanAmount, accrueAmount: 0n, stakeAmount, minPayment: toNano('80') },
            { borrower: second, loanAmount, accrueAmount: 0n, stakeAmount, minPayment: toNano('80') },
        ])

        const rsf = await recoverStakeFee()

        const result1 = await settle(first, toNano('100000'))
        expect(result1.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        const shortfall1 = loanAmount + rsf - incomingTonOf(result1.externals)
        const deficit1 = await treasury.getDeficit()
        expect(deficit1).toEqual(shortfall1)

        const result2 = await settle(second, toNano('50000'))
        expect(result2.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        const shortfall2 = loanAmount + rsf - incomingTonOf(result2.externals)
        expect(shortfall2).toBeGreaterThan(shortfall1) // the second borrower defaulted harder

        const deficit2 = await treasury.getDeficit()
        expect(deficit2).toEqual(shortfall1 + shortfall2)
        expect(deficit2).toBeBetween(toNano('449990'), toNano('450010')) // 600000 lent, 150000 back

        // and the second log carries the running total, not just its own loan's shortfall
        const log = logs(result2.externals, deficitTopic)[0].beginParse()
        log.loadUint(32)
        log.loadCoins()
        log.loadCoins()
        log.loadCoins()
        expect(log.loadCoins()).toEqual(shortfall2)
        expect(log.loadCoins()).toEqual(deficit2)

        // the rate still has not moved, and the surplus carries the whole loss
        const state = await treasury.getTreasuryState()
        expect(state.totalCoins).toBeGramValue(totalCoins)
        expect(state.currentRate).toBe(1_000_000_000n)
        const surplus = await treasury.getSurplus()
        expect(surplus + deficit2).toBeGreaterThan(0n)
        expect(surplus + deficit2).toBeLessThan(2n * (fees.requestLoanFee + rsf))
    })

    it('lets the governor set the deficit and rejects everyone else', async () => {
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(toNano('700010'), [
            {
                borrower,
                loanAmount: toNano('300000'),
                accrueAmount: toNano('400000'),
                stakeAmount: toNano('180'),
                minPayment: toNano('80'),
            },
        ])
        await settle(borrower, toNano('200000'))
        expect(await treasury.getDeficit()).toBeGreaterThan(0n)

        // the halter may flip instant_mint and stopped, but not this
        const halterResult = await treasury.sendSetDeficit(halter.getSender(), { value: '0.1', newDeficit: 0n })
        expect(halterResult.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            body: bodyOp(op.setDeficit),
            success: false,
            exitCode: 103, // err::access_denied
        })
        expect(await treasury.getDeficit()).toBeGreaterThan(0n)

        const strangerResult = await treasury.sendSetDeficit((await blockchain.treasury('stranger')).getSender(), {
            value: '0.1',
            newDeficit: 0n,
        })
        expect(strangerResult.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.setDeficit),
            success: false,
            exitCode: 103,
        })
        expect(await treasury.getDeficit()).toBeGreaterThan(0n)

        // the governor sets an absolute value: first a partial top-up, then a full clear
        const partial = await treasury.sendSetDeficit(governor.getSender(), {
            value: '0.1',
            newDeficit: toNano('123.456'),
        })
        expect(partial.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.setDeficit),
            success: true,
        })
        expect(partial.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            body: bodyOp(op.gasExcess),
            success: true,
        })
        expect(await treasury.getDeficit()).toBeGramValue(toNano('123.456'))

        const cleared = await treasury.sendSetDeficit(governor.getSender(), { value: '0.1', newDeficit: 0n })
        expect(cleared.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.setDeficit),
            success: true,
        })
        expect(await treasury.getDeficit()).toBeGramValue('0')

        // ... and the rest of the extension survived the round trip
        const state = await treasury.getTreasuryState()
        expect(state.governor.toString()).toEqual(governor.address.toString())
        expect(state.halter.toString()).toEqual(halter.address.toString())
        expect(state.governanceFee).toBe(4096n)
        expect(state.currentRate).toBe(1_000_000_000n)
    })

    it('still burns the round after a deficit event', async () => {
        // The failure mode worth guarding against is a wedge: a shortfall that leaves the round stuck
        // in `recovering` with its bills unburnable and every deferred deposit of that round frozen.
        // Here the round is the last one outstanding, so settling it runs the whole tail of the
        // lifecycle in one chain -- ready_to_burn, burn_all to the collection, last_bill_burned back,
        // log_finish, and the round dropped from participations.
        const totalCoins = toNano('700010')
        const borrower = (await blockchain.treasury('borrower')).address
        await setUp(totalCoins, [
            {
                borrower,
                loanAmount: toNano('300000'),
                accrueAmount: toNano('400000'),
                stakeAmount: toNano('180'),
                minPayment: toNano('80'),
            },
        ])

        const collection = await treasury.getCollectionAddress(roundSince)
        const result = await settle(borrower, toNano('200000'))
        expect(result.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        expect(result.transactions).not.toHaveTransaction({ inMessageBounced: true })
        expect(result.transactions).not.toHaveTransaction({ success: false })

        expect(await treasury.getDeficit()).toBeGreaterThan(0n)

        // burn_ready_participations moved the round past ready_to_burn and sent the collection its
        // burn_all; the collection had no bills left to burn, so it reported straight back.
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collection,
            body: bodyOp(op.burnAll),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: collection,
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
        })
        expect(logs(result.externals, finishTopic)).toHaveLength(1)

        const state = await treasury.getTreasuryState()
        expect(state.participations.size).toEqual(0)
        expect(state.totalCoins).toBeGramValue(totalCoins)
        expect(state.currentRate).toBe(1_000_000_000n)
        // ... and the round's own bookkeeping did not clobber the counter on the way out
        const rsf = await recoverStakeFee()
        expect(await treasury.getDeficit()).toEqual(
            toNano('300000') + toNano('400000') + rsf - incomingTonOf(result.externals),
        )
    })
})
