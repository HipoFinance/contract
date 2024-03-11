import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core'
import { op } from './common'

interface BillConfig {
    index: bigint
    collection: Address
    parent: Address
    owner: Address
    unstake: boolean
    amount: bigint
}

export function billConfigToCell(config: BillConfig): Cell {
    return beginCell()
        .storeUint(config.index, 64)
        .storeAddress(config.collection)
        .storeAddress(config.parent)
        .storeAddress(config.owner)
        .storeBit(config.unstake)
        .storeCoins(config.amount)
        .endCell()
}

export class Bill implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Bill(address)
    }

    static createFromConfig(config: BillConfig, code: Cell, workchain = 0) {
        const data = billConfigToCell(config)
        const init = { code, data }
        return new Bill(contractAddress(workchain, init), init)
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

    async sendDestroy(
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
                .storeUint(op.destroy, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .endCell(),
        })
    }

    async getNftData(provider: ContractProvider): Promise<[boolean, bigint, Address, Address | null, Cell]> {
        const { stack } = await provider.get('get_nft_data', [])
        return [
            stack.readBoolean(),
            stack.readBigNumber(),
            stack.readAddress(),
            stack.readAddressOpt(),
            stack.readCell(),
        ]
    }

    async getAuthorityAddress(provider: ContractProvider): Promise<Address> {
        const { stack } = await provider.get('get_authority_address', [])
        return stack.readAddress()
    }

    async getRevokedTime(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_revoked_time', [])
        return stack.readBigNumber()
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
