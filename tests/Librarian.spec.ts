import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Cell, Dictionary, toNano } from '@ton/core'
import { Librarian } from '../wrappers/Librarian'
import '@ton/test-utils'
import { compile } from '@ton/blueprint'
import { between, bodyOp } from './helper'
import { op } from '../wrappers/common'
import { Treasury } from '../wrappers/Treasury'

describe('Librarian', () => {
    let librarianCode: Cell
    let treasuryCode: Cell
    let walletCode: Cell

    beforeAll(async () => {
        librarianCode = await compile('Librarian')
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
    })

    let blockchain: Blockchain
    let governor: SandboxContract<TreasuryContract>
    let treasury: SandboxContract<Treasury>
    let librarian: SandboxContract<Librarian>

    beforeEach(async () => {
        blockchain = await Blockchain.create()
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
                    participations: Dictionary.empty(),
                    roundsImbalance: 255n,
                    stopped: false,
                    loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        Cell.EMPTY,
                    ),
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    halter: governor.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        Cell.EMPTY,
                    ),
                    billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        Cell.EMPTY,
                    ),
                    oldParents: Dictionary.empty(),
                },
                treasuryCode,
            ),
        )
        librarian = blockchain.openContract(
            Librarian.createFromConfig(
                {
                    treasury: treasury.address,
                },
                librarianCode,
            ),
        )

        const deployResult = await librarian.sendDeploy(governor.getSender(), { value: '1' })
        expect(deployResult.transactions).toHaveTransaction({
            from: governor.address,
            to: librarian.address,
            value: toNano('1'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
    })

    it('should set a public library', async () => {
        const result = await treasury.sendProxySetLibrary(governor.getSender(), {
            value: '1',
            destination: librarian.address,
            mode: 2n,
            code: walletCode,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.proxySetLibrary),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: librarian.address,
            value: between('0', '1'),
            body: bodyOp(op.setLibrary),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })

    it('should remove a library', async () => {
        const result = await treasury.sendProxySetLibrary(governor.getSender(), {
            value: '1',
            destination: librarian.address,
            mode: 0n,
            code: walletCode,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('1'),
            body: bodyOp(op.proxySetLibrary),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: librarian.address,
            value: between('0', '1'),
            body: bodyOp(op.setLibrary),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(3)
    })

    it('should withdraw surplus', async () => {
        const result = await treasury.sendProxyWithdrawSurplus(governor.getSender(), {
            value: '5',
            destination: librarian.address,
        })

        expect(result.transactions).toHaveTransaction({
            from: governor.address,
            to: treasury.address,
            value: toNano('5'),
            body: bodyOp(op.proxyWithdrawSurplus),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: librarian.address,
            value: between('0', '5'),
            body: bodyOp(op.withdrawSurplus),
            success: true,
            outMessagesCount: 1,
        })
        expect(result.transactions).toHaveTransaction({
            from: librarian.address,
            to: governor.address,
            value: between('4.9', '5'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result.transactions).toHaveLength(4)

        const librarianBalance = await librarian.getBalance()
        expect(librarianBalance).toBeTonValue('1')
    })
})
