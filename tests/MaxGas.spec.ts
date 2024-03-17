/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { compile } from '@ton/blueprint'
import { Blockchain, BlockchainTransaction, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import {
    accumulateFees,
    between,
    bodyOp,
    createNewStakeMsg,
    createVset,
    emptyNewStakeMsg,
    getElector,
    logTotalFees,
    setConfig,
} from './helper'
import { config, op } from '../wrappers/common'
import {
    Participation,
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Parent, parentConfigToCell } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Wallet, walletConfigToCell } from '../wrappers/Wallet'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Loan } from '../wrappers/Loan'

const count = 100
const gasUsed: Record<string, bigint> = {}
const muteLogComputeGas = false

const loanKeys = [
    'request_loan',
    'participate_in_election',
    'decide_loan_requests',
    'process_loan_requests',
    'proxy_new_stake',
    'vset_changed',
    'finish_participation',
    'recover_stakes',
    'proxy_recover_stake',
    'recover_stake_result',
    'burn_all',
    'last_bill_burned',
    'new_stake',
    'new_stake_error',
    'new_stake_ok',
    'recover_stake',
    'recover_stake_ok',
]

describe('Max Gas', () => {
    let electorCode: Cell
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell
    let mainWalletCode: Cell
    let mainCollectionCode: Cell
    let mainBillCode: Cell
    let mainLoanCode: Cell
    let participations: Dictionary<bigint, Participation>
    let loanCodes: Dictionary<bigint, Cell>
    let collectionCodes: Dictionary<bigint, Cell>
    let billCodes: Dictionary<bigint, Cell>
    let oldParents: Dictionary<bigint, unknown>

    afterAll(() => {
        logTotalFees()

        logComputeGas([
            'send_tokens',
            'receive_tokens',
            'deposit_coins',
            'proxy_save_coins',
            'save_coins',
            'mint_bill',
            'assign_bill',
            'burn_bill',
            'bill_burned',
            'mint_tokens',
            'proxy_tokens_minted',
            'tokens_minted',
            'unstake_tokens',
            'proxy_reserve_tokens',
            'reserve_tokens',
            'burn_tokens',
            'proxy_tokens_burned',
            'tokens_burned',
            'send_unstake_all',
            'proxy_unstake_all',
            'unstake_all',
            'upgrade_wallet',
            'proxy_migrate_wallet',
            'migrate_wallet',
            'proxy_merge_wallet',
            'merge_wallet',
        ])

        logComputeGas(loanKeys)

        logUnknownGas()
    })

    beforeAll(async () => {
        electorCode = await compile('elector-test/Elector')
        treasuryCode = await compile('Treasury')
        parentCode = await compile('Parent')
        mainWalletCode = await compile('Wallet')
        mainCollectionCode = await compile('Collection')
        mainBillCode = await compile('Bill')
        mainLoanCode = await compile('Loan')
        walletCode = exportLibCode(mainWalletCode)
        collectionCode = exportLibCode(mainCollectionCode)
        billCode = exportLibCode(mainBillCode)
        loanCode = exportLibCode(mainLoanCode)
        blockchainLibs = buildBlockchainLibraries([mainWalletCode, mainCollectionCode, mainBillCode, mainLoanCode])

        participations = Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue)
            .set(10n, { state: ParticipationState.Burning })
            .set(20n, { state: ParticipationState.Open })
            .set(30n, { state: ParticipationState.Validating })
            .set(40n, { state: ParticipationState.Held })
            .set(50n, { state: ParticipationState.Distributing })
            .set(60n, { state: ParticipationState.Recovering })
            .set(70n, { state: ParticipationState.Open })

        loanCodes = Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell())
            .set(10n, loanCode)
            .set(20n, loanCode)
            .set(30n, loanCode)
            .set(40n, loanCode)
            .set(50n, loanCode)

        collectionCodes = Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell())
            .set(10n, collectionCode)
            .set(20n, collectionCode)
            .set(30n, collectionCode)
            .set(40n, collectionCode)
            .set(50n, collectionCode)
            .set(60n, collectionCode)
            .set(70n, collectionCode)

        billCodes = Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell())
            .set(10n, billCode)
            .set(20n, billCode)
            .set(30n, billCode)
            .set(40n, billCode)
            .set(50n, billCode)
            .set(60n, billCode)
            .set(70n, billCode)

        oldParents = Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue)
            .set(10n, beginCell())
            .set(20n, beginCell())
            .set(30n, beginCell())
            .set(40n, beginCell())
            .set(50n, beginCell())
            .set(60n, beginCell())
            .set(70n, beginCell())
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
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
                    totalCoins: 0n,
                    totalTokens: 0n,
                    totalStaking: 0n,
                    totalUnstaking: 0n,
                    totalBorrowersStake: 0n,
                    parent: null,
                    participations,
                    roundsImbalance: 255n,
                    stopped: false,
                    instantMint: false,
                    loanCodes,
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    collectionCodes,
                    billCodes,
                    oldParents,
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

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10' })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue('10')

        electorAddress = getElector(blockchain)
    })

    it('should find max gas for wallet', async () => {
        // simulated conditions:
        // - larger than usual participations dict
        // - larger than usual staking dict
        // - larger than usual collection_codes
        // - larger than usual bill_codes
        // - larger than usual old_parents

        // deposit

        const staker = await blockchain.treasury('staker')
        const collectionAddress1 = await treasury.getCollectionAddress(60n)
        const walletAddress1 = await parent.getWalletAddress(staker.address)
        const staking = Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4))
            .set(10n, 10n)
            .set(20n, 20n)
            .set(30n, 30n)
            .set(40n, 40n)
            .set(50n, 50n)
            .set(60n, 60n)
            .set(70n, 70n)
        const fakeData = walletConfigToCell({
            owner: staker.address,
            parent: parent.address,
            tokens: 0n,
            staking,
            unstaking: 0n,
        })
        await blockchain.setShardAccount(
            walletAddress1,
            createShardAccount({
                workchain: 0,
                address: walletAddress1,
                code: walletCode,
                data: fakeData,
                balance: 0n,
            }),
        )

        const result1 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('10') + fees.depositCoinsFee + toNano('0.01'),
            ownershipAssignedAmount: toNano('0.01'),
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
            from: treasury.address,
            to: collectionAddress1,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.mintBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result1.transactions).not.toHaveTransaction({ success: false })
        expect(result1.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result1.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result1.transactions).toHaveLength(7)

        accumulateFees(result1.transactions)
        storeComputeGas('deposit_coins', op.depositCoins, result1.transactions[1])
        storeComputeGas('proxy_save_coins', op.proxySaveCoins, result1.transactions[2])
        storeComputeGas('save_coins', op.saveCoins, result1.transactions[4])
        storeComputeGas('mint_bill', op.mintBill, result1.transactions[3])
        storeComputeGas('assign_bill', op.assignBill, result1.transactions[5])

        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('4') + fees.depositCoinsFee })
        const treasuryState1 = await treasury.getTreasuryState()
        treasuryState1.participations.set(60n, { state: ParticipationState.Burning })
        const fakeData1 = treasuryConfigToCell(treasuryState1)
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

        const result2 = await treasury.sendRetryBurnAll(governor.getSender(), { value: '0.2', roundSince: 60n })
        expect(result2.transactions).toHaveTransaction({
            from: parent.address,
            to: walletAddress1,
            value: between('0', '0.1'),
            body: bodyOp(op.tokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).not.toHaveTransaction({ success: false })
        expect(result2.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result2.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result2.transactions).toHaveLength(16)

        accumulateFees(result2.transactions)
        storeComputeGas('burn_bill', op.burnBill, result2.transactions[3])
        storeComputeGas('bill_burned', op.billBurned, result2.transactions[4])
        storeComputeGas('burn_bill', op.burnBill, result2.transactions[5])
        storeComputeGas('mint_tokens', op.mintTokens, result2.transactions[6])
        storeComputeGas('bill_burned', op.billBurned, result2.transactions[7])
        storeComputeGas('proxy_tokens_minted', op.proxyTokensMinted, result2.transactions[8])
        storeComputeGas('mint_tokens', op.mintTokens, result2.transactions[10])
        storeComputeGas('tokens_minted', op.tokensMinted, result2.transactions[11])
        storeComputeGas('proxy_tokens_minted', op.proxyTokensMinted, result2.transactions[12])
        storeComputeGas('tokens_minted', op.tokensMinted, result2.transactions[14])

        await treasury.sendSetInstantMint(governor.getSender(), { value: '0.1', newInstantMint: true })

        const result3 = await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('5') + fees.depositCoinsFee,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: parent.address,
            value: between('0', fees.depositCoinsFee),
            body: bodyOp(op.proxyTokensMinted),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).not.toHaveTransaction({ success: false })
        expect(result3.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result3.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result3.transactions).toHaveLength(5)

        accumulateFees(result3.transactions)
        storeComputeGas('deposit_coins', op.depositCoins, result3.transactions[1])
        storeComputeGas('proxy_tokens_minted', op.proxyTokensMinted, result3.transactions[2])
        storeComputeGas('tokens_minted', op.tokensMinted, result3.transactions[3])

        // send

        const wallet1 = blockchain.openContract(Wallet.createFromAddress(walletAddress1))
        const walletFees = await wallet1.getWalletFees()
        const someone = await blockchain.treasury('someone')
        const walletAddress2 = await parent.getWalletAddress(someone.address)
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(walletAddress2))
        const forwardPayload = beginCell()
            .storeUint(0, 256)
            .storeUint(0, 56)
            .storeRef(treasuryCode)
            .endCell()
            .beginParse()

        const result4 = await wallet1.sendSendTokens(staker.getSender(), {
            value: walletFees.sendTokensFee + toNano('0.05') + toNano('0.167'), // 0.167 for forwarding payload
            tokens: '1',
            recipient: someone.address,
            customPayload: parentCode,
            forwardTonAmount: '0.05',
            forwardPayload,
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0', walletFees.sendTokensFee + toNano('0.05') + toNano('0.167')),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
        expect(result4.transactions).not.toHaveTransaction({ success: false })
        expect(result4.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result4.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result4.transactions).toHaveLength(5)

        accumulateFees(result4.transactions)
        storeComputeGas('send_tokens', op.sendTokens, result4.transactions[1])
        storeComputeGas('receive_tokens', op.receiveTokens, result4.transactions[2])

        const result5 = await wallet2.sendSendTokens(someone.getSender(), {
            value: walletFees.sendTokensFee,
            tokens: '1',
            recipient: staker.address,
        })
        expect(result5.transactions).toHaveTransaction({
            from: wallet2.address,
            to: wallet1.address,
            value: between('0', walletFees.sendTokensFee),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).not.toHaveTransaction({ success: false })
        expect(result5.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result5.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result5.transactions).toHaveLength(4)

        accumulateFees(result5.transactions)
        storeComputeGas('send_tokens', op.sendTokens, result5.transactions[1])
        storeComputeGas('receive_tokens', op.receiveTokens, result5.transactions[2])

        // unstake

        const [tokens1] = await wallet1.getWalletState()
        const treasuryState2 = await treasury.getTreasuryState()
        const fakeData2 = treasuryConfigToCell(treasuryState2)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: toNano('10') + tokens1 + 10n,
            }),
        )
        const result6 = await wallet1.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.01'),
            tokens: tokens1,
            ownershipAssignedAmount: toNano('0.01'),
        })
        expect(result6.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet1.address,
            value: between(tokens1, tokens1 + walletFees.unstakeTokensFee + toNano('0.01')),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result6.transactions).not.toHaveTransaction({ success: false })
        expect(result6.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result6.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result6.transactions).toHaveLength(7)

        accumulateFees(result6.transactions)
        storeComputeGas('unstake_tokens', op.unstakeTokens, result6.transactions[1])
        storeComputeGas('proxy_reserve_tokens', op.proxyReserveTokens, result6.transactions[2])
        storeComputeGas('reserve_tokens', op.reserveTokens, result6.transactions[3])
        storeComputeGas('proxy_tokens_burned', op.proxyTokensBurned, result6.transactions[4])
        storeComputeGas('tokens_burned', op.tokensBurned, result6.transactions[5])

        await treasury.sendDepositCoins(staker.getSender(), { value: tokens1 + fees.depositCoinsFee })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: toNano('10') + tokens1 - 10n,
            }),
        )
        const collectionAddress2 = await treasury.getCollectionAddress(30n)
        const result7 = await wallet1.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee + toNano('0.1') + toNano('2'),
            tokens: tokens1,
            ownershipAssignedAmount: toNano('0.1'),
        })
        expect(result7.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress2,
            value: between('0', walletFees.unstakeTokensFee + toNano('0.1') + toNano('2')),
            body: bodyOp(op.mintBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result7.transactions).not.toHaveTransaction({ success: false })
        expect(result7.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result7.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result7.transactions).toHaveLength(7)

        accumulateFees(result7.transactions)
        storeComputeGas('unstake_tokens', op.unstakeTokens, result7.transactions[1])
        storeComputeGas('proxy_reserve_tokens', op.proxyReserveTokens, result7.transactions[2])
        storeComputeGas('reserve_tokens', op.reserveTokens, result7.transactions[3])
        storeComputeGas('mint_bill', op.mintBill, result7.transactions[4])
        storeComputeGas('assign_bill', op.assignBill, result7.transactions[5])

        const treasuryState3 = await treasury.getTreasuryState()
        treasuryState3.participations.set(30n, { state: ParticipationState.Burning })
        treasuryState3.participations.set(40n, { state: ParticipationState.Burning })
        treasuryState3.participations.set(50n, { state: ParticipationState.Burning })
        treasuryState3.participations.set(60n, { state: ParticipationState.Burning })
        treasuryState3.participations.set(70n, { state: ParticipationState.Recovering })
        const fakeData3 = treasuryConfigToCell(treasuryState3)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData3,
                balance: toNano('10'),
            }),
        )

        const collectionAddress3 = await treasury.getCollectionAddress(70n)
        const result8 = await treasury.sendRetryBurnAll(halter.getSender(), { value: '0.1', roundSince: 30n })
        expect(result8.transactions).toHaveTransaction({
            from: treasury.address,
            to: collectionAddress3,
            value: between('0', walletFees.unstakeTokensFee + toNano('2')),
            body: bodyOp(op.mintBill),
            success: true,
            outMessagesCount: 1,
        })
        expect(result8.transactions).not.toHaveTransaction({ success: false })
        expect(result8.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result8.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result8.transactions).toHaveLength(9)

        accumulateFees(result8.transactions)
        storeComputeGas('burn_bill', op.burnBill, result8.transactions[3])
        storeComputeGas('bill_burned', op.billBurned, result8.transactions[4])
        storeComputeGas('burn_tokens', op.burnTokens, result8.transactions[6])
        storeComputeGas('mint_bill', op.mintBill, result8.transactions[7])
        storeComputeGas('assign_bill', op.assignBill, result8.transactions[8])

        const treasuryState4 = await treasury.getTreasuryState()
        treasuryState4.participations.set(70n, { state: ParticipationState.Burning })
        const fakeData4 = treasuryConfigToCell(treasuryState4)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData4,
                balance: toNano('10') + tokens1 + 10n,
            }),
        )

        const result9 = await treasury.sendRetryBurnAll(halter.getSender(), { value: '0.1', roundSince: 70n })
        expect(result9.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet1.address,
            value: between(tokens1, tokens1 + walletFees.unstakeTokensFee + toNano('2')),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result9.transactions).not.toHaveTransaction({ success: false })
        expect(result9.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result9.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result9.transactions).toHaveLength(10)

        accumulateFees(result9.transactions)
        storeComputeGas('burn_bill', op.burnBill, result9.transactions[3])
        storeComputeGas('bill_burned', op.billBurned, result9.transactions[4])
        storeComputeGas('burn_tokens', op.burnTokens, result9.transactions[6])
        storeComputeGas('proxy_tokens_burned', op.proxyTokensBurned, result9.transactions[7])
        storeComputeGas('tokens_burned', op.tokensBurned, result9.transactions[8])

        // unstake all

        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('3') + fees.depositCoinsFee })
        const result10 = await treasury.sendMessage(staker.getSender(), { value: fees.unstakeAllTokensFee, body: 'w' })
        expect(result10.transactions).toHaveTransaction({
            from: parent.address,
            to: wallet1.address,
            value: between('3', toNano('3') + fees.unstakeAllTokensFee),
            body: bodyOp(op.tokensBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result10.transactions).not.toHaveTransaction({ success: false })
        expect(result10.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result10.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result10.transactions).toHaveLength(10)

        accumulateFees(result10.transactions)
        storeComputeGas('send_unstake_all', op.sendUnstakeAll, result10.transactions[1])
        storeComputeGas('proxy_unstake_all', op.proxyUnstakeAll, result10.transactions[2])
        storeComputeGas('unstake_all', op.unstakeAll, result10.transactions[3])
        storeComputeGas('unstake_tokens', op.unstakeTokens, result10.transactions[4])
        storeComputeGas('proxy_reserve_tokens', op.proxyReserveTokens, result10.transactions[5])
        storeComputeGas('reserve_tokens', op.reserveTokens, result10.transactions[6])
        storeComputeGas('proxy_tokens_burned', op.proxyTokensBurned, result10.transactions[7])
        storeComputeGas('tokens_burned', op.tokensBurned, result10.transactions[8])

        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('2') + fees.depositCoinsFee })
        const result11 = await wallet1.sendMessage(staker.getSender(), { value: '0.2', body: 'W' })
        expect(result11.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet1.address,
            value: between('0', '0.2'),
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })
        expect(result11.transactions).not.toHaveTransaction({ success: false })
        expect(result11.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result11.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result11.transactions).toHaveLength(8)

        accumulateFees(result11.transactions)
        storeComputeGas('unstake_all', op.unstakeAll, result11.transactions[1])
        storeComputeGas('unstake_tokens', op.unstakeTokens, result11.transactions[2])
        storeComputeGas('proxy_reserve_tokens', op.proxyReserveTokens, result11.transactions[3])
        storeComputeGas('reserve_tokens', op.reserveTokens, result11.transactions[4])
        storeComputeGas('proxy_tokens_burned', op.proxyTokensBurned, result11.transactions[5])
        storeComputeGas('tokens_burned', op.tokensBurned, result11.transactions[6])

        // upgrade wallet

        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('6') + fees.depositCoinsFee })
        const newParentAddress = (await blockchain.treasury('new parent')).address
        await blockchain.setShardAccount(
            newParentAddress,
            createShardAccount({
                workchain: 0,
                address: newParentAddress,
                code: parentCode,
                data: parentConfigToCell({
                    totalTokens: 0n,
                    treasury: treasury.address,
                    walletCode,
                    content: Cell.EMPTY,
                }),
                balance: toNano('0.01'),
            }),
        )
        const newParent = blockchain.openContract(Parent.createFromAddress(newParentAddress))
        const newWalletAddress = await newParent.getWalletAddress(staker.address)
        await treasury.sendSetParent(governor.getSender(), { value: '0.1', newParent: newParent.address })

        const result12 = await wallet1.sendUpgradeWallet(staker.getSender(), {
            value: walletFees.upgradeWalletFee,
        })
        expect(result12.transactions).toHaveTransaction({
            from: newParentAddress,
            to: newWalletAddress,
            value: between('0', walletFees.upgradeWalletFee),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 0,
        })
        expect(result12.transactions).not.toHaveTransaction({ success: false })
        expect(result12.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result12.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(result12.transactions).toHaveLength(6)

        accumulateFees(result12.transactions)
        storeComputeGas('upgrade_wallet', op.upgradeWallet, result12.transactions[1])
        storeComputeGas('proxy_migrate_wallet', op.proxyMigrateWallet, result12.transactions[2])
        storeComputeGas('migrate_wallet', op.migrateWallet, result12.transactions[3])
        storeComputeGas('proxy_merge_wallet', op.proxyMergeWallet, result12.transactions[4])
        storeComputeGas('merge_wallet', op.mergeWallet, result12.transactions[5])
    })

    it('should handle a single loan request to log compute gas', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), {
            value: toNano('300000') + fees.depositCoinsFee + toNano('0.1'),
        })

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

        const borrower = await blockchain.treasury('borrower')
        const loanAddress = await treasury.getLoanAddress(borrower.address, until1)
        const loan = blockchain.openContract(Loan.createFromAddress(loanAddress))
        const newStakeMsg = await createNewStakeMsg(loan.address, until1)
        const result1 = await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('1151') + fees.requestLoanFee, // 1000 (stake) + 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result2 = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan.address,
            value: between('301151', '301152'),
            body: bodyOp(op.proxyNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan.address.hash.toString('hex')), toNano('350260'))
        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
                balance: toNano('350260') + toNano('350270') + toNano('1'),
            }),
        )

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        const result3 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result3.transactions).toHaveLength(1)

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        const result4 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result4.transactions).toHaveLength(1)

        const state1 = await treasury.getTreasuryState()
        const participation1 = state1.participations.get(until1) ?? {}
        participation1.stakeHeldUntil = 0n // set stake_held_until to zero
        state1.participations.set(until1, participation1)
        const fakeData1 = treasuryConfigToCell(state1)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData1,
                balance: toNano('10'),
            }),
        )
        const result5 = await treasury.sendFinishParticipation({ roundSince: until1 })

        expect(result5.transactions).toHaveTransaction({
            to: treasury.address,
            body: bodyOp(op.lastBillBurned),
            success: true,
            outMessagesCount: 1,
        })
        expect(result5.transactions).toHaveLength(10)
        expect(result5.externals).toHaveLength(2)

        const state2 = await treasury.getTreasuryState()
        const participation2 = state2.participations.get(60n) ?? {}
        participation2.state = ParticipationState.Burning
        state2.participations.set(60n, participation2)
        state2.participations.set(until1 - 10n, { state: ParticipationState.Validating })
        state2.participations.set(until1 - 20n, { state: ParticipationState.Open })
        const fakeData2 = treasuryConfigToCell(state2)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData2,
                balance: toNano('10'),
            }),
        )
        const result6 = await treasury.sendRetryBurnAll(governor.getSender(), { value: toNano('0.1'), roundSince: 60n })

        accumulateFees(result1.transactions)
        accumulateFees(result2.transactions)
        accumulateFees(result3.transactions)
        accumulateFees(result4.transactions)
        accumulateFees(result5.transactions)
        storeComputeGas('request_loan', op.requestLoan, result1.transactions[1])
        storeComputeGas('participate_in_election', op.participateInElection, result2.transactions[0])
        storeComputeGas('decide_loan_requests', op.decideLoanRequests, result2.transactions[1])
        storeComputeGas('process_loan_requests', op.processLoanRequests, result2.transactions[2])
        storeComputeGas('proxy_new_stake', op.proxyNewStake, result2.transactions[3])
        storeComputeGas('vset_changed', op.vsetChanged, result3.transactions[0])
        storeComputeGas('finish_participation', op.finishParticipation, result5.transactions[0])
        storeComputeGas('recover_stakes', op.recoverStakes, result5.transactions[1])
        storeComputeGas('proxy_recover_stake', op.proxyRecoverStake, result5.transactions[2])
        storeComputeGas('recover_stake_result', op.recoverStakeResult, result5.transactions[5])
        storeComputeGas('burn_all', op.burnAll, result6.transactions[2])
        storeComputeGas('last_bill_burned', op.lastBillBurned, result6.transactions[5])
        storeComputeGas('new_stake', op.newStake, result2.transactions[4])
        storeComputeGas('new_stake_ok', op.newStakeOk, result2.transactions[5])
        storeComputeGas('recover_stake', op.recoverStake, result5.transactions[3])
        storeComputeGas('recover_stake_ok', op.recoverStakeOk, result5.transactions[4])
    })

    it('should find max gas for loan when all requests are in the same bucket', async () => {
        let gas: Record<string, [bigint, BlockchainTransaction] | undefined> = {}

        const maxValidators = beginCell().storeUint(count, 16).storeUint(count, 16).storeUint(count, 16).endCell()
        setConfig(blockchain, config.validators, maxValidators)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

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

        const borrower1 = await blockchain.treasury('borrower1')
        const borrower2 = await blockchain.treasury('borrower2')
        const loanAddress1 = await treasury.getLoanAddress(borrower1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(borrower2.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })

        const result1 = await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        expect(result1.transactions).toHaveLength(2)
        gas = accumulateUsedGas(gas, result1.transactions)

        const state = await treasury.getTreasuryState()
        state.totalCoins = 1n
        state.totalTokens = 1n
        const sorted = state.participations.get(until1)?.sorted
        const requests = state.participations.get(until1)?.requests
        if (sorted == null || requests == null) {
            throw new Error('unexpected empty sorted or requests dicts')
        }
        const request = {
            minPayment: toNano('50'),
            borrowerRewardShare: 102n,
            loanAmount: toNano('300000'),
            accrueAmount: 0n,
            stakeAmount: toNano('151'),
            newStakeMsg: emptyNewStakeMsg,
        }
        const bucket = sorted.get(sorted.keys()[0])
        if (bucket == null) {
            throw new Error('unexpected empty bucket')
        }
        for (const i of Array(count - 1).keys()) {
            bucket.set(BigInt(i), Buffer.from([]))
            requests.set(BigInt(i), request)
        }
        sorted.set(sorted.keys()[0], bucket)
        const participation: Participation = {
            state: ParticipationState.Open,
            size: BigInt(count),
            sorted,
            requests,
        }
        state.participations.set(until1, participation)
        state.participations.set(until1 + 10n, { state: ParticipationState.Validating })
        state.participations.set(until1 + 20n, { state: ParticipationState.Held })
        state.totalBorrowersStake = state.totalBorrowersStake + toNano('151') * BigInt(count - 1)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: (await treasury.getBalance()) + toNano('300151') * BigInt(count),
            }),
        )

        const result2 = await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        expect(result2.transactions).toHaveLength(2)
        gas = accumulateUsedGas(gas, result2.transactions)

        const result3 = await treasury.sendRequestLoan(borrower2.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        expect(result3.transactions).toHaveLength(3)
        gas = accumulateUsedGas(gas, result3.transactions)

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result4 = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result4.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: (x) => x >= Math.min(count * 2, 100) && x <= Math.min(count * 2, 255),
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.loanResult),
            aborted: true, // borrower account is dummy and not initialized
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.proxyNewStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            to: electorAddress,
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: electorAddress,
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })

        let sendNewStakeCount = 0n
        let requestRejectedCount = 0n
        for (const tx of result4.transactions) {
            const bodyOp = tx.inMessage?.body.beginParse().loadUint(32)
            if (bodyOp === op.proxyNewStake) {
                sendNewStakeCount += 1n
            } else if (bodyOp === op.requestRejected) {
                requestRejectedCount += 1n
            }
        }
        expect(sendNewStakeCount).toEqual(BigInt(count))
        expect(requestRejectedCount).toEqual(0n)

        gas = accumulateUsedGas(gas, result4.transactions)

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        const result5 = await treasury.sendVsetChanged({ roundSince: until1 })

        gas = accumulateUsedGas(gas, result5.transactions)

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        const result6 = await treasury.sendVsetChanged({ roundSince: until1 })

        gas = accumulateUsedGas(gas, result6.transactions)

        accumulateFees(result4.transactions)
        storeComputeGas('request_loan', op.requestLoan, (gas[op.requestLoan] ?? [])[1])
        storeComputeGas('participate_in_election', op.participateInElection, (gas[op.participateInElection] ?? [])[1])
        storeComputeGas('proxy_new_stake', op.proxyNewStake, (gas[op.proxyNewStake] ?? [])[1])
        storeComputeGas('new_stake', op.newStake, (gas[op.newStake] ?? [])[1])
        storeComputeGas('new_stake_ok', op.newStakeOk, (gas[op.newStakeOk] ?? [])[1])
        storeComputeGas('new_stake_error', op.newStakeError, (gas[op.newStakeError] ?? [])[1])
        storeComputeGas('recover_stake_result', op.recoverStakeResult, (gas[op.recoverStakeResult] ?? [])[1])
        storeComputeGas('vset_changed', op.vsetChanged, (gas[op.vsetChanged] ?? [])[1])
        storeAverageGas(result4.transactions)
    })

    it('should find max gas for loan when all requests are in different buckets', async () => {
        let gas: Record<string, [bigint, BlockchainTransaction] | undefined> = {}

        const maxValidators = beginCell().storeUint(count, 16).storeUint(count, 16).storeUint(count, 16).endCell()
        setConfig(blockchain, config.validators, maxValidators)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

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

        const borrower1 = await blockchain.treasury('borrower1')
        const borrower2 = await blockchain.treasury('borrower2')
        const loanAddress1 = await treasury.getLoanAddress(borrower1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(borrower2.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })

        const result1 = await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        expect(result1.transactions).toHaveLength(2)
        gas = accumulateUsedGas(gas, result1.transactions)

        const state = await treasury.getTreasuryState()
        state.totalCoins = 1n
        state.totalTokens = 1n
        const sorted = state.participations.get(until1)?.sorted
        const requests = state.participations.get(until1)?.requests
        if (sorted == null || requests == null) {
            throw new Error('unexpected empty sorted or requests dicts')
        }
        const request = {
            minPayment: toNano('50'),
            borrowerRewardShare: 102n,
            loanAmount: toNano('300000'),
            accrueAmount: 0n,
            stakeAmount: toNano('151'),
            newStakeMsg: emptyNewStakeMsg,
        }
        for (const i of Array(count - 1).keys()) {
            const bucketSingle = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Buffer(0))
            bucketSingle.set(BigInt(i), Buffer.from([]))
            sorted.set(BigInt(i), bucketSingle.set(BigInt(i), Buffer.from([])))
            requests.set(BigInt(i), request)
        }
        const participation: Participation = {
            state: ParticipationState.Open,
            size: BigInt(count),
            sorted,
            requests,
        }
        state.participations.set(until1, participation)
        state.participations.set(until1 + 10n, { state: ParticipationState.Validating })
        state.participations.set(until1 + 20n, { state: ParticipationState.Held })
        state.totalBorrowersStake = state.totalBorrowersStake + toNano('151') * BigInt(count - 1)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: (await treasury.getBalance()) + toNano('300151') * BigInt(count),
            }),
        )

        const result2 = await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        expect(result2.transactions).toHaveLength(2)
        gas = accumulateUsedGas(gas, result2.transactions)

        const result3 = await treasury.sendRequestLoan(borrower2.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        expect(result3.transactions).toHaveLength(3)
        gas = accumulateUsedGas(gas, result3.transactions)

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result4 = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result4.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: (x) => x >= Math.min(count * 2, 100) && x <= Math.min(count * 2, 255),
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.loanResult),
            aborted: true, // borrower account is dummy and not initialized
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.proxyNewStake),
            success: true,
            outMessagesCount: 1,
        })

        let sendNewStakeCount = 0n
        let requestRejectedCount = 0n
        for (const tx of result4.transactions) {
            const bodyOp = tx.inMessage?.body.beginParse().loadUint(32)
            if (bodyOp === op.proxyNewStake) {
                sendNewStakeCount += 1n
            } else if (bodyOp === op.requestRejected) {
                requestRejectedCount += 1n
            }
        }
        expect(sendNewStakeCount).toEqual(BigInt(count))
        expect(requestRejectedCount).toEqual(0n)

        gas = accumulateUsedGas(gas, result4.transactions)

        accumulateFees(result4.transactions)
        storeComputeGas('request_loan', op.requestLoan, (gas[op.requestLoan] ?? [])[1])
        storeComputeGas('participate_in_election', op.participateInElection, (gas[op.participateInElection] ?? [])[1])
        storeComputeGas('proxy_new_stake', op.proxyNewStake, (gas[op.proxyNewStake] ?? [])[1])
        storeComputeGas('new_stake', op.newStake, (gas[op.newStake] ?? [])[1])
        storeComputeGas('new_stake_ok', op.newStakeOk, (gas[op.newStakeOk] ?? [])[1])
        storeComputeGas('new_stake_error', op.newStakeError, (gas[op.newStakeError] ?? [])[1])
        storeComputeGas('recover_stake_result', op.recoverStakeResult, (gas[op.recoverStakeResult] ?? [])[1])
        storeAverageGas(result4.transactions)
    })

    it('should find max gas for loan when all requests are rejected', async () => {
        let gas: Record<string, [bigint, BlockchainTransaction] | undefined> = {}

        const maxValidators = beginCell().storeUint(count, 16).storeUint(count, 16).storeUint(count, 16).endCell()
        setConfig(blockchain, config.validators, maxValidators)

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

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

        const borrower1 = await blockchain.treasury('borrower1')
        const borrower2 = await blockchain.treasury('borrower2')
        const loanAddress1 = await treasury.getLoanAddress(borrower1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(borrower2.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })

        const result1 = await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        expect(result1.transactions).toHaveLength(2)
        gas = accumulateUsedGas(gas, result1.transactions)

        const state = await treasury.getTreasuryState()
        state.totalCoins = 1n
        state.totalTokens = 1n
        const sorted = state.participations.get(until1)?.sorted
        const requests = state.participations.get(until1)?.requests
        if (sorted == null || requests == null) {
            throw new Error('unexpected empty sorted or requests dicts')
        }
        const request = {
            minPayment: toNano('50'),
            borrowerRewardShare: 102n,
            loanAmount: toNano('300000'),
            accrueAmount: 0n,
            stakeAmount: toNano('151'),
            newStakeMsg: emptyNewStakeMsg,
        }
        for (const i of Array(count - 1).keys()) {
            const bucketSingle = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Buffer(0))
            bucketSingle.set(BigInt(i), Buffer.from([]))
            sorted.set(BigInt(i), bucketSingle.set(BigInt(i), Buffer.from([])))
            requests.set(BigInt(i), request)
        }
        const participation: Participation = {
            state: ParticipationState.Open,
            size: BigInt(count),
            sorted,
            requests,
        }
        state.participations.set(until1, participation)
        state.participations.set(until1 + 10n, { state: ParticipationState.Validating })
        state.participations.set(until1 + 20n, { state: ParticipationState.Held })
        state.totalBorrowersStake = state.totalBorrowersStake + toNano('151') * BigInt(count - 1)
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
                balance: (await treasury.getBalance()) + toNano('151') * BigInt(count),
            }),
        )

        const result2 = await treasury.sendRequestLoan(borrower1.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        expect(result2.transactions).toHaveLength(2)
        gas = accumulateUsedGas(gas, result2.transactions)

        const result3 = await treasury.sendRequestLoan(borrower2.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        expect(result3.transactions).toHaveLength(3)
        gas = accumulateUsedGas(gas, result3.transactions)

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result4 = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result4.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.decideLoanRequests),
            success: true,
            outMessagesCount: 1,
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: (x) => x >= Math.min(count, 100) && x <= Math.min(count, 255),
        })
        expect(result4.transactions).toHaveTransaction({
            from: treasury.address,
            body: bodyOp(op.requestRejected),
            aborted: true, // borrower account is dummy and not initialized
        })

        let sendNewStakeCount = 0n
        let requestRejectedCount = 0n
        for (const tx of result4.transactions) {
            const bodyOp = tx.inMessage?.body.beginParse().loadUint(32)
            if (bodyOp === op.proxyNewStake) {
                sendNewStakeCount += 1n
            } else if (bodyOp === op.requestRejected) {
                requestRejectedCount += 1n
            }
        }
        expect(sendNewStakeCount).toEqual(0n)
        expect(requestRejectedCount).toEqual(BigInt(count))

        gas = accumulateUsedGas(gas, result4.transactions)

        accumulateFees(result4.transactions)
        storeComputeGas('request_loan', op.requestLoan, (gas[op.requestLoan] ?? [])[1])
        storeComputeGas('participate_in_election', op.participateInElection, (gas[op.participateInElection] ?? [])[1])
        storeAverageGas(result4.transactions)
    })

    it(
        'should find max gas for loan when recovering stakes',
        async () => {
            let gas: Record<string, [bigint, BlockchainTransaction] | undefined> = {}

            const maxValidators = beginCell().storeUint(count, 16).storeUint(count, 16).storeUint(count, 16).endCell()
            setConfig(blockchain, config.validators, maxValidators)

            const times = await treasury.getTimes()
            const electedFor = times.nextRoundSince - times.currentRoundSince
            const since1 = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
            const until1 = since1 + electedFor
            const vset1 = createVset(since1, until1)
            setConfig(blockchain, config.currentValidators, vset1)

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

            const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
            for (const i of Array(count).keys()) {
                const borrower = await blockchain.treasury('borrower ' + i)
                const loanAddress = await treasury.getLoanAddress(borrower.address, until1)
                credits.set(BigInt('0x' + loanAddress.hash.toString('hex')), toNano('350200'))
                const newStakeMsg = await createNewStakeMsg(loanAddress, until1)
                const result = await treasury.sendRequestLoan(borrower.getSender(), {
                    value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
                    roundSince: until1,
                    loanAmount: '300000',
                    minPayment: '50',
                    borrowerRewardShare: 102n, // 40%
                    newStakeMsg,
                })
                expect(result.transactions).toHaveLength(2)
                gas = accumulateUsedGas(gas, result.transactions)
            }

            const state1 = await treasury.getTreasuryState()
            state1.totalCoins = 1n
            state1.totalTokens = 1n
            state1.participations.set(until1 + 10n, { state: ParticipationState.Validating })
            state1.participations.set(until1 + 20n, { state: ParticipationState.Held })
            const fakeData1 = treasuryConfigToCell(state1)
            await blockchain.setShardAccount(
                treasury.address,
                createShardAccount({
                    workchain: 0,
                    address: treasury.address,
                    code: treasuryCode,
                    data: fakeData1,
                    balance: (await treasury.getBalance()) + toNano('300001') * BigInt(count),
                }),
            )

            const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
            const until2 = since2 + electedFor
            const vset2 = createVset(since2, until2)
            setConfig(blockchain, config.currentValidators, vset2)
            const result1 = await treasury.sendParticipateInElection({ roundSince: until1 })

            expect(result1.transactions).toHaveTransaction({
                from: undefined,
                to: treasury.address,
                body: bodyOp(op.participateInElection),
                success: true,
                outMessagesCount: 1,
            })
            expect(result1.transactions).toHaveTransaction({
                from: treasury.address,
                to: treasury.address,
                body: bodyOp(op.decideLoanRequests),
                success: true,
                outMessagesCount: 1,
            })
            expect(result1.transactions).toHaveTransaction({
                from: treasury.address,
                to: treasury.address,
                body: bodyOp(op.processLoanRequests),
                success: true,
                outMessagesCount: (x) => x >= Math.min(count * 2, 100) && x <= Math.min(count * 2, 255),
            })
            expect(result1.transactions).toHaveTransaction({
                to: electorAddress,
                body: bodyOp(op.newStake),
                success: true,
                outMessagesCount: 1,
            })
            expect(result1.transactions).toHaveTransaction({
                from: electorAddress,
                body: bodyOp(op.newStakeOk),
                success: true,
                outMessagesCount: 0,
            })
            expect(result1.transactions).not.toHaveTransaction({
                from: treasury.address,
                body: bodyOp(op.requestRejected),
            })

            gas = accumulateUsedGas(gas, result1.transactions)

            const vset3 = createVset(0n, 1n)
            setConfig(blockchain, config.currentValidators, vset3)
            const result2 = await treasury.sendVsetChanged({ roundSince: until1 })
            gas = accumulateUsedGas(gas, result2.transactions)

            const vset4 = createVset(1n, 2n)
            setConfig(blockchain, config.currentValidators, vset4)
            const result3 = await treasury.sendVsetChanged({ roundSince: until1 })
            gas = accumulateUsedGas(gas, result3.transactions)

            await blockchain.setShardAccount(
                electorAddress,
                createShardAccount({
                    workchain: -1,
                    address: electorAddress,
                    code: electorCode,
                    data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
                    balance: toNano('350200') * BigInt(count) + toNano('1'),
                }),
            )

            const state2 = await treasury.getTreasuryState()
            const participation = state2.participations.get(until1) ?? {}
            participation.stakeHeldUntil = 0n // set stake_held_until to zero
            state2.participations.set(until1, participation)
            const fakeData2 = treasuryConfigToCell(state2)
            await blockchain.setShardAccount(
                treasury.address,
                createShardAccount({
                    workchain: 0,
                    address: treasury.address,
                    code: treasuryCode,
                    data: fakeData2,
                    balance: toNano('10') + toNano('1') * BigInt(count),
                }),
            )

            const result4 = await treasury.sendFinishParticipation({ roundSince: until1 })

            expect(result4.transactions).toHaveTransaction({
                from: undefined,
                to: treasury.address,
                body: bodyOp(op.finishParticipation),
                success: true,
                outMessagesCount: 1,
            })
            expect(result4.transactions).toHaveTransaction({
                from: treasury.address,
                to: treasury.address,
                body: bodyOp(op.recoverStakes),
                success: true,
                outMessagesCount: (x) => x >= Math.min(count, 60) && x <= Math.min(count, 255),
            })
            expect(result4.transactions).toHaveTransaction({
                from: treasury.address,
                body: bodyOp(op.proxyRecoverStake),
                success: true,
                outMessagesCount: 1,
            })
            expect(result4.transactions).toHaveTransaction({
                to: electorAddress,
                body: bodyOp(op.recoverStake),
                success: true,
                outMessagesCount: 1,
            })
            expect(result4.transactions).toHaveTransaction({
                from: electorAddress,
                body: bodyOp(op.recoverStakeOk),
                success: true,
                outMessagesCount: 1,
            })
            expect(result4.transactions).toHaveTransaction({
                to: treasury.address,
                body: bodyOp(op.recoverStakeResult),
                success: true,
                outMessagesCount: 3,
            })
            expect(result4.transactions).toHaveTransaction({
                from: treasury.address,
                body: bodyOp(op.loanResult),
                success: true,
                outMessagesCount: 0,
            })
            expect(result4.transactions).toHaveTransaction({
                from: treasury.address,
                to: governor.address,
                body: bodyOp(op.takeProfit),
                success: true,
                outMessagesCount: 0,
            })
            expect(result4.transactions).toHaveTransaction({
                to: treasury.address,
                body: bodyOp(op.recoverStakeResult),
                success: true,
                outMessagesCount: 4,
            })
            expect(result4.transactions).toHaveTransaction({
                from: treasury.address,
                body: bodyOp(op.burnAll),
                success: true,
                outMessagesCount: 1,
            })
            expect(result4.transactions).toHaveTransaction({
                to: treasury.address,
                body: bodyOp(op.lastBillBurned),
                success: true,
                outMessagesCount: 1,
            })

            gas = accumulateUsedGas(gas, result4.transactions)

            let recoverStakeCount = 0
            for (const tx of result4.transactions) {
                const bodyOp = tx.inMessage?.body.beginParse().loadUint(32)
                if (bodyOp === op.proxyRecoverStake) {
                    recoverStakeCount += 1
                }
            }
            expect(recoverStakeCount).toEqual(count)

            accumulateFees(result1.transactions)
            accumulateFees(result4.transactions)
            storeComputeGas('request_loan', op.requestLoan, (gas[op.requestLoan] ?? [])[1])
            storeComputeGas(
                'participate_in_election',
                op.participateInElection,
                (gas[op.participateInElection] ?? [])[1],
            )
            storeComputeGas('proxy_new_stake', op.proxyNewStake, (gas[op.proxyNewStake] ?? [])[1])
            storeComputeGas('new_stake', op.newStake, (gas[op.newStake] ?? [])[1])
            storeComputeGas('new_stake_ok', op.newStakeOk, (gas[op.newStakeOk] ?? [])[1])
            storeComputeGas('vset_changed', op.vsetChanged, (gas[op.vsetChanged] ?? [])[1])
            storeComputeGas('finish_participation', op.finishParticipation, (gas[op.finishParticipation] ?? [])[1])
            storeComputeGas('proxy_recover_stake', op.proxyRecoverStake, (gas[op.proxyRecoverStake] ?? [])[1])
            storeComputeGas('recover_stake', op.recoverStake, (gas[op.recoverStake] ?? [])[1])
            storeComputeGas('recover_stake_ok', op.recoverStakeOk, (gas[op.recoverStakeOk] ?? [])[1])
            storeComputeGas('recover_stake_result', op.recoverStakeResult, (gas[op.recoverStakeResult] ?? [])[1])
            storeComputeGas('burn_all', op.burnAll, (gas[op.burnAll] ?? [])[1])
            storeComputeGas('last_bill_burned', op.lastBillBurned, (gas[op.lastBillBurned] ?? [])[1])
            storeAverageGas(result1.transactions)
            storeAverageGas(result4.transactions)
        },
        6000 * 1000,
    )

    it('should increase gas fees of loans by 10%', () => {
        for (const [key, value] of Object.entries(gasUsed)) {
            if (loanKeys.includes(key)) {
                gasUsed[key] = BigInt(Math.ceil((Number(value) * 1.1) / 1000) * 1000)
            }
        }
    })
})

function extractUsedGas(tx: BlockchainTransaction): bigint {
    const logs = tx.blockchainLogs
    const usedIndex = logs.indexOf('used=')
    const commaIndex = logs.indexOf(',', usedIndex)
    if (usedIndex === -1) {
        return 0n
    }
    if (logs.lastIndexOf('used=') !== usedIndex) {
        throw new Error('unexpected second "used" field in calculating gas')
    }
    return BigInt(logs.substring(usedIndex + 5, commaIndex))
}

function storeComputeGas(opLabel: string, opCode: number, tx: BlockchainTransaction | undefined) {
    if (tx == null) {
        throw new Error('no transaction to compute gas for op ' + opLabel)
    }
    if (!bodyOp(opCode)(tx.inMessage?.body ?? Cell.EMPTY) && !bodyOp(0)(tx.inMessage?.body ?? Cell.EMPTY)) {
        throw new Error('invalid transaction to log compute gas for op ' + opLabel)
    }
    const usedGas = extractUsedGas(tx)
    if (gasUsed[opLabel] == null || gasUsed[opLabel] < usedGas) {
        gasUsed[opLabel] = usedGas
    }
}

function logGas(opLabel: string): string | undefined {
    const used = gasUsed[opLabel]
    gasUsed[opLabel] = -1n
    if (used >= 0n) {
        return '    const int gas::' + opLabel + ' = ' + used.toString() + ';'
    }
}

function logComputeGas(opLabels: string[]) {
    if (!muteLogComputeGas) {
        console.info(
            'Compute Gas:\n' +
                opLabels
                    .map(logGas)
                    .filter((el) => el != null)
                    .join('\n'),
        )
    }
}

function logUnknownGas() {
    if (!muteLogComputeGas) {
        for (const [key, value] of Object.entries(gasUsed)) {
            if (value >= 0n) {
                console.info('Unknown gas: ', key, value)
            }
        }
    }
}

function accumulateUsedGas(
    gas: Record<string, [bigint, BlockchainTransaction] | undefined>,
    txs: BlockchainTransaction[],
): Record<string, [bigint, BlockchainTransaction] | undefined> {
    for (const tx of txs) {
        const body = tx.inMessage?.body ?? Cell.EMPTY
        const code = body.beginParse().loadUint(32).toString()
        const used = extractUsedGas(tx)
        const prev = gas[code]
        if (prev == null || prev[0] < used) {
            gas[code] = [used, tx]
        }
    }
    return gas
}

function storeAverageGas(txs: BlockchainTransaction[]) {
    let sumDecideLoanRequests = 0n
    let sumProcessLoanRequests = 0n
    let sumRecoverStakes = 0n
    for (const tx of txs) {
        const body = tx.inMessage?.body ?? Cell.EMPTY
        const code = body.beginParse().loadUint(32)
        if (code === op.decideLoanRequests) {
            sumDecideLoanRequests += extractUsedGas(tx)
        } else if (code === op.processLoanRequests) {
            sumProcessLoanRequests += extractUsedGas(tx)
        } else if (code === op.recoverStakes) {
            sumRecoverStakes += extractUsedGas(tx)
        }
    }

    const averageDecideLoanRequests = BigInt(Math.ceil(Number(sumDecideLoanRequests) / count))
    const averageProcessLoanRequests = BigInt(Math.ceil(Number(sumProcessLoanRequests) / count))
    const averageRecoverStakes = BigInt(Math.ceil(Number(sumRecoverStakes) / count))

    if (gasUsed.decide_loan_requests < averageDecideLoanRequests) {
        gasUsed.decide_loan_requests = averageDecideLoanRequests
    }

    if (gasUsed.process_loan_requests < averageProcessLoanRequests) {
        gasUsed.process_loan_requests = averageProcessLoanRequests
    }

    if (gasUsed.recover_stakes < averageRecoverStakes) {
        gasUsed.recover_stakes = averageRecoverStakes
    }
}
