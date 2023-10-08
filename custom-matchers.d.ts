export {}

declare global {
    namespace jest {
        interface AsymmetricMatchers {
            toBeBetween(a: bigint | string, b: bigint | string): void
            toBeTonValue(v: bigint | string): void
        }
        interface Matchers<R> {
            toBeBetween(a: bigint | string, b: bigint | string): R
            toBeTonValue(v: bigint | string): R
        }
    }
}
