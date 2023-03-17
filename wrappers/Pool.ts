import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from 'ton-core';

const opTopUp = 0x34e5d45a

export type PoolConfig = {
    elector?: Address
    root: Address
    validatorOwner: Address
};

export function poolConfigToCell(config: PoolConfig): Cell {
    return beginCell()
        .storeAddress(config.elector)
        .storeAddress(config.root)
        .storeAddress(config.validatorOwner)
        .endCell();
}

export class Pool implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Pool(address);
    }

    static createFromConfig(config: PoolConfig, code: Cell, workchain = -1) {
        const data = poolConfigToCell(config);
        const init = { code, data };
        return new Pool(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(opTopUp, 32).endCell(),
        });
    }
}
