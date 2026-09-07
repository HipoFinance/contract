import { compile } from '@ton/blueprint'
import { Blockchain, BlockchainTransaction, createShardAccount, SandboxContract } from '@ton/sandbox'
import '@ton/test-utils'
import { Cell, Dictionary, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { bodyOp, updateFeeConfig } from './helper'
import { op } from '../wrappers/common'
import {
    ParticipationState,
    Treasury,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Parent, parentConfigToCell } from '../wrappers/Parent'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { UnstakeMode, Wallet, WalletFees } from '../wrappers/Wallet'

// The v2 wallet code deployed on mainnet, compiled from commit eb839658 (2024-03-22). Read from the
// treasury's current parent EQDPdq8x..., whose get_jetton_data() exposes it as an exotic library-
// reference cell (SETLIBCODE): tag byte 2 then the 32-byte code hash. Calling .hash() on that cell
// hashes the POINTER and matches nothing — skip the tag and read the next 32 bytes.
//
// That parent's old_parents dictionary is empty, but do NOT read that as proof of a single generation.
// Entries are deleted once every wallet on a retired generation has been migrated, to keep treasury
// storage small, and the same is done for retired collection and bill codes. An earlier wallet
// generation did exist and was fully migrated. Separately, protocol v1 lived on a different treasury
// and address entirely, and still has a few hundred wallets that are NOT this code.
//
// Wallets compile send_tokens_fee / unstake_tokens_fee / upgrade_wallet_fee from imports/utils.fc, and
// those sum TREASURY-side gas:: constants. So every deployed wallet enforces a FROZEN estimate of what
// the treasury will cost, while the treasury itself keeps evolving. When a frozen fee stops covering the
// real cost the failure is not graceful: everything past proxy_reserve_tokens (parent.fc:93) is
// non-bounceable, so the chain aborts with no bounce, the wallet is left at tokens -1 / unstaking 1, and
// the user's hGRAM is destroyed.
//
// MinGas.spec.ts cannot catch this. It reads getWalletFees() off a wallet it just compiled and asserts
// that same wallet accepts it — a tautology that passes for every generation. This spec funds the
// ACTUAL deployed code at exactly the minimum it enforces, against the CURRENT treasury.
const deployedWalletHash = '68df0e0f417fa5e23a61ea59ccc06009f4c687b612e9a5b6c992ab4628b181ab'

describe('Wallet Generations', () => {
    let treasuryCode: Cell
    let parentCode: Cell
    let currentWalletCode: Cell
    let deployedWalletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        parentCode = await compile('Parent')
        currentWalletCode = await compile('Wallet')
        collectionCode = await compile('Collection')
        billCode = await compile('Bill')
        loanCode = await compile('Loan')
        deployedWalletCode = Cell.fromBoc(readFileSync(__dirname + '/fixtures/wallet-mainnet-2024-03-22.boc'))[0]
    })

    it('should carry a fixture that is byte-identical to the deployed wallet', () => {
        expect(deployedWalletCode.hash().toString('hex')).toEqual(deployedWalletHash)
    })

    // Stands up the current treasury and parent, but with `walletCode` as the wallet generation, so a
    // wallet minted here runs exactly that code against exactly today's treasury.
    async function setUp(walletCode: Cell) {
        const blockchain = await Blockchain.create()
        // Both wallet generations are registered, mirroring a real migration window: the retired code
        // must stay resolvable while wallets still run it, and the incoming code must already be there
        // for them to migrate onto. Registering only one makes an upgrading wallet fail to deploy with
        // a cell underflow rather than anything that looks like a fee problem.
        blockchain.libs = buildBlockchainLibraries([
            deployedWalletCode,
            currentWalletCode,
            collectionCode,
            billCode,
            loanCode,
        ])
        updateFeeConfig(blockchain)

        const halter = await blockchain.treasury('halter')
        const governor = await blockchain.treasury('governor')
        const treasury = blockchain.openContract(
            Treasury.createFromConfig(
                {
                    totalCoins: toNano('10'), // dead shares
                    totalTokens: toNano('10'), // dead shares
                    totalStaking: 0n,
                    totalUnstaking: 0n,
                    totalBorrowersStake: 0n,
                    deficit: 0n,
                    parent: null,
                    participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                    roundsImbalance: 255n,
                    stopped: false,
                    instantMint: false,
                    loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        exportLibCode(loanCode),
                    ),
                    previousRate: 1_000_000_000n,
                    currentRate: 1_000_000_000n,
                    windowDuration: 0n,
                    lastSettledRound: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    borrowerFee: 0n,
                    collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        exportLibCode(collectionCode),
                    ),
                    billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        exportLibCode(billCode),
                    ),
                    oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
                    midRate: 1_000_000_000n,
                    midRound: 0n,
                },
                treasuryCode,
            ),
        )
        const parent = blockchain.openContract(
            Parent.createFromConfig(
                {
                    totalTokens: 0n,
                    treasury: treasury.address,
                    walletCode: exportLibCode(walletCode),
                    content: Cell.EMPTY,
                },
                parentCode,
            ),
        )

        const deployer = await blockchain.treasury('deployer')
        await treasury.sendDeploy(deployer.getSender(), { value: '1' })
        await parent.sendDeploy(deployer.getSender(), { value: '1' })
        await treasury.sendSetParent(governor.getSender(), { value: '1', newParent: parent.address })

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('20') })
        const wallet = blockchain.openContract(Wallet.createFromAddress(await parent.getWalletAddress(staker.address)))
        const fees = await wallet.getWalletFees()

        return { blockchain, treasury, parent, wallet, staker, halter, governor, fees }
    }

    // Asserts a chain did not merely start, but ran to completion without destroying anything. The
    // partial-failure signature we care about is an aborted transaction mid-chain, or a wallet left
    // holding negative tokens with a dangling unstaking amount.
    async function expectChainCompleted(
        wallet: SandboxContract<Wallet>,
        transactions: BlockchainTransaction[],
        label: string,
    ) {
        const aborted = transactions.filter((t) => t.description.type === 'generic' && t.description.aborted)
        const skipped = transactions.filter(
            (t) => t.description.type === 'generic' && t.description.computePhase.type === 'skipped',
        )
        const [tokens, , unstaking] = await wallet.getWalletState()
        const detail =
            `${label}: ${String(transactions.length)} txs, ${String(aborted.length)} aborted, ` +
            `${String(skipped.length)} skipped, wallet tokens=${String(tokens)} unstaking=${String(unstaking)}`
        return { aborted: aborted.length, skipped: skipped.length, tokens, unstaking, detail }
    }

    function report(generation: string, fees: WalletFees) {
        console.info(
            `[${generation}] sendTokensFee=${String(fees.sendTokensFee)} ` +
                `unstakeTokensFee=${String(fees.unstakeTokensFee)} ` +
                `upgradeWalletFee=${String(fees.upgradeWalletFee)} ` +
                `walletStorageFee=${String(fees.walletStorageFee)}`,
        )
    }

    it('should report the frozen fees of both generations', async () => {
        const deployed = await setUp(deployedWalletCode)
        const current = await setUp(currentWalletCode)
        report('deployed 2024-03-22', deployed.fees)
        report('current HEAD       ', current.fees)
        console.info(
            `[delta] sendTokens=${String(current.fees.sendTokensFee - deployed.fees.sendTokensFee)} ` +
                `unstakeTokens=${String(current.fees.unstakeTokensFee - deployed.fees.unstakeTokensFee)} ` +
                `upgradeWallet=${String(current.fees.upgradeWalletFee - deployed.fees.upgradeWalletFee)} ` +
                `walletStorage=${String(current.fees.walletStorageFee - deployed.fees.walletStorageFee)}`,
        )
    })

    // send_tokens is the chain whose fee changed behaviourally: the deployed generation's
    // send_tokens_fee() has no forward-fee term at all, it was added later in utils.fc.
    it('should fund send_tokens from the deployed generation at its own enforced minimum', async () => {
        const { wallet, staker, halter } = await setUp(deployedWalletCode)
        const fees = await wallet.getWalletFees()
        const result = await wallet.sendSendTokens(staker.getSender(), {
            value: fees.sendTokensFee,
            tokens: '5',
            recipient: halter.address,
        })
        const outcome = await expectChainCompleted(wallet, result.transactions, 'send_tokens')
        console.info(`[deployed] ${outcome.detail}`)
        expect(result.transactions).toHaveTransaction({
            from: staker.address,
            to: wallet.address,
            body: bodyOp(op.sendTokens),
            success: true,
        })
        expect(outcome.aborted).toEqual(0)
        expect(outcome.tokens).toBeGreaterThanOrEqual(0n)
    })

    it('should fund an instant unstake from the deployed generation at its own enforced minimum', async () => {
        const { wallet, staker } = await setUp(deployedWalletCode)
        const fees = await wallet.getWalletFees()
        const result = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: fees.unstakeTokensFee,
            tokens: '5',
            mode: UnstakeMode.Instant,
        })
        const outcome = await expectChainCompleted(wallet, result.transactions, 'unstake instant')
        console.info(`[deployed] ${outcome.detail}`)
        expect(outcome.aborted).toEqual(0)
        expect(outcome.tokens).toBeGreaterThanOrEqual(0n)
        expect(outcome.unstaking).toEqual(0n)
    })

    // The bill path is the one with no safety net: past proxy_reserve_tokens nothing bounces. Reaching it
    // requires a round already staked, otherwise the treasury just settles instantly and this silently
    // measures the instant path instead — so assert a bill was actually minted before trusting the result.
    // Note MaxGas.spec.ts funds its own bill-path case at unstakeTokensFee + 0.1 GRAM, so the enforced
    // minimum on this path was never exercised anywhere before this test.
    it('should fund a best-rate unstake from the deployed generation at its own enforced minimum', async () => {
        const { blockchain, treasury, wallet, staker } = await setUp(deployedWalletCode)
        const fees = await wallet.getWalletFees()

        const round = 200n
        const state = await treasury.getTreasuryState()
        state.participations.set(round, { state: ParticipationState.Staked })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: await treasury.getBalance(),
            }),
        )
        const collection = await treasury.getCollectionAddress(round)

        const result = await wallet.sendUnstakeTokens(staker.getSender(), {
            value: fees.unstakeTokensFee,
            tokens: '5',
            mode: UnstakeMode.Best,
        })
        const outcome = await expectChainCompleted(wallet, result.transactions, 'unstake best')
        console.info(`[deployed] ${outcome.detail}`)

        // Proves the bill path really ran, rather than falling back to an instant settlement.
        expect(result.transactions).toHaveTransaction({
            from: treasury.address,
            to: collection,
            body: bodyOp(op.mintBill),
            success: true,
        })
        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(outcome.aborted).toEqual(0)
        expect(outcome.tokens).toBeGreaterThanOrEqual(0n)
    })

    // The real v2 -> v3 shape: a wallet running mainnet code migrating onto a parent that carries the
    // CURRENT generation. This is the thinnest margin in the protocol — upgrade_wallet_fee runs at
    // roughly 1.24x real cost, against 3.7x-6.4x for the unstake chains — and it is also the least
    // forgiving, because migrate_wallet zeroes the old wallet before merge_wallet runs. If the fee
    // does not cover the chain the balance is destroyed rather than bounced.
    it('should fund the upgrade chain from the deployed generation onto a current-generation parent', async () => {
        const { blockchain, treasury, wallet, staker, governor } = await setUp(deployedWalletCode)
        const fees = await wallet.getWalletFees()

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
                    walletCode: exportLibCode(currentWalletCode),
                    content: Cell.EMPTY,
                }),
                balance: toNano('0.01'),
            }),
        )
        const newParent = blockchain.openContract(Parent.createFromAddress(newParentAddress))
        const newWalletAddress = await newParent.getWalletAddress(staker.address)
        await treasury.sendSetParent(governor.getSender(), { value: '0.1', newParent: newParentAddress })

        const result = await wallet.sendUpgradeWallet(staker.getSender(), { value: fees.upgradeWalletFee })
        console.info(
            `[deployed] upgrade chain: ${String(result.transactions.length)} txs at ` +
                `upgradeWalletFee=${String(fees.upgradeWalletFee)}`,
        )

        // The merge must actually land on the new wallet; a chain that dies after migrate_wallet would
        // otherwise look like a quiet success from the old wallet's side.
        expect(result.transactions).toHaveTransaction({
            from: newParentAddress,
            to: newWalletAddress,
            body: bodyOp(op.mergeWallet),
            success: true,
        })
        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result.transactions).not.toHaveTransaction({ actionResultCode: 37 })

        const newWallet = blockchain.openContract(Wallet.createFromAddress(newWalletAddress))
        const [newTokens] = await newWallet.getWalletState()
        console.info(`[deployed] upgrade chain: new wallet tokens=${String(newTokens)}`)
        expect(newTokens).toBeGreaterThan(0n)
    })

    // The treasury holds fee::treasury_storage (10 GRAM) in reserve, so a treasury funded only by this
    // staker's own deposit cannot buy back their whole balance and correctly rolls the unstake back
    // instead. That is a real path, but it is covered by the rollback test below; to exercise the burn
    // here the treasury needs enough spare balance to actually pay out.
    it('should fund unstake_all through a deployed-generation wallet', async () => {
        const { blockchain, treasury, wallet, staker } = await setUp(deployedWalletCode)
        const treasuryFees = await treasury.getTreasuryFees(0n)

        const state = await treasury.getTreasuryState()
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(state),
                balance: toNano('60'),
            }),
        )

        const result = await treasury.sendMessage(staker.getSender(), {
            value: treasuryFees.unstakeAllTokensFee,
            body: 'w',
        })
        const outcome = await expectChainCompleted(wallet, result.transactions, 'unstake_all')
        console.info(`[deployed] ${outcome.detail}`)

        expect(result.transactions).toHaveTransaction({
            to: wallet.address,
            body: bodyOp(op.unstakeAll),
            success: true,
        })
        // Must actually burn, not quietly roll back — a rollback would leave tokens untouched and still
        // satisfy every "nothing failed" assertion.
        expect(result.transactions).not.toHaveTransaction({ body: bodyOp(op.rollbackUnstake) })
        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(outcome.aborted).toEqual(0)
        expect(outcome.tokens).toEqual(0n)
    })

    // rollback_unstake is burn_tokens' third branch: the treasury can neither pay the unstake out nor
    // postpone it onto a later round still holding bills, so it hands the tokens back. Reaching it needs
    // exactly one round, flipped to burning, with the treasury starved below what it owes.
    it('should fund rollback_unstake back into a deployed-generation wallet', async () => {
        const { blockchain, treasury, wallet, staker, halter } = await setUp(deployedWalletCode)
        const fees = await wallet.getWalletFees()

        const round = 200n // the only round, so nothing later can absorb a postponed bill
        const staked = await treasury.getTreasuryState()
        staked.participations.set(round, { state: ParticipationState.Staked })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(staked),
                balance: toNano('10') + toNano('10'),
            }),
        )

        await wallet.sendUnstakeTokens(staker.getSender(), {
            value: fees.unstakeTokensFee,
            tokens: '7',
            mode: UnstakeMode.Best,
        })

        const burning = await treasury.getTreasuryState()
        burning.participations.set(round, { state: ParticipationState.Burning })
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: treasuryConfigToCell(burning),
                balance: toNano('10') + toNano('3'), // available 3 GRAM < 7 coins owed
            }),
        )

        const result = await treasury.sendRetryBurnAll(halter.getSender(), { value: '0.1', roundSince: round })
        const outcome = await expectChainCompleted(wallet, result.transactions, 'rollback_unstake')
        console.info(`[deployed] ${outcome.detail}`)

        expect(result.transactions).toHaveTransaction({
            to: wallet.address,
            body: bodyOp(op.rollbackUnstake),
            success: true,
        })
        expect(result.transactions).not.toHaveTransaction({ success: false })
        expect(result.transactions).not.toHaveTransaction({ exitCode: -14 })
        expect(result.transactions).not.toHaveTransaction({ actionResultCode: 37 })
        expect(outcome.aborted).toEqual(0)
        // The rolled-back tokens must come home, not vanish: unstaking clears and the balance returns.
        expect(outcome.unstaking).toEqual(0n)
        expect(outcome.tokens).toBeGreaterThan(0n)
    })
})
