import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Cell, Dictionary, beginCell, toNano } from 'ton-core'
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
            deploy: true,
            success: true,
            outMessagesCount: 0,
            value: toNano('0.01'),
            body: bodyOp(op.topUp),
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
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: toNano('10'),
            body: new Cell(),
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: walletAddress,
            deploy: true,
            success: true,
            outMessagesCount: 0,
            value: between(fees.walletStorage, '0.1'),
            body: bodyOp(op.receiveTokens)
        })
        expect(result.transactions).toHaveLength(3)

        const rootBalance = await root.getTonBalance()
        const [ totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalStakedTokens).toBeBetween('9.9', '10')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const walletBalance = await wallet.getTonBalance()
        const [ stakedTokens, unstakedTokens, tokensDict ] = (await wallet.getWalletState())
        const dict = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict)
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(stakedTokens).toBeBetween('9.9', '10')
        expect(unstakedTokens).toBeTonValue(0n)
        expect(dict.size).toBe(1)
    })

    it('should stake ton with custom parameters', async () => {
        const user1 = await blockchain.treasury('user1')
        const user2 = await blockchain.treasury('user2')
        const user1TonBalanceBefore = await user1.getBalance()
        const user2TonBalanceBefore = await user2.getBalance()
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
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: toNano('15.1'),
            body: bodyOp(op.stakeTon),
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: wallet2Address,
            deploy: true,
            success: true,
            outMessagesCount: 2,
            value: between('5', '5.1'),
            body: bodyOp(op.receiveTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user2.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: toNano('5'),
            body: bodyOp(op.transferNotification),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user1.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
        })
        expect(result.transactions).toHaveLength(5)

        const tonBalance = await root.getTonBalance()
        const [ totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(tonBalance).toBeBetween('19.9', '20')
        expect(totalStakedTokens).toBeBetween('9.9', '10')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const [ stakedTokens, unstakedTokens, tokensDict ] = await wallet2.getWalletState()
        const dict = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict)
        expect(stakedTokens).toBeTonValue('10')
        expect(unstakedTokens).toBeTonValue(0n)
        expect(dict.size).toBe(1)

        const user1TonBalanceAfter = await user1.getBalance()
        const user1TonDiff = user1TonBalanceAfter - user1TonBalanceBefore
        expect(user1TonDiff).toBeBetween('-15', '-15.1')

        const user2TonBalanceAfter = await user2.getBalance()
        const user2TonDiff = user2TonBalanceAfter - user2TonBalanceBefore
        expect(user2TonDiff).toBeBetween('4.9', '5')
    })

    it('should send tokens to another new wallet', async () => {
        const user1 = await blockchain.treasury('user1')
        const user2 = await blockchain.treasury('user2')
        const user1TonBalanceBefore = await user1.getBalance()
        const user2TonBalanceBefore = await user2.getBalance()
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
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: toNano('2.2'),
            body: bodyOp(op.sendTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1Address,
            to: root.address,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: between('2', '2.2'),
            body: bodyOp(op.consolidate),
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: wallet1Address,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: between('2', '2.2'),
            body: bodyOp(op.receiveTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1Address,
            to: wallet2Address,
            deploy: true,
            success: true,
            outMessagesCount: 2,
            value: between('2', '2.2'),
            body: bodyOp(op.receiveTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user2.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: toNano('2'),
            body: bodyOp(op.transferNotification),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user1.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
        })
        expect(result.transactions).toHaveLength(7)

        const tonBalance = await root.getTonBalance()
        const [ totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(tonBalance).toBeBetween('19.9', '20')
        expect(totalStakedTokens).toBeBetween('9.9', '10')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const [ stakedTokens1, unstakedTokens1, tokensDict1 ] = await wallet1.getWalletState()
        const dict1 = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict1)
        expect(stakedTokens1).toBeBetween('0.9', '1')
        expect(unstakedTokens1).toBeTonValue(0n)
        expect(dict1.size).toBe(1)

        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const [ stakedTokens2, unstakedTokens2, tokensDict2 ] = await wallet2.getWalletState()
        const dict2 = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict2)
        expect(stakedTokens2).toBeTonValue('9')
        expect(unstakedTokens2).toBeTonValue(0n)
        expect(dict2.size).toBe(1)

        const user1TonBalanceAfter = await user1.getBalance()
        const user1TonDiff = user1TonBalanceAfter - user1TonBalanceBefore
        expect(user1TonDiff).toBeBetween('-12.2', '-12.1')

        const user2TonBalanceAfter = await user2.getBalance()
        const user2TonDiff = user2TonBalanceAfter - user2TonBalanceBefore
        expect(user2TonDiff).toBeBetween('1.9', '2')
    })

    it('should send tokens to another existing wallet', async () => {
        const user1 = await blockchain.treasury('user1')
        const user2 = await blockchain.treasury('user2')
        const user1TonBalanceBefore = await user1.getBalance()
        const user2TonBalanceBefore = await user2.getBalance()
        const wallet1Address = await root.getWalletAddress(user1.address)
        const wallet2Address = await root.getWalletAddress(user2.address)
        await root.sendMessage(user1.getSender(), { value: '10' })
        await root.sendMessage(user2.getSender(), { value: '5' })
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
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: toNano('2.2'),
            body: bodyOp(op.sendTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1Address,
            to: root.address,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: between('2', '2.2'),
            body: bodyOp(op.consolidate),
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: wallet1Address,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: between('2', '2.2'),
            body: bodyOp(op.receiveTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1Address,
            to: wallet2Address,
            deploy: false,
            success: true,
            outMessagesCount: 2,
            value: between('2', '2.2'),
            body: bodyOp(op.receiveTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user2.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: toNano('2'),
            body: bodyOp(op.transferNotification),
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2Address,
            to: user1.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: between('0', '0.2'),
            body: bodyOp(op.gasExcess),
        })
        expect(result.transactions).toHaveLength(7)

        const tonBalance = await root.getTonBalance()
        const [ totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(tonBalance).toBeBetween('24.8', '25')
        expect(totalStakedTokens).toBeBetween('14.8', '15')
        expect(totalUnstakedTokens).toBeTonValue(0n)

        const [ stakedTokens1, unstakedTokens1, tokensDict1 ] = await wallet1.getWalletState()
        const dict1 = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict1)
        expect(stakedTokens1).toBeBetween('0.9', '1')
        expect(unstakedTokens1).toBeTonValue(0n)
        expect(dict1.size).toBe(1)

        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        const [ stakedTokens2, unstakedTokens2, tokensDict2 ] = await wallet2.getWalletState()
        const dict2 = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict2)
        expect(stakedTokens2).toBeBetween('13.9', '14')
        expect(unstakedTokens2).toBeTonValue(0n)
        expect(dict2.size).toBe(1)

        const user1TonBalanceAfter = await user1.getBalance()
        const user1TonDiff = user1TonBalanceAfter - user1TonBalanceBefore
        expect(user1TonDiff).toBeBetween('-12.2', '-12.1')

        const user2TonBalanceAfter = await user2.getBalance()
        const user2TonDiff = user2TonBalanceAfter - user2TonBalanceBefore
        expect(user2TonDiff).toBeBetween('-3.1', '-3')
    })

    it('should unstake tokens', async () => {
        const user = await blockchain.treasury('user')
        const userTonBalanceBefore = await user.getBalance()
        const walletAddress = await root.getWalletAddress(user.address)
        await root.sendStakeTon(user.getSender(), {
            value: '10.1',
            tokens: '10',
            recipient: user.address,
            returnExcess: user.address,
        })
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await wallet.sendUnstakeTokens(user.getSender(), {
            value: '0.1',
            tokens: '7',
            returnExcess: user.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: walletAddress,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: toNano('0.1'),
            body: bodyOp(op.unstakeTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: walletAddress,
            to: root.address,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: between('0', '0.1'),
            body: bodyOp(op.unstakeReserve),
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: walletAddress,
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: between('0', '0.1'),
            body: bodyOp(op.receiveTokens),
        })
        expect(result.transactions).toHaveTransaction({
            from: walletAddress,
            to: user.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
        })
        expect(result.transactions).toHaveLength(5)

        const tonBalance = await root.getTonBalance()
        const [ totalStakedTokens, totalUnstakedTokens ] = await root.getRootState()
        expect(tonBalance).toBeBetween('20', '20.1')
        expect(totalStakedTokens).toBeTonValue('3')
        expect(totalUnstakedTokens).toBeTonValue('7')

        const [ stakedTokens, unstakedTokens, tokensDict ] = await wallet.getWalletState()
        const dict = Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), tokensDict)
        expect(stakedTokens).toBeTonValue('3')
        expect(unstakedTokens).toBeTonValue('7')
        expect(dict.size).toBe(1)

        const userTonBalanceAfter = await user.getBalance()
        const userTonDiff = userTonBalanceAfter - userTonBalanceBefore
        expect(userTonDiff).toBeBetween('-10.1', '-10.2')
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
            deploy: false,
            success: true,
            outMessagesCount: 1,
            value: toNano('0.1'),
            body: bodyOp(op.provideWalletAddress),
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: user.address,
            deploy: false,
            success: true,
            outMessagesCount: 0,
            value: between(0n, '0.1'),
            body: expectedBody,
        })
        expect(result.transactions).toHaveLength(3)
    })
})
