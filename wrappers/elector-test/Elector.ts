import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    TupleBuilder,
} from 'ton-core'

export interface ElectorConfig {
    currentElection?: Cell
    credits?: Dictionary<bigint, bigint>
    pastElections?: Cell
    coins?: bigint
    activeId?: bigint
    activeHash?: bigint
}

export function electorConfigToCell(config: ElectorConfig): Cell {
    return beginCell()
        .storeMaybeRef(config.currentElection)
        .storeDict(config.credits)
        .storeMaybeRef(config.pastElections)
        .storeCoins(config.coins ?? 0)
        .storeUint(config.activeId ?? 0, 32)
        .storeUint(config.activeHash ?? 0, 256)
        .endCell()
}

export interface ElectionConfig {
    electAt?: bigint
    electClose?: bigint
    minStake?: bigint
    totalStake?: bigint
    members?: Cell
    failed?: boolean
    finished?: boolean
}

export function createElectionConfig(config: ElectionConfig): Cell {
    return beginCell()
        .storeUint(config.electAt ?? 0, 32)
        .storeUint(config.electClose ?? 0, 32)
        .storeCoins(config.minStake ?? 0)
        .storeCoins(config.totalStake ?? 0)
        .storeMaybeRef(config.members)
        .storeBit(config.failed ?? false)
        .storeBit(config.finished ?? false)
        .endCell()
}

export class Elector implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Elector(address)
    }

    static createFromConfig(config: ElectorConfig, code: Cell, workchain = -1) {
        const data = electorConfigToCell(config)
        const init = { code, data }
        return new Elector(contractAddress(workchain, init), init)
    }

    async getCredit(provider: ContractProvider, loanAddress: Address): Promise<bigint> {
        const tb = new TupleBuilder()
        tb.writeNumber(BigInt('0x' + loanAddress.toRawString().split(':')[1]))
        const { stack } = await provider.get('compute_returned_stake', tb.build())
        return stack.readBigNumber()
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
