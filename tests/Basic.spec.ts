import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Cell, Dictionary, SendMode, beginCell, toNano } from 'ton-core'
import { Fees, Root } from '../wrappers/Root'
import { Wallet } from '../wrappers/Wallet'
import { between, bodyOp } from './utils'
import { op } from '../wrappers/common'

describe('Basic Operations', () => {
    let rootCode: Cell
    let walletCode: Cell
    let poolCode: Cell

    beforeAll(async () => {
        rootCode = await compile('Root')
        walletCode = await compile('Wallet')
        poolCode = await compile('Pool')
    })

    let blockchain: Blockchain
    let root: SandboxContract<Root>
    let fees: Fees

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        root = blockchain.openContract(Root.createFromConfig({
            walletCode,
            poolCode,
        }, rootCode))

        const deployer = await blockchain.treasury('deployer')
        const deployResult = await root.sendDeploy(deployer.getSender(), '0.01')

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: root.address,
            value: toNano('0.01'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployResult.transactions).toHaveLength(2);

        fees = await root.getFees()

        await root.sendTopUp(deployer.getSender(), fees.rootStorage)
    })

    it('should deploy root', async () => {
    })

    it('should stake ton by a simple empty message', async () => {
        const user = await blockchain.treasury('user')
        const walletAddress = await root.getWalletAddress(user.address)
        const result = await root.sendMessage(user.getSender(), { value: '10' })

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: root.address,
            value: toNano('10'),
            body: new Cell(),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: walletAddress,
            value: between(fees.walletStorage, '0.1'),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: walletAddress,
            to: user.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const rootBalance = await root.getBalance()
        const [ totalTon, totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalTon).toBeTonValue(totalStakedTokens)
        expect(totalStakedTokens).toBeBetween('9.9', '10')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletBalance = await wallet.getBalance()
        const [ stakedTokens, unstakedTokens, withdrawalIncentive ] = (await wallet.getWalletState())
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens).toBeBetween('9.9', '10')
        expect(unstakedTokens).toBeTonValue(0n)
        expect(withdrawalIncentive).toBeTonValue(0n)
    })

    it('should stake ton with custom parameters', async () => {
        const user1 = await blockchain.treasury('user1')
        const user2 = await blockchain.treasury('user2')
        const user1BalanceBefore = await user1.getBalance()
        const user2BalanceBefore = await user2.getBalance()
        const wallet2Address = await root.getWalletAddress(user2.address)
        const result = await root.sendStakeTon(user1.getSender(), {
            value: '15.1',
            tokens: '10',
            recipient: user2.address,
            returnExcess: user1.address,
            forwardTonAmount: '5',
        })

        expect(result.transactions).toHaveTransaction({
            from: user1.address,
            to: root.address,
            value: toNano('15.1'),
            body: bodyOp(op.stakeTon),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: wallet2Address,
            value: between('5', '5.1'),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user2.address,
            value: toNano('5'),
            body: bodyOp(op.transferNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalTon, totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('20', '20.1')
        expect(totalTon).toBeTonValue(totalStakedTokens)
        expect(totalStakedTokens).toBeTonValue('10')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const wallet2Balance = await wallet2.getBalance()
        const [ stakedTokens, unstakedTokens, withdrawalIncentive ] = (await wallet2.getWalletState())
        expect(wallet2Balance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens).toBeTonValue('10')
        expect(unstakedTokens).toBeTonValue(0n)
        expect(withdrawalIncentive).toBeTonValue(0n)

        const user1BalanceAfter = await user1.getBalance()
        const user1BalanceDiff = user1BalanceAfter - user1BalanceBefore
        expect(user1BalanceDiff).toBeBetween('-15.1', '-15.0')

        const user2BalanceAfter = await user2.getBalance()
        const user2BalanceDiff = user2BalanceAfter - user2BalanceBefore
        expect(user2BalanceDiff).toBeBetween('4.9', '5')
    })

    it('should send tokens to another new wallet', async () => {
        const user1 = await blockchain.treasury('user1')
        const user2 = await blockchain.treasury('user2')
        const user1BalanceBefore = await user1.getBalance()
        const user2BalanceBefore = await user2.getBalance()
        const wallet1Address = await root.getWalletAddress(user1.address)
        const wallet2Address = await root.getWalletAddress(user2.address)
        await root.sendMessage(user1.getSender(), { value: '10' })
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const result = await wallet1.sendSendTokens(user1.getSender(), {
            value: '2.2',
            tokens: '9',
            recipient: user2.address,
            returnExcess: user1.address,
            forwardTonAmount: '2',
        })

        expect(result.transactions).toHaveTransaction({
            from: user1.address,
            to: wallet1Address,
            value: toNano('2.2'),
            body: bodyOp(op.sendTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1Address,
            to: wallet2Address,
            value: between('2', '2.2'),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user2.address,
            value: toNano('2'),
            body: bodyOp(op.transferNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user1.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalTon, totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalTon).toBeTonValue(totalStakedTokens)
        expect(totalStakedTokens).toBeBetween('9.9', '10')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const wallet1Balance = await wallet1.getBalance()
        const [ stakedTokens1, unstakedTokens1, withdrawalIncentive1 ] = (await wallet1.getWalletState())
        expect(wallet1Balance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens1).toBeBetween('0.9', '1')
        expect(unstakedTokens1).toBeTonValue(0n)
        expect(withdrawalIncentive1).toBeTonValue(0n)

        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const wallet2Balance = await wallet2.getBalance()
        const [ stakedTokens2, unstakedTokens2, withdrawalIncentive2 ] = (await wallet2.getWalletState())
        expect(wallet2Balance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens2).toBeTonValue('9')
        expect(unstakedTokens2).toBeTonValue(0n)
        expect(withdrawalIncentive2).toBeTonValue(0n)

        const user1BalanceAfter = await user1.getBalance()
        const user1BalanceDiff = user1BalanceAfter - user1BalanceBefore
        expect(user1BalanceDiff).toBeBetween('-12.1', '-12.0')

        const user2BalanceAfter = await user2.getBalance()
        const user2BalanceDiff = user2BalanceAfter - user2BalanceBefore
        expect(user2BalanceDiff).toBeBetween('1.9', '2')
    })

    it('should send tokens to another existing wallet', async () => {
        const user1 = await blockchain.treasury('user1')
        const user2 = await blockchain.treasury('user2')
        const wallet1Address = await root.getWalletAddress(user1.address)
        const wallet2Address = await root.getWalletAddress(user2.address)
        await root.sendMessage(user1.getSender(), { value: '10' })
        await root.sendMessage(user2.getSender(), { value: '5' })
        const user1BalanceBefore = await user1.getBalance()
        const user2BalanceBefore = await user2.getBalance()
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const forwardPayload = beginCell().storeUint(0, 256).storeUint(0, 56).endCell().beginParse()
        const result = await wallet1.sendSendTokens(user1.getSender(), {
            value: '2.2',
            tokens: '9',
            recipient: user2.address,
            returnExcess: user1.address,
            forwardTonAmount: '2',
            forwardPayload,
        })

        expect(result.transactions).toHaveTransaction({
            from: user1.address,
            to: wallet1Address,
            value: toNano('2.2'),
            body: bodyOp(op.sendTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1Address,
            to: wallet2Address,
            value: between('2', '2.2'),
            body: bodyOp(op.receiveTokens),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user2.address,
            value: toNano('2'),
            body: bodyOp(op.transferNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user1.address,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalTon, totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('24.8', '25')
        expect(totalTon).toBeTonValue(totalStakedTokens)
        expect(totalStakedTokens).toBeBetween('14.8', '15')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const wallet1Balance = await wallet1.getBalance()
        const [ stakedTokens1, unstakedTokens1, withdrawalIncentive1 ] = (await wallet1.getWalletState())
        expect(wallet1Balance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens1).toBeBetween('0.9', '1')
        expect(unstakedTokens1).toBeTonValue(0n)
        expect(withdrawalIncentive1).toBeTonValue(0n)

        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const wallet2Balance = await wallet2.getBalance()
        const [ stakedTokens2, unstakedTokens2, withdrawalIncentive2 ] = (await wallet2.getWalletState())
        expect(wallet2Balance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens2).toBeBetween('13.9', '14')
        expect(unstakedTokens2).toBeTonValue(0n)
        expect(withdrawalIncentive2).toBeTonValue(0n)

        const user1BalanceAfter = await user1.getBalance()
        const user1BalanceDiff = user1BalanceAfter - user1BalanceBefore
        expect(user1BalanceDiff).toBeBetween('-2.1', '-2.0')

        const user2BalanceAfter = await user2.getBalance()
        const user2BalanceDiff = user2BalanceAfter - user2BalanceBefore
        expect(user2BalanceDiff).toBeBetween('1.9', '2')
    })

    it('should unstake tokens', async () => {
        const user = await blockchain.treasury('user')
        const userBalanceBefore = await user.getBalance()
        await root.sendStakeTon(user.getSender(), {
            value: '10.1',
            tokens: '10',
            recipient: user.address,
            returnExcess: user.address,
        })
        const walletAddress = await root.getWalletAddress(user.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await wallet.sendUnstakeTokens(user.getSender(), {
            value: '0.15',
            tokens: '7',
            incentive: '0.05',
            returnExcess: user.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: walletAddress,
            value: toNano('0.15'),
            body: bodyOp(op.unstakeTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: walletAddress,
            to: root.address,
            value: between('0', '0.1'),
            body: bodyOp(op.unstakeReserve),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: user.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const rootBalance = await root.getBalance()
        const [ totalTon, totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('20', '20.1')
        expect(totalTon).toBeTonValue('10')
        expect(totalStakedTokens).toBeTonValue('3')
        expect(totalUnstakedTokens).toBeTonValue('7')

        const walletBalance = await wallet.getBalance()
        const [ stakedTokens, unstakedTokens, withdrawalIncentive ] = (await wallet.getWalletState())
        expect(walletBalance).toBeBetween(fees.walletStorage + toNano('0.05'), fees.walletStorage + toNano('0.06'))
        expect(stakedTokens).toBeTonValue('3')
        expect(unstakedTokens).toBeTonValue('7')
        expect(withdrawalIncentive).toBeTonValue('0.05')

        const userBalanceAfter = await user.getBalance()
        const userBalanceDiff = userBalanceAfter - userBalanceBefore
        expect(userBalanceDiff).toBeBetween('-10.1', '-10.25')
    })

    it('should withdraw tokens', async () => {
        const user = await blockchain.treasury('user')
        const userBalanceBefore = await user.getBalance()
        const miner = await blockchain.treasury('miner')
        const minerBalanceBefore = await miner.getBalance()
        await root.sendStakeTon(user.getSender(), {
            value: '10.1',
            tokens: '10',
            recipient: user.address,
            returnExcess: user.address,
        })
        const walletAddress = await root.getWalletAddress(user.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendUnstakeTokens(user.getSender(), {
            value: '0.15',
            tokens: '7',
            incentive: '0.05',
            returnExcess: user.address,
        })
        const result = await wallet.sendReleaseTon(miner.getSender(), {
            value: '0.1',
            returnExcess: miner.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: miner.address,
            to: walletAddress,
            value: toNano('0.1'),
            body: bodyOp(op.releaseTon),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: walletAddress,
            to: root.address,
            value: between('0.05', '0.15'),
            body: bodyOp(op.withdrawTon),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: user.address,
            value: toNano('7'),
            body: bodyOp(op.releaseNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: miner.address,
            value: between('0.1', '0.15'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalTon, totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('13', '13.1')
        expect(totalTon).toBeTonValue(totalStakedTokens)
        expect(totalStakedTokens).toBeTonValue('3')
        expect(totalUnstakedTokens).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ stakedTokens, unstakedTokens, withdrawalIncentive ] = (await wallet.getWalletState())
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens).toBeTonValue('3')
        expect(unstakedTokens).toBeTonValue('0')
        expect(withdrawalIncentive).toBeTonValue(0n)

        const userBalanceAfter = await user.getBalance()
        const userBalanceDiff = userBalanceAfter - userBalanceBefore
        expect(userBalanceDiff).toBeBetween('-3.1', '-3.25')

        const minerBalanceAfter = await miner.getBalance()
        const minerBalanceDiff = minerBalanceAfter - minerBalanceBefore
        expect(minerBalanceDiff).toBeBetween('0', '0.05')
    })

    it('should respond with wallet address', async () => {
        const user = await blockchain.treasury('user')
        const walletAddress = await root.getWalletAddress(user.address)
        const queryId = BigInt(Math.floor(Math.random() * Math.pow(2, 64)))
        const expectedBody = beginCell()
            .storeUint(0xd1735400, 32)
            .storeUint(queryId, 64)
            .storeAddress(walletAddress)
            .storeMaybeRef(beginCell().storeAddress(user.address))
            .endCell()
        const result = await root.sendProvideWalletAddress(user.getSender(), {
            value: '0.1',
            queryId: queryId,
            owner: user.address,
            includeAddress: true,
        })

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: root.address,
            value: toNano('0.1'),
            body: bodyOp(op.provideWalletAddress),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: user.address,
            value: between(0n, '0.1'),
            body: expectedBody,
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })
})
