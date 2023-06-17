import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, ContractState, Dictionary, Sender, SendMode, Slice } from 'ton-core'
import { op, tonValue } from './common'

type WalletConfig = {
    owner: Address
    root: Address
    tokensDict: Dictionary<bigint, bigint>
    withdrawalTokens: bigint
    withdrawalIncentive: bigint
    walletCode: Cell
}

function walletConfigToCell(config: WalletConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeAddress(config.root)
        .storeDict(config.tokensDict)
        .storeCoins(config.withdrawalTokens)
        .storeCoins(config.withdrawalIncentive)
        .storeRef(config.walletCode)
        .endCell()
}

export class Wallet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell, data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Wallet(address)
    }

    static createFromConfig(config: WalletConfig, code: Cell, workchain = 0) {
        const data = walletConfigToCell(config)
        const init = { code, data }
        return new Wallet(contractAddress(workchain, init), init)
    }

    async sendMessage(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        body?: Cell | string
    }) {
        await provider.internal(via, opts)
    }

    async sendSendTokens(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
        tokens: bigint | string
        recipient: Address
        returnExcess?: Address
        customPayload?: Cell
        forwardTonAmount?: bigint | string
        forwardPayload?: Slice
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.sendTokens, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeCoins(tonValue(opts.tokens))
                .storeAddress(opts.recipient)
                .storeAddress(opts.returnExcess)
                .storeMaybeRef(opts.customPayload)
                .storeCoins(tonValue(opts.forwardTonAmount || 0n))
                .storeSlice(opts.forwardPayload || beginCell().storeUint(0, 1).endCell().beginParse())
                .endCell()
        })
    }

    async sendUnstakeTokens(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
        tokens: bigint | string
        incentive: bigint | string
        returnExcess?: Address
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.unstakeTokens, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeCoins(tonValue(opts.tokens))
                .storeAddress(opts.returnExcess)
                .storeMaybeRef(beginCell().storeCoins(tonValue(opts.incentive)))
                .endCell()
        })
    }

    async sendReleaseTon(provider: ContractProvider, via: Sender, opts: {
        value: bigint | string
        bounce?: boolean
        sendMode?: SendMode
        queryId?: bigint
        returnExcess?: Address
    }) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.releaseTon, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeAddress(opts.returnExcess)
                .endCell()
        })
    }

    async getWalletState(provider: ContractProvider): Promise<[bigint, bigint, bigint]> {
        const { stack } = await provider.get('get_wallet_state', [])
        return [ stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber() ]
    }

    async getWalletData(provider: ContractProvider): Promise<[bigint, Address, Address, Cell]> {
        const { stack } = await provider.get('get_wallet_data', [])
        return [ stack.readBigNumber(), stack.readAddress(), stack.readAddress(), stack.readCell() ]
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
