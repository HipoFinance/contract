import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core'
import {
    bodyOp,
    createNewStakeMsg,
    createVset,
    getElector,
    logCodeCost,
    logTreasuryFees,
    logWalletFees,
    setConfig,
} from './helper'
import { config, op } from '../wrappers/common'
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
import { Parent, toMetadataKey } from '../wrappers/Parent'
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
        halter = await blockchain.treasury('halter')
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
                    participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                    roundsImbalance: 255n,
                    stopped: false,
                    instantMint: false,
                    loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                        0n,
                        loanCode,
                    ),
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
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

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: '10' })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue('10')

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
        expect(maxPunishmentMin).toBeTonValue('101')

        const maxPunishmentMax = await treasury.getMaxPunishment(5000000000000000000n)
        expect(maxPunishmentMax).toBeTonValue('101')
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
        expect(totalTokens).toBeTonValue('10')
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

        const validator = await blockchain.treasury('validator')
        const loanAddress = await treasury.getLoanAddress(validator.address, until1)
        const loan = blockchain.openContract(Loan.createFromAddress(loanAddress))
        const newStakeMsg = await createNewStakeMsg(loan.address, until1)
        await treasury.sendRequestLoan(validator.getSender(), {
            value: toNano('151') + fees.requestLoanFee, // 101 (max punishment) + 50 (min payment) + fee
            roundSince: until1,
            loanAmount: '300000',
            minPayment: '50',
            validatorRewardShare: 102n, // 40%
            newStakeMsg: newStakeMsg,
        })

        const since2 = BigInt(Math.floor(Date.now() / 1000)) - times.participateSince + times.currentRoundSince
        const until2 = since2 + electedFor
        const vset2 = createVset(since2, until2)
        setConfig(blockchain, config.currentValidators, vset2)
        await treasury.sendParticipateInElection({ roundSince: until1 })

        const loanConfig = await loan.getLoanState()
        expect(loanConfig.elector).toEqualAddress(electorAddress)
        expect(loanConfig.treasury).toEqualAddress(treasury.address)
        expect(loanConfig.validator).toEqualAddress(validator.address)
        expect(loanConfig.roundSince).toEqual(until1)
    })

    it('should return wallet data', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const [tokens, ownerAddress, parentAddress, code] = await wallet.getWalletData()
        expect(tokens).toBeTonValue('10')
        expect(ownerAddress.toString()).toEqual(staker.address.toString())
        expect(parentAddress).toEqualAddress(parent.address)
        expect(code.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
    })

    it('should return treasury state', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.totalCoins).toBeTonValue('10')
        expect(treasuryState.totalTokens).toBeTonValue('10')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.parent).toEqualAddress(parent.address)
        expect(treasuryState.participations.keys()).toHaveLength(0)
        expect(treasuryState.roundsImbalance).toEqual(255n)
        expect(treasuryState.stopped).toEqual(false)
        expect(treasuryState.loanCodes.get(0n)?.toBoc().toString('base64')).toEqual(loanCode.toBoc().toString('base64'))
        expect(treasuryState.lastStaked).toBeTonValue('0')
        expect(treasuryState.lastRecovered).toBeTonValue('0')
        expect(treasuryState.halter.toString()).toEqual(halter.address.toString())
        expect(treasuryState.governor.toString()).toEqual(governor.address.toString())
        expect(treasuryState.proposedGovernor).toEqual(null)
        expect(treasuryState.governanceFee).toEqual(4096n)
        expect(treasuryState.collectionCodes.get(0n)?.toBoc().toString('base64')).toEqual(
            collectionCode.toBoc().toString('base64'),
        )
        expect(treasuryState.billCodes.get(0n)?.toBoc().toString('base64')).toEqual(billCode.toBoc().toString('base64'))
        expect(treasuryState.oldParents.size).toEqual(0)
    })

    it('should return wallet state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(tokens).toBeTonValue('10')
        expect(staking.keys()).toHaveLength(0)
        expect(unstaking).toBeTonValue('0')
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

        const walletFees = await wallet.getWalletFees(0n, Cell.EMPTY.beginParse())
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
        const walletFees = await wallet.getWalletFees(0n, Cell.EMPTY.beginParse())

        const roundSince = 1n
        const fakeState = await treasury.getTreasuryState()
        fakeState.participations.set(roundSince, { state: ParticipationState.Staked })
        const fakeData = treasuryConfigToCell(fakeState)
        await blockchain.setShardAccount(
            treasury.address,
            createShardAccount({
                workchain: 0,
                address: treasury.address,
                code: treasuryCode,
                data: fakeData,
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
        expect(metadata.get(toMetadataKey('image'))).toEqual('https://app.hipo.finance/bill.png')
        expect(treasuryAddress).toEqualAddress(treasury.address)

        const nftAddress1 = await collection.getNftAddressByIndex(0n)
        const nftAddress2 = await collection.getNftAddressByIndex(1n)
        expect(nftAddress1).toEqualAddress(billAddress1)
        expect(nftAddress2).toEqualAddress(billAddress2)

        const [initialized1, index1, collectionAddress1, ownerAddress1, billMetadata1] = await bill1.getNftData()
        expect(initialized1).toEqual(true)
        expect(index1).toEqual(0n)
        expect(collectionAddress1).toEqualAddress(collection.address)
        expect(ownerAddress1).toEqualAddress(staker.address)
        expect(billMetadata1.size).toEqual(2)
        expect(billMetadata1.get(toMetadataKey('name'))).toEqual('Hipo Bill #0')
        expect(billMetadata1.get(toMetadataKey('description'))).toEqual('Withdraw 7.123456000 hTON')

        const [initialized2, index2, collectionAddress2, ownerAddress2, billMetadata2] = await bill2.getNftData()
        expect(initialized2).toEqual(true)
        expect(index2).toEqual(1n)
        expect(collectionAddress2).toEqualAddress(collection.address)
        expect(ownerAddress2).toEqualAddress(staker.address)
        expect(billMetadata2.size).toEqual(2)
        expect(billMetadata2.get(toMetadataKey('name'))).toEqual('Hipo Bill #1')
        expect(billMetadata2.get(toMetadataKey('description'))).toEqual('Deposit 5.000000000 TON')

        const nftContent1 = await collection.getNftContent(0n, billMetadata1)
        expect(nftContent1.size).toEqual(3)
        expect(nftContent1.get(toMetadataKey('name'))).toEqual('Hipo Bill #0')
        expect(nftContent1.get(toMetadataKey('description'))).toEqual('Withdraw 7.123456000 hTON')
        expect(nftContent1.get(toMetadataKey('image'))).toEqual('https://app.hipo.finance/bill.png')

        const nftContent2 = await collection.getNftContent(1n, billMetadata2)
        expect(nftContent2.size).toEqual(3)
        expect(nftContent2.get(toMetadataKey('name'))).toEqual('Hipo Bill #1')
        expect(nftContent2.get(toMetadataKey('description'))).toEqual('Deposit 5.000000000 TON')
        expect(nftContent2.get(toMetadataKey('image'))).toEqual('https://app.hipo.finance/bill.png')

        const authorityAddress1 = await bill1.getAuthorityAddress()
        expect(authorityAddress1).toEqualAddress(collection.address)

        const authorityAddress2 = await bill2.getAuthorityAddress()
        expect(authorityAddress2).toEqualAddress(collection.address)

        const revokedTime1 = await bill1.getRevokedTime()
        expect(revokedTime1).toEqual(0n)

        const revokedTime2 = await bill2.getRevokedTime()
        expect(revokedTime2).toEqual(0n)
    })
})
