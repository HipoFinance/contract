import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Address, Cell, Dictionary, beginCell, fromNano, toNano } from 'ton-core'
import { between, bodyOp, createNewStakeMsg, createVset, emptyNewStakeMsg, getElector, printFees, setConfig, totalFees } from './helper'
import { config, op } from '../wrappers/common'
import { Loan } from '../wrappers/Loan'
import { Fees, Treasury, participationDictionaryValue, rewardDictionaryValue, treasuryConfigToCell } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'

describe('Loan', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell
    let electorCode: Cell

    afterAll(async () => {
        console.log(fromNano(totalFees))
    })

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
        loanCode = await compile('Loan')
        electorCode = await compile('elector-test/Elector')
    })

    let blockchain: Blockchain
    let treasury: SandboxContract<Treasury>
    let driver: SandboxContract<TreasuryContract>
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let fees: Fees
    let electorAddress: Address

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        driver = await blockchain.treasury('driver')
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(Treasury.createFromConfig({
            totalCoins: 0n,
            totalTokens: 0n,
            totalStaking: 0n,
            totalUnstaking: 0n,
            totalValidatorsStake: 0n,
            participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
            balancedRounds: false,
            stopped: false,
            walletCode,
            loanCode,
            driver: driver.address,
            halter: halter.address,
            governor: governor.address,
            proposedGovernor: null,
            governanceFee: 4096n,
            rewardsHistory: Dictionary.empty(Dictionary.Keys.BigUint(32), rewardDictionaryValue),
            content: Cell.EMPTY,
        }, treasuryCode))

        const deployer = await blockchain.treasury('deployer')
        const deployResult = await treasury.sendDeploy(deployer.getSender(), { value: '0.01' })

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

        await treasury.sendTopUp(deployer.getSender(), { value: fees.treasuryStorage })

        electorAddress = getElector(blockchain)
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
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: emptyNewStakeMsg,
        })

        expect(result.transactions).toHaveTransaction({
            from: validator.address,
            to: treasury.address,
            value: toNano('152.7'),
            body: bodyOp(op.requestLoan),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(2)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('162.6', '162.7')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue('0')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeBetween('151', '151.1')

        printFees(result.transactions)
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

        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
            balance: toNano('1'),
        }))

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '162.7', // 101 (max punishment) + 60 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '172.7', // 101 (max punishment) + 70 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
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
            value: between('699999', '700000'),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
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
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('350171', '350172'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: toNano('1'),
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: toNano('1'),
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(9)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('13', '14')
        expect(treasuryState.totalCoins).toBeBetween('699999', '700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size === 1).toBeTruthy()

        printFees(result.transactions)
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

        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
            balance: toNano('1'),
        }))

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '162.7', // 101 (max punishment) + 60 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '172.7', // 101 (max punishment) + 70 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
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
        expect(treasuryBalance).toBeBetween('13', '14')
        expect(treasuryState.totalCoins).toBeBetween('699999', '700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        printFees(result1.transactions)
        printFees(result2.transactions)
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

        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
            balance: toNano('1'),
        }))

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '162.7', // 101 (max punishment) + 60 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '172.7', // 101 (max punishment) + 70 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        await treasury.sendParticipateInElection({ roundSince: until1 })

        const credits = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4))
        credits.set(BigInt('0x' + loan2.address.toRawString().split(':')[1]), toNano('350260'))
        credits.set(BigInt('0x' + loan3.address.toRawString().split(':')[1]), toNano('350270'))
        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }), credits }),
            balance: toNano('350260') + toNano('350270') + toNano('1'),
        }))

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
        const fakeData = treasuryConfigToCell(state)
        await blockchain.setShardAccount(treasury.address, createShardAccount({
            workchain: 0,
            address: treasury.address,
            code: treasuryCode,
            data: fakeData,
            balance: toNano('10'),
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
            value: between('1.6', '1.7'),
            body: bodyOp(op.recoverStakes),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan2.address,
            value: between('0.5', '0.6'),
            body: bodyOp(op.sendRecoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: loan3.address,
            value: between('0.5', '0.6'),
            body: bodyOp(op.sendRecoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: electorAddress,
            value: between('0.4', '0.5'),
            body: bodyOp(op.recoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('0.4', '0.5'),
            body: bodyOp(op.recoverStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: between('350260', '350261'),
            body: bodyOp(op.recoverStakeOk),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: between('350270', '350271'),
            body: bodyOp(op.recoverStakeOk),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from:loan2.address,
            to: treasury.address,
            value: between('350261', '350262'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from:loan3.address,
            to: treasury.address,
            value: between('350271', '350272'),
            body: bodyOp(op.recoverStakeResult),
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('201', '202'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('201', '202'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('3', '4'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: governor.address,
            value: between('4', '5'),
            body: bodyOp(op.takeProfit),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(14)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700130', '700131')
        expect(treasuryState.totalCoins).toBeBetween('700122', '700123')
        expect(treasuryState.totalTokens).toBeBetween('699999', '700000')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')

        const reward = treasuryState.rewardsHistory.get(until1)
        expect(treasuryState.rewardsHistory.size).toBe(1)
        expect(reward?.staked).toBeBetween('699999', '700000')
        expect(reward?.recovered).toBeBetween('700121', '700122')

        printFees(result.transactions)
    })

    it('should remove participation when all loan requests are rejected', async () => {
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

        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: 0n }) }),
            balance: toNano('1'),
        }))

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '162.7', // 101 (max punishment) + 60 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '172.7', // 101 (max punishment) + 70 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
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
            value: between('699999', '700000'),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
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
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: electorAddress,
            value: between('350171', '350172'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan2.address,
            value: between('350161', '350162'),
            body: bodyOp(op.newStakeError),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: between('350171', '350172'),
            body: bodyOp(op.newStakeError),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan2.address,
            to: treasury.address,
            value: between('350161', '350162'),
            body: bodyOp(op.newStakeRejected),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: loan3.address,
            to: treasury.address,
            value: between('350171', '350172'),
            body: bodyOp(op.newStakeRejected),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('101', '101.1'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('101', '101.1'),
            body: bodyOp(op.loanResult),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(13)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('700143', '700144')
        expect(treasuryState.totalCoins).toBeBetween('700129', '700130')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size === 0).toBeTruthy()
        expect(treasuryState.rewardsHistory.size === 1).toBeTruthy()
        expect(treasuryState.rewardsHistory.get(until1)?.staked).toBeBetween('699999', '700000')
        expect(treasuryState.rewardsHistory.get(until1)?.recovered).toBeBetween('700129', '700130')

        printFees(result.transactions)
    })

    it('should remove participation when there is no funds available to give loans', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: 0n }) }),
            balance: toNano('1'),
        }))

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '162.7', // 101 (max punishment) + 60 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '172.7', // 101 (max punishment) + 70 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
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
            value: fees.requestLoanFee,
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('161', '161.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator3.address,
            value: between('171', '171.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('14', '15')
        expect(treasuryState.totalCoins).toBeTonValue('0')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size === 0).toBeTruthy()
        expect(treasuryState.rewardsHistory.size === 0).toBeTruthy()

        printFees(result.transactions)
    })

    it('should participate in election with balanced rounds', async () => {
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

        await treasury.sendSetBalancedRounds(halter.getSender(), { value: '0.1', newBalancedRounds: true })

        await blockchain.setShardAccount(electorAddress, createShardAccount({
            workchain: -1,
            address: electorAddress,
            code: electorCode,
            data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
            balance: toNano('1'),
        }))

        const validator1 = await blockchain.treasury('validator1')
        const validator2 = await blockchain.treasury('validator2')
        const validator3 = await blockchain.treasury('validator3')
        const loanAddress1 = await treasury.getLoanAddress(validator1.address, until1)
        const loanAddress2 = await treasury.getLoanAddress(validator2.address, until1)
        const loanAddress3 = await treasury.getLoanAddress(validator3.address, until1)
        const loan1 = blockchain.openContract(Loan.createFromAddress(loanAddress1))
        const loan2 = blockchain.openContract(Loan.createFromAddress(loanAddress2))
        const loan3 = blockchain.openContract(Loan.createFromAddress(loanAddress3))
        const newStakeMsg1 = await createNewStakeMsg(loan1.address, until1)
        const newStakeMsg2 = await createNewStakeMsg(loan2.address, until1)
        const newStakeMsg3 = await createNewStakeMsg(loan3.address, until1)
        await treasury.sendRequestLoan(validator1.getSender(), {
            value: '152.7', // 101 (max punishment) + 50 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg1,
        })
        await treasury.sendRequestLoan(validator2.getSender(), {
            value: '162.7', // 101 (max punishment) + 60 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '60',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg2,
        })
        await treasury.sendRequestLoan(validator3.getSender(), {
            value: '172.7', // 101 (max punishment) + 70 (min payment) + 1.7 (fee)
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '70',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg3,
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
            value: between('349999', '350000'),
            body: bodyOp(op.processLoanRequests),
            success: true,
            outMessagesCount: 3,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator1.address,
            value: between('151', '151.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: validator2.address,
            value: between('161', '161.1'),
            body: bodyOp(op.requestRejected),
            success: true,
            outMessagesCount: 0,
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
            from: loan3.address,
            to: electorAddress,
            value: between('350171', '350172'),
            body: bodyOp(op.newStake),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: electorAddress,
            to: loan3.address,
            value: toNano('1'),
            body: bodyOp(op.newStakeOk),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(7)

        const treasuryBalance = await treasury.getBalance()
        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryBalance).toBeBetween('350013', '350014')
        expect(treasuryState.totalCoins).toBeBetween('699999', '700000')
        expect(treasuryState.totalTokens).toBeTonValue(treasuryState.totalTokens)
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.participations.size === 1).toBeTruthy()

        printFees(result.transactions)
    })
})
