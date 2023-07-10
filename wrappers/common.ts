import { toNano } from "ton-core"

export const op = {
    sendTokens: 0x0f8a7ea5,
    receiveTokens: 0x178d4519,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    unstakeTokens: 0x595f07bc,
    reserveTokens: 0x7bdd97de,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,
    depositCoins: 0x00000020,
    saveCoins: 0x00000021,
    stakeCoins: 0x00000022,
    mintTokens: 0x00000023,
    withdrawTokens: 0x00000024,
    burnTokens: 0x00000025,
    burnFailed: 0x57fb08ea,
    withdrawFailed: 0x4c4fc2e7,
    withdrawalNotification: 0x2ec2a5a0,
    requestLoan: 0x00000030,
    participateInElection: 0x00000031,
    processLoanRequests: 0x00000032,
    sendNewStake: 0x00000033,
    newStakeRejected: 0x00000034,
    vsetChanged: 0x00000035,
    finishParticipation: 0x00000036,
    recoverStakes: 0x00000037,
    sendRecoverStake: 0x00000038,
    recoverStakeResult: 0x00000039,
    topUp: 0x34e5d45a,
}

export function tonValue(value: bigint | string): bigint {
    if (typeof value === 'string') {
        value = toNano(value)
    }
    return value
}
