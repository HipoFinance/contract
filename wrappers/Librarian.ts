import {
    Address,
    beginCell,
    BitBuilder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
} from '@ton/core'
import { op } from './common'

export function exportLibCode(code: Cell): Cell {
    const bits = new BitBuilder()
    bits.writeUint(2, 8)
    bits.writeUint(BigInt('0x' + code.hash().toString('hex')), 256)

    return new Cell({ exotic: true, bits: bits.build() })
}

export function buildBlockchainLibraries(libs: Cell[]): Cell {
    const libraries = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
    libs.forEach((lib) => libraries.set(BigInt('0x' + lib.hash().toString('hex')), lib))

    return beginCell().storeDictDirect(libraries).endCell()
}

export interface LibrarianConfig {
    treasury: Address
}

export function librarianConfigToCell(config: LibrarianConfig): Cell {
    return beginCell().storeAddress(config.treasury).endCell()
}

export class Librarian implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Librarian(address)
    }

    static createFromConfig(config: LibrarianConfig, code: Cell, workchain = -1) {
        const data = librarianConfigToCell(config)
        const init = { code, data }
        return new Librarian(contractAddress(workchain, init), init)
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

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
