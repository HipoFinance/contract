/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { Blockchain, BlockchainTransaction } from '@ton/sandbox'
import type { MatcherFunction } from 'expect'
import { Address, Builder, Cell, Dictionary, beginCell, fromNano, toNano } from '@ton/core'
import { mnemonicNew, mnemonicToPrivateKey, sign } from 'ton-crypto'
import { Fees } from '../wrappers/Treasury'

const muteLogComputeGas = true
const muteLogTotalFees = true
const muteLogCodeCost = true
const muteLogFees = true

const gasUsed: Record<string, bigint> = {}

export function bodyOp(op: number): (body: Cell | undefined) => boolean {
    return (body: Cell | undefined): boolean => {
        if (body == null) {
            return false
        }
        const s = body.beginParse()
        return s.remainingBits >= 32 && s.loadUint(32) === op
    }
}

export function between(a: bigint | string, b: bigint | string): (x?: bigint) => boolean {
    let u = typeof a === 'string' ? toNano(a) : a
    let v = typeof b === 'string' ? toNano(b) : b
    if (u > v) {
        const t = u
        u = v
        v = t
    }
    return (x?: bigint) => {
        return x != null && u <= x && x <= v
    }
}

export const toBeBetween: MatcherFunction<[a: unknown, b: unknown]> = function (actual, a, b) {
    if (
        (typeof a !== 'bigint' && typeof a !== 'string') ||
        (typeof b !== 'bigint' && typeof b !== 'string') ||
        typeof actual !== 'bigint'
    ) {
        throw new Error('invalid type')
    }

    const pass = between(a, b)(actual)
    if (pass) {
        return {
            message: () =>
                `expected ${this.utils.printReceived(actual)} not to be between ${this.utils.printExpected(
                    `[${a}, ${b}]`,
                )}`,
            pass: true,
        }
    } else {
        return {
            message: () =>
                `expected ${this.utils.printReceived(actual)} to be between ${this.utils.printExpected(
                    `[${a}, ${b}]`,
                )}`,
            pass: false,
        }
    }
}

export const toBeTonValue: MatcherFunction<[v: unknown]> = function (actual, v) {
    v = typeof v === 'string' ? toNano(v) : v
    if (typeof v !== 'bigint' || typeof actual !== 'bigint') {
        throw new Error('invalid type')
    }
    const pass = actual === v
    if (pass) {
        return {
            message: () =>
                `expected ${this.utils.printReceived(actual)} not to be ${this.utils.printExpected(v)} nanoTON`,
            pass: true,
        }
    } else {
        return {
            message: () => `expected ${this.utils.printReceived(actual)} to be ${this.utils.printExpected(v)} nanoTON`,
            pass: false,
        }
    }
}

export const emptyNewStakeMsg = beginCell()
    .storeUint(0, 256)
    .storeUint(0, 32)
    .storeUint(0, 32)
    .storeUint(0, 256)
    .storeRef(beginCell().storeUint(0, 256).storeUint(0, 256))
    .endCell()

export async function createNewStakeMsg(loanAddress: Address, roundSince: bigint): Promise<Cell> {
    const maxFactor = 0x10000n
    const keypair = await mnemonicToPrivateKey(await mnemonicNew())
    const adnl = await mnemonicToPrivateKey(await mnemonicNew())
    const confirmation = beginCell()
        .storeUint(0x654c5074, 32)
        .storeUint(roundSince, 32)
        .storeUint(maxFactor, 32)
        .storeBuffer(loanAddress.hash, 32) // 256 bits
        .storeBuffer(adnl.publicKey, 32) // 256 bits
        .endCell()
    const signature = sign(confirmation.bits.subbuffer(0, 608) ?? Buffer.from(''), keypair.secretKey)
    return beginCell()
        .storeBuffer(keypair.publicKey, 32) // 256 bits
        .storeUint(roundSince, 32)
        .storeUint(maxFactor, 32)
        .storeBuffer(adnl.publicKey, 32) // 256 bits
        .storeRef(beginCell().storeBuffer(signature, 64)) // 512 bits
        .endCell()
}

export function createVset(since: bigint, until: bigint, total?: bigint, main?: bigint, list?: Builder | Cell): Cell {
    return beginCell()
        .storeUint(0x12, 8)
        .storeUint(since, 32)
        .storeUint(until, 32)
        .storeUint(total ?? 1n, 16)
        .storeUint(main ?? 1n, 16)
        .storeMaybeRef(list)
        .endCell()
}

export function setConfig(blockchain: Blockchain, index: bigint, value: Cell) {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    config.set(index, value)
    const storage = beginCell()
    config.storeDirect(storage)
    const newConfig = storage.endCell()
    blockchain.setConfig(newConfig)
}

export function getElector(blockchain: Blockchain): Address {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    const electorAddr = config.get(1n)?.beginParse().loadUintBig(256) ?? 0n
    return Address.parseRaw('-1:' + electorAddr.toString(16))
}

export let totalFees = 0n

export function accumulateFees(transactions: BlockchainTransaction[]) {
    totalFees = transactions.reduce((acc, tx) => acc + tx.totalFees.coins, totalFees)
}

export function logTotalFees() {
    if (!muteLogTotalFees) {
        console.info('Total Fees: %s', fromNano(totalFees))
    }
}

function toBytes(bits: bigint): string {
    return Math.ceil(Number(bits) / 8)
        .toString()
        .padStart(5)
}

export function logCodeCost(cost: [bigint, bigint, bigint][]) {
    if (!muteLogCodeCost) {
        console.info(
            [
                'Code Storage Cost:',
                '               | Bytes | Cells | 1 Year Cost',
                '    Treasury   | %s | %s | %s',
                '    Parent     | %s | %s | %s',
                '    Wallet     | %s | %s | %s',
                '    Collection | %s | %s | %s',
                '    Bill       | %s | %s | %s',
                '    Loan       | %s | %s | %s',
            ].join('\n'),
            toBytes(cost[0][0]),
            cost[0][1].toString().padStart(5),
            fromNano(cost[0][2]).padStart(12),
            toBytes(cost[1][0]),
            cost[1][1].toString().padStart(5),
            fromNano(cost[1][2]).padStart(12),
            toBytes(cost[2][0]),
            cost[2][1].toString().padStart(5),
            fromNano(cost[2][2]).padStart(12),
            toBytes(cost[3][0]),
            cost[3][1].toString().padStart(5),
            fromNano(cost[3][2]).padStart(12),
            toBytes(cost[4][0]),
            cost[4][1].toString().padStart(5),
            fromNano(cost[4][2]).padStart(12),
            toBytes(cost[5][0]),
            cost[5][1].toString().padStart(5),
            fromNano(cost[5][2]).padStart(12),
        )
    }
}

export function storeComputeGas(opLabel: string, opCode: number, tx: BlockchainTransaction) {
    if (!bodyOp(opCode)(tx.inMessage?.body ?? Cell.EMPTY) && !bodyOp(0)(tx.inMessage?.body ?? Cell.EMPTY)) {
        throw new Error('invalid transaction to log compute gas for op ' + opLabel)
    }
    const logs = tx.blockchainLogs
    const usedIndex = logs.indexOf('used=')
    const commaIndex = logs.indexOf(',', usedIndex)
    const usedGas = BigInt(logs.substring(usedIndex + 5, commaIndex))
    if (logs.lastIndexOf('used=') !== usedIndex) {
        throw new Error('unexpected second "used" field in calculating gas')
    }
    if (gasUsed[opLabel] == null || gasUsed[opLabel] < usedGas) {
        gasUsed[opLabel] = usedGas
    }
}

function logGas(opLabel: string): string {
    const used = gasUsed[opLabel]
    gasUsed[opLabel] = -1n
    if (used >= 0n) {
        return '    const int gas::' + opLabel + ' = ' + used.toString() + ';'
    } else {
        return 'unknown gas: ' + opLabel
    }
}

export function logComputeGas(opLabels: string[]) {
    if (!muteLogComputeGas) {
        console.info('Compute Gas:\n' + opLabels.map(logGas).join('\n'))
        for (const [key, value] of Object.entries(gasUsed)) {
            if (value >= 0n) {
                console.info('Unknown gas: ', key, value)
            }
        }
    }
}

export function logFees(fees: Fees) {
    if (!muteLogFees) {
        const logs = [
            'Fees:',
            '    send tokens:        ' + fromNano(fees.sendTokensFee),
            '    deposit coins:      ' + fromNano(fees.depositCoinsFee),
            '    unstake tokens:     ' + fromNano(fees.unstakeTokensFee),
            '    unstake all tokens: ' + fromNano(fees.unstakeAllTokensFee),
            '    request loan:       ' + fromNano(fees.requestLoanFee),
            '    loan storage:       ' + fromNano(fees.loanStorage),
            '    wallet storage:     ' + fromNano(fees.walletStorage),
        ]
        console.info(logs.join('\n'))
    }
}
