import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    DictionaryValue,
    Sender,
    SendMode,
    Slice,
    TupleBuilder,
} from '@ton/core'
import { op } from './common'
import { sha256_sync } from '@ton/crypto'

interface ParentConfig {
    totalTokens: bigint
    treasury: Address
    walletCode: Cell
    content: Cell
}

export function parentConfigToCell(config: ParentConfig): Cell {
    return beginCell()
        .storeCoins(config.totalTokens)
        .storeAddress(config.treasury)
        .storeRef(config.walletCode)
        .storeRef(config.content)
        .endCell()
}

export function toMetadataKey(key: string): bigint {
    return BigInt('0x' + sha256_sync(key).toString('hex'))
}

export const metadataDictionaryValue: DictionaryValue<string> = {
    serialize: function (src: string, builder: Builder) {
        builder.storeUint(0, 8).storeStringTail(src)
    },
    parse: function (src: Slice): string {
        const prefix = src.loadUint(8)
        if (prefix !== 0) {
            throw new Error('Expected metadata dictionary value to start with a zero')
        }
        return src.loadStringTail()
    },
}

export class Parent implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Parent(address)
    }

    static createFromConfig(config: ParentConfig, code: Cell, workchain = 0) {
        const data = parentConfigToCell(config)
        const init = { code, data }
        return new Parent(contractAddress(workchain, init), init)
    }

    async sendMessage(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            body?: Cell | string
        },
    ) {
        await provider.internal(via, opts)
    }

    async sendDeploy(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
        },
    ) {
        await this.sendTopUp(provider, via, opts)
    }

    async sendTopUp(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.topUp, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .endCell(),
        })
    }

    async sendProvideWalletAddress(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            owner: Address
            includeAddress?: boolean
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.provideWalletAddress, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.owner)
                .storeBit(opts.includeAddress ?? false)
                .endCell(),
        })
    }

    async getJettonData(provider: ContractProvider): Promise<[bigint, boolean, Address, Cell, Cell]> {
        const { stack } = await provider.get('get_jetton_data', [])
        return [stack.readBigNumber(), stack.readBoolean(), stack.readAddress(), stack.readCell(), stack.readCell()]
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const tb = new TupleBuilder()
        tb.writeAddress(owner)
        const { stack } = await provider.get('get_wallet_address', tb.build())
        return stack.readAddress()
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
