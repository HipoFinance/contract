import { compile } from '@ton/blueprint'
import { Blockchain, EmulationError, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { between, bodyOp, logTotalFees, accumulateFees, updateFeeConfig } from './helper'
import { err, op } from '../wrappers/common'
import {
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { UnstakeMode, Wallet } from '../wrappers/Wallet'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'

describe('Wallet', () => {
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
    const treasuryStorage = toNano('10')
    const deadShares = toNano('10')

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

        await treasury.sendWithdrawSurplus(governor.getSender(), {
            value: treasuryStorage,
            destination: governor.address,
        })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeGramValue(treasuryStorage)
    })

    it('should deposit and mint tokens when there is no active round', async () => {
        const amount = toNano('10')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendDepositCoins(staker.getSender(), {
            value: amount + fees.depositCoinsFee,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: amount + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.tokensMinted),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            // value: between('0.03', '0.04'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + amount - 5n, treasuryStorage + amount)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + amount)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue(amount)

        const walletBalance = await wallet.getBalance()
        const walletFees = await wallet.getWalletFees()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue(amount)
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should deposit and save coins when there is an active round', async () => {
        const roundSince = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: await treasury.getBalance(),
            }),
        )

        const amount = toNano('10')
        const ownershipAssignedAmount = toNano('0.05')
        const staker = await blockchain.treasury('staker')
        const referrer = await blockchain.treasury('referrer')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const billAddress = await treasury.getBillAddress(roundSince, 0n)
        const result1 = await treasury.sendDepositCoins(staker.getSender(), {
            value: amount + fees.depositCoinsFee + ownershipAssignedAmount,
            ownershipAssignedAmount,
            referrer: referrer.address,
        })

        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: amount + fees.depositCoinsFee + ownershipAssignedAmount,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 2,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxySaveCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.saveCoins),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            value: between('0', fees.depositCoinsFee + ownershipAssignedAmount),
            body: bodyOp(op.mintBill),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: collectionAddress,
            to: billAddress,
            value: between('0', fees.depositCoinsFee + ownershipAssignedAmount),
            body: bodyOp(op.assignBill),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: billAddress,
            to: staker.address,
            value: ownershipAssignedAmount,
            body: bodyOp(op.ownershipAssigned),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(7)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + amount - 5n, treasuryStorage + amount)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares)
        expect(treasuryState.totalTokens).toBeGramValue(deadShares)
        expect(treasuryState.totalStaking).toBeGramValue(amount)
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue('0')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween('0', '0.006')
        expect(tokens).toBeGramValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(roundSince)).toBeGramValue(amount)
        expect(unstaking).toBeGramValue('0')

        const fakeState2 = await treasury.getTreasuryState()
        fakeState2.participations.set(roundSince, { state: ParticipationState.Burning })
        const fakeData2 = treasuryConfigToCell(fakeState2)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: await treasury.getBalance(),
            }),
        )

        const fee = toNano('0.2')
        const result2 = await treasury.sendRetryBurnAll(halter.getSender(), { value: fee, roundSince })

        expect(result2.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: fee,
            body: bodyOp(op.retryBurnAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            value: between('0', fee),
            body: bodyOp(op.burnAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: collectionAddress,
            to: billAddress,
            value: between('0', fee),
            body: bodyOp(op.burnBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: billAddress,
            to: collectionAddress,
            value: between('0', fee),
            body: bodyOp(op.billBurned),
            success: true,
            outMessagesCount: 2,
        })
        expect(result2.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            value: between('0', fee),
            body: bodyOp(op.lastBillBurned),
            success: true,
            outMessagesCount: 0 + 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            value: between('0', '0.3'),
            body: bodyOp(op.mintTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', '0.2'),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.tokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.2'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(10)
        expect(result2.externals).toHaveLength(1)

        accumulateFees(result1.transactions)
    })

    it('should deposit and mint tokens when instant mint flag is set', async () => {
        const roundSince = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince, { state: ParticipationState.Staked })
        fakeState1.instantMint = true
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: await treasury.getBalance(),
            }),
        )

        const amount = toNano('10')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendDepositCoins(staker.getSender(), {
            value: amount + fees.depositCoinsFee,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: amount + fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.tokensMinted),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            // value: between('0.03', '0.04'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + amount - 5n, treasuryStorage + amount)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + amount)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue(amount)

        const walletBalance = await wallet.getBalance()
        const walletFees = await wallet.getWalletFees()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue(amount)
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should reject deposits that would mint zero tokens', async () => {
        // inflate the exchange rate to 2.0 so that a 1 nanogram deposit rounds down to zero tokens
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.totalCoins = toNano('20')
        fakeState1.totalTokens = toNano('10')
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: await treasury.getBalance(),
            }),
        )

        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))

        // instant path: no active round
        const result1 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('0.1') + fees.depositCoinsFee,
            coins: 1n,
        })
        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            body: bodyOp(op.depositCoins),
            success: false,
            exitCode: err.depositTooSmall,
        })
        expect(result1.transactions).toHaveLength(3) // deposit failed and bounced, nothing else happened

        const treasuryState1 = await treasury.getTreasuryState()
        expect(treasuryState1.totalCoins).toBeGramValue('20')
        expect(treasuryState1.totalTokens).toBeGramValue('10')
        expect(treasuryState1.totalStaking).toBeGramValue('0')

        // smallest deposit minting one token unit at rate 2.0 succeeds
        const result2 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('0.1') + fees.depositCoinsFee,
            coins: 2n,
        })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })

        const treasuryState2 = await treasury.getTreasuryState()
        expect(treasuryState2.totalCoins).toEqual(toNano('20') + 2n)
        expect(treasuryState2.totalTokens).toEqual(toNano('10') + 1n)

        const [tokens] = await wallet.getWalletState()
        expect(tokens).toEqual(1n)

        // deferred path: active round, deposit saved for a later mint
        const roundSince = 1n
        const fakeState2 = await treasury.getTreasuryState()
        fakeState2.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData2 = treasuryConfigToCell(fakeState2)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: await treasury.getBalance(),
            }),
        )

        const result3 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('0.1') + fees.depositCoinsFee,
            coins: 1n,
        })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            body: bodyOp(op.depositCoins),
            success: false,
            exitCode: err.depositTooSmall,
        })
        expect(result3.transactions).toHaveLength(3)

        const treasuryState3 = await treasury.getTreasuryState()
        expect(treasuryState3.totalStaking).toBeGramValue('0')
    })

    it('should deposit coins for a different owner', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const other = await blockchain.treasury('other')

        const result1 = await treasury.sendDepositCoins(other.getSender(), {
            value: toNano('3') + toNano('0.2'), // 0.2 for fee
            owner: staker.address,
            coins: toNano('3'),
            ownershipAssignedAmount: toNano('0.01'),
            referrer: other.address,
        })
        expect(result1.transactions).toHaveTransaction({
            from: other.address,
            to: treasury.address,
            value: toNano('3') + toNano('0.2'),
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', '0.2'),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.tokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.2'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(5)

        const result2 = await treasury.sendDepositCoins(other.getSender(), {
            value: toNano('4') + fees.depositCoinsFee,
            owner: staker.address,
        })
        expect(result2.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.tokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveLength(5)

        const result3 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('2') + toNano('0.2'), // 0.2 for fee
            coins: toNano('2'),
        })
        expect(result3.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', '0.2'),
            body: bodyOp(op.tokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + toNano('9') - 5n, treasuryStorage + toNano('9'))
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('9'))
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue('9')

        const walletBalance = await wallet.getBalance()
        const walletFees = await wallet.getWalletFees()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue('9')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
    })

    it('should unstake and withdraw coins when there is no active round', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()
        const result = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '7',
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.unstakeTokensFee,
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: parent.address,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.proxyReserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('7', toNano('7') + walletFees.unstakeTokensFee),
            body: bodyOp(op.proxyTokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('7', toNano('7') + walletFees.unstakeTokensFee),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('7', toNano('7') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(7)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + toNano('3') - 5n, treasuryStorage + toNano('3'))
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('3'))
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue('3')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue('3')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should unstake and reserve tokens when there is an active round', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()

        const roundSince = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: treasuryStorage + toNano('3'),
            }),
        )

        const ownershipAssignedAmount = toNano('0.05')
        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const billAddress = await treasury.getBillAddress(roundSince, 0n)
        const fee1 = walletFees.unstakeTokensFee + ownershipAssignedAmount + toNano('0.001')
        const result1 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: fee1,
            tokens: '7',
            ownershipAssignedAmount,
        })

        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: fee1,
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: wallet.address,
            to: parent.address,
            value: between('0', fee1),
            body: bodyOp(op.proxyReserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', fee1),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            value: between('0', fee1),
            body: bodyOp(op.mintBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: collectionAddress,
            to: billAddress,
            value: between('0', fee1),
            body: bodyOp(op.assignBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).toHaveTransaction({
            from: billAddress,
            to: staker.address,
            value: ownershipAssignedAmount,
            body: bodyOp(op.ownershipAssigned),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(7)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + toNano('3') - 5n, treasuryStorage + toNano('3'))
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('10'))
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('7')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue('10')

        const walletBalance = await wallet.getBalance()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue('3')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('7')

        const fakeState2 = await treasury.getTreasuryState()
        fakeState2.participations.set(roundSince, { state: ParticipationState.Burning })
        const fakeData2 = treasuryConfigToCell(fakeState2)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: treasuryStorage + toNano('10'),
            }),
        )

        const fee2 = toNano('0.1')
        const result2 = await treasury.sendRetryBurnAll(halter.getSender(), { value: fee2, roundSince })

        expect(result2.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: fee2,
            body: bodyOp(op.retryBurnAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress,
            value: between('0', fee2),
            body: bodyOp(op.burnAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: collectionAddress,
            to: billAddress,
            // value: between('0.008', '0.009'),
            body: bodyOp(op.burnBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: billAddress,
            to: collectionAddress,
            // value: between('0.05', '0.06'),
            body: bodyOp(op.billBurned),
            success: true,
            outMessagesCount: 2,
        })
        expect(result2.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            // value: between('0.007', '0.008'),
            body: bodyOp(op.lastBillBurned),
            success: true,
            outMessagesCount: 0 + 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: collectionAddress,
            to: treasury.address,
            // value: between('0.12', '0.13'),
            body: bodyOp(op.burnTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('7', '7.17'),
            body: bodyOp(op.proxyTokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('7', '7.17'),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('7', '7.17'),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(10)
        expect(result2.externals).toHaveLength(1)

        accumulateFees(result1.transactions)
    })

    it('should postpone a deferred unstake to the next round using that round\'s bill code', async () => {
        // Regression for the wrong-round code lookup in burn_tokens' postpone branch:
        // when an illiquid treasury postpones an unstake bill to the next round, the new bill
        // must be minted on the collection derived from the NEXT round's bill/collection code,
        // not the original round's. This only diverges once a code upgrade sits between the
        // two rounds, so a distinct (upgraded) bill code is registered on the target round.
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()

        const round1 = 1n // where the deferred unstake bill is first minted
        const round2 = 2n // postpone target, carrying an upgraded bill code
        const upgradedBillCode = beginCell().storeUint(0xb111, 16).endCell()

        // Round 2's collection address BEFORE the upgrade — what the buggy code targets,
        // since it reuses round 1's code when postponing to round 2.
        const staleRound2Collection = await treasury.getCollectionAddress(round2)

        const activeState = await treasury.getTreasuryState()
        activeState.participations.set(round1, { state: ParticipationState.Staked })
        activeState.participations.set(round2, { state: ParticipationState.Staked })
        activeState.billCodes.set(round2, upgradedBillCode)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(activeState),
                balance: treasuryStorage + toNano('10'),
            }),
        )

        const round1Collection = await treasury.getCollectionAddress(round1)
        const round2Collection = await treasury.getCollectionAddress(round2)
        // The upgrade makes round 2's collection differ from the stale (round 1 code) address.
        expect(round2Collection.equals(staleRound2Collection)).toBe(false)

        // Deferred unstake (best mode) mints its bill on the earliest non-open round (round 1).
        const resultUnstake = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.1'),
            tokens: '7',
            mode: UnstakeMode.Best,
        })
        expect(resultUnstake.transactions).toHaveTransaction({
            from: treasury.address,
            to: round1Collection,
            body: bodyOp(op.mintBill),
            success: true,
        })

        // Flip round 1 to burning and make the treasury illiquid so its burn must postpone.
        const burningState = await treasury.getTreasuryState()
        burningState.participations.set(round1, { state: ParticipationState.Burning })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(burningState),
                balance: treasuryStorage + toNano('3'), // available 3 GRAM < 7 coins owed
            }),
        )

        const resultBurn = await treasury.sendRetryBurnAll(halter.getSender(), { value: '0.1', roundSince: round1 })

        // Fixed: the postponed bill is minted on round 2's upgraded collection.
        expect(resultBurn.transactions).toHaveTransaction({
            from: treasury.address,
            to: round2Collection,
            body: bodyOp(op.mintBill),
            success: true,
        })
        // And never on the stale address derived from round 1's bill code.
        expect(resultBurn.transactions).not.toHaveTransaction({
            from: treasury.address,
            to: staleRound2Collection,
            body: bodyOp(op.mintBill),
        })
    })

    it('should unstake with different modes where there is no active round', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()

        const result1 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
        })
        expect(result1.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(7)

        const result2 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result2.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee + toNano('0.05')),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(7)

        const result3 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            mode: UnstakeMode.Auto,
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result3.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee + toNano('0.05')),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(7)

        const result4 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Instant,
            ownershipAssignedAmount: 0n,
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(7)

        const result5 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Best,
        })
        expect(result5.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result5.transactions).toHaveLength(7)

        const fakeState = await treasury.getTreasuryState()
        const fakeData = treasuryConfigToCell(fakeState)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: treasuryStorage,
            }),
        )

        const result6 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
        })
        expect(result6.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.rollbackUnstake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result6.transactions).toHaveLength(7)

        const result7 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result7.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', walletFees.unstakeTokensFee + toNano('0.05')),
            body: bodyOp(op.rollbackUnstake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result7.transactions).toHaveLength(7)

        const result8 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            mode: UnstakeMode.Auto,
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result8.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', walletFees.unstakeTokensFee + toNano('0.05')),
            body: bodyOp(op.rollbackUnstake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result8.transactions).toHaveLength(7)

        const result9 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Instant,
            ownershipAssignedAmount: 0n,
        })
        expect(result9.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.rollbackUnstake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result9.transactions).toHaveLength(7)

        const result10 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Best,
        })
        expect(result10.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.rollbackUnstake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result10.transactions).toHaveLength(7)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        accumulateFees(result6.transactions)
        accumulateFees(result7.transactions)
        accumulateFees(result8.transactions)
        accumulateFees(result9.transactions)
        accumulateFees(result10.transactions)
    })

    it('should unstake with different modes when there is an active round', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletFees = await wallet.getWalletFees()

        const roundSince = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: treasuryStorage + toNano('10'),
            }),
        )
        const collectionAddress = await treasury.getCollectionAddress(roundSince)

        const result1 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
        })
        expect(result1.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(7)

        const result2 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result2.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee + toNano('0.05')),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(7)

        const result3 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Auto,
        })
        expect(result3.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(7)

        const result4 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Instant,
            ownershipAssignedAmount: 0n,
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('1', toNano('1') + walletFees.unstakeTokensFee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result4.transactions).toHaveLength(7)

        const billAddress0 = await treasury.getBillAddress(roundSince, 0n)
        const result5 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            mode: UnstakeMode.Best,
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result5.transactions).toHaveTransaction({
            from: billAddress0,
            to: staker.address,
            value: toNano('0.05'),
            body: bodyOp(op.ownershipAssigned),
            success: true,
            outMessagesCount: 0,
        })
        expect(result5.transactions).toHaveLength(7)

        const fakeState = await treasury.getTreasuryState()
        const fakeData = treasuryConfigToCell(fakeState)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: treasuryStorage,
            }),
        )

        const billAddress1 = await treasury.getBillAddress(roundSince, 1n)
        const result6 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
        })
        expect(result6.transactions).toHaveTransaction({
            from: collectionAddress,
            to: billAddress1,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.assignBill),
            success: true,
            outMessagesCount: 0,
        })
        expect(result6.transactions).toHaveLength(6)

        const billAddress2 = await treasury.getBillAddress(roundSince, 2n)
        const result7 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result7.transactions).toHaveTransaction({
            from: billAddress2,
            to: staker.address,
            value: toNano('0.05'),
            body: bodyOp(op.ownershipAssigned),
            success: true,
            outMessagesCount: 0,
        })
        expect(result7.transactions).toHaveLength(7)

        const billAddress3 = await treasury.getBillAddress(roundSince, 3n)
        const result8 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.05'),
            tokens: '1',
            mode: UnstakeMode.Auto,
            ownershipAssignedAmount: toNano('0.05'),
        })
        expect(result8.transactions).toHaveTransaction({
            from: billAddress3,
            to: staker.address,
            value: toNano('0.05'),
            body: bodyOp(op.ownershipAssigned),
            success: true,
            outMessagesCount: 0,
        })
        expect(result8.transactions).toHaveLength(7)

        const result9 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Instant,
        })
        expect(result9.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.rollbackUnstake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result9.transactions).toHaveLength(7)

        const billAddress4 = await treasury.getBillAddress(roundSince, 4n)
        const result10 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
            mode: UnstakeMode.Best,
            ownershipAssignedAmount: 0n,
        })
        expect(result10.transactions).toHaveTransaction({
            from: collectionAddress,
            to: billAddress4,
            value: between('0', walletFees.unstakeTokensFee),
            body: bodyOp(op.assignBill),
            success: true,
            outMessagesCount: 0,
        })
        expect(result10.transactions).toHaveLength(6)

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        accumulateFees(result6.transactions)
        accumulateFees(result7.transactions)
        accumulateFees(result8.transactions)
        accumulateFees(result9.transactions)
        accumulateFees(result10.transactions)
    })

    it('should deposit coins for comment d', async () => {
        const amount = toNano('10')
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await treasury.sendMessage(staker.getSender(), { value: amount, body: 'd' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: amount,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.tokensMinted),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            // value: between('0.03', '0.04'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(
            treasuryStorage + amount - fees.depositCoinsFee - 5n,
            treasuryStorage + amount - fees.depositCoinsFee,
        )
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + amount - fees.depositCoinsFee)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue(amount - fees.depositCoinsFee)

        const walletBalance = await wallet.getBalance()
        const walletFees = await wallet.getWalletFees()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue(amount - fees.depositCoinsFee)
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should unstake all tokens for comment w sent to treasury', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendMessage(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee, body: 'D' })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const fee = fees.unstakeAllTokensFee
        await treasury.sendTopUp(governor.getSender(), { value: 5n })
        const result = await treasury.sendMessage(staker.getSender(), { value: fee, body: 'w' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fee),
            body: bodyOp(op.proxyUnstakeAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', fee),
            body: bodyOp(op.unstakeAll),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: wallet.address,
            value: between('0', fee),
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: parent.address,
            value: between('0', fee),
            body: bodyOp(op.proxyReserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', fee),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('10', toNano('10') + fee),
            body: bodyOp(op.proxyTokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('10', toNano('10') + fee),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('10', toNano('10') + fee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(10)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage, treasuryStorage + 5n)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const walletBalance = await wallet.getBalance()
        const walletFees = await wallet.getWalletFees()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue('0')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should unstake all tokens for comment w sent to wallet', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendTopUp(governor.getSender(), { value: 10n })
        await treasury.sendMessage(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee, body: 'd' })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const fee = fees.unstakeAllTokensFee
        const result = await wallet.sendMessage(staker.getSender(), { value: fee, body: 'W' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: fee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: wallet.address,
            value: between('0', fee),
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: parent.address,
            value: between('0', fee),
            body: bodyOp(op.proxyReserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', fee),
            body: bodyOp(op.reserveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('10', toNano('10') + fee),
            body: bodyOp(op.proxyTokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('10', toNano('10') + fee),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('10', toNano('10') + fee),
            body: bodyOp(op.withdrawalNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(8)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage, treasuryStorage + 10n)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const walletBalance = await wallet.getBalance()
        const walletFees = await wallet.getWalletFees()
        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens).toBeGramValue('0')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should handle multiple deposits, unstakes, and sends', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        const staker3 = await blockchain.treasury('staker3')
        const walletAddress1 = await parent.getWalletAddress(staker1.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(walletAddress1))
        const walletAddress2 = await parent.getWalletAddress(staker2.address)
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(walletAddress2))
        const walletAddress3 = await parent.getWalletAddress(staker3.address)
        const wallet3 = blockchain.openContract(Wallet.createFromAddress(walletAddress3))

        await treasury.sendDepositCoins(staker1.getSender(), { value: toNano('1') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('2') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker3.getSender(), { value: toNano('3') + fees.depositCoinsFee })
        const walletFees = await wallet1.getWalletFees()

        // tokens staking unstaking
        // 1 0 0 | 2 0 0 | 3 0 0

        await wallet2.sendSendTokens(staker2.getSender(), {
            value: walletFees.sendTokensFee,
            tokens: '1.5',
            recipient: staker1.address,
        })
        await wallet2.sendSendTokens(staker2.getSender(), {
            value: walletFees.sendTokensFee,
            tokens: '0.5',
            recipient: staker3.address,
        })
        await wallet3.sendSendTokens(staker3.getSender(), {
            value: walletFees.sendTokensFee,
            tokens: '2.5',
            recipient: staker2.address,
        })
        await wallet2.sendSendTokens(staker2.getSender(), {
            value: walletFees.sendTokensFee,
            tokens: '0.5',
            recipient: staker1.address,
        })

        // 3 0 0 | 2 0 0 | 1 0 0

        let treasuryBalance = await treasury.getBalance()
        let treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + toNano('6') - 5n, treasuryStorage + toNano('6'))
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('6'))
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('6'))
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')

        let [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('3')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')

        let [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(tokens2).toBeGramValue('2')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeGramValue('0')

        let [tokens3, staking3, unstaking3] = await wallet3.getWalletState()
        expect(tokens3).toBeGramValue('1')
        expect(staking3.keys()).toHaveLength(0)
        expect(unstaking3).toBeGramValue('0')

        const roundSince1 = 1n
        const fakeState1 = await treasury.getTreasuryState()
        fakeState1.participations.set(roundSince1, { state: ParticipationState.Staked })
        const fakeData1 = treasuryConfigToCell(fakeState1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: treasuryStorage + toNano('2') + 5n,
            }),
        )

        await wallet1.sendUnstakeTokens(staker1.getSender(), { value: walletFees.unstakeTokensFee, tokens: '2' })
        // 1 0 0 | 2 0 0 | 1 0 0
        await wallet2.sendUnstakeTokens(staker2.getSender(), { value: walletFees.unstakeTokensFee, tokens: '0.5' })
        // 1 0 0 | 1.5 0 0.5 | 1 0 0
        await wallet2.sendUnstakeTokens(staker2.getSender(), { value: walletFees.unstakeTokensFee, tokens: '0.5' })
        // 1 0 0 | 1 0 1 | 1 0 0
        await wallet1.sendUnstakeTokens(staker1.getSender(), { value: walletFees.unstakeTokensFee, tokens: '1' })
        // 0 0 1 | 1 0 1 | 1 0 0

        await treasury.sendDepositCoins(staker1.getSender(), { value: toNano('1') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('2') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('2') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker1.getSender(), { value: toNano('1') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker3.getSender(), { value: toNano('3') + fees.depositCoinsFee })

        // 0 2 1 | 1 4 1 | 1 3 0

        await wallet2.sendUnstakeTokens(staker2.getSender(), { value: walletFees.unstakeTokensFee, tokens: '1' })

        // 0 2 1 | 0 4 1 | 1 3 0

        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('1') + fees.depositCoinsFee })

        // 0 2 1 | 0 5 1 | 1 3 0

        treasuryBalance = await treasury.getBalance()
        treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + toNano('9'), treasuryStorage + toNano('9') + 5n)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('3'))
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('3'))
        expect(treasuryState.totalStaking).toBeGramValue('10')
        expect(treasuryState.totalUnstaking).toBeGramValue('2')
        ;[tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('0')
        expect(staking1.keys()).toHaveLength(1)
        expect(staking1.get(roundSince1)).toBeGramValue('2')
        expect(unstaking1).toBeGramValue('1')
        ;[tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(tokens2).toBeGramValue('0')
        expect(staking2.keys()).toHaveLength(1)
        expect(staking2.get(roundSince1)).toBeGramValue('5')
        expect(unstaking2).toBeGramValue('1')
        ;[tokens3, staking3, unstaking3] = await wallet3.getWalletState()
        expect(tokens3).toBeGramValue('1')
        expect(staking3.keys()).toHaveLength(1)
        expect(staking3.get(roundSince1)).toBeGramValue('3')
        expect(unstaking3).toBeGramValue('0')

        const roundSince2 = 2n
        const fakeState2 = await treasury.getTreasuryState()
        fakeState2.participations.set(roundSince1, { state: ParticipationState.Burning })
        fakeState2.participations.set(roundSince2, { state: ParticipationState.Staked })
        const fakeData2 = treasuryConfigToCell(fakeState2)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: treasuryStorage + 5n,
            }),
        )

        await wallet3.sendUnstakeTokens(staker3.getSender(), { value: walletFees.unstakeTokensFee, tokens: '1' })

        // 0 2 1 | 0 5 1 | 0 3 1

        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('1') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker2.getSender(), { value: toNano('1') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker3.getSender(), { value: toNano('1') + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker3.getSender(), { value: toNano('1') + fees.depositCoinsFee })

        // 0 2 1 | 0 5,2 1 | 0 3,2 1

        treasuryBalance = await treasury.getBalance()
        treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + toNano('4'), treasuryStorage + toNano('4') + 5n)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('3'))
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('3'))
        expect(treasuryState.totalStaking).toBeGramValue('14')
        expect(treasuryState.totalUnstaking).toBeGramValue('3')
        ;[tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('0')
        expect(staking1.keys()).toHaveLength(1)
        expect(staking1.get(roundSince1)).toBeGramValue('2')
        expect(unstaking1).toBeGramValue('1')
        ;[tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(tokens2).toBeGramValue('0')
        expect(staking2.keys()).toHaveLength(2)
        expect(staking2.get(roundSince1)).toBeGramValue('5')
        expect(staking2.get(roundSince2)).toBeGramValue('2')
        expect(unstaking2).toBeGramValue('1')
        ;[tokens3, staking3, unstaking3] = await wallet3.getWalletState()
        expect(tokens3).toBeGramValue('0')
        expect(staking3.keys()).toHaveLength(2)
        expect(staking3.get(roundSince1)).toBeGramValue('3')
        expect(staking3.get(roundSince2)).toBeGramValue('2')
        expect(unstaking3).toBeGramValue('1')

        await treasury.sendRetryBurnAll(halter.getSender(), { value: toNano('0.1'), roundSince: roundSince1 })

        // 2 0 0 | 5 2 0 | 3 2 1

        treasuryBalance = await treasury.getBalance()
        treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(
            treasuryStorage + toNano('2'),
            treasuryStorage + toNano('2') + toNano('0.005'),
        )
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('11'))
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('11'))
        expect(treasuryState.totalStaking).toBeGramValue('4')
        expect(treasuryState.totalUnstaking).toBeGramValue('1')
        ;[tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('2')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')
        ;[tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(tokens2).toBeGramValue('5')
        expect(staking2.keys()).toHaveLength(1)
        expect(staking2.get(roundSince2)).toBeGramValue('2')
        expect(unstaking2).toBeGramValue('0')
        ;[tokens3, staking3, unstaking3] = await wallet3.getWalletState()
        expect(tokens3).toBeGramValue('3')
        expect(staking3.keys()).toHaveLength(1)
        expect(staking3.get(roundSince2)).toBeGramValue('2')
        expect(unstaking3).toBeGramValue('1')

        const roundSince3 = 3n
        const fakeState3 = await treasury.getTreasuryState()
        fakeState3.participations.set(roundSince2, { state: ParticipationState.Burning })
        fakeState3.participations.set(roundSince3, { state: ParticipationState.Staked })
        const fakeData3 = treasuryConfigToCell(fakeState3)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData3,
                balance: treasuryStorage + toNano('15') + 5n,
            }),
        )

        await treasury.sendRetryBurnAll(halter.getSender(), { value: toNano('0.1'), roundSince: roundSince2 })

        // 2 0 0 | 7 0 0 | 5 0 0

        treasuryBalance = await treasury.getBalance()
        treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(
            treasuryStorage + toNano('14'),
            treasuryStorage + toNano('14') + toNano('0.005'),
        )
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + toNano('14'))
        expect(treasuryState.totalTokens).toBeGramValue(deadShares + toNano('14'))
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        ;[tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('2')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')
        ;[tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(tokens2).toBeGramValue('7')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeGramValue('0')
        ;[tokens3, staking3, unstaking3] = await wallet3.getWalletState()
        expect(tokens3).toBeGramValue('5')
        expect(staking3.keys()).toHaveLength(0)
        expect(unstaking3).toBeGramValue('0')
    })

    it('should handle invalid sends', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        const walletAddress1 = await parent.getWalletAddress(staker1.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(walletAddress1))
        const walletAddress2 = await parent.getWalletAddress(staker2.address)
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(walletAddress2))

        await treasury.sendDepositCoins(staker1.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletFees = await wallet1.getWalletFees()

        const mainnetAddress = await treasury.getLoanAddress(staker1.address, 1n)
        try {
            await parent.getWalletAddress(mainnetAddress)
            throw new Error('failed')
        } catch (e) {
            expect((e as EmulationError).exitCode).toEqual(err.onlyBasechainAllowed)
        }

        expect(
            (
                await wallet1.sendSendTokens(staker2.getSender(), {
                    value: walletFees.sendTokensFee,
                    tokens: '0.05',
                    recipient: staker2.address,
                })
            ).transactions,
        ).toHaveTransaction({ exitCode: err.accessDenied })

        expect(
            (
                await wallet1.sendSendTokens(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    tokens: '0.05',
                    recipient: staker1.address,
                })
            ).transactions,
        ).toHaveTransaction({ exitCode: err.receiverIsSender })

        expect(
            (
                await wallet1.sendSendTokens(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    tokens: '1000',
                    recipient: staker2.address,
                })
            ).transactions,
        ).toHaveTransaction({ exitCode: err.insufficientFunds })

        expect(
            (
                await wallet1.sendSendTokens(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    tokens: 0n,
                    recipient: staker2.address,
                })
            ).transactions,
        ).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0', walletFees.sendTokensFee),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 1,
        })

        expect(
            (
                await wallet1.sendSendTokens(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    tokens: '0.05',
                    recipient: mainnetAddress,
                })
            ).transactions,
        ).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: between('0', walletFees.sendTokensFee),
            body: bodyOp(op.sendTokens),
            success: false,
            exitCode: err.onlyBasechainAllowed,
        })

        expect(
            (
                await wallet1.sendMessage(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    body: beginCell()
                        .storeUint(op.sendTokens, 32)
                        .storeUint(0, 64)
                        .storeCoins(toNano('0.05'))
                        .storeAddress(staker2.address)
                        .storeAddress(null)
                        .storeMaybeRef(null)
                        .storeCoins(0n)
                        .storeSlice(beginCell().endCell().beginParse())
                        .endCell(),
                })
            ).transactions,
        ).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: walletFees.sendTokensFee,
            body: bodyOp(op.sendTokens),
            success: false,
            exitCode: 9,
        })

        expect(
            (
                await wallet1.sendMessage(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    body: beginCell()
                        .storeUint(op.sendTokens, 32)
                        .storeUint(0, 64)
                        .storeCoins(toNano('0.05'))
                        .storeAddress(staker2.address)
                        .storeAddress(null)
                        .storeMaybeRef(null)
                        .storeCoins(0n)
                        .storeSlice(beginCell().storeUint(1, 1).endCell().beginParse())
                        .endCell(),
                })
            ).transactions,
        ).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: walletFees.sendTokensFee,
            body: bodyOp(op.sendTokens),
            success: false,
            exitCode: 9,
        })

        expect(
            (
                await wallet1.sendMessage(staker1.getSender(), {
                    value: walletFees.sendTokensFee,
                    body: beginCell()
                        .storeUint(op.sendTokens, 32)
                        .storeUint(0, 64)
                        .storeCoins(toNano('0.05'))
                        .storeAddress(staker2.address)
                        .storeAddress(null)
                        .storeMaybeRef(null)
                        .storeCoins(0n)
                        .storeSlice(beginCell().storeUint(1, 1).storeRef(Cell.EMPTY).endCell().beginParse())
                        .endCell(),
                })
            ).transactions,
        ).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: walletFees.sendTokensFee,
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
    })

    it('should send tokens with minimum fee', async () => {
        const amount = toNano('10')
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await treasury.sendDepositCoins(staker1.getSender(), { value: amount + fees.depositCoinsFee })
        const wallet1Address = await parent.getWalletAddress(staker1.address)
        const wallet2Address = await parent.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const walletFees = await wallet1.getWalletFees()
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: walletFees.sendTokensFee,
            tokens: '9',
            recipient: staker2.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: walletFees.sendTokensFee,
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0', walletFees.sendTokensFee),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker1.address,
            // value: between('0.001', '0.002'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + amount - 5n, treasuryStorage + amount)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + amount)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens1).toBeGramValue('1')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens2).toBeGramValue('9')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should send tokens to another new wallet', async () => {
        const amount = toNano('10')
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        const excessReceiver = await blockchain.treasury('excessReceiver')
        await treasury.sendDepositCoins(staker1.getSender(), { value: amount + fees.depositCoinsFee })
        const wallet1Address = await parent.getWalletAddress(staker1.address)
        const wallet2Address = await parent.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const walletFees = await wallet1.getWalletFees()
        const fee = walletFees.sendTokensFee + 1n + toNano('0.003') // 0.003 for forwarding notification
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: fee,
            tokens: '9',
            recipient: staker2.address,
            returnExcess: excessReceiver.address,
            forwardTonAmount: 1n,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: fee,
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0', fee),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker2.address,
            value: 1n,
            body: bodyOp(op.transferNotification),
            success: false,
            aborted: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: excessReceiver.address,
            value: between('0.002', '0.003'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(treasuryStorage + amount - 5n, treasuryStorage + amount)
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + amount)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens1).toBeGramValue('1')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens2).toBeGramValue('9')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should send tokens to another existing wallet', async () => {
        const amount1 = toNano('10')
        const amount2 = toNano('5')
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await treasury.sendDepositCoins(staker1.getSender(), { value: amount1 + fees.depositCoinsFee })
        await treasury.sendDepositCoins(staker2.getSender(), { value: amount2 + fees.depositCoinsFee })
        const wallet1Address = await parent.getWalletAddress(staker1.address)
        const wallet2Address = await parent.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const walletFees = await wallet1.getWalletFees()
        const forwardTonAmount = toNano('0.01')
        const forwardPayload = beginCell().storeUint(0, 256).storeUint(0, 56).endCell().beginParse()
        const fee = walletFees.sendTokensFee + forwardTonAmount + toNano('0.003') // 0.003 for forwarding notification
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: fee,
            tokens: '9',
            recipient: staker2.address,
            returnExcess: staker1.address,
            forwardTonAmount,
            forwardPayload,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: fee,
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0', fee),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker2.address,
            value: forwardTonAmount,
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker1.address,
            // value: between('0.006', '0.007'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween(
            treasuryStorage + amount1 + amount2 - 5n,
            treasuryStorage + amount1 + amount2,
        )
        expect(treasuryState.totalCoins).toBeGramValue(deadShares + amount1 + amount2)
        expect(treasuryState.totalTokens).toBeGramValue(treasuryState.totalCoins)
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens1).toBeGramValue('1')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(walletFees.walletStorageFee - 5n, walletFees.walletStorageFee)
        expect(tokens2).toBeGramValue('14')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeGramValue('0')

        accumulateFees(result.transactions)
    })

    it('should send tokens with a payload similar to dedust', async () => {
        const staker = await blockchain.treasury('staker')
        const lp = await blockchain.treasury('lp')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('100') + fees.depositCoinsFee })
        const walletAddress1 = await parent.getWalletAddress(staker.address)
        const walletAddress2 = await parent.getWalletAddress(lp.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(walletAddress1))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(walletAddress2))
        const payload = beginCell().storeBuffer(
            Buffer.from(
                '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
                'hex',
            ),
        )
        const result = await wallet1.sendSendTokens(staker.getSender(), {
            value: '0.5',
            recipient: lp.address,
            tokens: '98.38',
            forwardTonAmount: '0.4',
            forwardPayload: beginCell().storeBit(true).storeRef(payload).endCell().beginParse(),
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet1.address,
            value: toNano('0.5'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0.4', '0.5'),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: lp.address,
            value: toNano('0.4'),
            body: bodyOp(op.transferNotification),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker.address,
            // value: between('0', '0.09'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)
    })

    it('should respond with wallet address', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const queryId = BigInt(Math.floor(Math.random() * Math.pow(2, 64)))
        const expectedBody = beginCell()
            .storeUint(op.takeWalletAddress, 32)
            .storeUint(queryId, 64)
            .storeAddress(walletAddress)
            .storeMaybeRef(beginCell().storeAddress(staker.address))
            .endCell()
        const result = await parent.sendProvideWalletAddress(staker.getSender(), {
            value: '0.1',
            queryId: queryId,
            owner: staker.address,
            includeAddress: true,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: parent.address,
            value: toNano('0.1'),
            body: bodyOp(op.provideWalletAddress),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: expectedBody,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should provide current quote', async () => {
        const fakeState = await treasury.getTreasuryState()
        fakeState.totalCoins = toNano('22000')
        fakeState.totalTokens = toNano('21000')
        const fakeData = treasuryConfigToCell(fakeState)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: await treasury.getBalance(),
            }),
        )
        const dex = await blockchain.treasury('dex')
        const queryId = BigInt(Math.floor(Math.random() * Math.pow(2, 64)))
        const customPayload = beginCell().storeAddress(dex.address).endCell()
        const expectedBody = beginCell()
            .storeUint(op.takeCurrentQuote, 32)
            .storeUint(queryId, 64)
            .storeUint(toNano('22000'), 128)
            .storeUint(toNano('21000'), 128)
            .storeMaybeRef(customPayload)
            .endCell()
        const fee = toNano('0.01')
        const result = await treasury.sendProvideCurrentQuote(dex.getSender(), { value: fee, queryId, customPayload })

        expect(result.transactions).toHaveTransaction({
            from: dex.address,
            to: treasury.address,
            value: fee,
            body: bodyOp(op.provideCurrentQuote),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: dex.address,
            value: between('0', fee),
            body: expectedBody,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })

    it('should withdraw surplus', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendTopUp(staker.getSender(), { value: '20' })
        const result = await wallet.sendWithdrawSurplus(staker.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawSurplus),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('20', '20.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)

        accumulateFees(result.transactions)
    })

    it('should withdraw wrongly sent jettons', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const childWallet = await blockchain.treasury('childWallet')
        const result = await wallet.sendWithdrawJettons(staker.getSender(), {
            value: '0.1',
            childWallet: childWallet.address,
            tokens: 100n,
            customPayload: Cell.EMPTY,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawJettons),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: childWallet.address,
            value: between('0', '0.1'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })

    it('should upgrade wallet to itself when there is no new version', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await wallet.sendUpgradeWallet(staker.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: parent.address,
            value: between('0', '0.2'),
            body: bodyOp(op.proxyMigrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.migrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyMergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet.address,
            value: between('0', '0.1'),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0.001', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(7)

        const [parentTotalTokens] = await parent.getJettonData()
        expect(parentTotalTokens).toBeGramValue('10')

        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(tokens).toBeGramValue('10')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')
    })

    it('should upgrade wallet to new version when there is a new version', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress1 = await parent.getWalletAddress(staker.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(walletAddress1))

        const parent2 = blockchain.openContract(
            Parent.createFromConfig(
                {
                    totalTokens: 0n,
                    treasury: treasury.address,
                    walletCode,
                    content: beginCell().storeUint(2, 2).endCell(),
                },
                parentCode,
            ),
        )
        await parent2.sendDeploy(governor.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), {
            value: '1',
            newParent: parent2.address,
        })

        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('5') + fees.depositCoinsFee })
        const walletAddress2 = await parent2.getWalletAddress(staker.address)
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(walletAddress2))
        expect(wallet2.address.equals(wallet1.address)).toEqual(false)

        const [parentTotalTokens1] = await parent.getJettonData()
        expect(parentTotalTokens1).toBeGramValue('10')

        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('10')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')

        const [parentTotalTokens2] = await parent2.getJettonData()
        expect(parentTotalTokens2).toBeGramValue('5')

        const [tokens2, staking2, unstaking2] = await wallet2.getWalletState()
        expect(tokens2).toBeGramValue('5')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeGramValue('0')

        const result = await wallet1.sendUpgradeWallet(staker.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet1.address,
            value: toNano('0.1'),
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: parent.address,
            value: between('0', '0.11'),
            body: bodyOp(op.proxyMigrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.migrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent2.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyMergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent2.address,
            to: wallet2.address,
            value: between('0', '0.1'),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker.address,
            value: between('0.001', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(7)

        const [parentTotalTokens1After] = await parent.getJettonData()
        expect(parentTotalTokens1After).toBeGramValue('0')

        const [tokens1After, staking1After, unstaking1After] = await wallet1.getWalletState()
        expect(tokens1After).toBeGramValue('0')
        expect(staking1After.keys()).toHaveLength(0)
        expect(unstaking1After).toBeGramValue('0')

        const [parentTotalTokens2After] = await parent2.getJettonData()
        expect(parentTotalTokens2After).toBeGramValue('15')

        const [tokens2After, staking2After, unstaking2After] = await wallet2.getWalletState()
        expect(tokens2After).toBeGramValue('15')
        expect(staking2After.keys()).toHaveLength(0)
        expect(unstaking2After).toBeGramValue('0')
    })

    it('should upgrade wallet to new version when halter decides', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletAddress1 = await parent.getWalletAddress(staker.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(walletAddress1))

        const parent2 = blockchain.openContract(
            Parent.createFromConfig(
                {
                    totalTokens: 0n,
                    treasury: treasury.address,
                    walletCode,
                    content: beginCell().storeUint(2, 2).endCell(),
                },
                parentCode,
            ),
        )
        await parent2.sendDeploy(governor.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), {
            value: '1',
            newParent: parent2.address,
        })

        const walletAddress2 = await parent2.getWalletAddress(staker.address)
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(walletAddress2))
        expect(wallet2.address.equals(wallet1.address)).toEqual(false)

        const [parentTotalTokens1] = await parent.getJettonData()
        expect(parentTotalTokens1).toBeGramValue('10')

        const [tokens1, staking1, unstaking1] = await wallet1.getWalletState()
        expect(tokens1).toBeGramValue('10')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeGramValue('0')

        const [parentTotalTokens2] = await parent2.getJettonData()
        expect(parentTotalTokens2).toBeGramValue('0')

        const result = await treasury.sendSendUpgradeWallet(halter.getSender(), {
            value: '0.1',
            destination: parent.address,
            owner: staker.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: halter.address,
            to: treasury.address,
            value: toNano('0.1'),
            body: bodyOp(op.sendUpgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyUpgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: parent.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyMigrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent.address,
            to: treasury.address,
            value: between('0', '0.1'),
            body: bodyOp(op.migrateWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent2.address,
            value: between('0', '0.1'),
            body: bodyOp(op.proxyMergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: parent2.address,
            to: wallet2.address,
            value: between('0', '0.1'),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker.address,
            value: between('0.001', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(9)

        const [parentTotalTokens1After] = await parent.getJettonData()
        expect(parentTotalTokens1After).toBeGramValue('0')

        const [tokens1After, staking1After, unstaking1After] = await wallet1.getWalletState()
        expect(tokens1After).toBeGramValue('0')
        expect(staking1After.keys()).toHaveLength(0)
        expect(unstaking1After).toBeGramValue('0')

        const [parentTotalTokens2After] = await parent2.getJettonData()
        expect(parentTotalTokens2After).toBeGramValue('10')

        const [tokens2After, staking2After, unstaking2After] = await wallet2.getWalletState()
        expect(tokens2After).toBeGramValue('10')
        expect(staking2After.keys()).toHaveLength(0)
        expect(unstaking2After).toBeGramValue('0')
    })
})
