import { toNano } from "ton-core"

export const op = {
    newStake: 0x4e73744b,
    newStakeError: 0xee6f454c,
    newStakeOk: 0xf374484c,
    recoverStake: 0x47657424,
    recoverStakeError: 0xfffffffe,
    recoverStakeOk: 0xf96f7324,

    sendTokens: 0x0f8a7ea5,
    receiveTokens: 0x178d4519,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    unstakeTokens: 0x595f07bc,
    reserveTokens: 0x7bdd97de,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,

    depositCoins: 0x1375a585,
    saveCoins: 0x7f30ee55,
    stakeCoins: 0x4cae3ab1,
    stakeFirstCoins: 0x70c09713,
    mintTokens: 0x4559ca57,
    unstakeAllTokens: 0x2dda9652,
    withdrawTokens: 0x469bd91e,
    burnTokens: 0x002c6e13,
    burnFailed: 0x272e3dda,
    withdrawFailed: 0xc6caea4d,
    withdrawalNotification: 0x2ec2a5a0,

    requestLoan: 0x12b808d3,
    participateInElection: 0x574a297b,
    processLoanRequests: 0x071d07cc,
    requestRejected: 0x4d0f2116,
    sendNewStake: 0x77a897f2,
    newStakeRejected: 0x2bf7a8d5,
    vsetChanged: 0x2f0b5b3b,
    finishParticipation: 0x23274435,
    recoverStakes: 0x4f173d3e,
    sendRecoverStake: 0x05eec9a2,
    recoverStakeResult: 0x48310d2a,
    loanResult: 0x7aaa8366,
    takeProfit: 0x0b556813,

    proposeGovernor: 0x76ff2956,
    acceptGovernance: 0x06e237e3,
    setHalter: 0x16bb5b17,
    setStopped: 0x700d5e50,
    setDriver: 0x7e7da841,
    setContent: 0x471dad93,
    setRewardShare: 0x51df41a6,
    setBalancedRounds: 0x230e906a,
    sendMessageToLoan: 0x2b93b447,
    sendProcessLoanRequests: 0x06cbff48,
    upgradeCode: 0x282600ff,

    withdrawSurplus: 0x302b2fea,
    topUp: 0x5372158c,
}

export const config = {
    currentValidators: 34n
}

export function tonValue(value: bigint | string): bigint {
    if (typeof value === 'string') {
        value = toNano(value)
    }
    return value
}
