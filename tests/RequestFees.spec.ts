import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { bodyOp, createVset, emptyNewStakeMsg, logTotalFees, setConfig, updateFeeConfig } from './helper'
import { config, op } from '../wrappers/common'
import {
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
} from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { UnstakeMode, Wallet } from '../wrappers/Wallet'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Request fees', () => {
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
                    totalRequestFees: 0n,
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
                    governanceFee: 4096n,
                    borrowerFee: 0n,
                    // 40%, which is what every bid in this file asked for before the share became the
                    // protocol's. Kept so the settlement figures these tests assert stay the ones they
                    // were written against; the tests that care about the share set it themselves.
                    rewardShare: 26214n,
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

    })

    // A borrower's request_loan attaches collateral AND a fee. The collateral is tracked as
    // total_borrowers_stake and held back from instant unstakes; the fee used to be untracked balance
    // that an instant unstake could legally spend, even though process_loan_requests and
    // recover_stakes were about to send it to the masterchain. total_request_fees is that money.
    // See docs/specs/2026-09-20-prepaid-request-fees.md.

    async function openRound() {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000))
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))
        return { times, electedFor, until }
    }

    // Move the validator set forward so that now() has passed participate_since for the round bid
    // above, which is what participate_in_election checks before accept_message.
    function openElection(times: Awaited<ReturnType<Treasury['getTimes']>>, electedFor: bigint, elected: boolean) {
        const since = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))
        setConfig(blockchain, config.nextValidators, elected ? createVset(until, until + electedFor) : null)
    }

    async function bid(borrower: SandboxContract<TreasuryContract>, until: bigint, minPayment: string) {
        return treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('101') + toNano(minPayment) + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment,
            newStakeMsg: emptyNewStakeMsg,
        })
    }

    it('should count one fee per standing request, not one per message', async () => {
        const { until } = await openRound()
        const borrower = await blockchain.treasury('borrower')

        expect((await treasury.getTreasuryState()).totalRequestFees).toBeGramValue('0')

        await bid(borrower, until, '50')
        expect((await treasury.getTreasuryState()).totalRequestFees).toEqual(fees.requestLoanFee)

        // A re-bid pays another fee and keeps the same slot. The counter follows `size`, so it does
        // not move -- the extra fee stays on the balance unreserved, which is the safe direction.
        // Following the money instead would make the counter climb forever.
        await bid(borrower, until, '60')
        expect((await treasury.getTreasuryState()).totalRequestFees).toEqual(fees.requestLoanFee)

        // A second borrower is a second slot.
        const other = await blockchain.treasury('other')
        await bid(other, until, '70')
        expect((await treasury.getTreasuryState()).totalRequestFees).toEqual(2n * fees.requestLoanFee)
    })

    it('should hold the request fees back from an instant unstake', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('100') + fees.depositCoinsFee })

        const { until } = await openRound()
        const borrower = await blockchain.treasury('borrower')
        await bid(borrower, until, '50')

        // The rule the contract applies, asserted against the contract's own numbers. Before this
        // change the last term was missing, and that GRAM -- already paid for proxy_new_stake and
        // proxy_recover_stake -- was offered to whoever unstaked first.
        const balance = await treasury.getBalance()
        const state = await treasury.getTreasuryState()
        expect(state.totalRequestFees).toEqual(fees.requestLoanFee)
        const available = balance - toNano('10') - state.totalBorrowersStake - state.totalRequestFees
        const burnable = await treasury.getMaxBurnableTokens()
        expect(burnable).toEqual((available * state.totalTokens) / state.totalCoins)

        // And the handler agrees with the getter: one nano past what it offers is rolled back.
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()
        const tooMuch = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: burnable + 1n,
            mode: UnstakeMode.Instant,
        })
        expect(tooMuch.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.proxyRollbackUnstake),
            success: true,
        })
    })

    it('should release a fee when its request is rejected, clamping if the fee price rose', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

        const { times, electedFor, until } = await openRound()
        const borrower = await blockchain.treasury('borrower')
        await bid(borrower, until, '50')
        expect((await treasury.getTreasuryState()).totalRequestFees).toEqual(fees.requestLoanFee)

        // Make gas ten times dearer after the request was made, so the release computes a LARGER fee
        // than the one counted in. Without the clamp the counter goes negative and store_coins aborts
        // process_loan_requests -- stranding the round this change exists to protect.
        const dearer = beginCell()
            .storeUint(0xd1, 8)
            .storeUint(100, 64)
            .storeUint(66670, 64)
            .storeUint(0xde, 8)
            .storeUint(43690670, 64)
            .storeUint(1000000, 64)
            .storeUint(1000000, 64)
            .storeUint(10000, 64)
            .storeUint(10000000, 64)
            .storeUint(100000000, 64)
            .storeUint(1000000000, 64)
            .endCell()
        setConfig(blockchain, config.gasPrices, dearer)
        expect((await treasury.getTreasuryFees(0n)).requestLoanFee).toBeGreaterThan(fees.requestLoanFee)

        // next_validators being set makes distribute reject every request rather than lend.
        openElection(times, electedFor, true)
        const result = await treasury.sendParticipateInElection({ roundSince: until })

        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: borrower.address,
            body: bodyOp(op.requestRejected),
            success: true,
        })
        const failed = result.transactions.filter((t) => {
            const d = t.description
            return d.type === 'generic' && d.computePhase.type === 'vm' && !d.computePhase.success
        })
        expect(failed).toHaveLength(0)
        expect((await treasury.getTreasuryState()).totalRequestFees).toBeGramValue('0')
    })
})
