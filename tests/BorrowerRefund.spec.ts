import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import {
    accumulateFees,
    between,
    bodyOp,
    createNewStakeMsg,
    createVset,
    getElector,
    logTotalFees,
    setConfig,
    updateFeeConfig,
} from './helper'
import { config, op } from '../wrappers/common'
import { Loan } from '../wrappers/Loan'
import {
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    requestDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

// recover_stake_result settles a loan by reserving what the treasury keeps and paying out the rest:
// the borrower's collateral goes out as loan_result and whatever is left of the round's fee budget
// goes to the governor as take_profit. The negative-reward branch used to reserve the incoming value
// minus the borrower's share minus the governance fee, which leaves only the governance fee to cover
// this transaction's gas and its two outgoing messages. governance_fee is 0 on mainnet, so there was
// nothing to cover them: loan_result failed with "not enough funds", send::ignore_errors skipped it
// silently, and take_profit's send::unreserved_balance swept the borrower's collateral to the
// governor. These tests pin the refund down at governance_fee = 0 and at a non-zero fee, and cover
// the two branches of the max(0, ...) clamp that keeps a total loss from wedging the round.

describe('BorrowerRefund', () => {
    let electorCode: Cell
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
        electorCode = await compile('elector-test/Elector')
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
    let electorAddress: Address
    const deadShares = toNano('10')

    // Same fixture as tests/Loan.spec.ts, except that governance_fee is a parameter: the whole point
    // of these tests is what happens when it is zero, which is its value on mainnet.
    async function deploy(governanceFee: bigint) {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        updateFeeConfig(blockchain)
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
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
                    governanceFee,
                    borrowerFee: 0n,
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
        expect(await treasury.getBalance()).toBeGramValue('10')

        electorAddress = getElector(blockchain)
    }

    // Every take_profit the governor received, in GRAM. This is where the borrower's collateral used
    // to end up, so each test pins down both the refunds and what was left over for the governor.
    function takeProfitValues(result: SendMessageResult): bigint[] {
        return result.transactions
            .filter(
                (tx) =>
                    tx.inMessage?.info.type === 'internal' &&
                    tx.inMessage.info.src.toString() === treasury.address.toString() &&
                    tx.inMessage.info.dest.toString() === governor.address.toString() &&
                    bodyOp(op.takeProfit)(tx.inMessage.body),
            )
            .map((tx) => (tx.inMessage?.info.type === 'internal' ? tx.inMessage.info.value.coins : 0n))
    }

    interface Round {
        roundSince: bigint
        borrower2: SandboxContract<TreasuryContract>
        borrower3: SandboxContract<TreasuryContract>
        loan2: SandboxContract<Loan>
        loan3: SandboxContract<Loan>
        collectionAddress: Address
    }

    // Deposits 700000, then puts three loan requests in. Only two of them fit, so the round stakes
    // 300000 + 50000 accrued against 161 and 171 of collateral respectively -- the same shape as
    // 'should finish participation' in tests/Loan.spec.ts. electAt decides what the elector does with
    // the new stake: pass 0n to have it bounce the stake straight back (an instant rejection), or the
    // round's roundSince to have it accept and hold the stake until it is recovered.
    async function participate(electAt: (roundSince: bigint) => bigint): Promise<Round> {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since1, until1))

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: electAt(until1) }) }),
                balance: toNano('1'),
            }),
        )

        const borrower1 = await blockchain.treasury('borrower1')
        const borrower2 = await blockchain.treasury('borrower2')
        const borrower3 = await blockchain.treasury('borrower3')
        const loan1 = blockchain.openContract(
            Loan.createFromAddress(await treasury.getLoanAddress(borrower1.address, until1)),
        )
        const loan2 = blockchain.openContract(
            Loan.createFromAddress(await treasury.getLoanAddress(borrower2.address, until1)),
        )
        const loan3 = blockchain.openContract(
            Loan.createFromAddress(await treasury.getLoanAddress(borrower3.address, until1)),
        )
        await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 26214n, // 40%
            newStakeMsg: await createNewStakeMsg(loan1.address, until1),
        })
        await treasury.sendRequestLoan(borrower2.getSender(), {
            value: toNano('161') + fees.requestLoanFee, // 101 (max punishment) + 60 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            borrowerRewardShare: 26214n, // 40%
            newStakeMsg: await createNewStakeMsg(loan2.address, until1),
        })
        await treasury.sendRequestLoan(borrower3.getSender(), {
            value: toNano('171') + fees.requestLoanFee, // 101 (max punishment) + 70 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            borrowerRewardShare: 26214n, // 40%
            newStakeMsg: await createNewStakeMsg(loan3.address, until1),
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        setConfig(blockchain, config.currentValidators, createVset(since2, since2 + electedFor))
        setConfig(blockchain, config.nextValidators, null)

        return {
            roundSince: until1,
            borrower2,
            borrower3,
            loan2,
            loan3,
            collectionAddress: await treasury.getCollectionAddress(until1),
        }
    }

    // Walks the round through validation and hands the elector the two amounts it will return when
    // the stakes are recovered. Anything below 350161 / 350171 is a loss for that borrower.
    async function recoverWithCredits(round: Round, credit2: bigint, credit3: bigint) {
        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + round.loan2.address.hash.toString('hex')), credit2)
        credits.set(BigInt('0x' + round.loan3.address.hash.toString('hex')), credit3)
        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({
                    currentElection: createElectionConfig({ electAt: round.roundSince }),
                    credits,
                }),
                balance: credit2 + credit3 + toNano('1'),
            }),
        )

        setConfig(blockchain, config.currentValidators, createVset(0n, 1n))
        await treasury.sendVsetChanged({ roundSince: round.roundSince })
        setConfig(blockchain, config.currentValidators, createVset(1n, 2n))
        await treasury.sendVsetChanged({ roundSince: round.roundSince })

        // release the stake-held timer the same way tests/Loan.spec.ts does
        const state = await treasury.getTreasuryState()
        const participation = state.participations.get(round.roundSince) ?? {}
        participation.stakeHeldUntil = 0n
        state.participations.set(round.roundSince, participation)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: toNano('10'),
            }),
        )

        return treasury.sendFinishParticipation({ roundSince: round.roundSince })
    }

    it('should refund the borrower when governance_fee is zero', async () => {
        await deploy(0n)
        const round = await participate(() => 0n) // elector rejects the new stake instantly
        const result = await treasury.sendParticipateInElection({ roundSince: round.roundSince })

        // Both stakes come straight back, so the round settles at a small loss: the treasury advanced
        // recover_stake_fee and only the unspent part of proxy_new_stake_fee came back with the
        // stake. The collateral covers the ~0.02 difference, then min_payment is taken, so borrower2
        // keeps 161 - 0.02 - 60 and borrower3 keeps 171 - 0.02 - 70 -- the same 100.978 each. Before
        // the fix neither refund was sent at all.
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: round.borrower2.address,
            value: between('100.9', '101'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: round.borrower3.address,
            value: between('100.9', '101'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })

        // With no governance fee the only thing left for the governor is the unspent remainder of
        // recover_stake_fee (0.2878), minus this transaction's gas and messages. Before the fix these
        // two carried 100.976 and 100.973 instead -- the borrowers' collateral.
        const takeProfits = takeProfitValues(result)
        expect(takeProfits).toHaveLength(2)
        for (const value of takeProfits) {
            expect(value).toBeBetween('0.28', '0.29')
        }

        // no action was skipped: every send in recover_stake_result went through
        for (const tx of result.transactions) {
            if (tx.description.type === 'generic' && tx.description.actionPhase != null) {
                expect(tx.description.actionPhase.skippedActions).toBe(0)
            }
        }

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size).toEqual(0)
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('700000'))

        accumulateFees(result.transactions)
    })

    it('should refund the borrower when governance_fee is not zero', async () => {
        await deploy(4096n)
        const round = await participate(() => 0n) // elector rejects the new stake instantly
        const result = await treasury.sendParticipateInElection({ roundSince: round.roundSince })

        // The refunds are the same as at governance_fee = 0: the governance fee is carved out of the
        // treasury's min_payment, never out of the borrower's collateral.
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: round.borrower2.address,
            value: between('100.9', '101'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: round.borrower3.address,
            value: between('100.9', '101'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })

        // 60 * 4096 / 65535 = 3.7499 and 70 * 4096 / 65535 = 4.3749 of governance fee, each now
        // joined by the 0.2878 of recover_stake_fee that the branch used to keep reserved. That
        // 0.2878 is the only thing the fix changes here: it used to leave through withdraw_surplus
        // once the round was gone instead of through take_profit.
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('4.03', '4.04'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('4.65', '4.66'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size).toEqual(0)
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should settle a loss larger than the collateral without paying the borrower', async () => {
        await deploy(0n)
        const round = await participate((roundSince) => roundSince)
        await treasury.sendParticipateInElection({ roundSince: round.roundSince })

        // 349000 back against 350161 / 350171 staked: the loss is over 1000, far more than the 161 /
        // 171 of collateral, so the whole collateral is taken and there is nothing left to refund.
        const result = await recoverWithCredits(round, toNano('349000'), toNano('349000'))

        expect(result.transactions).toHaveTransaction({
            from: round.loan2.address,
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: round.loan3.address,
            to: treasury.address,
            body: bodyOp(op.recoverStakeResult),
            success: true,
        })
        expect(result.transactions).not.toHaveTransaction({ to: round.borrower2.address, body: bodyOp(op.loanResult) })
        expect(result.transactions).not.toHaveTransaction({ to: round.borrower3.address, body: bodyOp(op.loanResult) })

        // the whole fee budget is the governor's, since neither the treasury nor the borrower earned
        // anything on a round that lost money
        const takeProfits = takeProfitValues(result)
        expect(takeProfits).toHaveLength(2)
        for (const value of takeProfits) {
            expect(value).toBeBetween('0.28', '0.29')
        }

        // the round still gets through the barrier and its bills still burn
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: round.collectionAddress,
            body: bodyOp(op.burnAll),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: round.collectionAddress,
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
        })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size).toEqual(0)
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('700000'))

        accumulateFees(result.transactions)
    })

    it('should settle without throwing when less than recover_stake_fee comes back', async () => {
        // The elector always leaves the loan the 1 GRAM it sends to confirm a new_stake, so a stake it
        // returns in full carries far more than recover_stake_fee back here -- an elector that credits
        // nothing still repays about 1.14. What can drain that 1 GRAM is masterchain storage on a round
        // that stays open far longer than loan_storage_fee budgeted for, and then incoming_ton lands
        // below recover_stake_fee. reserve_amount would go negative, raw_reserve would throw, and
        // recover_stake_result is non-bounceable, so nothing would retry: the round would sit in
        // recovering forever while owes_reward? blocked every later round from burning its bills.
        // Drive that amount in directly, from the loan address the treasury derives itself.
        await deploy(0n)
        const borrower = await blockchain.treasury('borrower')
        const roundSince = 0n

        const recovering = Dictionary.empty(Dictionary.Keys.BigUint(256), requestDictionaryValue)
        recovering.set(BigInt('0x' + borrower.address.hash.toString('hex')), {
            minPayment: toNano('60'),
            borrowerRewardShare: 26214n,
            loanAmount: toNano('300000'),
            accrueAmount: toNano('50000'),
            stakeAmount: toNano('161'),
            requestFee: 0n,
            newStakeMsg: Cell.EMPTY,
        })
        const state = await treasury.getTreasuryState()
        state.participations.set(roundSince, { state: ParticipationState.Recovering, size: 1n, recovering })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: toNano('10'),
            }),
        )

        const loanAddress = await treasury.getLoanAddress(borrower.address, roundSince)
        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const incoming = toNano('0.2') // recover_stake_fee is 0.2878
        const result = await treasury.sendMessage(blockchain.sender(loanAddress), {
            value: incoming,
            body: beginCell()
                .storeUint(op.recoverStakeResult, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeAddress(borrower.address)
                .storeUint(roundSince, 32)
                .endCell(),
        })

        expect(result.transactions).toHaveTransaction({
            from: loanAddress,
            to: treasury.address,
            value: incoming,
            body: bodyOp(op.recoverStakeResult),
            success: true,
            exitCode: 0,
        })

        // the loss ate the whole 161 of collateral, so there is nothing to refund and nothing to
        // reserve: what little came back pays this transaction and the rest is the governor's
        expect(result.transactions).not.toHaveTransaction({ to: borrower.address, body: bodyOp(op.loanResult) })
        const takeProfits = takeProfitValues(result)
        expect(takeProfits).toHaveLength(1)
        expect(takeProfits[0]).toBeBetween('0.1', '0.2')

        // no wedge: the round leaves recovering, burns its bills and is gone
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.burnAll),
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
        })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size).toEqual(0)

        accumulateFees(result.transactions)
    })
})
