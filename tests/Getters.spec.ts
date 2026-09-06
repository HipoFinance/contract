import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, beginCell, Cell, Dictionary, TupleReader, toNano } from '@ton/core'
import {
    between,
    bodyOp,
    createNewStakeMsg,
    createVset,
    getElector,
    logCodeCost,
    logTreasuryFees,
    logWalletFees,
    setConfig,
    updateFeeConfig,
} from './helper'
import { config, err, op } from '../wrappers/common'
import {
    ParticipationState,
    Treasury,
    TreasuryFees,
    emptyDictionaryValue,
    participationDictionaryValue,
    treasuryConfigToCell,
} from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { Loan } from '../wrappers/Loan'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { Parent, metadataDictionaryValue, toMetadataKey } from '../wrappers/Parent'
import { StorageCost } from '../wrappers/storage-cost/StorageCost'
import { buildBlockchainLibraries, exportLibCode } from '../wrappers/Librarian'
import { Collection } from '../wrappers/Collection'
import { Bill } from '../wrappers/Bill'

describe('Getters', () => {
    let electorCode: Cell
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell
    let librarianCode: Cell
    let mainWalletCode: Cell
    let mainCollectionCode: Cell
    let mainBillCode: Cell
    let mainLoanCode: Cell

    beforeAll(async () => {
        electorCode = await compile('elector-test/Elector')
        treasuryCode = await compile('Treasury')
        parentCode = await compile('Parent')
        mainWalletCode = await compile('Wallet')
        mainCollectionCode = await compile('Collection')
        mainBillCode = await compile('Bill')
        mainLoanCode = await compile('Loan')
        librarianCode = await compile('Librarian')
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
    let electorAddress: Address

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        blockchain.libs = blockchainLibs
        updateFeeConfig(blockchain)
        halter = await blockchain.treasury('halter')
        governor = await blockchain.treasury('governor')
        treasury = blockchain.openContract(
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
                        loanCode,
                    ),
                    previousRate: 1_000_000_000n,
                    currentRate: 1_000_000_000n,
                    roundDuration: 0n,
                    lastSettledRound: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    borrowerFee: 0n,
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

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10', destination: governor.address })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeGramValue('10')

        electorAddress = getElector(blockchain)
    })

    it('should calculate code sizes', async () => {
        const oneYear = 60 * 60 * 24 * 365
        const deployer = await blockchain.treasury('deployer')
        const storageCostCode = await compile('storage-cost/StorageCost')
        const storageCost = blockchain.openContract(StorageCost.createFromConfig({}, storageCostCode))
        await storageCost.sendDeploy(deployer.getSender(), { value: '0.1' })

        const cost = await Promise.all([
            storageCost.getStorageCost(false, oneYear, treasuryCode),
            storageCost.getStorageCost(false, oneYear, parentCode),
            storageCost.getStorageCost(true, oneYear, mainWalletCode),
            storageCost.getStorageCost(true, oneYear, mainCollectionCode),
            storageCost.getStorageCost(true, oneYear, mainBillCode),
            storageCost.getStorageCost(true, oneYear, mainLoanCode),
            storageCost.getStorageCost(true, oneYear, librarianCode),
        ])
        logCodeCost(cost)
    })

    it('should return max punishment value', async () => {
        const maxPunishmentMin = await treasury.getMaxPunishment(1n)
        expect(maxPunishmentMin).toBeGramValue('101')

        const maxPunishmentMax = await treasury.getMaxPunishment(5000000000000000000n)
        expect(maxPunishmentMax).toBeGramValue('101')
    })

    it('should return jetton data', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const newContent = beginCell().storeUint(0, 9).endCell()
        await treasury.sendProxySetContent(governor.getSender(), {
            value: '0.1',
            destination: parent.address,
            newContent: newContent,
        })

        const [totalTokens, mintable, adminAddress, content, code] = await parent.getJettonData()
        expect(totalTokens).toBeGramValue('10')
        expect(mintable).toEqual(true)
        expect(adminAddress).toEqualAddress(treasury.address)
        expect(content.toBoc().toString('base64')).toEqual(newContent.toBoc().toString('base64'))
        expect(code.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
    })

    it('should return loan data', async () => {
        const times = await treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        const since1 = BigInt(Math.floor(Date.now() / 1000))
        const until1 = since1 + electedFor
        const vset1 = createVset(since1, until1)
        setConfig(blockchain, config.currentValidators, vset1)

        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('700000') + fees.depositCoinsFee })

        await blockchain.setShardAccount(
            electorAddress,
            createShardAccount({
                workchain: -1,
                address: electorAddress,
                code: electorCode,
                data: electorConfigToCell({ currentElection: createElectionConfig({ electAt: until1 }) }),
                balance: toNano('1'),
            }),
        )

        const borrower = await blockchain.treasury('borrower')
        const loanAddress = await treasury.getLoanAddress(borrower.address, until1)
        const loan = blockchain.openContract(Loan.createFromAddress(loanAddress))
        const newStakeMsg = await createNewStakeMsg(loan.address, until1)
        await treasury.sendRequestLoan(borrower.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            borrowerRewardShare: 26214n, // 40%
            newStakeMsg: newStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        setConfig(blockchain, config.nextValidators, null)
        await treasury.sendParticipateInElection({ roundSince: until1 })

        const loanConfig = await loan.getLoanState()
        expect(loanConfig.elector).toEqualAddress(electorAddress)
        expect(loanConfig.treasury).toEqualAddress(treasury.address)
        expect(loanConfig.borrower).toEqualAddress(borrower.address)
        expect(loanConfig.roundSince).toEqual(until1)
    })

    it('should return wallet data', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const [tokens, ownerAddress, parentAddress, code] = await wallet.getWalletData()
        expect(tokens).toBeGramValue('10')
        expect(ownerAddress.toString()).toEqual(staker.address.toString())
        expect(parentAddress).toEqualAddress(parent.address)
        expect(code.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
    })

    it('should return treasury state', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.totalCoins).toBeGramValue('20') // 10 dead shares + 10 deposited
        expect(treasuryState.totalTokens).toBeGramValue('20')
        expect(treasuryState.totalStaking).toBeGramValue('0')
        expect(treasuryState.totalUnstaking).toBeGramValue('0')
        expect(treasuryState.totalBorrowersStake).toBeGramValue('0')
        expect(treasuryState.parent).toEqualAddress(parent.address)
        expect(treasuryState.participations.keys()).toHaveLength(0)
        expect(treasuryState.roundsImbalance).toEqual(255n)
        expect(treasuryState.stopped).toEqual(false)
        expect(treasuryState.loanCodes.get(0n)?.toBoc().toString('base64')).toEqual(loanCode.toBoc().toString('base64'))
        expect(treasuryState.previousRate).toBe(1_000_000_000n)
        expect(treasuryState.currentRate).toBe(1_000_000_000n)
        expect(treasuryState.halter.toString()).toEqual(halter.address.toString())
        expect(treasuryState.governor.toString()).toEqual(governor.address.toString())
        expect(treasuryState.proposedGovernor).toEqual(null)
        expect(treasuryState.governanceFee).toEqual(4096n)
        expect(treasuryState.collectionCodes.get(0n)?.toBoc().toString('base64')).toEqual(
            collectionCode.toBoc().toString('base64'),
        )
        expect(treasuryState.billCodes.get(0n)?.toBoc().toString('base64')).toEqual(billCode.toBoc().toString('base64'))
        expect(treasuryState.oldParents.size).toEqual(0)
        // Nothing has settled on a fresh treasury, so there is no interval to report yet.
        expect(treasuryState.roundDuration).toEqual(0n)
        expect(treasuryState.lastSettledRound).toEqual(0n)
        expect(treasuryState.deficit).toEqual(0n)
    })

    // get_deficit was removed when get_treasury_state grew to return everything the treasury stores.
    // A removed get method is a breaking change for anything that called it -- the gauge did -- so it
    // is worth an assertion rather than an absence nobody notices until a dashboard goes blank.
    it('should no longer expose get_deficit, now that the state tuple carries it', async () => {
        const contract = await blockchain.getContract(treasury.address)
        const result = await contract.get('get_deficit').catch((e: unknown) => e)
        expect(result).toBeInstanceOf(Error)

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.deficit).toEqual(0n)
    })

    // get_treasury_state's tuple is ABI, and it mirrors storage order: root fields in save_data order,
    // then extension fields in pack_extension order. The website, mcp, sdk, sdk-example and the gauge
    // read it positionally, and DefiLlama's fee and yield adapters index it at hardcoded offsets that
    // nobody here can redeploy -- so a field that moves is a field that silently misreads somewhere
    // else, and the release that moved deficit, round_duration and last_settled_round into place had
    // to be coordinated with all of them. This pins the result rather than trusting a reviewer to
    // notice, so the next such move is a deliberate one.
    it('should keep every get_treasury_state field at its established position', async () => {
        const contract = await blockchain.getContract(treasury.address)
        const stack = new TupleReader((await contract.get('get_treasury_state')).stack)

        const positions = [
            'total_coins',
            'total_tokens',
            'total_staking',
            'total_unstaking',
            'total_borrowers_stake',
            'deficit',
            'parent',
            'participations',
            'rounds_imbalance',
            'stopped',
            'instant_mint',
            'loan_codes',
            'previous_rate',
            'current_rate',
            'round_duration',
            'last_settled_round',
            'halter',
            'governor',
            'proposed_governor',
            'governance_fee',
            'borrower_fee',
            'collection_codes',
            'bill_codes',
            'old_parents',
        ]
        expect(stack.remaining).toEqual(positions.length)

        // Read positionally the way an external consumer does, and check the values that are cheap to
        // identify. Anything inserted rather than appended shifts these and fails here.
        expect(stack.readBigNumber()).toBeGramValue('10') // total_coins, the dead shares alone
        expect(stack.readBigNumber()).toBeGramValue('10') // total_tokens
        expect(stack.readBigNumber()).toEqual(0n) // total_staking
        expect(stack.readBigNumber()).toEqual(0n) // total_unstaking
        expect(stack.readBigNumber()).toEqual(0n) // total_borrowers_stake
        expect(stack.readBigNumber()).toEqual(0n) // deficit
        expect(stack.readAddress()).toEqualAddress(parent.address)
        stack.readCellOpt() // participations
        expect(stack.readBigNumber()).toEqual(255n) // rounds_imbalance
        expect(stack.readBoolean()).toEqual(false) // stopped
        stack.readBoolean() // instant_mint
        stack.readCell() // loan_codes
        expect(stack.readBigNumber()).toEqual(1_000_000_000n) // previous_rate
        expect(stack.readBigNumber()).toEqual(1_000_000_000n) // current_rate
        expect(stack.readBigNumber()).toEqual(0n) // round_duration
        expect(stack.readBigNumber()).toEqual(0n) // last_settled_round
        expect(stack.readAddress().toString()).toEqual(halter.address.toString())
        expect(stack.readAddress().toString()).toEqual(governor.address.toString())
        expect(stack.readCellOpt()).toEqual(null) // proposed_governor
        expect(stack.readBigNumber()).toEqual(4096n) // governance_fee
        expect(stack.readBigNumber()).toEqual(0n) // borrower_fee
        stack.readCell() // collection_codes
        stack.readCell() // bill_codes
        stack.readCellOpt() // old_parents
        expect(stack.remaining).toEqual(0)
    })

    it('should return wallet state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(tokens).toBeGramValue('10')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeGramValue('0')
    })

    it('should return treasury fees', () => {
        expect(fees.requestLoanFee).toBeGreaterThan(0n)
        expect(fees.depositCoinsFee).toBeGreaterThan(0n)
        expect(fees.unstakeAllTokensFee).toBeGreaterThan(0n)

        logTreasuryFees(fees)
    })

    it('should return wallet fees', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const walletFees = await wallet.getWalletFees()
        expect(walletFees.sendTokensFee).toBeGreaterThan(0n)
        expect(walletFees.unstakeTokensFee).toBeGreaterThan(0n)
        expect(walletFees.upgradeWalletFee).toBeGreaterThan(0n)
        expect(walletFees.walletStorageFee).toBeGreaterThan(0n)

        logWalletFees(walletFees)
    })

    it('should return max burnable tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const maxBurnableTokens = await treasury.getMaxBurnableTokens()
        expect(maxBurnableTokens).toBeBetween(toNano('10') - 5n, '10')
    })

    it('should return surplus', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const surplus = await treasury.getSurplus()
        expect(surplus).toBeBetween(-5n, 5n)
    })

    it('should return metadata for SBTs', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })
        const walletFees = await wallet.getWalletFees()

        const roundSince = 1n
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
                balance: toNano('10'),
            }),
        )
        const collectionAddress = await treasury.getCollectionAddress(roundSince)
        const collection = blockchain.openContract(Collection.createFromAddress(collectionAddress))
        const billAddress1 = await treasury.getBillAddress(roundSince, 0n)
        const bill1 = blockchain.openContract(Bill.createFromAddress(billAddress1))
        const billAddress2 = await treasury.getBillAddress(roundSince, 1n)
        const bill2 = blockchain.openContract(Bill.createFromAddress(billAddress2))

        await wallet.sendUnstakeTokens(staker.getSender(), { value: walletFees.unstakeTokensFee, tokens: '7.123456' })
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('5') + fees.depositCoinsFee })

        const [nextItemIndex, metadata, treasuryAddress] = await collection.getCollectionData()
        expect(nextItemIndex).toEqual(2n)
        expect(metadata.size).toEqual(3)
        expect(metadata.get(toMetadataKey('name'))).toEqual('Hipo Payout 1')
        expect(metadata.get(toMetadataKey('description'))).toEqual('For validation round starting at Unix time 1')
        expect(metadata.get(toMetadataKey('image'))).toEqual('https://hipo.finance/collection.jpg')
        expect(treasuryAddress).toEqualAddress(treasury.address)

        const nftAddress1 = await collection.getNftAddressByIndex(0n)
        const nftAddress2 = await collection.getNftAddressByIndex(1n)
        expect(nftAddress1).toEqualAddress(billAddress1)
        expect(nftAddress2).toEqualAddress(billAddress2)

        const [initialized1, index1, collectionAddress1, ownerAddress1, billMetadataCell1] = await bill1.getNftData()
        const billMetadata1 = Dictionary.load(
            Dictionary.Keys.BigUint(256),
            metadataDictionaryValue,
            billMetadataCell1.beginParse().skip(8),
        )
        expect(initialized1).toEqual(true)
        expect(index1).toEqual(0n)
        expect(collectionAddress1).toEqualAddress(collection.address)
        expect(ownerAddress1).toEqualAddress(staker.address)
        expect(billMetadata1.size).toEqual(3)
        expect(billMetadata1.get(toMetadataKey('name'))).toEqual('Hipo Receipt #0')
        expect(billMetadata1.get(toMetadataKey('description'))).toEqual('Unstake 7.123456000 hGRAM')
        expect(billMetadata1.get(toMetadataKey('image'))).toEqual('https://hipo.finance/unstaking.jpg')

        const [initialized2, index2, collectionAddress2, ownerAddress2, billMetadataCell2] = await bill2.getNftData()
        const billMetadata2 = Dictionary.load(
            Dictionary.Keys.BigUint(256),
            metadataDictionaryValue,
            billMetadataCell2.beginParse().skip(8),
        )
        expect(initialized2).toEqual(true)
        expect(index2).toEqual(1n)
        expect(collectionAddress2).toEqualAddress(collection.address)
        expect(ownerAddress2).toEqualAddress(staker.address)
        expect(billMetadata2.size).toEqual(3)
        expect(billMetadata2.get(toMetadataKey('name'))).toEqual('Hipo Receipt #1')
        expect(billMetadata2.get(toMetadataKey('description'))).toEqual('Stake 5.000000000 GRAM')
        expect(billMetadata2.get(toMetadataKey('image'))).toEqual('https://hipo.finance/staking.jpg')

        const nftContent1 = await collection.getNftContent(0n, billMetadataCell1)
        expect(nftContent1.size).toEqual(3)
        expect(nftContent1.get(toMetadataKey('name'))).toEqual('Hipo Receipt #0')
        expect(nftContent1.get(toMetadataKey('description'))).toEqual('Unstake 7.123456000 hGRAM')
        expect(nftContent1.get(toMetadataKey('image'))).toEqual('https://hipo.finance/unstaking.jpg')

        const nftContent2 = await collection.getNftContent(1n, billMetadataCell2)
        expect(nftContent2.size).toEqual(3)
        expect(nftContent2.get(toMetadataKey('name'))).toEqual('Hipo Receipt #1')
        expect(nftContent2.get(toMetadataKey('description'))).toEqual('Stake 5.000000000 GRAM')
        expect(nftContent2.get(toMetadataKey('image'))).toEqual('https://hipo.finance/staking.jpg')

        const authorityAddress1 = await bill1.getAuthorityAddress()
        expect(authorityAddress1).toEqualAddress(collection.address)

        const authorityAddress2 = await bill2.getAuthorityAddress()
        expect(authorityAddress2).toEqualAddress(collection.address)

        const revokedTime1 = await bill1.getRevokedTime()
        expect(revokedTime1).toEqual(0n)

        const revokedTime2 = await bill2.getRevokedTime()
        expect(revokedTime2).toEqual(0n)

        const result1 = await bill1.sendDestroy(governor.getSender(), { value: '0.1' })
        expect(result1.transactions).toHaveTransaction({
            from: governor.address,
            to: bill1.address,
            value: toNano('0.1'),
            body: bodyOp(op.destroy),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result1.transactions).toHaveLength(3)

        const result2 = await bill1.sendDestroy(staker.getSender(), { value: '0.1' })
        expect(result2.transactions).toHaveTransaction({
            from: staker.address,
            to: bill1.address,
            value: toNano('0.1'),
            body: bodyOp(op.destroy),
            success: false,
            exitCode: err.accessDenied,
        })
        expect(result2.transactions).toHaveLength(3)

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
                balance: toNano('10'),
            }),
        )

        await treasury.sendRetryBurnAll(halter.getSender(), { value: '0.1', roundSince })

        const result3 = await bill1.sendDestroy(staker.getSender(), { value: '0.1' })
        expect(result3.transactions).toHaveTransaction({
            from: staker.address,
            to: bill1.address,
            value: toNano('0.1'),
            body: bodyOp(op.destroy),
            success: true,
            outMessagesCount: 1,
        })
        expect(result3.transactions).toHaveTransaction({
            from: bill1.address,
            to: staker.address,
            value: between('0', '0.1'),
            body: bodyOp(op.gasExcess),
            success: true,
            outMessagesCount: 0,
        })
        expect(result3.transactions).toHaveLength(3)

        const revokedTime1After = await bill1.getRevokedTime()
        expect(revokedTime1After).toBeGreaterThan(0n)

        const revokedTime2After = await bill2.getRevokedTime()
        expect(revokedTime2After).toBeGreaterThan(0n)

        const [initializedA1, indexA1, collectionAddressA1, ownerAddressA1, billMetadataCellA1] =
            await bill1.getNftData()
        const billMetadataA1 = Dictionary.load(
            Dictionary.Keys.BigUint(256),
            metadataDictionaryValue,
            billMetadataCellA1.beginParse().skip(8),
        )
        expect(initializedA1).toEqual(true)
        expect(indexA1).toEqual(0n)
        expect(collectionAddressA1).toEqualAddress(collection.address)
        expect(ownerAddressA1).toBeNull()
        expect(billMetadataA1.size).toEqual(4)
        expect(billMetadataA1.get(toMetadataKey('name'))).toEqual('Hipo Receipt #0')
        expect(billMetadataA1.get(toMetadataKey('description'))).toEqual('Unstake 7.123456000 hGRAM')
        expect(billMetadataA1.get(toMetadataKey('image'))).toEqual('https://hipo.finance/unstaking.jpg')
        expect(billMetadataA1.get(toMetadataKey('render_type'))).toEqual('hidden')

        const [initializedA2, indexA2, collectionAddressA2, ownerAddressA2, billMetadataCellA2] =
            await bill2.getNftData()
        const billMetadataA2 = Dictionary.load(
            Dictionary.Keys.BigUint(256),
            metadataDictionaryValue,
            billMetadataCellA2.beginParse().skip(8),
        )
        expect(initializedA2).toEqual(true)
        expect(indexA2).toEqual(1n)
        expect(collectionAddressA2).toEqualAddress(collection.address)
        expect(ownerAddressA2).toEqualAddress(staker.address)
        expect(billMetadataA2.size).toEqual(4)
        expect(billMetadataA2.get(toMetadataKey('name'))).toEqual('Hipo Receipt #1')
        expect(billMetadataA2.get(toMetadataKey('description'))).toEqual('Stake 5.000000000 GRAM')
        expect(billMetadataA2.get(toMetadataKey('image'))).toEqual('https://hipo.finance/staking.jpg')
        expect(billMetadataA2.get(toMetadataKey('render_type'))).toEqual('hidden')

        const fakeState3 = await treasury.getTreasuryState()
        fakeState3.participations.set(roundSince, { state: ParticipationState.Burning })
        const fakeData3 = treasuryConfigToCell(fakeState3)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData3,
                balance: toNano('10'),
            }),
        )

        const result4 = await treasury.sendRetryBurnAll(halter.getSender(), { value: '0.1', roundSince })
        expect(result4.transactions).toHaveTransaction({
            from: collection.address,
            to: bill1.address,
            value: between('0', '0.1'),
            body: bodyOp(op.burnBill),
            success: false,
            exitCode: err.stopped,
        })
        expect(result4.transactions).toHaveLength(4)
    })
})
