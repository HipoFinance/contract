import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core'
import { bodyOp, createNewStakeMsg, createVset, getElector, logFees, setConfig } from './helper'
import { config, op } from '../wrappers/common'
import { Fees, Treasury, emptyDictionaryValue, participationDictionaryValue } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { Loan } from '../wrappers/Loan'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'
import { LibraryDeployer, buildBlockchainLibraries } from '../wrappers/LibraryDeployer'
import { Parent } from '../wrappers/Parent'

describe('Getters', () => {
    let electorCode: Cell
    let treasuryCode: Cell
    let parentCode: Cell
    let walletCode: Cell
    let collectionCode: Cell
    let billCode: Cell
    let loanCode: Cell
    let blockchainLibs: Cell

    beforeAll(async () => {
        electorCode = await compile('elector-test/Elector')
        treasuryCode = await compile('Treasury')
        parentCode = await compile('Parent')
        const mainWalletCode = await compile('Wallet')
        const mainCollectionCode = await compile('Collection')
        const mainBillCode = await compile('Bill')
        const mainLoanCode = await compile('Loan')
        walletCode = LibraryDeployer.exportLibCode(mainWalletCode)
        collectionCode = LibraryDeployer.exportLibCode(mainCollectionCode)
        billCode = LibraryDeployer.exportLibCode(mainBillCode)
        loanCode = LibraryDeployer.exportLibCode(mainLoanCode)
        blockchainLibs = buildBlockchainLibraries([mainWalletCode, mainCollectionCode, mainBillCode, mainLoanCode])
    })

    let blockchain: Blockchain
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let treasury: SandboxContract<Treasury>
    let parent: SandboxContract<Parent>
    let fees: Fees
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
                    loanCode,
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    collectionCode,
                    billCode,
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

        fees = await treasury.getFees()

        await treasury.sendWithdrawSurplus(governor.getSender(), { value: fees.treasuryStorage })
        const treasuryBalance = await treasury.getBalance()
        expect(treasuryBalance).toBeTonValue(fees.treasuryStorage)

        electorAddress = getElector(blockchain)
    })

    it('should deploy treasury', () => {
        return
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
        expect(treasuryState.loanCode.toBoc().toString('base64')).toEqual(loanCode.toBoc().toString('base64'))
        expect(treasuryState.lastStaked).toBeTonValue('0')
        expect(treasuryState.lastRecovered).toBeTonValue('0')
        expect(treasuryState.halter.toString()).toEqual(halter.address.toString())
        expect(treasuryState.governor.toString()).toEqual(governor.address.toString())
        expect(treasuryState.proposedGovernor).toEqual(null)
        expect(treasuryState.governanceFee).toEqual(4096n)
        expect(treasuryState.collectionCode.toBoc().toString('base64')).toEqual(
            collectionCode.toBoc().toString('base64'),
        )
        expect(treasuryState.billCode.toBoc().toString('base64')).toEqual(billCode.toBoc().toString('base64'))
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

    it('should return wallet fees', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await parent.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const walletFees = await wallet.getWalletFees()
        expect(walletFees.unstakeTokensFee).toEqual(fees.unstakeTokensFee)
        expect(walletFees.storageFee).toEqual(fees.walletStorage)
        expect(walletFees.tonBalance).toEqual(fees.walletStorage)

        logFees(fees)
    })

    it('should return max burnable tokens', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const maxBurnableTokens = await treasury.getMaxBurnableTokens()
        expect(maxBurnableTokens).toBeTonValue('10')
    })

    it('should return surplus', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: toNano('10') + fees.depositCoinsFee })

        const surplus = await treasury.getSurplus()
        expect(surplus).toBeBetween(-5n, 5n)
    })
})
