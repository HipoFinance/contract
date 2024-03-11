import { toNano } from '@ton/core'

export const err = {
    insufficientFee: 101,
    insufficientFunds: 102,
    accessDenied: 103,
    onlyBasechainAllowed: 104,
    receiverIsSender: 105,
    stopped: 106,
    invalidOp: 107,
    invalidComment: 108,
    invalidParameters: 109,

    notAcceptingLoanRequests: 201,
    unableToParticipate: 202,
    tooSoonToParticipate: 203,
    notReadyToFinishParticipation: 204,
    tooSoonToFinishParticipation: 205,
    vsetNotChanged: 206,
    vsetNotChangeable: 207,
    notReadyToBurnAll: 208,

    unexpectedStoragePriceFormat: 301,
    unexpectedGasPriceFormat: 302,
    unexpectedMsgForwardPricesFormat: 303,
    unexpectedValidatorSetFormat: 304,
}

export const op = {
    newStake: 0x4e73744b,
    newStakeError: 0xee6f454c,
    newStakeOk: 0xf374484c,
    recoverStake: 0x47657424,
    recoverStakeError: 0xfffffffe,
    recoverStakeOk: 0xf96f7324,

    ownershipAssigned: 0x05138d91,
    getStaticData: 0x2fcb26a2,
    reportStaticData: 0x8b771735,

    sendTokens: 0x0f8a7ea5,
    receiveTokens: 0x178d4519,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    unstakeTokens: 0x595f07bc,

    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,

    proveOwnership: 0x04ded148,
    ownershipProof: 0x0524c7ae,
    ownershipProofBounced: 0xc18e86d2,
    requestOwner: 0xd0c3bfea,
    ownerInfo: 0x0dd607e3,
    destroy: 0x1f04537a,
    burnBill: 0x6f89f5e3,

    provideCurrentQuote: 0xad83913f,
    takeCurrentQuote: 0x0a420458,

    depositCoins: 0x3d3761a6,
    sendUnstakeAll: 0x45baeda9,
    reserveTokens: 0x386a358b,
    mintTokens: 0x42684479,
    burnTokens: 0x7cffe1ee,
    requestLoan: 0x36335da9,
    participateInElection: 0x574a297b,
    decideLoanRequests: 0x6a31d344,
    processLoanRequests: 0x071d07cc,
    vsetChanged: 0x2f0b5b3b,
    finishParticipation: 0x23274435,
    recoverStakes: 0x4f173d3e,
    recoverStakeResult: 0x0fca4c86,
    lastBillBurned: 0xc6d8b51f,
    proposeGovernor: 0x76ff2956,
    acceptGovernance: 0x06e237e3,
    setHalter: 0x16bb5b17,
    setStopped: 0x0e5e9773,
    setInstantMint: 0x535b09d2,
    setGovernanceFee: 0x470fe5f6,
    setRoundsImbalance: 0x1b4463b6,
    sendMessageToLoan: 0x0e93f65b,
    retryDistribute: 0x6ec00c48,
    retryRecoverStakes: 0x2b7ad9e8,
    retryMintBill: 0x654de488,
    retryBurnAll: 0x106b8001,
    setParent: 0x4f6f6eed,
    proxySetContent: 0x2b1c8e37,
    withdrawSurplus: 0x23355ffb,
    proxyWithdrawSurplus: 0x77a0bf77,
    upgradeCode: 0x3d6a29b5,
    proxyUpgradeCode: 0x78570010,
    sendUpgradeWallet: 0x7ade1ed8,
    migrateWallet: 0x325aacfa,
    proxyAddLibrary: 0x31cb87f7,
    proxyRemoveLibrary: 0x747bf3a2,
    giftCoins: 0x3496db80,
    topUp: 0x5372158c,

    proxyTokensMinted: 0x5be57626,
    proxySaveCoins: 0x47daa10f,
    proxyReserveTokens: 0x688b0213,
    proxyRollbackUnstake: 0x32b67194,
    proxyTokensBurned: 0x4476fde0,
    proxyUnstakeAll: 0x76bd2760,
    proxyUpgradeWallet: 0x4664bc68,
    proxyMigrateWallet: 0x0cb246bb,
    proxyMergeWallet: 0x6833d7d0,
    setContent: 0x04dc78b7,

    tokensMinted: 0x5445efee,
    saveCoins: 0x4cce0e74,
    rollbackUnstake: 0x1b77fd1a,
    tokensBurned: 0x5b512e25,
    unstakeAll: 0x5ae30148,
    upgradeWallet: 0x01d9ae1c,
    mergeWallet: 0x63d3a76c,
    withdrawJettons: 0x768a50b2,

    mintBill: 0x4b2d7871,
    billBurned: 0x840f6369,
    burnAll: 0x639d400a,

    assignBill: 0x3275dfc2,

    proxyNewStake: 0x089cd4d0,
    proxyRecoverStake: 0x407cb243,

    requestRejected: 0xcd0f2116,
    loanResult: 0xfaaa8366,
    takeProfit: 0x8b556813,

    stakeNotification: 0xd401b82b,
    withdrawalNotification: 0xf0fa223b,

    addLibrary: 0x53d0473e,
    removeLibrary: 0x6bd0ce52,
}

export const config = {
    election: 15n,
    validators: 16n,
    currentValidators: 34n,
}

export function tonValue(value: bigint | string): bigint {
    if (typeof value === 'string') {
        value = toNano(value)
    }
    return value
}
