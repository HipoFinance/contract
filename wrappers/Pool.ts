import { Address, beginCell, Cell, Contract, contractAddress } from 'ton-core'

export type PoolConfig = {
    elector?: Address
    treasury: Address
    validator: Address
    roundSince: bigint
}

export function poolConfigToCell(config: PoolConfig): Cell {
    return beginCell()
        .storeAddress(config.elector)
        .storeAddress(config.treasury)
        .storeAddress(config.validator)
        .storeUint(config.roundSince, 32)
        .endCell()
}

export class Pool implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell, data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Pool(address)
    }

    static createFromConfig(config: PoolConfig, code: Cell, workchain = -1) {
        const data = poolConfigToCell(config)
        const init = { code, data }
        return new Pool(contractAddress(workchain, init), init)
    }
}
