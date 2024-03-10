import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
} from '@ton/core'
import { metadataDictionaryValue } from './Parent'

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

    async getNftData(
        provider: ContractProvider,
    ): Promise<[boolean, bigint, Address, Address, Dictionary<bigint, string>]> {
        const { stack } = await provider.get('get_nft_data', [])
        return [
            stack.readBoolean(),
            stack.readBigNumber(),
            stack.readAddress(),
            stack.readAddress(),
            Dictionary.load(
                Dictionary.Keys.BigUint(256),
                metadataDictionaryValue,
                stack.readCell().beginParse().skip(8),
            ),
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
