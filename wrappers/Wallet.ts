import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, ContractState, Sender, SendMode, Slice } from 'ton-core'

const opWithdraw = 0x334da837
const opTopUp = 0x34e5d45a

export type WalletConfig = {
    activeBalance: bigint
    nextBalance: bigint
    laterBalance: bigint
    round: bigint
    owner: Address
    root: Address
    walletCode: Cell
}

export function walletConfigToCell(config: WalletConfig): Cell {
    return beginCell()
        .storeCoins(config.activeBalance)
        .storeCoins(config.nextBalance)
        .storeCoins(config.laterBalance)
        .storeUint(config.round, 32)
        .storeAddress(config.owner)
        .storeAddress(config.root)
        .storeRef(config.walletCode)
        .endCell()
}

export class Wallet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Wallet(address)
    }

    static createFromConfig(config: WalletConfig, code: Cell, workchain = 0) {
        const data = walletConfigToCell(config)
        const init = { code, data }
        return new Wallet(contractAddress(workchain, init), init)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: beginCell().storeUint(opTopUp, 32).endCell(),
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

    async sendSend(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint,
            queryId?: bigint,
            stakeAmount: bigint,
            recipientOwner: Address,
            returnExcess: Address,
            notificationTonAmount?: bigint,
            notificationPayload?: Slice,
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: beginCell()
                .storeUint(0x0f8a7ea5, 32)
                .storeUint(opts.queryId || 0n, 64)
                .storeCoins(opts.stakeAmount)
                .storeAddress(opts.recipientOwner)
                .storeAddress(opts.returnExcess)
                .storeUint(0, 1)
                .storeCoins(opts.notificationTonAmount || 0n)
                .storeSlice(opts.notificationPayload || beginCell().storeUint(0, 1).endCell().beginParse())
                .endCell()
        })
    }

    async sendWithdraw(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint,
            queryId?: bigint,
            stakeAmount: bigint,
            recipient: Address,
            returnExcess?: Address,
            payload?: Cell
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATLY,
            body: beginCell()
                .storeUint(opWithdraw, 32)
                .storeUint(opts.queryId || 0n, 64)
                .storeCoins(opts.stakeAmount)
                .storeAddress(opts.recipient)
                .storeAddress(opts.returnExcess)
                .storeMaybeRef(opts.payload)
                .endCell()
        })
    }

    async getBalances(provider: ContractProvider): Promise<[bigint, bigint, bigint]> {
        const { stack } = await provider.get('get_balances', [])
        return [stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber()]
    }

    async getStateBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
