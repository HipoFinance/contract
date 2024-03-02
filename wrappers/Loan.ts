import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core'

export interface LoanConfig {
    elector?: Address
    treasury: Address
    borrower: Address
    roundSince: bigint
}

export function loanConfigToCell(config: LoanConfig): Cell {
    return beginCell()
        .storeAddress(config.elector)
        .storeAddress(config.treasury)
        .storeAddress(config.borrower)
        .storeUint(config.roundSince, 32)
        .endCell()
}

export class Loan implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Loan(address)
    }

    static createFromConfig(config: LoanConfig, code: Cell, workchain = -1) {
        const data = loanConfigToCell(config)
        const init = { code, data }
        return new Loan(contractAddress(workchain, init), init)
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

    async getLoanState(provider: ContractProvider): Promise<LoanConfig> {
        const { stack } = await provider.get('get_loan_state', [])
        return {
            elector: stack.readAddress(),
            treasury: stack.readAddress(),
            borrower: stack.readAddress(),
            roundSince: stack.readBigNumber(),
        }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
