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
    TupleBuilder,
} from '@ton/core'
import { metadataDictionaryValue } from './Parent'

interface CollectionConfig {
    treasury: Address
    roundSince: bigint
    nextItemIndex: bigint
    billCode: Cell
}

export function collectionConfigToCell(config: CollectionConfig): Cell {
    return beginCell()
        .storeAddress(config.treasury)
        .storeUint(config.roundSince, 32)
        .storeUint(config.nextItemIndex, 64)
        .storeRef(config.billCode)
        .endCell()
}

export class Collection implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Collection(address)
    }

    static createFromConfig(config: CollectionConfig, code: Cell, workchain = 0) {
        const data = collectionConfigToCell(config)
        const init = { code, data }
        return new Collection(contractAddress(workchain, init), init)
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

    async getCollectionData(provider: ContractProvider): Promise<[bigint, Dictionary<bigint, string>, Address]> {
        const { stack } = await provider.get('get_collection_data', [])
        return [
            stack.readBigNumber(),
            Dictionary.loadDirect(Dictionary.Keys.BigUint(256), metadataDictionaryValue, stack.readCellOpt()),
            stack.readAddress(),
        ]
    }

    async getNftAddressByIndex(provider: ContractProvider, index: bigint): Promise<Address> {
        const tb = new TupleBuilder()
        tb.writeNumber(index)
        const { stack } = await provider.get('get_nft_address_by_index', tb.build())
        return stack.readAddress()
    }

    async getNftContent(
        provider: ContractProvider,
        index: bigint,
        individualContent: Dictionary<bigint, string>,
    ): Promise<Dictionary<bigint, string>> {
        const b = beginCell()
        individualContent.storeDirect(b)
        const tb = new TupleBuilder()
        tb.writeNumber(index)
        tb.writeCell(b.endCell())
        const { stack } = await provider.get('get_nft_content', tb.build())
        return Dictionary.loadDirect(Dictionary.Keys.BigUint(256), metadataDictionaryValue, stack.readCellOpt())
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
