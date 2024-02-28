import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { accumulateFees, between, bodyOp, logComputeGas, logTotalFees, storeComputeGas } from './helper'
import { op } from '../wrappers/common'
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

describe('Max Gas', () => {
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
    })

    beforeAll(async () => {
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

        loanCodes = Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, loanCode)
        // .set(10n, loanCode)
        // .set(20n, loanCode)
        // .set(30n, loanCode)
        // .set(40n, loanCode)

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
                    totalValidatorsStake: 0n,
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

        const result2 = await treasury.sendRetryBurnAll(governor.getSender(), { value: '0.1', roundSince: 60n })
        expect(result2.transactions).toHaveTransaction({
            from: parent.address,
            to: walletAddress1,
            value: between('0', '0.1'),
            body: bodyOp(op.tokensMinted),
            success: true,
            outMessagesCount: 1,
        })
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

        const result4 = await wallet1.sendSendTokens(staker.getSender(), {
            value: walletFees.sendTokensFee + toNano('0.047') + toNano('0.17'), // 0.17 for forwarding payload
            tokens: '1',
            recipient: someone.address,
            customPayload: parentCode,
            forwardTonAmount: '0.05',
            forwardPayload: treasuryCode.beginParse(),
        })
        expect(result4.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0', walletFees.sendTokensFee + toNano('0.047') + toNano('0.17')),
            body: bodyOp(op.receiveTokens),
            success: true,
            outMessagesCount: 2,
        })
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
        expect(result5.transactions).toHaveLength(4)

        accumulateFees(result4.transactions)
        storeComputeGas('send_tokens', op.sendTokens, result4.transactions[1])
        storeComputeGas('receive_tokens', op.receiveTokens, result4.transactions[2])

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

        const result11 = await wallet1.sendUpgradeWallet(staker.getSender(), {
            value: walletFees.upgradeWalletFee,
        })
        expect(result11.transactions).toHaveTransaction({
            from: newParentAddress,
            to: newWalletAddress,
            value: between('0', walletFees.upgradeWalletFee),
            body: bodyOp(op.mergeWallet),
            success: true,
            outMessagesCount: 0,
        })
        expect(result11.transactions).toHaveLength(6)

        accumulateFees(result11.transactions)
        storeComputeGas('upgrade_wallet', op.upgradeWallet, result11.transactions[1])
        storeComputeGas('proxy_migrate_wallet', op.proxyMigrateWallet, result11.transactions[2])
        storeComputeGas('migrate_wallet', op.migrateWallet, result11.transactions[3])
        storeComputeGas('proxy_merge_wallet', op.proxyMergeWallet, result11.transactions[4])
        storeComputeGas('merge_wallet', op.mergeWallet, result11.transactions[5])

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
    })
})
