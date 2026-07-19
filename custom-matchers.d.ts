export {}

declare global {
    namespace jest {
        interface AsymmetricMatchers {
            toBeBetween(a: bigint | string, b: bigint | string): void
            toBeGramValue(v: bigint | string): void
        }
        interface Matchers<R> {
            toBeBetween(a: bigint | string, b: bigint | string): R
            toBeGramValue(v: bigint | string): R
        }
    }
}
