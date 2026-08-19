import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import {
    between,
    bodyOp,
    createVset,
    emptyNewStakeMsg,
    logTotalFees,
    accumulateFees,
    setConfig,
    updateFeeConfig,
} from './helper'
import { config, err, op } from '../wrappers/common'
import {
    Participation,
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

// Matches a mint_bill body that records the given parent, which is the field a rescued bill later
// settles against. mint_bill is op, query_id, amount, unstake?, owner, parent, ownership amount.
function mintBillWithParent(expected: Address) {
    return (body: Cell | undefined) => {
        if (body == null) {
            return false
        }
        const s = body.beginParse()
        if (s.remainingBits < 32 + 64 || s.loadUint(32) !== op.mintBill) {
            return false
        }
        s.loadUint(64)
        s.loadCoins()
        s.loadBit()
        s.loadAddress()
        return s.loadAddress().equals(expected)
    }
}

describe('Governance', () => {
    let onlyUpgradeCode: Cell
    let resetDataCode: Cell
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
        onlyUpgradeCode = await compile('upgrade-code-test/OnlyUpgrade')
        resetDataCode = await compile('upgrade-code-test/ResetData')
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

    it('should propose governor', async () => {
        const newGovernor = await blockchain.treasury('newGovernor')
        const result = await treasury.sendProposeGovernor(governor.getSender(), {
            value: '0.1',
            newGovernor: newGovernor.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proposeGovernor),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        const proposedGovernor = (treasuryState.proposedGovernor ?? Cell.EMPTY).beginParse()
        const after = Math.floor(Date.now() / 1000) + 60 * 60 * 24
        expect(Math.abs(proposedGovernor.loadUint(32) - after)).toBeLessThanOrEqual(1)
        expect(proposedGovernor.loadAddress()).toEqualAddress(newGovernor.address)
        expect(treasuryState.governor).toEqualAddress(governor.address)

        accumulateFees(result.transactions)
    })

    it('should accept governance', async () => {
        const newGovernor = await blockchain.treasury('newGovernor')
        await treasury.sendProposeGovernor(governor.getSender(), { value: '0.1', newGovernor: newGovernor.address })
        const before = Math.floor(Date.now() / 1000) - 60 * 60 * 24
        const state = await treasury.getTreasuryState()
        state.proposedGovernor = beginCell().storeUint(before, 32).storeAddress(newGovernor.address).endCell()
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10'),
            }),
        )
        const result = await treasury.sendAcceptGovernance(newGovernor.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: newGovernor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.acceptGovernance),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: newGovernor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.governor).toEqualAddress(newGovernor.address)
        expect(treasuryState.proposedGovernor).toBeNull()

        accumulateFees(result.transactions)
    })

    it('should set halter', async () => {
        const newHalter = await blockchain.treasury('newHalter')
        const result = await treasury.sendSetHalter(governor.getSender(), {
            value: '0.1',
            newHalter: newHalter.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setHalter),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.halter).toEqualAddress(newHalter.address)

        accumulateFees(result.transactions)
    })

    it('should set stopped', async () => {
        const result1 = await treasury.sendSetStopped(halter.getSender(), { value: '0.1', newStopped: true })

        expect(result1.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setStopped),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: halter.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.stopped).toEqual(true)

        const staker = await blockchain.treasury('staker')
        const result2 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: staker.address,
            value: between('10', toNano('10') + fees.depositCoinsFee),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(3)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const borrower = await blockchain.treasury('borrower')
        const result3 = await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result3.transactions).toHaveTransaction({
            from: borrower.address,
            to: treasury.address,
            value: toNano('151') + fees.requestLoanFee,
            body: bodyOp(op.requestLoan),
            success: false,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: borrower.address,
            value: between('151', toNano('151') + fees.requestLoanFee),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        await treasury.sendSetStopped(halter.getSender(), { value: '0.1', newStopped: false })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result4 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })

        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.tokensMinted),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(5)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
    })

    it('should proxy set content', async () => {
        const newContent = beginCell().storeUint(0, 9).endCell()
        const result = await treasury.sendProxySetContent(governor.getSender(), {
            value: '0.1',
            destination: parent.address,
            newContent: newContent,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.proxySetContent),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', '0.1'),
            body: bodyOp(op.setContent),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: governor.address,
            value: between('0', '0.1'),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const content = (await parent.getJettonData())[3]
        expect(content).toEqualCell(newContent)

        accumulateFees(result.transactions)
    })

    it('should set reward share', async () => {
        const result = await treasury.sendSetGovernanceFee(governor.getSender(), {
            value: '0.1',
            newGovernanceFee: 8192n,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setGovernanceFee),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.governanceFee).toBe(8192n)

        accumulateFees(result.transactions)
    })

    it('should set rounds imbalance', async () => {
        const result = await treasury.sendSetRoundsImbalance(governor.getSender(), {
            value: '0.1',
            newRoundsImbalance: 128n,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.setRoundsImbalance),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.roundsImbalance).toEqual(128n)

        accumulateFees(result.transactions)
    })

    it('should send message to loan', async () => {
        const borrower = await blockchain.treasury('borrower')
        const loanAddress = await treasury.getLoanAddress(borrower.address, 0n)
        const message = beginCell().storeUint(op.proxyRecoverStake, 32).storeUint(1, 64).endCell()
        const result = await treasury.sendSendMessageToLoan(halter.getSender(), {
            value: '1',
            borrower: borrower.address,
            roundSince: 0n,
            message,
        })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.sendMessageToLoan),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loanAddress,
            value: between('0', '1'),
            body: bodyOp(op.proxyRecoverStake),
            success: false, // loan is not deployed
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loanAddress,
            to: treasury.address,
            value: between('0', '1'),
            body: bodyOp(0xffffffff),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        accumulateFees(result.transactions)
    })

    it('should reject send message to loan when the vset has not actually changed', async () => {
        // unpack_participation returns 14 fields; send_message_to_loan used to bind the 11th
        // (total_recovered) to vset_hash instead of the 12th (current_vset_hash). Pin a synthetic
        // participation whose current_vset_hash equals the live config-param-34 cell and whose
        // total_recovered is a distinct, non-colliding value (0n), so a pre-fix read of the wrong
        // field would slip past the vset-changed guard instead of failing with err::vset_not_changed.
        const borrower = await blockchain.treasury('borrower')
        const since = BigInt(Math.floor(Date.now() / 1000)) - 200_000n
        const until = since + 100_000n
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)
        const currentVsetHash = BigInt('0x' + vset.hash().toString('hex'))

        const roundSince = 0n
        const treasuryState = await treasury.getTreasuryState()
        treasuryState.participations.set(roundSince, {
            state: ParticipationState.Held,
            currentVsetHash,
            totalRecovered: 0n,
            stakeHeldFor: 0n,
            stakeHeldUntil: 1n, // in the past, so the timing guard alone would not block this
        })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(treasuryState),
                balance: toNano('10'),
            }),
        )

        const message = beginCell().storeUint(op.proxyRecoverStake, 32).storeUint(1, 64).endCell()
        const result = await treasury.sendSendMessageToLoan(governor.getSender(), {
            value: '1',
            borrower: borrower.address,
            roundSince,
            message,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.sendMessageToLoan),
            success: false,
            exitCode: err.vsetNotChanged,
        })
        expect(result.transactions).toHaveLength(3) // governor -> treasury, plus the bounce back
    })

    it('should send process loan requests', async () => {
        const state = await treasury.getTreasuryState()
        const participation = {
            state: ParticipationState.Distributing,
        }
        state.participations.set(0n, participation)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10'),
            }),
        )

        const collectionAddress = await treasury.getCollectionAddress(0n)
        const result = await treasury.sendRetryDistribute(halter.getSender(), {
            value: '1',
            roundSince: 0n,
        })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.retryDistribute),
            success: true,
            outMessagesCount: 1,
        })
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
        expect(result.transactions).toHaveLength(5)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.participations.size).toEqual(0)

        accumulateFees(result.transactions)
    })

    it('should re-mint a lost bill while the round is already burning', async () => {
        // A gap in the burn chain only becomes visible once the round is burning, and finishing the
        // chain means stepping over the gap. retry_mint_bill is the only way to put the lost bill
        // back, so refusing it in that state stranded the owner's coins and left total_staking
        // inflated with no way to ever settle it.
        const staker = await blockchain.treasury('staker')

        const roundSince = 0n
        const state = await treasury.getTreasuryState()
        state.participations.set(roundSince, { state: ParticipationState.Burning })
        state.totalStaking = toNano('1') // the deposit whose bill went missing
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: toNano('20'),
            }),
        )

        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const resultMint = await treasury.sendRetryMintBill(governor.getSender(), {
            value: '1',
            roundSince,
            amount: toNano('1'),
            unstake: false,
            owner: staker.address,
            parent: parent.address,
            ownershipAssignedAmount: 1n,
        })
        expect(resultMint.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.retryMintBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(resultMint.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: bodyOp(op.mintBill),
            success: true,
        })

        // And the rescued bill settles like any other once the chain is restarted.
        const resultBurn = await treasury.sendRetryBurnAll(halter.getSender(), { value: '1', roundSince })
        expect(resultBurn.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.mintTokens),
            success: true,
        })
        expect(resultBurn.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
        })

        const finalState = await treasury.getTreasuryState()
        expect(finalState.totalStaking).toBe(0n)
        expect(finalState.participations.size).toEqual(0)

        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const [tokens] = await wallet.getWalletState()
        expect(tokens).toBe(toNano('1'))

        accumulateFees(resultBurn.transactions)
    })

    it('should mint a retried bill on the parent it was validated against', async () => {
        // retry_mint_bill accepts an old parent for fixed_parent, because upgrading a wallet moves
        // only its tokens: the staking and unstaking balances a bill settles against stay behind on
        // the old wallet. So the rescued bill has to record that same parent, or mint_tokens and
        // burn_tokens later pay a wallet under the current parent that was never debited.
        const staker = await blockchain.treasury('staker')
        const newParent = await blockchain.treasury('newParent')

        const roundSince = 0n
        const state = await treasury.getTreasuryState()
        state.participations.set(roundSince, { state: ParticipationState.Staked })
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

        // Replacing the parent files the outgoing one in old_parents, which is what makes it an
        // acceptable fixed_parent below.
        const resultSetParent = await treasury.sendSetParent(governor.getSender(), {
            value: '1',
            newParent: newParent.address,
        })
        expect(resultSetParent.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.setParent),
            success: true,
        })
        const movedState = await treasury.getTreasuryState()
        expect(movedState.parent?.equals(newParent.address)).toBe(true)
        expect(movedState.oldParents.has(BigInt('0x' + parent.address.hash.toString('hex')))).toBe(true)

        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const result = await treasury.sendRetryMintBill(governor.getSender(), {
            value: '1',
            roundSince,
            amount: toNano('7'),
            unstake: true,
            owner: staker.address,
            parent: parent.address, // the old parent, still holding this owner's unstaking balance
            ownershipAssignedAmount: 1n,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            body: bodyOp(op.retryMintBill),
            success: true,
            outMessagesCount: 1,
        })
        // The bill must carry the old parent, not the one set_parent just installed.
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: mintBillWithParent(parent.address),
            success: true,
        })
        expect(result.transactions).not.toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            body: mintBillWithParent(newParent.address),
        })

        accumulateFees(result.transactions)
    })

    it('should upgrade code', async () => {
        const oldState = await treasury.getState()
        const someone = await blockchain.treasury('someone')

        // Reject upgrade since not sent by governor
        const result1 = await treasury.sendUpgradeCode(someone.getSender(), {
            value: '0.1',
            newCode: onlyUpgradeCode,
        })
        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: false,
            outMessagesCount: 1,
        })

        // Reject upgrade since governor is not the same after upgrade
        const result2 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: onlyUpgradeCode,
            newData: beginCell().storeAddress(someone.address).endCell(),
        })
        expect(result2.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: false,
            outMessagesCount: 1,
        })

        const result3 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: onlyUpgradeCode,
            newData: beginCell().storeAddress(governor.address).endCell(),
        })

        expect(result3.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await treasury.sendDepositCoins(governor.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })
        expect(result4.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })

        const result5 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: resetDataCode,
        })

        expect(result5.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await treasury.sendDepositCoins(governor.getSender(), {
            value: toNano('10') + fees.depositCoinsFee,
        })
        expect(result6.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('10') + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            outMessagesCount: 1,
        })

        const result7 = await treasury.sendUpgradeCode(governor.getSender(), {
            value: '0.1',
            newCode: treasuryCode,
        })

        expect(result7.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeCode),
            success: true,
            outMessagesCount: 1,
        })
        expect(result7.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result7.transactions).toHaveLength(3)

        const newState = await treasury.getState()
        expect(oldState.state.type).toEqual('active')
        expect(oldState.state.type).toEqual(newState.state.type)
        if (oldState.state.type === 'active' && newState.state.type === 'active') {
            expect(oldState.state.data?.toString('base64')).toEqual(newState.state.data?.toString('base64'))
        }

        accumulateFees(result1.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        accumulateFees(result6.transactions)
        accumulateFees(result7.transactions)
    })

    it('should withdraw surplus', async () => {
        const state = await treasury.getTreasuryState()
        const participation1: Participation = {
            state: ParticipationState.Held,
            size: 5n,
            totalStaked: toNano('1000000'),
            totalRecovered: toNano('1001000'),
        }
        const participation2: Participation = {
            state: ParticipationState.Validating,
            size: 10n,
            totalStaked: toNano('500000'),
            totalRecovered: 0n,
        }
        const participation3: Participation = {
            state: ParticipationState.Staked,
            size: 1n,
            totalStaked: 0n,
            totalRecovered: 0n,
        }
        state.participations.set(1n, participation1)
        state.participations.set(2n, participation2)
        state.participations.set(3n, participation3)
        state.totalCoins = toNano('900000') + toNano('10') // pool + dead shares
        state.totalTokens = toNano('800000')
        state.totalStaking = toNano('100000')
        state.totalUnstaking = toNano('200000')
        state.totalBorrowersStake = toNano('300000')
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: toNano('10') + toNano('801000') + 16n * fees.requestLoanFee + toNano('20'),
            }),
        )
        const result = await treasury.sendWithdrawSurplus(governor.getSender(), {
            value: '0.1',
            destination: governor.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('20', '20.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should gift coins', async () => {
        const someone = await blockchain.treasury('someone')
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('1') })

        const totalCoinsBefore1 = (await treasury.getTreasuryState()).totalCoins
        const result1 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: 0n })
        const totalCoinsAfter1 = (await treasury.getTreasuryState()).totalCoins

        expect(result1.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveLength(3)
        expect(totalCoinsAfter1).toEqual(totalCoinsBefore1)

        const totalCoinsBefore2 = (await treasury.getTreasuryState()).totalCoins
        const result2 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: 1n })
        const totalCoinsAfter2 = (await treasury.getTreasuryState()).totalCoins

        expect(result2.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveLength(3)
        expect(totalCoinsAfter2).toEqual(totalCoinsBefore2 + 1n)

        const totalCoinsBefore3 = (await treasury.getTreasuryState()).totalCoins
        const result3 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.08') })
        const totalCoinsAfter3 = (await treasury.getTreasuryState()).totalCoins

        expect(result3.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveLength(3)
        expect(totalCoinsAfter3).toEqual(totalCoinsBefore3 + toNano('0.08'))

        const totalCoinsBefore4 = (await treasury.getTreasuryState()).totalCoins
        const result4 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.09915') })
        const totalCoinsAfter4 = (await treasury.getTreasuryState()).totalCoins

        expect(result4.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(2)
        expect(totalCoinsAfter4).toEqual(totalCoinsBefore4 + toNano('0.09915'))

        const totalCoinsBefore5 = (await treasury.getTreasuryState()).totalCoins
        const result5 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.0992') })
        const totalCoinsAfter5 = (await treasury.getTreasuryState()).totalCoins

        expect(result5.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: false,
            actionResultCode: 37,
        })
        expect(result5.transactions).toHaveLength(2)
        expect(totalCoinsAfter5).toEqual(totalCoinsBefore5)

        await treasury.sendMessage(staker.getSender(), { value: fees.unstakeAllTokensFee, body: 'w' })
        const totalCoinsBefore6 = (await treasury.getTreasuryState()).totalCoins
        const result6 = await treasury.sendGiftCoins(someone.getSender(), { value: '0.1', coins: toNano('0.08') })
        const totalCoinsAfter6 = (await treasury.getTreasuryState()).totalCoins

        expect(result6.transactions).toHaveTransaction({
            from: someone.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.giftCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result6.transactions).toHaveLength(3)
        // even with no real stakers left, gifts are accepted and accrue to the dead shares
        expect(totalCoinsAfter6).toEqual(totalCoinsBefore6 + toNano('0.08'))
    })
})
