import { compile } from '@ton/blueprint'
import { Blockchain, createShardAccount, SandboxContract, TreasuryContract } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, fromNano, toNano } from '@ton/core'
import { bodyOp, createVset, emptyNewStakeMsg, setConfig } from './helper'
import { config, err, op } from '../wrappers/common'
import {
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Wallet } from '../wrappers/Wallet'

describe('Min Gas', () => {
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
                    lastStaked: 0n,
                    lastRecovered: 0n,
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

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10' })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue('10')
    })

    it('should require min gas fee in treasury', async () => {
        const staker = await blockchain.treasury('staker')

        const result1 = await treasury.sendDepositCoins(staker.getSender(), { value: fees.depositCoinsFee })
        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.depositCoinsFee,
            body: bodyOp(op.depositCoins),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await treasury.sendDepositCoins(staker.getSender(), { value: fees.depositCoinsFee + 1n })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.depositCoinsFee + 1n,
            body: bodyOp(op.depositCoins),
            success: true,
            outMessagesCount: 1,
        })

        const result3 = await treasury.sendMessage(staker.getSender(), {
            value: fees.unstakeAllTokensFee - 1n,
            body: 'w',
        })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.unstakeAllTokensFee - 1n,
            body: bodyOp(0),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await treasury.sendMessage(staker.getSender(), { value: fees.unstakeAllTokensFee, body: 'w' })
        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: fees.unstakeAllTokensFee,
            body: bodyOp(0),
            success: true,
            outMessagesCount: 1,
        })

        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000))
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const minStake = toNano('300000')
        const maxPunishment = await treasury.getMaxPunishment(0n)
        const newStakeConfirmation = toNano('1')

        const result5 = await treasury.sendRequestLoan(staker.getSender(), {
            value: maxPunishment + fees.requestLoanFee - 1n,
            loanAmount: minStake - maxPunishment + newStakeConfirmation,
            minPayment: 0n,
            borrowerRewardShare: 0n,
            newStakeMsg: emptyNewStakeMsg,
            roundSince: until,
        })
        expect(result5.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: maxPunishment + fees.requestLoanFee - 1n,
            body: bodyOp(op.requestLoan),
            success: false,
            exitCode: err.insufficientFunds,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await treasury.sendRequestLoan(staker.getSender(), {
            value: maxPunishment + fees.requestLoanFee,
            loanAmount: minStake - maxPunishment + newStakeConfirmation,
            minPayment: 0n,
            borrowerRewardShare: 0n,
            newStakeMsg: emptyNewStakeMsg,
            roundSince: until,
        })
        expect(result6.transactions).toHaveTransaction({
            from: staker.address,
            to: treasury.address,
            value: maxPunishment + fees.requestLoanFee,
            body: bodyOp(op.requestLoan),
            success: true,
            outMessagesCount: 0,
        })
    })

    it('should require min gas fee in wallet', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') })
        const walletFees = await wallet.getWalletFees()

        const result1 = await wallet.sendSendTokens(staker.getSender(), {
            value: toNano('0.014'),
            tokens: '7',
            recipient: halter.address,
            forwardTonAmount: 1n,
        })
        expect(result1.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.014'),
            body: bodyOp(op.sendTokens),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await wallet.sendSendTokens(staker.getSender(), {
            value: toNano('0.015'),
            tokens: '7',
            recipient: halter.address,
            forwardTonAmount: 1n,
        })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.015'),
            body: bodyOp(op.sendTokens),
            success: true,
            outMessagesCount: 1,
        })

        const result3 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee - 1n,
            tokens: '1',
        })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.unstakeTokensFee - 1n,
            body: bodyOp(op.unstakeTokens),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result3.transactions).toHaveLength(3)

        const result4 = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: walletFees.unstakeTokensFee,
            tokens: '1',
        })
        expect(result4.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.unstakeTokensFee,
            body: bodyOp(op.unstakeTokens),
            success: true,
            outMessagesCount: 1,
        })

        const result5 = await wallet.sendUpgradeWallet(staker.getSender(), { value: walletFees.upgradeWalletFee - 1n })
        expect(result5.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.upgradeWalletFee - 1n,
            body: bodyOp(op.upgradeWallet),
            success: false,
            exitCode: err.insufficientFee,
        })
        expect(result5.transactions).toHaveLength(3)

        const result6 = await wallet.sendUpgradeWallet(staker.getSender(), { value: walletFees.upgradeWalletFee })
        expect(result6.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: walletFees.upgradeWalletFee,
            body: bodyOp(op.upgradeWallet),
            success: true,
            outMessagesCount: 1,
        })
    })

    it('should print average gas usage for stake and unstake', async () => {
        let roundSince = 1n
        const stakerA = await blockchain.treasury('stakerA')

        // slow stake 1

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

        const beforeSlowStake1 = await stakerA.getBalance()
        const result1 = await treasury.sendDepositCoins(stakerA.getSender(), {
            value: toNano('2'),
            coins: toNano('1'),
            ownershipAssignedAmount: 1n,
        })
        expect(result1.transactions).toHaveLength(7)

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
        const result2 = await treasury.sendRetryBurnAll(halter.getSender(), { value: toNano('0.02'), roundSince })
        expect(result2.transactions).toHaveLength(10)

        const afterSlowStake1 = await stakerA.getBalance()
        const slowStake1 = -(afterSlowStake1 - beforeSlowStake1 + toNano('1'))

        // slow stake 2

        roundSince = 2n

        const fakeState3 = await treasury.getTreasuryState()
        fakeState3.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData3 = treasuryConfigToCell(fakeState3)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData3,
                balance: await treasury.getBalance(),
            }),
        )

        const beforeSlowStake2 = await stakerA.getBalance()
        const result3 = await treasury.sendDepositCoins(stakerA.getSender(), {
            value: toNano('2'),
            coins: toNano('1'),
            ownershipAssignedAmount: 1n,
        })
        expect(result3.transactions).toHaveLength(7)

        const fakeState4 = await treasury.getTreasuryState()
        fakeState4.participations.set(roundSince, { state: ParticipationState.Burning })
        const fakeData4 = treasuryConfigToCell(fakeState4)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData4,
                balance: await treasury.getBalance(),
            }),
        )
        const result4 = await treasury.sendRetryBurnAll(halter.getSender(), { value: toNano('0.02'), roundSince })
        expect(result4.transactions).toHaveLength(10)

        const afterSlowStake2 = await stakerA.getBalance()
        const slowStake2 = -(afterSlowStake2 - beforeSlowStake2 + toNano('1'))

        // instant stake 1

        roundSince = 3n
        const stakerB = await blockchain.treasury('stakerB')

        const fakeState5 = await treasury.getTreasuryState()
        fakeState5.participations.set(roundSince, { state: ParticipationState.Staked })
        fakeState5.instantMint = true
        const fakeData5 = treasuryConfigToCell(fakeState5)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData5,
                balance: toNano('1'),
            }),
        )

        const beforeInstantStake1 = await stakerB.getBalance()
        const result5 = await treasury.sendDepositCoins(stakerB.getSender(), { value: toNano('2'), coins: toNano('1') })
        expect(result5.transactions).toHaveLength(5)

        const afterInstantStake1 = await stakerB.getBalance()
        const instantStake1 = -(afterInstantStake1 - beforeInstantStake1 + toNano('1'))

        // instant stake 2

        const beforeInstantStake2 = await stakerB.getBalance()
        const result6 = await treasury.sendDepositCoins(stakerB.getSender(), { value: toNano('2'), coins: toNano('1') })
        expect(result6.transactions).toHaveLength(5)

        const afterInstantStake2 = await stakerB.getBalance()
        const instantStake2 = -(afterInstantStake2 - beforeInstantStake2 + toNano('1'))

        // slow unstake 1

        const beforeSlowUnstake1 = await stakerA.getBalance()
        const walletAddressA = await parent.getWalletAddress(stakerA.address)
        const walletA = blockchain.openContract(Wallet.createFromAddress(walletAddressA))
        const result7 = await walletA.sendUnstakeTokens(stakerA.getSender(), {
            value: toNano('1'),
            tokens: '1',
            ownershipAssignedAmount: 1n,
        })
        expect(result7.transactions).toHaveLength(7)

        const fakeState7 = await treasury.getTreasuryState()
        fakeState7.participations.set(roundSince, { state: ParticipationState.Burning })
        const fakeData7 = treasuryConfigToCell(fakeState7)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData7,
                balance: toNano('20'),
            }),
        )
        const result8 = await treasury.sendRetryBurnAll(halter.getSender(), { value: toNano('0.02'), roundSince })
        expect(result8.transactions).toHaveLength(10)

        const afterSlowUnstake1 = await stakerA.getBalance()
        const slowUnstake1 = -(afterSlowUnstake1 - beforeSlowUnstake1 - toNano('1'))

        // slow unstake 2

        roundSince = 4n

        const fakeState6 = await treasury.getTreasuryState()
        fakeState6.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData6 = treasuryConfigToCell(fakeState6)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData6,
                balance: toNano('1'),
            }),
        )

        const beforeSlowUnstake2 = await stakerA.getBalance()
        const result9 = await walletA.sendUnstakeTokens(stakerA.getSender(), {
            value: toNano('1'),
            tokens: '1',
            ownershipAssignedAmount: 1n,
        })
        expect(result9.transactions).toHaveLength(7)

        const fakeState8 = await treasury.getTreasuryState()
        fakeState8.participations.set(roundSince, { state: ParticipationState.Burning })
        const fakeData8 = treasuryConfigToCell(fakeState8)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData8,
                balance: toNano('20'),
            }),
        )
        const result10 = await treasury.sendRetryBurnAll(halter.getSender(), { value: toNano('0.02'), roundSince })
        expect(result10.transactions).toHaveLength(10)

        const afterSlowUnstake2 = await stakerA.getBalance()
        const slowUnstake2 = -(afterSlowUnstake2 - beforeSlowUnstake2 - toNano('1'))

        // instant unstake 1

        const beforeInstantUnstake1 = await stakerB.getBalance()
        const walletAddressB = await parent.getWalletAddress(stakerB.address)
        const walletB = blockchain.openContract(Wallet.createFromAddress(walletAddressB))
        const result11 = await walletB.sendUnstakeTokens(stakerB.getSender(), {
            value: toNano('1'),
            tokens: '1',
            ownershipAssignedAmount: 1n,
        })
        expect(result11.transactions).toHaveLength(7)

        const afterInstantUnstake1 = await stakerB.getBalance()
        const instantUnstake1 = -(afterInstantUnstake1 - beforeInstantUnstake1 - toNano('1'))

        // instant unstake 2

        const beforeInstantUnstake2 = await stakerB.getBalance()
        const result12 = await walletB.sendUnstakeTokens(stakerB.getSender(), {
            value: toNano('1'),
            tokens: '1',
            ownershipAssignedAmount: 1n,
        })
        expect(result12.transactions).toHaveLength(7)

        const afterInstantUnstake2 = await stakerB.getBalance()
        const instantUnstake2 = -(afterInstantUnstake2 - beforeInstantUnstake2 - toNano('1'))

        console.info(
            [
                'Average gas usage:',
                '         slow stake 1: %s',
                '         slow stake 2: %s',
                '      instant stake 1: %s',
                '      instant stake 2: %s',
                '       slow unstake 1: %s',
                '       slow unstake 2: %s',
                '    instant unstake 1: %s',
                '    instant unstake 2: %s',
            ].join('\n'),
            fromNano(slowStake1).padEnd(11, '0'),
            fromNano(slowStake2).padEnd(11, '0'),
            fromNano(instantStake1).padEnd(11, '0'),
            fromNano(instantStake2).padEnd(11, '0'),
            fromNano(slowUnstake1).padEnd(11, '0'),
            fromNano(slowUnstake2).padEnd(11, '0'),
            fromNano(instantUnstake1).padEnd(11, '0'),
            fromNano(instantUnstake2).padEnd(11, '0'),
        )
    })
})
