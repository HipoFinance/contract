import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Cell, beginCell, toNano } from 'ton-core'
import { Fees, Root } from '../wrappers/Root'
import { Wallet } from '../wrappers/Wallet'
import { between, bodyOp } from './helper'
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
    let driver: SandboxContract<TreasuryContract>
    let fees: Fees

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        driver = await blockchain.treasury('driver')
        root = blockchain.openContract(Root.createFromConfig({
            walletCode,
            poolCode,
            driver: driver.address,
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

    it('should deposit coins', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await root.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await root.sendDepositCoins(staker.getSender(), { value: '10' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: root.address,
            value: toNano('10'),
            body: bodyOp(op.depositCoins),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: wallet.address,
            value: between(fees.walletStorage, '0.1'),
            body: bodyOp(op.saveCoins),
            deploy: true,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const rootBalance = await root.getBalance()
        const [ totalCoins, totalTokens, totalStaking, totalUnstaking, totalValidatorsStake ] =
            await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalCoins).toBeTonValue('0')
        expect(totalTokens).toBeTonValue('0')
        expect(totalStaking).toBeBetween('9.9', '10')
        expect(totalUnstaking).toBeTonValue('0')
        expect(totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage, '0.1')
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeBetween('9.9', '10')
        expect(unstaking).toBeTonValue('0')
    })

    it('should stake coins', async () => {
        const staker = await blockchain.treasury('staker')
        await root.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await root.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        const result = await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })

        expect(result.transactions).toHaveTransaction({
            from: driver.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.stakeCoins),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            value: between('0', '0.1'),
            body: bodyOp(op.mintTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: wallet.address,
            value: between('0', '0.1'),
            body: bodyOp(op.receiveTokens),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: bodyOp(op.transferNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(6)

        const rootBalance = await root.getBalance()
        const [ totalCoins, totalTokens, totalStaking, totalUnstaking, totalValidatorsStake ] =
            await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalCoins).toBeBetween('9.9', '10')
        expect(totalTokens).toBeTonValue(totalCoins)
        expect(totalStaking).toBeTonValue('0')
        expect(totalUnstaking).toBeTonValue('0')
        expect(totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeBetween('9.9', '10')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')
    })

    it('should send tokens to another new wallet', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await root.sendDepositCoins(staker1.getSender(), { value: '10' })
        const wallet1Address = await root.getWalletAddress(staker1.address)
        const wallet2Address = await root.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        await wallet1.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: '0.11',
            tokens: '9',
            recipient: staker2.address,
            returnExcess: staker1.address,
            forwardTonAmount: '0.01',
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: toNano('0.11'),
            body: bodyOp(op.sendTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0.01', '0.11'),
            body: bodyOp(op.receiveTokens),
            deploy: true,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker2.address,
            value: toNano('0.01'),
            body: bodyOp(op.transferNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalCoins, totalTokens, totalStaking, totalUnstaking, totalValidatorsStake ] =
            await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalCoins).toBeBetween('9.9', '10')
        expect(totalTokens).toBeTonValue(totalCoins)
        expect(totalStaking).toBeTonValue('0')
        expect(totalUnstaking).toBeTonValue('0')
        expect(totalValidatorsStake).toBeTonValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [ tokens1, staking1, unstaking1 ] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens1).toBeBetween('0.9', '1')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeTonValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [ tokens2, staking2, unstaking2 ] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens2).toBeTonValue('9')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeTonValue('0')
    })

    it('should send tokens to another existing wallet', async () => {
        const staker1 = await blockchain.treasury('staker1')
        const staker2 = await blockchain.treasury('staker2')
        await root.sendDepositCoins(staker1.getSender(), { value: '10' })
        await root.sendDepositCoins(staker2.getSender(), { value: '5' })
        const wallet1Address = await root.getWalletAddress(staker1.address)
        const wallet2Address = await root.getWalletAddress(staker2.address)
        const wallet1 = blockchain.openContract(Wallet.createFromAddress(wallet1Address))
        const wallet2 = blockchain.openContract(Wallet.createFromAddress(wallet2Address))
        await wallet1.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        await wallet2.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const forwardPayload = beginCell().storeUint(0, 256).storeUint(0, 56).endCell().beginParse()
        const result = await wallet1.sendSendTokens(staker1.getSender(), {
            value: '0.11',
            tokens: '9',
            recipient: staker2.address,
            returnExcess: staker1.address,
            forwardTonAmount: '0.01',
            forwardPayload,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker1.address,
            to: wallet1.address,
            value: toNano('0.11'),
            body: bodyOp(op.sendTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet1.address,
            to: wallet2.address,
            value: between('0.01', '0.11'),
            body: bodyOp(op.receiveTokens),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker2.address,
            value: toNano('0.01'),
            body: bodyOp(op.transferNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet2.address,
            to: staker1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalCoins, totalTokens, totalStaking, totalUnstaking, totalValidatorsStake ] =
            await root.getRootState()
        expect(rootBalance).toBeBetween('24.8', '25')
        expect(totalCoins).toBeBetween('14.8', '15')
        expect(totalTokens).toBeTonValue(totalCoins)
        expect(totalStaking).toBeTonValue('0')
        expect(totalUnstaking).toBeTonValue('0')
        expect(totalValidatorsStake).toBeTonValue('0')

        const wallet1Balance = await wallet1.getBalance()
        const [ tokens1, staking1, unstaking1 ] = await wallet1.getWalletState()
        expect(wallet1Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens1).toBeBetween('0.9', '1')
        expect(staking1.keys()).toHaveLength(0)
        expect(unstaking1).toBeTonValue('0')

        const wallet2Balance = await wallet2.getBalance()
        const [ tokens2, staking2, unstaking2 ] = await wallet2.getWalletState()
        expect(wallet2Balance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens2).toBeBetween('13.9', '14')
        expect(staking2.keys()).toHaveLength(0)
        expect(unstaking2).toBeTonValue('0')
    })

    it('should unstake tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await root.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await root.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        const result = await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.1', tokens: '7' })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.unstakeTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            value: between('0', '0.1'),
            body: bodyOp(op.reserveTokens),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalCoins, totalTokens, totalStaking, totalUnstaking, totalValidatorsStake ] =
            await root.getRootState()
        expect(rootBalance).toBeBetween('19.9', '20')
        expect(totalCoins).toBeBetween('9.9', '10')
        expect(totalTokens).toBeTonValue(totalCoins)
        expect(totalStaking).toBeTonValue('0')
        expect(totalUnstaking).toBeTonValue('7')
        expect(totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeBetween('2.9', '3')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('7')
    })

    it('should withdraw tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await root.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await root.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.1', roundSince: 0n })
        await wallet.sendUnstakeTokens(staker.getSender(), { value: '0.1', tokens: '7' })
        const result = await wallet.sendWithdrawTokens(driver.getSender(), { value: '0.1' })

        expect(result.transactions).toHaveTransaction({
            from: driver.address,
            to: wallet.address,
            value: toNano('0.1'),
            body: bodyOp(op.withdrawTokens),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            value: between('0', '0.1'),
            body: bodyOp(op.burnTokens),
            deploy: false,
            success: true,
            outMessagesCount: 2,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: staker.address,
            value: toNano('7'),
            body: bodyOp(op.withdrawalNotification),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: driver.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(5)

        const rootBalance = await root.getBalance()
        const [ totalCoins, totalTokens, totalStaking, totalUnstaking, totalValidatorsStake ] =
            await root.getRootState()
        expect(rootBalance).toBeBetween('12.9', '13')
        expect(totalCoins).toBeBetween('2.9', '3')
        expect(totalTokens).toBeTonValue(totalCoins)
        expect(totalStaking).toBeTonValue('0')
        expect(totalUnstaking).toBeTonValue('0')
        expect(totalValidatorsStake).toBeTonValue('0')

        const walletBalance = await wallet.getBalance()
        const [ tokens, staking, unstaking ] = await wallet.getWalletState()
        expect(walletBalance).toBeBetween(fees.walletStorage - 1n, fees.walletStorage)
        expect(tokens).toBeBetween('2.9', '3')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')
    })

    it('should respond with wallet address', async () => {
        const staker = await blockchain.treasury('staker')
        await root.sendDepositCoins(staker.getSender(), { value: '10' })
        const walletAddress = await root.getWalletAddress(staker.address)
        const queryId = BigInt(Math.floor(Math.random() * Math.pow(2, 64)))
        const expectedBody = beginCell()
            .storeUint(op.takeWalletAddress, 32)
            .storeUint(queryId, 64)
            .storeAddress(walletAddress)
            .storeMaybeRef(beginCell().storeAddress(staker.address))
            .endCell()
        const result = await root.sendProvideWalletAddress(staker.getSender(), {
            value: '0.1',
            queryId: queryId,
            owner: staker.address,
            includeAddress: true,
        })

        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: root.address,
            value: toNano('0.1'),
            body: bodyOp(op.provideWalletAddress),
            deploy: false,
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: root.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: expectedBody,
            deploy: false,
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })
})
