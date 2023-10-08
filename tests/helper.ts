/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { Blockchain, BlockchainTransaction } from '@ton-community/sandbox'
import type { MatcherFunction } from 'expect'
import { Address, Builder, Cell, Dictionary, beginCell, fromNano, toNano } from 'ton-core'
import { mnemonicNew, mnemonicToPrivateKey, sign } from 'ton-crypto'

const muteLogTotalFees = true
const muteLogCodeSizes = true
const muteLogComputeGas = true

export function bodyOp(op: number): (body: Cell) => boolean {
    return (body: Cell): boolean => {
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
        console.info('total fees: %s', fromNano(totalFees))
    }
}

export function logCodeSizes(treasuryCode: Cell, walletCode: Cell, loanCode: Cell) {
    if (!muteLogCodeSizes) {
        const t = treasuryCode.toBoc().length
        const w = walletCode.toBoc().length
        const l = loanCode.toBoc().length
        console.info('treasury code size: %d\nwallet code size:   %d\nloan code size:     %d', t, w, l)
    }
}

export function logComputeGas(opLabel: string, opCode: number, tx: BlockchainTransaction) {
    if (!bodyOp(opCode)(tx.inMessage?.body ?? Cell.EMPTY)) {
        throw new Error('invalida transaction to log compute gas for op ' + opLabel)
    }
    const logs = tx.blockchainLogs
    const usedIndex = logs.indexOf('used=')
    const commaIndex = logs.indexOf(',', usedIndex)
    const usedGas = logs.substring(usedIndex + 5, commaIndex)
    const roundedGas = Math.ceil((parseInt(usedGas, 10) / 1000) * 1.2) * 1000
    if (logs.lastIndexOf('used=') !== usedIndex) {
        throw new Error('unexpected second "used" field in calculating gas')
    }
    if (!muteLogComputeGas) {
        console.info('compute gas for   gas::%s:   used: %s   rounded up: %s', opLabel, usedGas, roundedGas)
    }
}
