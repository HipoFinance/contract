import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, Sender, SendMode, Slice, TupleBuilder } from 'ton-core'

const opTopUp = 0x34e5d45a

export type NewStakeMsg = {
    validatorPubKey: bigint
    stakeAt: number
    maxFactor: number
    adnlAddr: bigint
    signature: bigint
}

export type LoanRequest = {
    minPayment: bigint
    validatorRewardShare: number
    loanAmount: bigint
    accruedAmount: bigint
    stakeAmount: bigint
    newStakeMsg: NewStakeMsg
}

export type LoanData = {
    requests?: Dictionary<bigint, LoanRequest>
    accepted?: Dictionary<bigint, LoanRequest>
    staked?: Dictionary<bigint, LoanRequest>
    held?: Dictionary<bigint, LoanRequest>
    currentReward: bigint
    currentTotal: bigint
    activeNext: bigint
    rewardNext: bigint
    activeLater: bigint
    rewardLater: bigint
}

export type RootConfig = {
    state: number
    roundSince: number
    totalActive: bigint
    totalNext: bigint
    totalLater: bigint
    walletCode: Cell
    poolCode: Cell
    loanData: Cell
    roundNext: number
    durationNext: number
    heldNext: number
    participationStart: number
    roundLater: number
    durationLater: number
    heldLater: number
    content: Cell
}

export type RecipientPayload = {
    recipient: Address
    payload?: Cell
}

export function loanDataToCell(loanData: LoanData): Cell {
    return beginCell()
        .storeDict(loanData.requests)
        .storeDict(loanData.accepted)
        .storeDict(loanData.staked)
        .storeDict(loanData.held)
        .storeCoins(loanData.currentReward)
        .storeCoins(loanData.currentTotal)
        .storeCoins(loanData.activeNext)
        .storeCoins(loanData.rewardNext)
        .storeCoins(loanData.activeLater)
        .storeCoins(loanData.rewardLater)
        .endCell()
}

export function rootConfigToCell(config: RootConfig): Cell {
    return beginCell()
        .storeUint(config.state, 4)
        .storeUint(config.roundSince, 32)
        .storeCoins(config.totalActive)
        .storeCoins(config.totalNext)
        .storeCoins(config.totalLater)
        .storeRef(config.walletCode)
        .storeRef(config.poolCode)
        .storeRef(config.loanData)
        .storeUint(config.roundNext, 32)
        .storeUint(config.durationNext, 32)
        .storeUint(config.heldNext, 32)
        .storeUint(config.participationStart, 32)
        .storeUint(config.roundLater, 32)
        .storeUint(config.durationLater, 32)
        .storeUint(config.heldLater, 32)
        .storeRef(config.content)
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

    static state = {
        stakeHeld: 0,
        recovering: 1,
        waiting: 2,
        rewardDistribution: 3,
        participating: 4,
        participated: 5,
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(opTopUp, 32).endCell(),
        })
    }

    async sendDeposit(provider: ContractProvider, via: Sender, opts: {
        value: bigint
        queryId?: bigint
        stakeAmount: bigint
        recipientOwner: Address
        returnExcess?: Address
        notificationTonAmount?: bigint
        notificationPayload?: Slice
    }) {
        await provider.internal(via, {
            value: opts.value,
            bounce: true,
            sendMode: SendMode.NONE,
            body: beginCell()
                .storeUint(0x696aace0, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeCoins(opts.stakeAmount)
                .storeAddress(opts.recipientOwner)
                .storeAddress(opts.returnExcess)
                .storeCoins(opts.notificationTonAmount || 0)
                .storeSlice(opts.notificationPayload || beginCell().storeUint(0, 1).endCell().beginParse())
                .endCell()
        })
    }

    async sendWithdraw(provider: ContractProvider, via: Sender, opts: {
        value: bigint
        queryId?: bigint
        stakeAmount: bigint
        returnExcess?: Address
        recipientPayload?: RecipientPayload
    }) {
        let recipientPayload
        if (opts.recipientPayload != null) {
            recipientPayload = beginCell()
                .storeAddress(opts.recipientPayload.recipient)
                .storeMaybeRef(opts.recipientPayload.payload)
        }
        await provider.internal(via, {
            value: opts.value,
            bounce: true,
            sendMode: SendMode.NONE,
            body: beginCell()
                .storeUint(0x595f07bc, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeCoins(opts.stakeAmount)
                .storeAddress(opts.returnExcess)
                .storeMaybeBuilder(recipientPayload)
                .endCell()
        })
    }

    async sendMessage(provider: ContractProvider, via: Sender, opts: {
        value: bigint;
        bounce?: boolean;
        sendMode: SendMode;
        body: Cell;
    }) {
        await provider.internal(via, opts)
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await  provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(opTopUp, 32).endCell(),
        })
    }

    async sendSimpleTransfer(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            comment?: string
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: opts.comment,
        })
    }

    async getTotalBalances(provider: ContractProvider): Promise<[bigint, bigint, bigint]> {
        const { stack } = await provider.get('get_total_balances', [])
        return [stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber()]
    }

    async getJettonData(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_jetton_data', [])
        return result.stack.readBigNumber()
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const tb = new TupleBuilder()
        tb.writeAddress(owner)
        const result = await provider.get('get_wallet_address', tb.build())
        return result.stack.readAddress()
    }

    async getFees(provider: ContractProvider): Promise<[bigint, bigint, bigint, bigint]> {
        const result = await provider.get('get_fees', [])
        return [
            result.stack.readBigNumber(),
            result.stack.readBigNumber(),
            result.stack.readBigNumber(),
            result.stack.readBigNumber()
        ]
    }

    async getStateBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
