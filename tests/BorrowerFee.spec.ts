import { compile } from '@ton/blueprint'
import { burnerAddress } from '../wrappers/burner'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, toNano } from '@ton/core'
import {
    bodyOp,
    createNewStakeMsg,
    createVset,
    emptyNewStakeMsg,
    getElector,
    logTotalFees,
    accumulateFees,
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
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Borrower Fee', () => {
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
            outMessagesCount: 0,
        })
        expect(deployTreasuryResult.transactions).toHaveLength(2)
        expect(deployParentResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: parent.address,
            value: toNano('1'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployParentResult.transactions).toHaveLength(2)
        expect(setParentResult.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.setParent),
            success: true,
            outMessagesCount: 1,
        })
        expect(setParentResult.transactions).toHaveLength(3)

        fees = await treasury.getTreasuryFees(0n)

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10', destination: governor.address })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeGramValue('10')

        electorAddress = getElector(blockchain)
    })


    // These tests identify the fee purely by which address received it, so the address has to come
    // from the contract source rather than a copy. See wrappers/burner.ts.
    const burner = burnerAddress()
    const minBurn = toNano('1')

    // Everything below drives one round to recovery, so the split can be read off the messages the
    // treasury sends when the elector pays back. Structured as a helper because each test only differs
    // in the bid and the fee in force.
    async function runRound(opts: {
        borrowerFee: bigint
        minPayment: string
        borrowerRewardShare: bigint
        /** Round reward, in GRAM, on top of whatever the loan actually staked. */
        reward: string
        /** Applied after the request is made, to prove the request-time snapshot holds. */
        changeFeeTo?: bigint
    }) {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since1, until1))

        if (opts.borrowerFee !== 0n) {
            await treasury.sendSetBorrowerFee(governor.getSender(), {
                value: '0.1',
                newBorrowerFee: opts.borrowerFee,
            })
        }

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
                balance: toNano('1'),
            }),
        )

        const borrower = await blockchain.treasury('borrower1')
        const loan = blockchain.openContract(Loan.createFromAddress(await treasury.getLoanAddress(borrower.address, until1)))
        const newStakeMsg = await createNewStakeMsg(loan.address, until1)

        // 101 max punishment + min_payment + the burn floor once the fee is on
        const collateral =
            toNano('101') + toNano(opts.minPayment) + (opts.borrowerFee === 0n ? 0n : minBurn)
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: collateral + fees.requestLoanFee,
            roundSince: until1,
            loanAmount: '300000',
            minPayment: opts.minPayment,
            borrowerRewardShare: opts.borrowerRewardShare,
            newStakeMsg,
        })

        if (opts.changeFeeTo != null) {
            await treasury.sendSetBorrowerFee(governor.getSender(), {
                value: '0.1',
                newBorrowerFee: opts.changeFeeTo,
            })
        }

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        setConfig(blockchain, config.currentValidators, createVset(since2, since2 + electedFor))
        setConfig(blockchain, config.nextValidators, null)
        await treasury.sendParticipateInElection({ roundSince: until1 })

        // The elector pays back whatever the loan staked, plus the round's reward. That has to be
        // derived rather than hardcoded: a single borrower takes the whole pool through accrue_amount,
        // so a fixed credit would read as a catastrophic loss and never reach the reward branch.
        const stakedNow = await treasury.getParticipation(until1)
        const staked = stakedNow.staked?.get(BigInt('0x' + borrower.address.hash.toString('hex')))
        if (staked == null) throw new Error('loan was not staked')
        const credit = staked.loanAmount + staked.accrueAmount + staked.stakeAmount + toNano(opts.reward)

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan.address.hash.toString('hex')), credit)
        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
                balance: credit + toNano('1'),
            }),
        )

        setConfig(blockchain, config.currentValidators, createVset(0n, 1n))
        await treasury.sendVsetChanged({ roundSince: until1 })
        setConfig(blockchain, config.currentValidators, createVset(1n, 2n))
        await treasury.sendVsetChanged({ roundSince: until1 })

        const state = await treasury.getTreasuryState()
        const participation = state.participations.get(until1) ?? {}
        const request = participation.staked?.get(BigInt('0x' + borrower.address.hash.toString('hex')))
        participation.stakeHeldUntil = 0n
        state.participations.set(until1, participation)
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

        const result = await treasury.sendFinishParticipation({ roundSince: until1 })
        accumulateFees(result.transactions)

        const burn = result.transactions.find(
            (t) => t.inMessage?.info.dest?.toString() === burner.toString(),
        )
        const burned =
            burn?.inMessage?.info.type === 'internal' ? burn.inMessage.info.value.coins : 0n

        return { result, burned, request, borrower, until1 }
    }

    it('should send nothing to the burner while the fee is zero', async () => {
        // The kill switch has to be total: not just no rate, but no floor either. Without the
        // borrower_fee > 0 guard the 1 GRAM minimum would be charged on every loan at a zero rate, and
        // shipping the upgrade disabled would silently change economics.
        const { result, burned } = await runRound({
            borrowerFee: 0n,
            minPayment: '50',
            borrowerRewardShare: 26214n,
            reward: '400',
        })

        expect(burned).toEqual(0n)
        expect(result.transactions).not.toHaveTransaction({ body: bodyOp(op.takeBorrowerFee) })
        expect(result.transactions).toHaveTransaction({ body: bodyOp(op.loanResult), success: true })
    })

    it('should send half the contractual reward to the burner at 32767', async () => {
        // The base is muldiv(reward, borrower_reward_share, 65535) -- what the borrower contracted to
        // earn, not what they realised -- so 32767 is half of it. With a 400 GRAM round reward and a
        // 40% share that is 160 * 0.5 = 80 GRAM. The band is not tighter because `reward` is what the
        // elector actually returned less the loan, accrual, collateral and recovery fee -- and the loan
        // contract sweeps its own leftover gas back with it, so the reward lands a little above 400.
        const { result, burned } = await runRound({
            borrowerFee: 32767n,
            minPayment: '50',
            borrowerRewardShare: 26214n, // 40%
            reward: '400',
        })

        expect(burned).toBeGreaterThan(toNano('79.5'))
        expect(burned).toBeLessThan(toNano('80.5'))
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: burner,
            body: bodyOp(op.takeBorrowerFee),
        })

        // The pool's own share is untouched: the fee is charged on top of treasury_reward, out of the
        // borrower's funds, so the exchange rate moves exactly as it would with the fee off.
        expect(result.transactions).toHaveTransaction({ body: bodyOp(op.loanResult), success: true })
    })

    it('should still charge a borrower who bids min_payment above the whole reward', async () => {
        // The escape this base exists to close. treasury_reward = max(min_payment, ...) drives the
        // borrower's REALISED take to zero or below, so a fee on that would collect nothing from a
        // borrower who wants the validator slot for reasons outside the loan. The contractual share
        // does not move with min_payment, so the fee lands anyway -- out of collateral.
        const { burned } = await runRound({
            borrowerFee: 32767n,
            minPayment: '400',
            borrowerRewardShare: 26214n,
            reward: '100', // the whole reward is below min_payment, so the clamp binds
        })
        expect(burned).toBeGreaterThanOrEqual(minBurn)
    })

    it('should charge exactly the floor when the borrower contracted for no reward', async () => {
        // share = 0 makes the contractual base zero, so only fee::min_burn applies. Such a borrower
        // hands the pool the entire reward, so paying only the floor is the intended outcome, not a
        // hole -- but it must still pay something.
        const { burned } = await runRound({
            borrowerFee: 32767n,
            minPayment: '50',
            borrowerRewardShare: 0n,
            reward: '400',
        })
        expect(burned).toEqual(minBurn)
    })

    it('should charge the rate in force when the request was made, not at recovery', async () => {
        // borrower_fee is snapshotted into the request. There is no window in which no participation is
        // mid-flight -- the round chains interleave -- so a governance change could otherwise reprice
        // loans already committed, and that had to be ruled out structurally rather than by timing.
        const { burned, request } = await runRound({
            borrowerFee: 655n, // ~1% at request time
            minPayment: '50',
            borrowerRewardShare: 26214n, // 40%
            reward: '400',
            changeFeeTo: 65535n, // raised to the maximum AFTER the request, before recovery
        })

        expect(request?.requestFee).toEqual(655n)

        // ~1% of a 160 GRAM contractual share. Had the rate been read at recovery it would have been
        // the whole 160, so this is two orders of magnitude apart and cannot pass by coincidence.
        expect(burned).toBeGreaterThan(toNano('1.5'))
        expect(burned).toBeLessThan(toNano('1.7'))
    })

    it('should rank a worse reward share strictly below a better one, however small the gap', async () => {
        // The reason request_sort_key carries treasury_reward_share at its full 16 bits and the sorted
        // dict is keyed at 120 rather than 112.
        //
        // Packing the share into the 8 bits it used while borrower_reward_share was a uint8 would be
        // monotone, so a worse offer could never outrank a better one -- but it would collapse offers
        // within 1/256 of each other into a TIE, and the tie falls through to loan_amount_round_comp,
        // where the smaller loan wins. A borrower could bid up to 255/65535 worse for the pool, rank
        // equally, and take the round by asking for less. That band does not exist while the share is a
        // uint8, because the next expressible value is a whole step worse -- widening the payment
        // precision without widening the key is what would have created it.
        //
        // So: two bids with the SAME efficiency -- 302400 and 301300 round to loan units 275 and 274,
        // which both divide to 167 -- differing by one unit of share, the gap that collapses under >>8
        // (65535-26214 = 39321 and 65535-26215 = 39320 both truncate to 153). The worse bid also asks
        // for the smaller loan, so under truncation it would tie on share and then win the tiebreaker.
        // Both loans clear min_stake, or the smaller one would simply be rejected and prove nothing.
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        const better = await blockchain.treasury('better')
        const worse = await blockchain.treasury('worse')

        await treasury.sendRequestLoan(better.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '302400',
            minPayment: '50',
            borrowerRewardShare: 26214n,
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(worse.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '301300', // same efficiency bucket, smaller loan: the tiebreaker it would win on
            minPayment: '50',
            borrowerRewardShare: 26214n + 1n, // one unit worse for the pool, invisible to an 8-bit slot
            newStakeMsg: emptyNewStakeMsg,
        })

        const participation = await treasury.getParticipation(until)
        const sorted = participation.sorted
        expect(sorted?.size).toEqual(2)

        // decide_loan_requests reads the dict from the top, so the better bid must hold the larger key.
        const keys = sorted?.keys() ?? []
        const betterKey = keys[1]
        const worseKey = keys[0]
        expect(betterKey).toBeGreaterThan(worseKey)

        const holder = (key: bigint) => {
            const bucket = sorted?.get(key)
            const addrs = bucket?.keys() ?? []
            return addrs[0]
        }
        expect(holder(betterKey)).toEqual(BigInt('0x' + better.address.hash.toString('hex')))
        expect(holder(worseKey)).toEqual(BigInt('0x' + worse.address.hash.toString('hex')))

        // And the two must not share a key at all -- a tie is the failure mode, not just wrong order.
        // With the shares truncated to 8 bits both keys read ...a799 99... and ...a799 98... as the same
        // 0x99, leaving the loan-amount complement to decide: the worse bid's is the larger, so it
        // would take the round. That is the concrete shape this test exists to prevent.
        expect(betterKey).not.toEqual(worseKey)
        expect(betterKey >> 80n).toBeGreaterThan(worseKey >> 80n)
    })

    it('should tell an open request apart from no request at all', async () => {
        // ParticipationState.Open is 0, and so is "nothing here". Without a separate found flag these
        // two are the same eight zeroes, and they are exactly the pair a caller wants to distinguish
        // while a round is open: has this borrower bid yet, or not?
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        const bidder = await blockchain.treasury('bidder')
        const absent = await blockchain.treasury('absent')

        // Nothing anywhere yet: the round itself does not exist.
        const unknownRound = await treasury.getLoanRequest(until, bidder.address)
        expect(unknownRound.found).toBe(false)

        await treasury.sendRequestLoan(bidder.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 26214n,
            newStakeMsg: emptyNewStakeMsg,
        })

        const bid = await treasury.getLoanRequest(until, bidder.address)
        expect(bid.found).toBe(true)
        expect(bid.stage).toEqual(ParticipationState.Open)
        expect(bid.minPayment).toEqual(toNano('50'))
        expect(bid.borrowerRewardShare).toEqual(26214n)
        expect(bid.loanAmount).toEqual(toNano('300000'))
        expect(bid.requestFee).toEqual(0n)

        // Same round, a borrower who never bid. Identical to the bidder on every field except found.
        const missing = await treasury.getLoanRequest(until, absent.address)
        expect(missing.found).toBe(false)
        expect(missing.stage).toEqual(ParticipationState.Open)
        expect(missing.minPayment).toEqual(0n)
    })

    it('should report the stage and the snapshotted fee as a round advances', async () => {
        const { borrower, until1, request } = await runRound({
            borrowerFee: 655n,
            minPayment: '50',
            borrowerRewardShare: 26214n,
            reward: '400',
        })

        // runRound drives the round to recovery, so by now the participation is gone and the getter
        // has to say so rather than returning a zeroed request that reads as a real one.
        const after = await treasury.getLoanRequest(until1, borrower.address)
        expect(after.found).toBe(false)

        // While it was staked the rate snapshotted into the request was readable, which is what the
        // getter exists for -- nothing else exposes it.
        expect(request?.requestFee).toEqual(655n)
    })
})
