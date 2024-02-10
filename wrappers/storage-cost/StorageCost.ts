import { Address, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode, TupleBuilder } from '@ton/core'

export class StorageCost implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new StorageCost(address)
    }

    static createFromConfig(config: Record<string, never>, code: Cell, workchain = 0) {
        const data = Cell.EMPTY
        const init = { code, data }
        return new StorageCost(contractAddress(workchain, init), init)
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
        await this.sendMessage(provider, via, opts)
    }

    async getStorageCost(
        provider: ContractProvider,
        main: boolean,
        duration: number,
        c: Cell,
    ): Promise<[bigint, bigint, bigint]> {
        const tb = new TupleBuilder()
        tb.writeBoolean(main)
        tb.writeNumber(duration)
        tb.writeCell(c)
        const { stack } = await provider.get('get_storage_cost', tb.build())
        return [stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber()]
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
