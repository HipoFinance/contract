import { Blockchain, createShardAccount } from '@ton-community/sandbox'
import { Address, Cell, toNano } from 'ton-core'
import { Wallet, walletConfigToCell } from '../wrappers/Wallet'
import { Root } from '../wrappers/Root'
import '@ton-community/test-utils'
import { compile } from '@ton-community/blueprint'

const emptyAddress = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c")

describe('Wallet', () => {
    let rootCode: Cell
    let walletCode: Cell
    let emptyRoot: Root

    beforeAll(async () => {
        rootCode = await compile('Root')
        walletCode = await compile('Wallet')

        emptyRoot = Root.createFromConfig({
            totalActive: 0n,
            totalNext: 0n,
            totalLater: 0n,
            round: 0n,
            content: new Cell(),
            walletCode,
        }, rootCode)
    })

    it('should be deployed by root', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        const r = await root.sendSimpleTransfer(owner.getSender(), {
            value: toNano('5'),
            comment: '',
        })
        expect(r.transactions).toHaveTransaction({
            from: owner.address,
            to: root.address,
            value: toNano('5'),
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: root.address,
            to: walletAddress,
            success: true,
            deploy: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(3)
    })

    it.only('should return balances', async () => {
        const b = await Blockchain.create()
        const wallet = b.openContract(Wallet.createFromConfig({
            activeBalance: toNano('3'),
            nextBalance: toNano('2'),
            laterBalance: toNano('1'),
            round: 0n,
            owner: emptyAddress,
            root: emptyAddress,
            walletCode,
        }, walletCode))
        const deployer = await b.treasury('deployer')
        const dr = await wallet.sendDeploy(deployer.getSender(), toNano('0.05'))
        expect(dr.transactions).toHaveTransaction({
            from: deployer.address,
            to: wallet.address,
            success: true,
            deploy: true,
        })
        const [active, next, later] = await wallet.getBalances()
        expect(active).toBe(toNano('3'))
        expect(next).toBe(toNano('2'))
        expect(later).toBe(toNano('1'))
    })

    it('should send to new wallet', async () => {
        const b = await Blockchain.create()
        const deployer = await b.treasury('deployer')
        const sender = await b.treasury('sender')
        const receiver = await b.treasury('receiver')
        const root = b.openContract(emptyRoot)
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        const walletSenderAddress = await root.getWalletAddress(sender.address)
        const walletReceiverAddress = await root.getWalletAddress(receiver.address)
        await b.setShardAccount(walletSenderAddress, createShardAccount({
            address: walletSenderAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('100'),
                nextBalance: toNano('10'),
                laterBalance: toNano('5'),
                round: 0n,
                owner: sender.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('0.05')
        }))
        const walletSender = b.openContract(Wallet.createFromAddress(walletSenderAddress))

        const r = await walletSender.sendSend(sender.getSender(), {
            value: toNano('0.1'),
            stakeAmount: toNano('60'),
            recipientOwner: receiver.address,
            returnExcess: sender.address,
            notificationTonAmount: 0n,
        })
        expect(r.transactions).toHaveTransaction({
            from: sender.address,
            to: walletSenderAddress,
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: walletSenderAddress,
            to: walletReceiverAddress,
            success: true,
            deploy: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(3)

        const walletReceiver = b.openContract(Wallet.createFromAddress(walletReceiverAddress))
        const sb = await walletSender.getBalances()
        const rb = await walletReceiver.getBalances()
        expect(sb).toEqual([toNano('40'), toNano('10'), toNano('5')])
        expect(rb).toEqual([toNano('60'), toNano('0'), toNano('0')])
    })
})
