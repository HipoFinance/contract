import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { bodyOp, createVset, emptyNewStakeMsg, logTotalFees, setConfig, updateFeeConfig } from './helper'
import { config, op } from '../wrappers/common'
import { Treasury, TreasuryFees, emptyDictionaryValue, participationDictionaryValue } from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Reward Share', () => {
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
                    rewardShare: 1799n,
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

    // A request in the old format carries 16 bits of share before its ref. Refs are counted apart
    // from bits, so load_ref still succeeds and end_parse is what rejects it -- loudly, with the
    // collateral bounced, which is the whole point of not accepting and ignoring the field.
    it('should refuse a request that still carries a reward share', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        const borrower = await blockchain.treasury('borrower')
        const value = toNano('151') + fees.requestLoanFee
        const result = await treasury.sendMessage(borrower.getSender(), {
            value,
            body: beginCell()
                .storeUint(op.requestLoan, 32)
                .storeUint(0, 64)
                .storeUint(until, 32)
                .storeCoins(toNano('300000'))
                .storeCoins(toNano('50'))
                .storeUint(26214n, 16) // the field this release removed
                .storeRef(emptyNewStakeMsg)
                .endCell(),
        })

        expect(result.transactions).toHaveTransaction({
            from: borrower.address,
            to: treasury.address,
            body: bodyOp(op.requestLoan),
            success: false,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: borrower.address,
            inMessageBounced: true,
        })
        // No participation was even created, so the request never reached the book.
        expect(await treasury.getLoanRequest(until, borrower.address)).toMatchObject({ found: false })
        expect((await treasury.getTreasuryState()).totalBorrowersStake).toEqual(0n)
    })

    // Whatever the borrower wanted, the request is written with the protocol's value.
    it('should write the protocol reward share into every request', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        await treasury.sendSetRewardShare(governor.getSender(), { value: '0.1', newRewardShare: 4096n })

        const borrower = await blockchain.treasury('borrower')
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            newStakeMsg: emptyNewStakeMsg,
        })

        const bid = await treasury.getLoanRequest(until, borrower.address)
        expect(bid.found).toBe(true)
        expect(bid.borrowerRewardShare).toEqual(4096n)
    })

    // The snapshot is what stops a governance call repricing a bid already made -- the same reason
    // borrower_fee is snapshotted. It is also the only way two requests in one round can differ.
    it('should keep the share a request was made under when the protocol value changes', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        const borrower = await blockchain.treasury('borrower')
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            newStakeMsg: emptyNewStakeMsg,
        })

        await treasury.sendSetRewardShare(governor.getSender(), { value: '0.1', newRewardShare: 32768n })

        const bid = await treasury.getLoanRequest(until, borrower.address)
        expect(bid.borrowerRewardShare).toEqual(1799n)
        expect((await treasury.getTreasuryState()).rewardShare).toEqual(32768n)
    })

    // 65535 would leave the pool max(min_payment, 0) on every loan, which is the exposure this
    // release exists to remove. It is not something to leave one governance call away.
    it('should refuse a reward share of 65535, and refuse anyone but the governor', async () => {
        const refused = await treasury.sendSetRewardShare(governor.getSender(), {
            value: '0.1',
            newRewardShare: 65535n,
        })
        expect(refused.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.setRewardShare),
            success: false,
            exitCode: 109,
        })
        expect((await treasury.getTreasuryState()).rewardShare).toEqual(1799n)

        const someone = await blockchain.treasury('someone')
        const denied = await treasury.sendSetRewardShare(someone.getSender(), {
            value: '0.1',
            newRewardShare: 4096n,
        })
        expect(denied.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.setRewardShare),
            success: false,
        })
        expect((await treasury.getTreasuryState()).rewardShare).toEqual(1799n)

        const allowed = await treasury.sendSetRewardShare(governor.getSender(), {
            value: '0.1',
            newRewardShare: 65534n,
        })
        expect(allowed.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.setRewardShare),
            success: true,
        })
        expect((await treasury.getTreasuryState()).rewardShare).toEqual(65534n)
    })

    // A state this release makes reachable for the first time: a borrower replaces their own request
    // and the two copies carry DIFFERENT shares, without the borrower having changed anything. The
    // replacement path recomputes the old sort key from the OLD request's stored share -- if it used
    // the current one instead, the stale key would be left behind and `sorted` would grow a phantom
    // entry pointing at a borrower who is no longer there.
    it('should delete the old sort key when the share changed under a replaced request', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        const borrower = await blockchain.treasury('borrower')
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            newStakeMsg: emptyNewStakeMsg,
        })
        const first = await treasury.getParticipation(until)
        expect(first.sorted?.size).toEqual(1)

        await treasury.sendSetRewardShare(governor.getSender(), { value: '0.1', newRewardShare: 26214n })

        // The replacement carries the collateral forward, so it only needs the fee plus the difference.
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            newStakeMsg: emptyNewStakeMsg,
        })

        const after = await treasury.getParticipation(until)
        expect(after.size).toEqual(1n)
        expect(after.sorted?.size).toEqual(1)
        const bid = await treasury.getLoanRequest(until, borrower.address)
        expect(bid.borrowerRewardShare).toEqual(26214n)
        // And the one key left is the one the new share produces, not the old one.
        const key = (after.sorted?.keys() ?? [])[0]
        expect((key >> 80n) & 0xffffn).toEqual(65535n - 26214n)
    })

    // Monotonicity. With the share common to the round, the sort key orders purely by
    // min_payment/loan, so the request served first is never the one that pays the pool less: both
    // carry the same contractual fraction, and the one ahead promises more per GRAM lent.
    it('should serve the request that pays the pool more, first', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        setConfig(blockchain, config.currentValidators, createVset(since, until))

        const generous = await blockchain.treasury('generous')
        const stingy = await blockchain.treasury('stingy')

        // The stingy one bids first and asks for a SMALLER loan, which used to be the tiebreaker it
        // would win on. It cannot win now: its promise per GRAM lent is lower and nothing else counts.
        await treasury.sendRequestLoan(stingy.getSender(), {
            value: toNano('151') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(generous.getSender(), {
            value: toNano('251') + fees.requestLoanFee,
            roundSince: until,
            loanAmount: '400000',
            minPayment: '150',
            newStakeMsg: emptyNewStakeMsg,
        })

        const participation = await treasury.getParticipation(until)
        const sorted = participation.sorted
        expect(sorted?.size).toEqual(2)
        const keys = sorted?.keys() ?? []
        const best = keys.reduce((a, b) => (a > b ? a : b))
        const bucket = sorted?.get(best)
        expect(bucket?.has(BigInt('0x' + generous.address.hash.toString('hex')))).toBe(true)

        // Both carry the same contractual fraction, which is what makes the ordering meaningful.
        const a = await treasury.getLoanRequest(until, generous.address)
        const b = await treasury.getLoanRequest(until, stingy.address)
        expect(a.borrowerRewardShare).toEqual(b.borrowerRewardShare)
        expect(a.minPayment * b.loanAmount).toBeGreaterThan(b.minPayment * a.loanAmount)
    })
})
