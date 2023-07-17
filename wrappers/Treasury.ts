import { Address, beginCell, Builder, Cell, Contract, contractAddress, ContractProvider, Dictionary, DictionaryValue, Sender, SendMode, Slice, TupleBuilder } from 'ton-core'
import { op, tonValue } from './common'

export type Times = {
    currentRoundSince: bigint
    participateSince: bigint
    participateUntil: bigint
    nextRoundSince: bigint
    nextRoundUntil: bigint
    stakeHeldFor: bigint
}

export type Fees = {
    treasuryStorage: bigint
    walletStorage: bigint
    loanStorage: bigint
}

export type True = {}

type Reward = {
    staked: bigint
    recovered: bigint
}

export enum ParticipationState {
    Open,
    Distribution,
    Staked,
    Validating,
    Held,
    Recovering,
}

type Loan = {
    minPayment: bigint
    validatorRewardShare: bigint
    loanAmount: bigint
    accrueAmount: bigint
    stakeAmount: bigint
    newStakeMsg: Cell
}

type Participation = {
    state?: ParticipationState
    sorted?: Dictionary<bigint, Dictionary<bigint, True>>
    loansSize?: bigint
    requests?: Dictionary<bigint, Loan>
    accepted?: Dictionary<bigint, Loan>
    staked?: Dictionary<bigint, Loan>
    recovering?: Dictionary<bigint, Loan>
    totalStaked?: bigint
    totalRecovered?: bigint
    currentVsetHash?: bigint
    stakeHeldFor?: bigint
    stakeHeldUntil?: bigint
}

type TreasuryConfig = {
    totalCoins: bigint
    totalTokens: bigint
    totalStaking: bigint
    totalUnstaking: bigint
    totalValidatorsStake: bigint
    participations: Dictionary<bigint, Participation>
    walletCode: Cell
    loanCode: Cell
    driver: Address
    halter: Address
    governor: Address
    proposedGovernor: Cell | null
    rewardsHistory: Dictionary<bigint, Reward>
    content: Cell
}

export const trueDictionaryValue: DictionaryValue<True> = {
    serialize: function(src: True, builder: Builder) {
    },
    parse: function(src: Slice): True {
        return {}
    }
}

export const rewardDictionaryValue: DictionaryValue<Reward> = {
    serialize: function(src: Reward, builder: Builder) {
        builder
            .storeCoins(src.staked)
            .storeCoins(src.recovered)
    },
    parse: function(src: Slice): Reward {
        return {
            staked: src.loadCoins(),
            recovered: src.loadCoins(),
        }
    }
}

export const sortedDictionaryValue: DictionaryValue<Dictionary<bigint, True>> = {
    serialize: function(src: Dictionary<bigint, True>, builder: Builder) {
        builder
            .storeRef(beginCell().storeDictDirect(src))
    },
    parse: function(src: Slice): Dictionary<bigint, True> {
        return src.loadRef().beginParse().loadDictDirect(Dictionary.Keys.BigUint(256), trueDictionaryValue)
    }
}

export const loanDictionaryValue: DictionaryValue<Loan> = {
    serialize: function(src: Loan, builder: Builder) {
        builder
            .storeCoins(src.minPayment)
            .storeUint(src.validatorRewardShare, 8)
            .storeCoins(src.loanAmount)
            .storeCoins(src.accrueAmount)
            .storeCoins(src.stakeAmount)
            .storeRef(src.newStakeMsg)
    },
    parse: function(src: Slice): Loan {
        return {
            minPayment: src.loadCoins(),
            validatorRewardShare: src.loadUintBig(8),
            loanAmount: src.loadCoins(),
            accrueAmount: src.loadCoins(),
            stakeAmount: src.loadCoins(),
            newStakeMsg: src.loadRef(),
        }
    }
}

export const participationDictionaryValue: DictionaryValue<Participation> = {
    serialize: function(src: Participation, builder: Builder) {
        builder
            .storeUint(src.state || 0, 3)
            .storeDict(src.sorted)
            .storeUint(src.loansSize || 0, 16)
            .storeDict(src.requests)
            .storeDict(src.accepted)
            .storeDict(src.staked)
            .storeDict(src.recovering)
            .storeCoins(src.totalStaked || 0)
            .storeCoins(src.totalRecovered || 0)
            .storeUint(src.currentVsetHash || 0, 256)
            .storeUint(src.stakeHeldFor || 0, 32)
            .storeUint(src.stakeHeldUntil || 0, 32)
    },
    parse: function(src: Slice): Participation {
        return {
            state: src.loadUint(3),
            sorted: src.loadDict(Dictionary.Keys.BigUint(112), sortedDictionaryValue),
            loansSize: src.loadUintBig(16),
            requests: src.loadDict(Dictionary.Keys.BigUint(256), loanDictionaryValue),
            accepted: src.loadDict(Dictionary.Keys.BigUint(256), loanDictionaryValue),
            staked: src.loadDict(Dictionary.Keys.BigUint(256), loanDictionaryValue),
            recovering: src.loadDict(Dictionary.Keys.BigUint(256), loanDictionaryValue),
            totalStaked: src.loadCoins(),
            totalRecovered: src.loadCoins(),
            currentVsetHash: src.loadUintBig(256),
            stakeHeldFor: src.loadUintBig(32),
            stakeHeldUntil: src.loadUintBig(32),
        }
    }
}

function treasuryConfigToCell(config: TreasuryConfig): Cell {
    const treasuryExtension = beginCell()
        .storeAddress(config.driver)
        .storeAddress(config.halter)
        .storeAddress(config.governor)
        .storeMaybeRef(config.proposedGovernor)
        .storeDict(config.rewardsHistory)
        .storeRef(config.content || Cell.EMPTY)
    return beginCell()
        .storeCoins(config.totalCoins || 0)
        .storeCoins(config.totalTokens || 0)
        .storeCoins(config.totalStaking || 0)
        .storeCoins(config.totalUnstaking || 0)
        .storeCoins(config.totalValidatorsStake || 0)
        .storeDict(config.participations)
        .storeRef(config.walletCode)
        .storeRef(config.loanCode)
        .storeRef(treasuryExtension)
        .endCell()
}

export class Treasury implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell, data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Treasury(address)
    }

    static createFromConfig(config: TreasuryConfig, code: Cell, workchain = 0) {
        const data = treasuryConfigToCell(config)
        const init = { code, data }
        return new Treasury(contractAddress(workchain, init), init)
    }

    async sendMessage(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        body?: Cell | string
    }) {
        await provider.internal(via, opts)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint | string) {
        await this.sendMessage(provider, via, {
            value,
            body: beginCell().storeUint(op.topUp, 32).endCell(),
        })
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint | string) {
        await this.sendMessage(provider, via, {
            value,
            body: beginCell().storeUint(op.topUp, 32).endCell(),
        })
    }

    async sendDepositCoins(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.depositCoins, 32)
                .storeUint(opts.queryId || 0, 64)
                .endCell()
        })
    }

    async sendProvideWalletAddress(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
        owner: Address
        includeAddress?: boolean
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.provideWalletAddress, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeAddress(opts.owner)
                .storeBit(opts.includeAddress || false)
                .endCell()
        })
    }

    async sendRequestLoan(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
        roundSince: bigint
        loanAmount: bigint | string
        minPayment: bigint | string
        validatorRewardShare: bigint
        newStakeMsg: Cell
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.requestLoan, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeUint(opts.roundSince, 32)
                .storeCoins(tonValue(opts.loanAmount))
                .storeCoins(tonValue(opts.minPayment))
                .storeUint(opts.validatorRewardShare, 8)
                .storeRef(opts.newStakeMsg)
                .endCell()
        })
    }

    async sendParticipateInElection(provider: ContractProvider, opts: {
        queryId?: bigint
        roundSince: bigint
    }) {
        const message = beginCell()
            .storeUint(op.participateInElection, 32)
            .storeUint(opts.queryId || 0, 64)
            .storeUint(opts.roundSince, 32)
            .endCell()
        await provider.external(message)
    }

    async sendVsetChanged(provider: ContractProvider, opts: {
        queryId?: bigint
        roundSince: bigint
    }) {
        const message = beginCell()
            .storeUint(op.vsetChanged, 32)
            .storeUint(opts.queryId || 0, 64)
            .storeUint(opts.roundSince, 32)
            .endCell()
        await provider.external(message)
    }

    async sendFinishParticipation(provider: ContractProvider, opts: {
        queryId?: bigint
        roundSince: bigint
    }) {
        const message = beginCell()
            .storeUint(op.finishParticipation, 32)
            .storeUint(opts.queryId || 0, 64)
            .storeUint(opts.roundSince, 32)
            .endCell()
        await provider.external(message)
    }

    async sendProposeGovernor(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
        newGovernor: Address
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proposeGovernor, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeAddress(opts.newGovernor)
                .endCell()
        })
    }

    async sendAcceptGovernance(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.acceptGovernance, 32)
                .storeUint(opts.queryId || 0, 64)
                .endCell()
        })
    }

    async getTreasuryState(provider: ContractProvider): Promise<TreasuryConfig> {
        const { stack } = await provider.get('get_treasury_state', [])
        return {
            totalCoins: stack.readBigNumber(),
            totalTokens: stack.readBigNumber(),
            totalStaking: stack.readBigNumber(),
            totalUnstaking: stack.readBigNumber(),
            totalValidatorsStake: stack.readBigNumber(),
            participations: Dictionary.loadDirect(Dictionary.Keys.BigUint(32), participationDictionaryValue,
                stack.readCellOpt()),
            rewardsHistory: Dictionary.loadDirect(Dictionary.Keys.BigUint(32), rewardDictionaryValue,
                stack.readCellOpt()),
            driver: stack.readAddress(),
            halter: stack.readAddress(),
            governor: stack.readAddress(),
            proposedGovernor: stack.readCellOpt(),
            walletCode: stack.readCell(),
            loanCode: stack.readCell(),
            content: stack.readCell(),
        }
    }

    async getJettonData(provider: ContractProvider): Promise<[bigint, boolean, Address, Cell, Cell]> {
        const { stack } = await provider.get('get_jetton_data', [])
        return [
            stack.readBigNumber(),
            stack.readBoolean(),
            stack.readAddress(),
            stack.readCell(),
            stack.readCell(),
        ]
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const tb = new TupleBuilder()
        tb.writeAddress(owner)
        const { stack } = await provider.get('get_wallet_address', tb.build())
        return stack.readAddress()
    }

    async getLoanAddress(provider: ContractProvider, validator: Address, roundSince: bigint) {
        const tb = new TupleBuilder()
        tb.writeAddress(validator)
        tb.writeNumber(roundSince)
        const { stack } = await provider.get('get_loan_address', tb.build())
        return stack.readAddress()
    }

    async getTimes(provider: ContractProvider): Promise<Times> {
        const { stack } = await provider.get('get_times', [])
        return {
            currentRoundSince: stack.readBigNumber(),
            participateSince: stack.readBigNumber(),
            participateUntil: stack.readBigNumber(),
            nextRoundSince: stack.readBigNumber(),
            nextRoundUntil: stack.readBigNumber(),
            stakeHeldFor: stack.readBigNumber(),
        }
    }

    async getFees(provider: ContractProvider): Promise<Fees> {
        const { stack } = await provider.get('get_fees', [])
        return {
            treasuryStorage: stack.readBigNumber(),
            walletStorage: stack.readBigNumber(),
            loanStorage: stack.readBigNumber(),
        }
    }

    async getMaxPunishment(provider: ContractProvider, stake: bigint) {
        const tb = new TupleBuilder()
        tb.writeNumber(stake)
        const { stack } = await provider.get('get_max_punishment', tb.build())
        return stack.readBigNumber()
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
