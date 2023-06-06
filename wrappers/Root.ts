import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, Sender, SendMode, Slice, toNano, TupleBuilder } from 'ton-core'

const opTopUp = 0x34e5d45a

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
    accruedAmount: bigint
    stakedTokens: bigint
    newStakeMsg: NewStakeMsg
}

type ParticipationData = {
    state: ParticipationState
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
    totalStakedTokens?: bigint
    totalUnstakedTokens?: bigint
    walletCode: Cell
    rewardsDict?: Dictionary<bigint, RewardData>
    participations?: Dictionary<bigint, ParticipationData>
    poolCode: Cell
    rewardsSize?: bigint
    content?: Cell
}

function rootConfigToCell(config: RootConfig): Cell {
    const rootExtension = beginCell()
        .storeRef(config.poolCode)
        .storeUint(config.rewardsSize || 0n, 10)
        .storeRef(config.content || new Cell())
    return beginCell()
        .storeCoins(config.totalStakedTokens || 0n)
        .storeCoins(config.totalUnstakedTokens || 0n)
        .storeRef(config.walletCode)
        .storeDict(config.rewardsDict)
        .storeDict(config.participations)
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
            body: beginCell().storeUint(opTopUp, 32).endCell(),
        })
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint | string) {
        await this.sendMessage(provider, via, {
            value,
            body: beginCell().storeUint(opTopUp, 32).endCell(),
        })
    }
    async sendStakeTon(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        queryId?: bigint
        tokens: bigint | string
        recipient: Address
        returnExcess?: Address
        forwardTonAmount?: bigint | string
        forwardPayload?: Slice
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            body: beginCell()
                .storeUint(0x696aace0, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeCoins(tonValue(opts.tokens))
                .storeAddress(opts.recipient)
                .storeAddress(opts.returnExcess)
                .storeCoins(tonValue(opts.forwardTonAmount || 0n) )
                .storeSlice(opts.forwardPayload || beginCell().storeUint(0, 1).endCell().beginParse())
                .endCell()
        })
    }

    async sendProvideWalletAddress(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        queryId?: bigint
        owner: Address
        includeAddress?: boolean
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            body: beginCell()
                .storeUint(0x2c76b973, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeAddress(opts.owner)
                .storeBit(opts.includeAddress || false)
                .endCell()
        })
    }

    async getRootState(provider: ContractProvider): Promise<[bigint, bigint, Cell | null, Cell | null, Cell, bigint]> {
        const { stack } = await provider.get('get_root_state', [])
        return [
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readCellOpt(),
            stack.readCellOpt(),
            stack.readCell(),
            stack.readBigNumber(),
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

    async getTonBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}

export function tonValue(value: bigint | string): bigint {
    if (typeof value === 'string') {
        value = toNano(value)
    }
    return value
}
