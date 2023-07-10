import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, Sender, SendMode, TupleBuilder } from 'ton-core'
import { op, tonValue } from './common'

export type Fees = {
    rootStorage: bigint
    walletStorage: bigint
    poolStorage: bigint
}

type RewardData = {
    staked: bigint
    recovered: bigint
}

enum ParticipationState {
    Open,
    Distribution,
    Staked,
    Validating,
    Held,
    Recovering,
}

type NewStakeMsg = {
    validatorPubKey: bigint
    stakeAt: bigint
    maxFactor: bigint
    adnlAddr: bigint
    signature: bigint
}

type LoanRequest = {
    minPayment: bigint
    validatorRewardShare: bigint
    loanAmount: bigint
    accrueAmount: bigint
    stakeAmount: bigint
    newStakeMsg: NewStakeMsg
}

type ParticipationData = {
    state?: ParticipationState
    sorted?: Dictionary<bigint, (Dictionary<bigint, bigint>)>
    loansSize?: bigint
    requests?: Dictionary<bigint, LoanRequest>
    accepted?: Dictionary<bigint, LoanRequest>
    staked?: Dictionary<bigint, LoanRequest>
    recovering?: Dictionary<bigint, LoanRequest>
    totalStaked?: bigint
    totalRecovered?: bigint
    currentVsetHash?: bigint
    stakeHeldFor?: bigint
    stakeHeldUntil?: bigint
}

type RootConfig = {
    totalCoins?: bigint
    totalTokens?: bigint
    totalStaking?: bigint
    totalUnstaking?: bigint
    totalValidatorsStake?: bigint
    participations?: Dictionary<bigint, ParticipationData>
    walletCode: Cell
    poolCode: Cell
    driver?: Address
    rewardsHistory?: Dictionary<bigint, RewardData>
    content?: Cell
}

function rootConfigToCell(config: RootConfig): Cell {
    const rootExtension = beginCell()
        .storeAddress(config.driver)
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
        .storeRef(config.poolCode)
        .storeRef(rootExtension)
        .endCell()
}

export class Root implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell, data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Root(address)
    }

    static createFromConfig(config: RootConfig, code: Cell, workchain = 0) {
        const data = rootConfigToCell(config)
        const init = { code, data }
        return new Root(contractAddress(workchain, init), init)
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

    async getRootState(provider: ContractProvider):
            Promise<[bigint, bigint, bigint, bigint, bigint, Cell | null, Cell | null, Address, Cell, Cell, Cell]> {
        const { stack } = await provider.get('get_root_state', [])
        return [
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readCellOpt(),
            stack.readCellOpt(),
            stack.readAddress(),
            stack.readCell(),
            stack.readCell(),
            stack.readCell(),
        ]
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

    async getPoolAddress(provider: ContractProvider, validator: Address, roundSince: bigint) {
        const tb = new TupleBuilder()
        tb.writeAddress(validator)
        tb.writeNumber(roundSince)
        const { stack } = await provider.get('get_pool_address', tb.build())
        return stack.readAddress()
    }

    async getFees(provider: ContractProvider): Promise<Fees> {
        const { stack } = await provider.get('get_fees', [])
        return {
            rootStorage: stack.readBigNumber(),
            walletStorage: stack.readBigNumber(),
            poolStorage: stack.readBigNumber(),
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
