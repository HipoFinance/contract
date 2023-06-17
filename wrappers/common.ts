import { toNano } from "ton-core"

export const op = {
    sendTokens: 0x0f8a7ea5,
    receiveTokens: 0x178d4519,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    unstakeTokens: 0x595f07bc,
    unstakeReserve: 0x7bdd97de,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,
    stakeTon: 0x4525e9b2,
    releaseTon: 0x661d636b,
    withdrawTon: 0x2fbfa63e,
    withdrawFailed: 0x57fb08ea,
    releaseFailed: 0x4c4fc2e7,
    withdrawalNotification: 0x2ec2a5a0,
    topUp: 0x34e5d45a,
}

export function tonValue(value: bigint | string): bigint {
    if (typeof value === 'string') {
        value = toNano(value)
    }
    return value
}
