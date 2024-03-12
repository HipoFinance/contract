import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    ContractState,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
    Slice,
    TupleBuilder,
} from '@ton/core'
import { op, tonValue } from './common'

export interface Times {
    currentRoundSince: bigint
    participateSince: bigint
    participateUntil: bigint
    nextRoundSince: bigint
    nextRoundUntil: bigint
    stakeHeldFor: bigint
}

export interface TreasuryFees {
    requestLoanFee: bigint
    depositCoinsFee: bigint
    unstakeAllTokensFee: bigint
}

export enum ParticipationState {
    Open,
    Distributing,
    Staked,
    Validating,
    Held,
    Recovering,
    Burning,
}

export interface Request {
    minPayment: bigint
    borrowerRewardShare: bigint
    loanAmount: bigint
    accrueAmount: bigint
    stakeAmount: bigint
    newStakeMsg: Cell
}

export interface Participation {
    state?: ParticipationState
    size?: bigint
    sorted?: Dictionary<bigint, Dictionary<bigint, unknown>>
    requests?: Dictionary<bigint, Request>
    rejected?: Dictionary<bigint, Request>
    accepted?: Dictionary<bigint, Request>
    accrued?: Dictionary<bigint, Request>
    staked?: Dictionary<bigint, Request>
    recovering?: Dictionary<bigint, Request>
    totalStaked?: bigint
    totalRecovered?: bigint
    currentVsetHash?: bigint
    stakeHeldFor?: bigint
    stakeHeldUntil?: bigint
}

export interface TreasuryConfig {
    totalCoins: bigint
    totalTokens: bigint
    totalStaking: bigint
    totalUnstaking: bigint
    totalBorrowersStake: bigint
    parent: Address | null
    participations: Dictionary<bigint, Participation>
    roundsImbalance: bigint
    stopped: boolean
    instantMint: boolean
    loanCodes: Dictionary<bigint, Cell>
    lastStaked: bigint
    lastRecovered: bigint
    halter: Address
    governor: Address
    proposedGovernor: Cell | null
    governanceFee: bigint
    collectionCodes: Dictionary<bigint, Cell>
    billCodes: Dictionary<bigint, Cell>
    oldParents: Dictionary<bigint, unknown>
}

export function treasuryConfigToCell(config: TreasuryConfig): Cell {
    const treasuryExtension = beginCell()
        .storeCoins(config.lastStaked)
        .storeCoins(config.lastRecovered)
        .storeAddress(config.halter)
        .storeAddress(config.governor)
        .storeMaybeRef(config.proposedGovernor)
        .storeUint(config.governanceFee, 16)
        .storeRef(beginCell().storeDictDirect(config.collectionCodes))
        .storeRef(beginCell().storeDictDirect(config.billCodes))
        .storeDict(config.oldParents)
    return beginCell()
        .storeCoins(config.totalCoins)
        .storeCoins(config.totalTokens)
        .storeCoins(config.totalStaking)
        .storeCoins(config.totalUnstaking)
        .storeCoins(config.totalBorrowersStake)
        .storeAddress(config.parent)
        .storeDict(config.participations)
        .storeUint(config.roundsImbalance, 8)
        .storeBit(config.stopped)
        .storeBit(config.instantMint)
        .storeRef(beginCell().storeDictDirect(config.loanCodes))
        .storeRef(treasuryExtension)
        .endCell()
}

export const emptyDictionaryValue: DictionaryValue<unknown> = {
    serialize: function () {
        return
    },
    parse: function (): unknown {
        return {}
    },
}

export const sortedDictionaryValue: DictionaryValue<Dictionary<bigint, unknown>> = {
    serialize: function (src: Dictionary<bigint, unknown>, builder: Builder) {
        builder.storeRef(beginCell().storeDictDirect(src))
    },
    parse: function (src: Slice): Dictionary<bigint, unknown> {
        return src.loadRef().beginParse().loadDictDirect(Dictionary.Keys.BigUint(256), emptyDictionaryValue)
    },
}

export const requestDictionaryValue: DictionaryValue<Request> = {
    serialize: function (src: Request, builder: Builder) {
        builder
            .storeCoins(src.minPayment)
            .storeUint(src.borrowerRewardShare, 8)
            .storeCoins(src.loanAmount)
            .storeCoins(src.accrueAmount)
            .storeCoins(src.stakeAmount)
            .storeRef(src.newStakeMsg)
    },
    parse: function (src: Slice): Request {
        return {
            minPayment: src.loadCoins(),
            borrowerRewardShare: src.loadUintBig(8),
            loanAmount: src.loadCoins(),
            accrueAmount: src.loadCoins(),
            stakeAmount: src.loadCoins(),
            newStakeMsg: src.loadRef(),
        }
    },
}

export const participationDictionaryValue: DictionaryValue<Participation> = {
    serialize: function (src: Participation, builder: Builder) {
        builder
            .storeUint(src.state ?? 0, 4)
            .storeUint(src.size ?? 0, 16)
            .storeDict(src.sorted)
            .storeDict(src.requests)
            .storeDict(src.rejected)
            .storeDict(src.accepted)
            .storeDict(src.accrued)
            .storeDict(src.staked)
            .storeDict(src.recovering)
            .storeCoins(src.totalStaked ?? 0)
            .storeCoins(src.totalRecovered ?? 0)
            .storeUint(src.currentVsetHash ?? 0, 256)
            .storeUint(src.stakeHeldFor ?? 0, 32)
            .storeUint(src.stakeHeldUntil ?? 0, 32)
    },
    parse: function (src: Slice): Participation {
        return {
            state: src.loadUint(4),
            size: src.loadUintBig(16),
            sorted: src.loadDict(Dictionary.Keys.BigUint(112), sortedDictionaryValue),
            requests: src.loadDict(Dictionary.Keys.BigUint(256), requestDictionaryValue),
            rejected: src.loadDict(Dictionary.Keys.BigUint(256), requestDictionaryValue),
            accepted: src.loadDict(Dictionary.Keys.BigUint(256), requestDictionaryValue),
            accrued: src.loadDict(Dictionary.Keys.BigUint(256), requestDictionaryValue),
            staked: src.loadDict(Dictionary.Keys.BigUint(256), requestDictionaryValue),
            recovering: src.loadDict(Dictionary.Keys.BigUint(256), requestDictionaryValue),
            totalStaked: src.loadCoins(),
            totalRecovered: src.loadCoins(),
            currentVsetHash: src.loadUintBig(256),
            stakeHeldFor: src.loadUintBig(32),
            stakeHeldUntil: src.loadUintBig(32),
        }
    },
}

export class Treasury implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Treasury(address)
    }

    static createFromConfig(config: TreasuryConfig, code: Cell, workchain = 0) {
        const data = treasuryConfigToCell(config)
        const init = { code, data }
        return new Treasury(contractAddress(workchain, init), init)
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

    async sendDepositCoins(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            owner?: Address
            coins?: bigint
            ownershipAssignedAmount?: bigint
            referrer?: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.depositCoins, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.owner)
                .storeCoins(opts.coins ?? 0)
                .storeCoins(opts.ownershipAssignedAmount ?? 0)
                .storeAddress(opts.referrer)
                .endCell(),
        })
    }

    async sendProvideCurrentQuote(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            customPayload?: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.provideCurrentQuote, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeMaybeRef(opts.customPayload)
                .endCell(),
        })
    }

    async sendRequestLoan(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            roundSince: bigint
            loanAmount: bigint | string
            minPayment: bigint | string
            borrowerRewardShare: bigint
            newStakeMsg: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.requestLoan, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.roundSince, 32)
                .storeCoins(tonValue(opts.loanAmount))
                .storeCoins(tonValue(opts.minPayment))
                .storeUint(opts.borrowerRewardShare, 8)
                .storeRef(opts.newStakeMsg)
                .endCell(),
        })
    }

    async sendParticipateInElection(
        provider: ContractProvider,
        opts: {
            queryId?: bigint
            roundSince: bigint
        },
    ) {
        const message = beginCell()
            .storeUint(op.participateInElection, 32)
            .storeUint(opts.queryId ?? 0, 64)
            .storeUint(opts.roundSince, 32)
            .endCell()
        await provider.external(message)
    }

    async sendVsetChanged(
        provider: ContractProvider,
        opts: {
            queryId?: bigint
            roundSince: bigint
        },
    ) {
        const message = beginCell()
            .storeUint(op.vsetChanged, 32)
            .storeUint(opts.queryId ?? 0, 64)
            .storeUint(opts.roundSince, 32)
            .endCell()
        await provider.external(message)
    }

    async sendFinishParticipation(
        provider: ContractProvider,
        opts: {
            queryId?: bigint
            roundSince: bigint
        },
    ) {
        const message = beginCell()
            .storeUint(op.finishParticipation, 32)
            .storeUint(opts.queryId ?? 0, 64)
            .storeUint(opts.roundSince, 32)
            .endCell()
        await provider.external(message)
    }

    async sendProposeGovernor(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newGovernor: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proposeGovernor, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.newGovernor)
                .endCell(),
        })
    }

    async sendAcceptGovernance(
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
                .storeUint(op.acceptGovernance, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .endCell(),
        })
    }

    async sendSetHalter(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newHalter: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.setHalter, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.newHalter)
                .endCell(),
        })
    }

    async sendSetStopped(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newStopped: boolean
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.setStopped, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeBit(opts.newStopped)
                .endCell(),
        })
    }

    async sendSetInstantMint(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newInstantMint: boolean
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.setInstantMint, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeBit(opts.newInstantMint)
                .endCell(),
        })
    }

    async sendSetGovernanceFee(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newGovernanceFee: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.setGovernanceFee, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.newGovernanceFee, 16)
                .endCell(),
        })
    }

    async sendSetRoundsImbalance(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newRoundsImbalance: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.setRoundsImbalance, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.newRoundsImbalance, 8)
                .endCell(),
        })
    }

    async sendSendMessageToLoan(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            borrower: Address
            roundSince: bigint
            message: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.sendMessageToLoan, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.borrower)
                .storeUint(opts.roundSince, 32)
                .storeRef(opts.message)
                .endCell(),
        })
    }

    async sendRetryDistribute(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            roundSince: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.retryDistribute, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.roundSince, 32)
                .endCell(),
        })
    }

    async sendRetryRecoverStakes(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            roundSince: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.retryRecoverStakes, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.roundSince, 32)
                .endCell(),
        })
    }

    async sendRetryMintBill(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            roundSince: bigint
            amount: bigint
            unstake: boolean
            owner: Address
            parent: Address
            ownershipAssignedAmount: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.retryMintBill, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.roundSince, 32)
                .storeCoins(opts.amount)
                .storeBit(opts.unstake)
                .storeAddress(opts.owner)
                .storeAddress(opts.parent)
                .storeCoins(opts.ownershipAssignedAmount)
                .endCell(),
        })
    }

    async sendRetryBurnAll(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            roundSince: bigint
            startIndex?: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.retryBurnAll, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeUint(opts.roundSince, 32)
                .storeUint(opts.startIndex ?? 0, 64)
                .endCell(),
        })
    }

    async sendSetParent(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newParent: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.setParent, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.newParent)
                .endCell(),
        })
    }

    async sendProxySetContent(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            destination: Address
            newContent: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proxySetContent, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.destination)
                .storeRef(opts.newContent)
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
                .storeAddress(opts.returnExcess ?? via.address)
                .endCell(),
        })
    }

    async sendProxyWithdrawSurplus(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            destination: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proxyWithdrawSurplus, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.destination)
                .endCell(),
        })
    }

    async sendUpgradeCode(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            newCode: Cell
            newData?: Cell
            returnExcess?: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.upgradeCode, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeRef(opts.newCode)
                .storeMaybeRef(opts.newData)
                .storeAddress(opts.returnExcess ?? via.address)
                .endCell(),
        })
    }

    async sendProxyUpgradeCode(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            destination: Address
            newCode: Cell
            newData?: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proxyUpgradeCode, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.destination)
                .storeRef(opts.newCode)
                .storeMaybeRef(opts.newData)
                .endCell(),
        })
    }

    async sendSendUpgradeWallet(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            destination: Address
            owner: Address
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.sendUpgradeWallet, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.destination)
                .storeAddress(opts.owner)
                .endCell(),
        })
    }

    async sendProxyAddLibrary(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            destination: Address
            code: Cell
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proxyAddLibrary, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.destination)
                .storeRef(opts.code)
                .endCell(),
        })
    }

    async sendProxyRemoveLibrary(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            destination: Address
            codeHash: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.proxyRemoveLibrary, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeAddress(opts.destination)
                .storeUint(opts.codeHash, 256)
                .endCell(),
        })
    }

    async sendGiftCoins(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint | string
            bounce?: boolean
            sendMode?: SendMode
            queryId?: bigint
            coins: bigint
        },
    ) {
        await this.sendMessage(provider, via, {
            value: opts.value,
            bounce: opts.bounce,
            sendMode: opts.sendMode,
            body: beginCell()
                .storeUint(op.giftCoins, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeCoins(opts.coins)
                .endCell(),
        })
    }

    async getTimes(provider: ContractProvider): Promise<Times> {
        const { stack } = await provider.get('get_times', [])
        return {
            currentRoundSince: stack.readBigNumber(),
            participateSince: stack.readBigNumber(),
            participateUntil: stack.readBigNumber(),
            nextRoundSince: stack.readBigNumber(),
            nextRoundUntil: stack.readBigNumber(),
            stakeHeldFor: stack.readBigNumber(),
        }
    }

    async getTreasuryState(provider: ContractProvider): Promise<TreasuryConfig> {
        const { stack } = await provider.get('get_treasury_state', [])
        return {
            totalCoins: stack.readBigNumber(),
            totalTokens: stack.readBigNumber(),
            totalStaking: stack.readBigNumber(),
            totalUnstaking: stack.readBigNumber(),
            totalBorrowersStake: stack.readBigNumber(),
            parent: stack.readAddressOpt(),
            participations: Dictionary.loadDirect(
                Dictionary.Keys.BigUint(32),
                participationDictionaryValue,
                stack.readCellOpt(),
            ),
            roundsImbalance: stack.readBigNumber(),
            stopped: stack.readBoolean(),
            instantMint: stack.readBoolean(),
            loanCodes: Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell(), stack.readCell()),
            lastStaked: stack.readBigNumber(),
            lastRecovered: stack.readBigNumber(),
            halter: stack.readAddress(),
            governor: stack.readAddress(),
            proposedGovernor: stack.readCellOpt(),
            governanceFee: stack.readBigNumber(),
            collectionCodes: Dictionary.loadDirect(
                Dictionary.Keys.BigUint(32),
                Dictionary.Values.Cell(),
                stack.readCell(),
            ),
            billCodes: Dictionary.loadDirect(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell(), stack.readCell()),
            oldParents: Dictionary.loadDirect(Dictionary.Keys.BigUint(256), emptyDictionaryValue, stack.readCellOpt()),
        }
    }

    async getParticipation(provider: ContractProvider, roundSince: bigint): Promise<Participation> {
        const tb = new TupleBuilder()
        tb.writeNumber(roundSince)
        const { stack } = await provider.get('get_participation', tb.build())
        return {
            state: stack.readNumber(),
            size: stack.readBigNumber(),
            sorted: Dictionary.loadDirect(Dictionary.Keys.BigUint(112), sortedDictionaryValue, stack.readCellOpt()),
            requests: Dictionary.loadDirect(Dictionary.Keys.BigUint(256), requestDictionaryValue, stack.readCellOpt()),
            rejected: Dictionary.loadDirect(Dictionary.Keys.BigUint(256), requestDictionaryValue, stack.readCellOpt()),
            accepted: Dictionary.loadDirect(Dictionary.Keys.BigUint(256), requestDictionaryValue, stack.readCellOpt()),
            accrued: Dictionary.loadDirect(Dictionary.Keys.BigUint(256), requestDictionaryValue, stack.readCellOpt()),
            staked: Dictionary.loadDirect(Dictionary.Keys.BigUint(256), requestDictionaryValue, stack.readCellOpt()),
            recovering: Dictionary.loadDirect(
                Dictionary.Keys.BigUint(256),
                requestDictionaryValue,
                stack.readCellOpt(),
            ),
            totalStaked: stack.readBigNumber(),
            totalRecovered: stack.readBigNumber(),
            currentVsetHash: stack.readBigNumber(),
            stakeHeldFor: stack.readBigNumber(),
            stakeHeldUntil: stack.readBigNumber(),
        }
    }

    async getCollectionAddress(provider: ContractProvider, roundSince: bigint) {
        const tb = new TupleBuilder()
        tb.writeNumber(roundSince)
        const { stack } = await provider.get('get_collection_address', tb.build())
        return stack.readAddress()
    }

    async getBillAddress(provider: ContractProvider, roundSince: bigint, index: bigint) {
        const tb = new TupleBuilder()
        tb.writeNumber(roundSince)
        tb.writeNumber(index)
        const { stack } = await provider.get('get_bill_address', tb.build())
        return stack.readAddress()
    }

    async getLoanAddress(provider: ContractProvider, borrower: Address, roundSince: bigint) {
        const tb = new TupleBuilder()
        tb.writeAddress(borrower)
        tb.writeNumber(roundSince)
        const { stack } = await provider.get('get_loan_address', tb.build())
        return stack.readAddress()
    }

    async getTreasuryFees(provider: ContractProvider, ownershipAssignedAmount: bigint): Promise<TreasuryFees> {
        const tb = new TupleBuilder()
        tb.writeNumber(ownershipAssignedAmount)
        const { stack } = await provider.get('get_treasury_fees', tb.build())
        return {
            requestLoanFee: stack.readBigNumber(),
            depositCoinsFee: stack.readBigNumber(),
            unstakeAllTokensFee: stack.readBigNumber(),
        }
    }

    async getMaxBurnableTokens(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_max_burnable_tokens', [])
        return stack.readBigNumber()
    }

    async getSurplus(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_surplus', [])
        return stack.readBigNumber()
    }

    async getMaxPunishment(provider: ContractProvider, stake: bigint) {
        const tb = new TupleBuilder()
        tb.writeNumber(stake)
        const { stack } = await provider.get('get_max_punishment', tb.build())
        return stack.readBigNumber()
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        const state = await provider.getState()
        return state.balance
    }

    async getState(provider: ContractProvider): Promise<ContractState> {
        return await provider.getState()
    }
}
