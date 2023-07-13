import { compile } from "@ton-community/blueprint"
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from "@ton-community/sandbox"
import '@ton-community/test-utils'
import { Cell, Dictionary, Message, beginCell, toNano } from "ton-core"
import { between, bodyOp, createRecoverStakeOkMessage, createVset, emptyNewStakeMsg, getElector, setConfig } from "./helper"
import { config, op } from "../wrappers/common"
import { Loan } from "../wrappers/Loan"
import { Fees, Treasury } from "../wrappers/Treasury"
import { Wallet } from "../wrappers/Wallet"

describe('Loan', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
        loanCode = await compile('Loan')
    })

    let blockchain: Blockchain
    let treasury: SandboxContract<Treasury>
    let driver: SandboxContract<TreasuryContract>
    let fees: Fees

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        driver = await blockchain.treasury('driver')
        treasury = blockchain.openContract(Treasury.createFromConfig({
            walletCode,
            loanCode,
            driver: driver.address,
        }, treasuryCode))

        const deployer = await blockchain.treasury('deployer')
        const deployResult = await treasury.sendDeploy(deployer.getSender(), '0.01')

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: treasury.address,
            value: toNano('0.01'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployResult.transactions).toHaveLength(2);

        fees = await treasury.getFees()

        await treasury.sendTopUp(deployer.getSender(), fees.treasuryStorage)
    })

    it('should deploy treasury', async () => {
    })

    it('should save a loan request', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since = BigInt(Math.floor(Date.now() / 1000)) - electedFor / 2n
        const until = since + electedFor
        const vset = createVset(since, until)
        setConfig(blockchain, config.currentValidators, vset)

        const validator = await blockchain.treasury('validator')
        const result = await treasury.sendRequestLoan(validator.getSender(), {
            value: '151.6', // 101 (max punishment) + 50 (min payment) + 0.6 (fee)
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result.transactions).toHaveTransaction({
            from: validator.address,
            to: treasury.address,
            value: toNano('151.6'),
            body: bodyOp(op.requestLoan),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(2)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('161.5', '161.6')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeBetween('151', '151.1')
    })

    it('should participate in election', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loan2Address = await treasury.getLoanAddress(validator2.address, until1)
        const loan3Address = await treasury.getLoanAddress(validator3.address, until1)
        const loan2 = blockchain.openContract(Loan.createFromAddress(loan2Address))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loan3Address))
        const electorAddress = getElector(blockchain)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '151.6', // 101 (max punishment) + 50 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.6', // 101 (max punishment) + 60 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.6', // 101 (max punishment) + 70 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        const result = await treasury.sendParticipateInElection({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.participateInElection),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('0.52', '0.53'),
            body: bodyOp(op.processLoanRequests),
            deploy: false,
            success: true,
            outMessagesCount: 3,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: Cell.EMPTY,
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.sendNewStake),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('350161', '350162'),
            body: bodyOp(op.newStake),
            deploy: false,
            success: false, // elector smart contract is not available on sandbox
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('350171', '350172'),
            body: bodyOp(op.newStake),
            deploy: false,
            success: false, // elector smart contract is not available on sandbox
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            deploy: false,
            success: true, // this is the bounce message from elector instead of new_stake_ok
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            deploy: false,
            success: true, // this is the bounce message from elector instead of new_stake_ok
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(9)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('10.5', '10.6')
        expect(treasuryState.totalCoins).toBeBetween('700000', '700000.1')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
    })

    it('should change vset', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '151.6', // 101 (max punishment) + 50 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.6', // 101 (max punishment) + 60 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.6', // 101 (max punishment) + 70 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        await treasury.sendParticipateInElection({ roundSince: until1 })

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        const result1 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result1.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.vsetChanged),
            success: true,
            outMessagesCount: 0,
        })
        expect(result1.transactions).toHaveLength(1)

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        const result2 = await treasury.sendVsetChanged({ roundSince: until1 })

        expect(result2.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.vsetChanged),
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(1)

        const vset5 = createVset(2n, 3n)
        setConfig(blockchain, config.currentValidators, vset5)
        try {
            // For the third case, an internal message is sent to avoid error message for external messages in console.
            // await treasury.sendVsetChanged({ roundSince: until1 })
            await treasury.sendMessage(driver.getSender(), {
                value: '0.1',
                body: beginCell()
                    .storeUint(op.vsetChanged, 32)
                    .storeUint(until1, 32)
                    .endCell()
            })
            fail()
        } catch (e) {
            // ignore
        }

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('10.5', '10.6')
        expect(treasuryState.totalCoins).toBeBetween('700000', '700000.1')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
    })

    it('should finish participation', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loan2Address = await treasury.getLoanAddress(validator2.address, until1)
        const loan3Address = await treasury.getLoanAddress(validator3.address, until1)
        const loan2 = blockchain.openContract(Loan.createFromAddress(loan2Address))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loan3Address))
        const electorAddress = getElector(blockchain)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '151.6', // 101 (max punishment) + 50 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '161.6', // 101 (max punishment) + 60 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '171.6', // 101 (max punishment) + 70 (min payment) + 0.6 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        await treasury.sendParticipateInElection({ roundSince: until1 })

        const vset3 = createVset(0n, 1n)
        setConfig(blockchain, config.currentValidators, vset3)
        await treasury.sendVsetChanged({ roundSince: until1 })

        const vset4 = createVset(1n, 2n)
        setConfig(blockchain, config.currentValidators, vset4)
        await treasury.sendVsetChanged({ roundSince: until1 })

        const state = await treasury.getTreasuryState()
        const participation = state.participations.get(until1) || {}
        participation.stakeHeldUntil = 0n // set stake_held_until to zero
        state.participations.set(until1, participation)
        const extension = beginCell()
            .storeAddress(state.driver)
            .storeDict(state.rewardsHistory)
            .storeRef(state.content)
        const fakeData = beginCell()
            .storeCoins(state.totalCoins)
            .storeCoins(state.totalTokens)
            .storeCoins(state.totalStaking)
            .storeCoins(state.totalUnstaking)
            .storeCoins(state.totalValidatorsStake)
            .storeDict(state.participations)
            .storeRef(state.walletCode)
            .storeRef(state.loanCode)
            .storeRef(extension)
            .endCell()
        await blockchain.setShardAccount(treasury.address, createShardAccount({
            workchain: 0,
            address: treasury.address,
            code: treasuryCode,
            data: fakeData,
            balance: await treasury.getBalance(),
        }))
        const result = await treasury.sendFinishParticipation({ roundSince: until1 })

        expect(result.transactions).toHaveTransaction({
            from: undefined,
            to: treasury.address,
            body: bodyOp(op.finishParticipation),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: treasury.address,
            value: between('0.5', '0.6'),
            body: bodyOp(op.recoverStakes),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('0.1', '0.2'),
            body: bodyOp(op.sendRecoverStake),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('0.1', '0.2'),
            body: bodyOp(op.sendRecoverStake),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('0', '0.1'),
            body: bodyOp(op.recoverStake),
            deploy: false,
            success: false, // elector smart contract is not available on sandbox
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('0', '0.1'),
            body: bodyOp(op.recoverStake),
            deploy: false,
            success: false, // elector smart contract is not available on sandbox
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            deploy: false,
            success: true, // this is the bounce message from elector instead of recover_stake_ok
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            deploy: false,
            success: true, // this is the bounce message from elector instead of recover_stake_ok
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(8)

        const recoverStakeOkMsg2 = createRecoverStakeOkMessage(electorAddress, loan2.address, toNano('100'))
        const recoverStakeOkMsg3 = createRecoverStakeOkMessage(electorAddress, loan3.address, toNano('100'))
        const result2 = await blockchain.sendMessage(recoverStakeOkMsg2)
        const result3 = await blockchain.sendMessage(recoverStakeOkMsg3)

        expect(result2.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: toNano('100'),
            body: bodyOp(op.recoverStakeOk),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: loan2.address,
            to: treasury.address,
            value: between('350261', '350262'),
            body: bodyOp(op.recoverStakeResult),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result2.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('201', '202'),
            body: Cell.EMPTY,
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result2.transactions).toHaveLength(3)

        expect(result3.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: toNano('100'),
            body: bodyOp(op.recoverStakeOk),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: loan3.address,
            to: treasury.address,
            value: between('350271', '350272'),
            body: bodyOp(op.recoverStakeResult),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('201', '202'),
            body: Cell.EMPTY,
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700139', '700140')
        expect(treasuryState.totalCoins).toBeBetween('700000', '700000.1')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const reward = treasuryState.rewardsHistory.get(until1)
        expect(treasuryState.rewardsHistory.size).toBe(1)
        expect(reward?.staked).toBeBetween('699999', '700000')
        expect(reward?.recovered).toBeBetween('700129', '700130')
    })
})
