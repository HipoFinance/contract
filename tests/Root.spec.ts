import { Blockchain, createShardAccount } from '@ton-community/sandbox'
import { Address, beginCell, Cell, Dictionary, fromNano, SendMode, toNano } from 'ton-core'
import { Root } from '../wrappers/Root'
import { Wallet, walletConfigToCell } from '../wrappers/Wallet'
import '@ton-community/test-utils'
import { compile } from '@ton-community/blueprint'
import { sha256 } from 'ton-crypto'

const opRelease = 3
const opProvideWalletAddress = 0x2c76b973

describe('Root', () => {
    let rootCode: Cell
    let walletCode: Cell
    let emptyRoot: Root
    let filledRoot: Root

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

        filledRoot = Root.createFromConfig({
            totalActive: toNano('1000000'),
            totalNext: toNano('1000000'),
            totalLater: toNano('1000000'),
            round: 100n,
            content: new Cell(),
            walletCode,
        }, rootCode)
    })

    it('should deploy', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        const r = await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        expect(r.transactions).toHaveTransaction({
            from: deployer.address,
            to: root.address,
            success: true,
            deploy: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(2)
    })

    it.skip('should ignore bounced messages', async () => {
        const alwaysFailCode = await compile("AlwaysFail")
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        await b.setShardAccount(walletAddress, createShardAccount({
            address: walletAddress,
            code: alwaysFailCode,
            data: new Cell(),
            balance: toNano('1'),
        }))
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
        const r = await wallet.sendMessage(owner.getSender(), {
            value: toNano('10'),
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: beginCell()
                .storeUint(opProvideWalletAddress, 32)
                .storeUint(0, 64)
                .storeUint(0, 1)
                .endCell()
        })
        expect(r.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            value: toNano('10'),
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: root.address,
            to: walletAddress,
            success: false,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: walletAddress,
            to: root.address,
            exitCode: 1,
            success: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(4)
    })

    it('should mint staked TON for messages with incomplete op field', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))

        const owner = await b.treasury('owner')
        const r = await root.sendMessage(owner.getSender(), {
            value: toNano('2'),
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: beginCell()
                .storeUint(1234, 31)
                .endCell()
        })
        const walletAddress = await root.getWalletAddress(owner.address)

        expect(r.transactions).toHaveTransaction({
            from: owner.address,
            to: root.address,
            value: toNano('2'),
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

        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
        const [, , later] = await wallet.getBalances()
        // expect(+fromNano(later)).toBeCloseTo(2, 1)
    })

    it('should accept simple transfers and mint staked TON', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        const dr = await root.sendDeploy(deployer.getSender(), toNano('0.05'))

        const [rootStorage, walletStorage] = await root.getFees()

        let totalBalance = toNano('0.05') - dr.transactions[1].totalFees.coins
        let totalLater = 0n

        let balance = await root.getStateBalance()
        expect(balance).toBe(totalBalance)

        for (let i = 0; i < 5; i += 1) {
            const owner = await b.treasury('owner' + i)
            const [, , beforeLater] = await root.getTotalBalances()

            const value = BigInt(Math.floor(Math.random() * 50 * 1000000000)) + toNano('0.05')

            const r = await root.sendSimpleTransfer(owner.getSender(), {
                value,
                comment: (i == 0) ? undefined : (i == 1) ? '' : 'some comment',
            })
            const walletAddress = await root.getWalletAddress(owner.address)

            expect(r.transactions).toHaveTransaction({
                from: owner.address,
                to: root.address,
                value,
                success: true,
                deploy: false,
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

            totalBalance += value - walletStorage - r.transactions[1].totalFees.coins - toNano('0.005')
            totalLater += value

            const [, , afterLater] = await root.getTotalBalances()
            // expect(+fromNano(afterLater)).toBeCloseTo(+fromNano(beforeLater + value), 1)

            const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
            const [, , later] = await wallet.getBalances()
            // expect(+fromNano(later)).toBeCloseTo(+fromNano(value), 1)

            // const walletStateBalance = await wallet.getStateBalance()
            // expect(walletStateBalance).toBe(walletStorage - r.transactions[2].totalFees.coins)

            balance = await root.getStateBalance()
            // expect(+fromNano(balance)).toBeCloseTo(+fromNano(totalBalance))
        }

        const [, , afterLater] = await root.getTotalBalances()
        expect(+fromNano(afterLater)).toBeCloseTo(+fromNano(totalLater), 0)
        // expect(totalBalance).toBeGreaterThan(totalLater)

        balance = await root.getStateBalance()
        // expect(+fromNano(balance)).toBeCloseTo(+fromNano(totalBalance))
    })

    it('should not mint when fee is inadequate', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        const owner = await b.treasury('owner')

        const r0 = await root.sendSimpleTransfer(owner.getSender(), {
            value: toNano('0.01'),
            comment: 'low fee',
        })
        expect(r0.transactions).toHaveTransaction({
            from: owner.address,
            to: root.address,
            value: toNano('0.01'),
            exitCode: 101,
        })
        expect(r0.transactions).toHaveLength(3)

        const r1 = await root.sendSimpleTransfer(owner.getSender(), {
            value: toNano('0.1'),
            comment: 'enough',
        })
        const walletAddress = await root.getWalletAddress(owner.address)
        expect(r1.transactions).toHaveTransaction({
            from: owner.address,
            to: root.address,
            value: toNano('0.1'),
            success: true,
            outMessagesCount: 1,
        })
        expect(r1.transactions).toHaveTransaction({
            from: root.address,
            to: walletAddress,
            success: true,
            deploy: true,
            outMessagesCount: 0,
        })
        expect(r1.transactions).toHaveLength(3)
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
        const [, , later] = await wallet.getBalances()
        // expect(later).toBe(1n)
    })

    it('should not mint when owner is not on base chain', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))

        const mcOwner = await b.treasury('owner', { workchain: -1 })
        const r1 = await root.sendSimpleTransfer(mcOwner.getSender(), {
            value: toNano('10'),
            comment: 'from master chain',
        })
        expect(r1.transactions).toHaveTransaction({
            from: mcOwner.address,
            to: root.address,
            value: toNano('10'),
            exitCode: 104,
        })
        expect(r1.transactions).toHaveLength(3)

        const bcOwner = await b.treasury('owner', { workchain: 0 })
        const r2 = await root.sendSimpleTransfer(bcOwner.getSender(), {
            value: toNano('10'),
            comment: 'from base chain',
        })
        expect(r2.transactions).toHaveTransaction({
            from: bcOwner.address,
            to: root.address,
            value: toNano('10'),
            success: true,
            outMessagesCount: 1,
        })
        expect(r2.transactions).toHaveTransaction({
            from: root.address,
            success: true,
            deploy: true,
            outMessagesCount: 0,
        })
        expect(r2.transactions).toHaveLength(3)
    })

    it.skip('should not mint when not deployed on base chain', async () => {
        const b = await Blockchain.create()
        const mcEmptyRoot = Root.createFromConfig({
            totalActive: 0n,
            totalNext: 0n,
            totalLater: 0n,
            round: 0n,
            content: new Cell(),
            walletCode,
        }, rootCode, -1)
        const root = b.openContract(mcEmptyRoot)
        const deployer = await b.treasury('deployer')
        const dr = await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        expect(dr.transactions).toHaveTransaction({
            from: deployer.address,
            to: root.address,
            success: true,
            deploy: true,
            outMessagesCount: 0,
        })
        expect(dr.transactions).toHaveLength(2)

        const owner = await b.treasury('owner')
        const r = await root.sendSimpleTransfer(owner.getSender(), {
            value: toNano('10'),
            comment: 'root is deployed on master chain',
        })
        expect(r.transactions).toHaveTransaction({
            from: owner.address,
            to: root.address,
            value: toNano('10'),
            exitCode: 103,
        })
        expect(r.transactions).toHaveLength(3)
    })

    it('should withdraw staked TON and release TON', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(filledRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('500000'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        await b.setShardAccount(walletAddress, createShardAccount({
            address: walletAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('100000'),
                nextBalance: toNano('100000'),
                laterBalance: toNano('100000'),
                round: 100n,
                owner: owner.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('0.5'),
        }))
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
        const [activeBefore] = await wallet.getBalances()
        const balanceBefore = await root.getStateBalance()

        const r = await wallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            stakeAmount: toNano('60000'),
            recipient: owner.address,
        })
        const [activeAfter] = await wallet.getBalances()
        const balanceAfter = await root.getStateBalance()
        expect(walletAddress).toBe(wallet.address)
        expect(activeAfter).toBe(activeBefore - toNano('60000'))
        expect(r.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            value: toNano('1'),
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: root.address,
            to: owner.address,
            value: toNano('60000'),
            success: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(4)
        expect(+fromNano(balanceAfter)).toBeCloseTo(
            +fromNano(balanceBefore - r.transactions[2].totalFees.coins - toNano('60000') + toNano('1')), 1)
    })

    it.skip('should not withdraw when wallet is not on base chain', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(filledRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('10'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        const mcWalletAddress = new Address(-1, walletAddress.hash)
        await b.setShardAccount(mcWalletAddress, createShardAccount({
            address: mcWalletAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('10'),
                nextBalance: 0n,
                laterBalance: 0n,
                round: 100n,
                owner: owner.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('0.05'),
        }))
        const mcWallet = b.openContract(Wallet.createFromAddress(mcWalletAddress))
        const [activeBefore] = await mcWallet.getBalances()

        const r = await mcWallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            stakeAmount: toNano('6'),
            recipient: owner.address,
        })
        const [activeAfter] = await mcWallet.getBalances()
        expect(activeAfter).toBe(activeBefore)
        expect(r.transactions).toHaveTransaction({
            from: owner.address,
            to: mcWallet.address,
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: mcWallet.address,
            to: root.address,
            exitCode: 103,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: root.address,
            to: mcWallet.address,
            success: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(4)
    })

    it('should not withdraw when not deployed on base chain', async () => {
        const b = await Blockchain.create()
        const mcFilledRoot = Root.createFromConfig({
            totalActive: toNano('1000000'),
            totalNext: toNano('1000000'),
            totalLater: toNano('1000000'),
            round: 100n,
            content: new Cell(),
            walletCode,
        }, rootCode, -1)
        const root = b.openContract(mcFilledRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        await b.setShardAccount(walletAddress, createShardAccount({
            address: walletAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('10'),
                nextBalance: 0n,
                laterBalance: 0n,
                round: 0n,
                owner: owner.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('0.05'),
        }))
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
        const [activeBefore] = await wallet.getBalances()

        const r = await wallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            stakeAmount: toNano('6'),
            recipient: owner.address,
        })
        const [activeAfter] = await wallet.getBalances()
        expect(activeAfter).toBe(activeBefore)
        expect(r.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: wallet.address,
            // this doesn't happen, since in wallet, root is forced to be on base chain
            // to: root.address,
            success: false,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            // this too
            // from: root.address,
            to: wallet.address,
            success: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(4)
    })

    it('should not withdraw when available TON is insufficient', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(filledRoot)
        const deployer = await b.treasury('deployer')
        const owner = await b.treasury('owner')
        await root.sendDeploy(deployer.getSender(), toNano('100'))
        const walletAddress = await root.getWalletAddress(owner.address)
        await b.setShardAccount(walletAddress, createShardAccount({
            address: walletAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('100000'),
                nextBalance: 0n,
                laterBalance: 0n,
                round: 100n,
                owner: owner.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('0.05'),
        }))
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))
        const balance = await root.getStateBalance()

        const r1 = await wallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            stakeAmount: balance - toNano('10') + 1n,
            recipient: owner.address,
        })
        expect(r1.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            exitCode: 102,
            outMessagesCount: 1,
        })
        expect(r1.transactions).toHaveTransaction({
            from: root.address,
            to: wallet.address,
            success: true,
            outMessagesCount: 0,
        })
        expect(r1.transactions).toHaveLength(4)

        const r2 = await wallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            // looks like sometimes storage fee is reducing balance by 1nano
            // this depends on the speed of executing tests
            stakeAmount: balance - toNano('10') - 1n,
            recipient: owner.address,
        })
        expect(r2.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            success: true,
            outMessagesCount: 1,
        })
        expect(r2.transactions).toHaveTransaction({
            from: root.address,
            to: owner.address,
            value: balance - toNano('10') - 1n,
            success: true,
            outMessagesCount: 0,
        })
        expect(r2.transactions).toHaveLength(4)
    })

    it.skip('should not burn when sender is not a wallet', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(filledRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('100'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        await b.setShardAccount(walletAddress, createShardAccount({
            address: walletAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('100'),
                nextBalance: 0n,
                laterBalance: 0n,
                round: 100n,
                owner: owner.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('100'),
        }))
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))

        const r1 = await root.sendMessage(owner.getSender(), {
            value: toNano('1'),
            sendMode: SendMode.NONE,
            body: beginCell()
                .storeUint(opRelease, 32)
                .storeUint(0, 64)
                .storeCoins(toNano('60'))
                .storeUint(BigInt('0x' + owner.address.hash.toString('hex')), 256)
                .endCell()
        })
        expect(r1.transactions).toHaveTransaction({
            from: owner.address,
            to: root.address,
            exitCode: 105,
            outMessagesCount: 1,
        })
        expect(r1.transactions).toHaveTransaction({
            from: root.address,
            to: owner.address,
            success: true,
            outMessagesCount: 0,
        })
        expect(r1.transactions).toHaveLength(3)
    })

    it('should not burn when amount is more than total active balance of root', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(Root.createFromConfig({
            totalActive: toNano('100000'),
            totalNext: 0n,
            totalLater: 0n,
            round: 100n,
            content: new Cell(),
            walletCode,
        }, rootCode))
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('500000'))
        const owner = await b.treasury('owner')
        const walletAddress = await root.getWalletAddress(owner.address)
        await b.setShardAccount(walletAddress, createShardAccount({
            address: walletAddress,
            code: walletCode,
            data: walletConfigToCell({
                activeBalance: toNano('200001'),
                nextBalance: 0n,
                laterBalance: 0n,
                round: 100n,
                owner: owner.address,
                root: root.address,
                walletCode,
            }),
            balance: toNano('0.05'),
        }))
        const wallet = b.openContract(Wallet.createFromAddress(walletAddress))

        const r1 = await wallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            stakeAmount: toNano('100000') + 1n,
            recipient: owner.address,
        })
        expect(r1.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            exitCode: 102,
            outMessagesCount: 1,
        })
        expect(r1.transactions).toHaveTransaction({
            from: root.address,
            to: wallet.address,
            success: true,
            outMessagesCount: 0,
        })
        expect(r1.transactions).toHaveLength(4)

        const r2 = await wallet.sendWithdraw(owner.getSender(), {
            value: toNano('1'),
            stakeAmount: toNano('100000'),
            recipient: owner.address,
        })
        expect(r2.transactions).toHaveTransaction({
            from: wallet.address,
            to: root.address,
            success: true,
            outMessagesCount: 1,
        })
        expect(r2.transactions).toHaveTransaction({
            from: root.address,
            to: owner.address,
            value: toNano('100000'),
            success: true,
            outMessagesCount: 0,
        })
        expect(r2.transactions).toHaveLength(4)
    })

    it('should not mint staked TON for top-up messages', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        const dr = await root.sendDeploy(deployer.getSender(), toNano('0.05'))

        const beforeBalance = await root.getStateBalance()
        expect(beforeBalance).toBe(toNano('0.05') - dr.transactions[1].totalFees.coins)

        const someone = await b.treasury('someone')
        const r = await root.sendTopUp(someone.getSender(), toNano('0.1'))
        expect(r.transactions).toHaveTransaction({
            from: someone.address,
            to: root.address,
            success: true,
            deploy: false,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(2)

        const afterBalance = await root.getStateBalance()
        expect(afterBalance).toBe(beforeBalance + toNano('0.1') - r.transactions[1].totalFees.coins)
    })

    it('should throw error when op is unknown', async () => {
        const b = await Blockchain.create()
        const root = b.openContract(emptyRoot)
        const deployer = await b.treasury('deployer')
        await root.sendDeploy(deployer.getSender(), toNano('0.05'))
        const r = await root.sendMessage(deployer.getSender(), {
            value: toNano('2'),
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: beginCell()
                .storeUint(10, 32)
                .endCell()
        })
        expect(r.transactions).toHaveTransaction({
            from: deployer.address,
            to: root.address,
            exitCode: 999,
            outMessagesCount: 1,
        })
        expect(r.transactions).toHaveTransaction({
            from: root.address,
            to: deployer.address,
            success: true,
            outMessagesCount: 0,
        })
        expect(r.transactions).toHaveLength(3)
    })
})
