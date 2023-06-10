import { toNano } from "ton-core"

export const op = {
    sendTokens: 0x0f8a7ea5,
    receiveTokens: 0x178d4519,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,
    stakeTon: 0x696aace0,
    unstakeTokens: 0x595f07bc,
    unstakeReserve: 0x73d523e4,
    releaseNotification: 0x2e0aea83,
    topUp: 0x34e5d45a,
    consolidate: 13,
}

export function tonValue(value: bigint | string): bigint {
    if (typeof value === 'string') {
        value = toNano(value)
    }
    return value
}
