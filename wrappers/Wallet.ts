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
    Slice,
} from '@ton/core'
import { op, tonValue } from './common'

export interface WalletFees {
    sendTokensFee: bigint
    unstakeTokensFee: bigint
    upgradeWalletFee: bigint
    walletStorageFee: bigint
}

export enum UnstakeMode {
    Auto,
    Instant,
    Best,
}

interface WalletConfig {
    owner: Address
    parent: Address
    tokens: bigint
    staking: Dictionary<bigint, bigint>
    unstaking: bigint
}

export function walletConfigToCell(config: WalletConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeAddress(config.parent)
        .storeCoins(config.tokens)
        .storeDict(config.staking)
        .storeCoins(config.unstaking)
        .endCell()
}

export class Wallet implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Wallet(address)
    }

    static createFromConfig(config: WalletConfig, code: Cell, workchain = 0) {
        const data = walletConfigToCell(config)
        const init = { code, data }
        return new Wallet(contractAddress(workchain, init), init)
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

    async sendSendTokens(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            tokens: bigint | string
            recipient: Address
            returnExcess?: Address
            customPayload?: Cell
            forwardTonAmount?: bigint | string
            forwardPayload?: Slice
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.sendTokens, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeCoins(tonValue(opts.tokens))
                .storeAddress(opts.recipient)
                .storeAddress(opts.returnExcess)
                .storeMaybeRef(opts.customPayload)
                .storeCoins(tonValue(opts.forwardTonAmount ?? 0n))
                .storeSlice(opts.forwardPayload ?? beginCell().storeUint(0, 1).endCell().beginParse())
                .endCell(),
        })
    }

    async sendUnstakeTokens(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            tokens: bigint | string
            returnExcess?: Address
            mode?: UnstakeMode
            ownershipAssignedAmount?: bigint
        },
    ) {
        let customPayload: Cell | null = null
        if (opts.ownershipAssignedAmount != null || opts.mode != null) {
            customPayload = beginCell()
                .storeUint(opts.mode ?? 0, 4)
                .storeCoins(opts.ownershipAssignedAmount ?? 0)
                .endCell()
        }
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.unstakeTokens, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeCoins(tonValue(opts.tokens))
                .storeAddress(opts.returnExcess)
                .storeMaybeRef(customPayload)
                .endCell(),
        })
    }

    async sendWithdrawSurplus(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            returnExcess?: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.withdrawSurplus, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.returnExcess)
                .endCell(),
        })
    }

    async sendUpgradeWallet(
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
                .storeUint(op.upgradeWallet, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .endCell(),
        })
    }

    async sendWithdrawJettons(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            childWallet: Address
            tokens: bigint
            customPayload?: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.withdrawJettons, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.childWallet)
                .storeCoins(opts.tokens)
                .storeMaybeRef(opts.customPayload)
                .endCell(),
        })
    }

    async getWalletData(provider: ContractProvider): Promise<[bigint, Address, Address, Cell]> {
        const { stack } = await provider.get('get_wallet_data', [])
        return [stack.readBigNumber(), stack.readAddress(), stack.readAddress(), stack.readCell()]
    }

    async getWalletState(provider: ContractProvider): Promise<[bigint, Dictionary<bigint, bigint>, bigint]> {
        const { stack } = await provider.get('get_wallet_state', [])
        return [
            stack.readBigNumber(),
            Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4), stack.readCellOpt()),
            stack.readBigNumber(),
        ]
    }

    async getWalletFees(provider: ContractProvider): Promise<WalletFees> {
        const { stack } = await provider.get('get_wallet_fees', [])
        return {
            sendTokensFee: stack.readBigNumber(),
            unstakeTokensFee: stack.readBigNumber(),
            upgradeWalletFee: stack.readBigNumber(),
            walletStorageFee: stack.readBigNumber(),
        }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }
}
