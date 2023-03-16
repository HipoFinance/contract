import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, Slice, TupleBuilder } from 'ton-core'

const opTopUp = 0x34e5d45a

export type RootConfig = {
    totalActive: bigint
    totalNext: bigint
    totalLater: bigint
    round: bigint
    content: Cell
    walletCode: Cell
}

export type RecipientPayload = {
    recipient: Address
    payload?: Cell
}

export function rootConfigToCell(config: RootConfig): Cell {
    return beginCell()
        .storeCoins(config.totalActive)
        .storeCoins(config.totalNext)
        .storeCoins(config.totalLater)
        .storeUint(config.round, 32)
        .storeRef(config.content)
        .storeRef(config.walletCode)
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

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATLY,
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
            sendMode: SendMode.PAY_GAS_SEPARATLY,
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
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: opts.comment,
        })
    }

    async getTotalBalances(provider: ContractProvider): Promise<[bigint, bigint, bigint]> {
        const { stack } = await provider.get('get_total_balances', [])
        return [stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber()]
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const tb = new TupleBuilder()
        tb.writeAddress(owner)
        const { stack } = await provider.get('get_wallet_address', tb.build())
        return stack.readAddress()
    }

    async getFees(provider: ContractProvider): Promise<[bigint, bigint, bigint, bigint]> {
        const { stack } = await provider.get('get_fees', [])
        return [
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readBigNumber(),
            stack.readBigNumber()
        ]
    }

    async getStateBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
