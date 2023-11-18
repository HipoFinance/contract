import { compile } from '@ton-community/blueprint'
import { Blockchain, SandboxContract, TreasuryContract, createShardAccount } from '@ton-community/sandbox'
import '@ton-community/test-utils'
import { Address, beginCell, Cell, Dictionary, toNano } from 'ton-core'
import { bodyOp, createNewStakeMsg, createVset, getElector, logTotalFees, setConfig } from './helper'
import { config, op } from '../wrappers/common'
import { Fees, Treasury, participationDictionaryValue } from '../wrappers/Treasury'
import { Wallet } from '../wrappers/Wallet'
import { Loan } from '../wrappers/Loan'
import { createElectionConfig, electorConfigToCell } from '../wrappers/elector-test/Elector'

describe('Getters', () => {
    let treasuryCode: Cell
    let walletCode: Cell
    let loanCode: Cell
    let electorCode: Cell

    afterAll(() => {
        logTotalFees()
    })

    beforeAll(async () => {
        treasuryCode = await compile('Treasury')
        walletCode = await compile('Wallet')
        loanCode = await compile('Loan')
        electorCode = await compile('elector-test/Elector')
    })

    let blockchain: Blockchain
    let treasury: SandboxContract<Treasury>
    let driver: SandboxContract<TreasuryContract>
    let halter: SandboxContract<TreasuryContract>
    let governor: SandboxContract<TreasuryContract>
    let fees: Fees
    let electorAddress: Address

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        driver = await blockchain.treasury('driver')
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
                    lastStaked: 0n,
                    lastRecovered: 0n,
                    participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                    roundsImbalance: 255n,
                    stopped: false,
                    walletCode,
                    loanCode,
                    driver: driver.address,
                    halter: halter.address,
                    governor: governor.address,
                    proposedGovernor: null,
                    governanceFee: 4096n,
                    content: Cell.EMPTY,
                },
                treasuryCode,
            ),
        )

        const deployer = await blockchain.treasury('deployer')
        const deployResult = await treasury.sendDeploy(deployer.getSender(), { value: '0.01' })

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: treasury.address,
            value: toNano('0.01'),
            body: bodyOp(op.topUp),
            deploy: true,
            success: true,
            outMessagesCount: 0,
        })
        expect(deployResult.transactions).toHaveLength(2)

        fees = await treasury.getFees()

        await treasury.sendTopUp(deployer.getSender(), { value: fees.treasuryStorage })

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
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        const newContent = beginCell().storeUint(0, 9).endCell()
        await treasury.sendSetContent(governor.getSender(), { value: '0.1', newContent: newContent })

        const [totalTokens, mintable, adminAddress, content, code] = await treasury.getJettonData()
        expect(totalTokens).toBeBetween('9', '10')
        expect(mintable).toEqual(true)
        expect(adminAddress.toString()).toEqual('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c')
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
        await treasury.sendDepositCoins(staker.getSender(), { value: '700000.1' })
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })

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
            value: '151.9', // 101 (max punishment) + 50 (min payment) + 0.9 (fee)
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
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })

        const [tokens, ownerAddress, treasuryAddress, code] = await wallet.getWalletData()
        expect(tokens).toBeBetween('9', '10')
        expect(ownerAddress.toString()).toEqual(staker.address.toString())
        expect(treasuryAddress.toString()).toEqual(treasury.address.toString())
        expect(code.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
    })

    it('should return treasury state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        const newContent = beginCell().storeUint(0, 9).endCell()
        await treasury.sendSetContent(governor.getSender(), { value: '0.1', newContent: newContent })

        const treasuryState = await treasury.getTreasuryState()
        expect(treasuryState.totalCoins).toBeBetween('9', '10')
        expect(treasuryState.totalTokens).toBeBetween('9', '10')
        expect(treasuryState.totalStaking).toBeTonValue('0')
        expect(treasuryState.totalUnstaking).toBeTonValue('0')
        expect(treasuryState.totalValidatorsStake).toBeTonValue('0')
        expect(treasuryState.lastStaked).toBeTonValue('0')
        expect(treasuryState.lastRecovered).toBeTonValue('0')
        expect(treasuryState.participations.keys()).toHaveLength(0)
        expect(treasuryState.roundsImbalance).toEqual(255n)
        expect(treasuryState.stopped).toEqual(false)
        expect(treasuryState.walletCode.toBoc().toString('base64')).toEqual(walletCode.toBoc().toString('base64'))
        expect(treasuryState.loanCode.toBoc().toString('base64')).toEqual(loanCode.toBoc().toString('base64'))
        expect(treasuryState.driver.toString()).toEqual(driver.address.toString())
        expect(treasuryState.halter.toString()).toEqual(halter.address.toString())
        expect(treasuryState.governor.toString()).toEqual(governor.address.toString())
        expect(treasuryState.proposedGovernor).toEqual(null)
        expect(treasuryState.governanceFee).toEqual(4096n)
        expect(treasuryState.content.toBoc().toString('base64')).toEqual(newContent.toBoc().toString('base64'))
    })

    it('should return wallet state', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        const [tokens, staking, unstaking] = await wallet.getWalletState()
        expect(tokens).toBeTonValue('0')
        expect(staking.keys()).toHaveLength(1)
        expect(staking.get(0n)).toBeBetween('9', '10')
        expect(unstaking).toBeTonValue('0')

        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })
        const [tokensAfterStake, stakingAfterStake, unstakingAfterStake] = await wallet.getWalletState()
        expect(tokensAfterStake).toBeBetween('9', '10')
        expect(stakingAfterStake.keys()).toHaveLength(0)
        expect(unstakingAfterStake).toBeTonValue('0')
    })

    it('should return wallet fees', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        const walletFees = await wallet.getWalletFees()
        expect(walletFees.unstakeTokensFee).toBeBetween('0.1', '0.2')
        expect(walletFees.storageFee).toBeBetween('0.03', '0.04')
        expect(walletFees.tonBalance).toBeBetween('0.03', '0.04')
    })

    it('should return max burnable tokens', async () => {
        const staker = await blockchain.treasury('staker')
        const walletAddress = await treasury.getWalletAddress(staker.address)
        const wallet = blockchain.openContract(Wallet.createFromAddress(walletAddress))
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })
        await wallet.sendStakeCoins(driver.getSender(), { value: '0.11', roundSince: 0n })

        const maxBurnableTokens = await treasury.getMaxBurnableTokens()
        expect(maxBurnableTokens).toBeBetween('9.8', '9.9')
    })

    it('should return surplus', async () => {
        const staker = await blockchain.treasury('staker')
        await treasury.sendDepositCoins(staker.getSender(), { value: '10' })

        const surplus = await treasury.getSurplus()
        expect(surplus).toBeTonValue('0')
    })
})
