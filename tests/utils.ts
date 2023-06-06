import { expect } from '@jest/globals'
import type { MatcherFunction } from 'expect'
import { tonValue } from "../wrappers/Root"
import { toNano } from 'ton-core'

export function between(a: bigint | string, b: bigint | string): (x?: bigint) => boolean {
    let u = tonValue(a)
    let v = tonValue(b)
    if (u > v) {
        const t = u
        u = v
        v = t
    }
    return (x?: bigint) => {
        return x != null && u <= x && x <= v
    }
}

const toBeBetween: MatcherFunction<[a: unknown, b: unknown]> =
    function (actual, a, b) {
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
                        `[${a}, ${b}]`
                    )}`,
                pass: true,
            }
        } else {
            return {
                message: () =>
                    `expected ${this.utils.printReceived(actual)} to be between ${this.utils.printExpected(
                        `[${a}, ${b}]`
                    )}`,
                pass: false,
            }
        }
    }

const toBeTonValue: MatcherFunction<[v: unknown]> =
    function (actual, v) {
        if (
            (typeof v !== 'bigint' && typeof v !== 'string') ||
            typeof actual !== 'bigint'
        ) {
            throw new Error('invalid type')
        }

        if (typeof v === 'string') {
            v = toNano(v)
        }
        const pass = actual === v
        if (pass) {
            return {
                message: () =>
                    `expected ${this.utils.printReceived(actual)} not to be ${this.utils.printExpected(v)} TON`,
                pass: true,
            }
        } else {
            return {
                message: () =>
                    `expected ${this.utils.printReceived(actual)} to be ${this.utils.printExpected(v)} TON`,
                pass: false,
            }
        }
    }

expect.extend({
    toBeBetween,
    toBeTonValue,
})

declare module 'expect' {
    interface AsymmetricMatchers {
        toBeBetween(a: bigint | string, b: bigint | string): void
        toBeTonValue(v: bigint | string): void
    }
    interface Matchers<R> {
        toBeBetween(a: bigint | string, b: bigint | string): R
        toBeTonValue(v: bigint | string): R
    }
}
