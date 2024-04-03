import { Address, Dictionary } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { ParticipationState, Request, Treasury } from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const treasuryState = await treasury.getTreasuryState()
    let walletCode = null
    if (treasuryState.parent != null) {
        const parent = provider.open(Parent.createFromAddress(treasuryState.parent))
        walletCode = (await parent.getJettonData())[4]
    }

    const times = await treasury.getTimes()
    const duration = 2 * Number(times.nextRoundSince - times.currentRoundSince)
    const year = 365 * 24 * 60 * 60
    const compoundingFrequency = year / duration
    const apy =
        Math.pow(Number(treasuryState.lastRecovered) / Number(treasuryState.lastStaked) || 1, compoundingFrequency) - 1
    const apyPercent = formatPercent(apy)

    const testOnly = provider.network() !== 'mainnet'
    const proposedGovernorSlice = treasuryState.proposedGovernor?.beginParse()
    const proposedGovernorAcceptAfter = formatDate(proposedGovernorSlice?.loadUintBig(32) ?? 0n)
    const proposedGovernorAddress = proposedGovernorSlice?.loadAddress().toString({ testOnly })
    const roundsImbalancePercent = formatPercent((Number(treasuryState.roundsImbalance) + 1 + 256) / 512)
    const governanceFeePercent = formatPercent(Number(treasuryState.governanceFee) / 65535)

    console.info()
    console.info('Treasury State')
    console.info('==============')
    console.info('              total_coins: %s TON', formatNano(treasuryState.totalCoins))
    console.info('             total_tokens: %s hTON', formatNano(treasuryState.totalTokens))
    console.info('            total_staking: %s TON', formatNano(treasuryState.totalStaking))
    console.info('          total_unstaking: %s hTON', formatNano(treasuryState.totalUnstaking))
    console.info('    total_borrowers_stake: %s TON', formatNano(treasuryState.totalBorrowersStake))
    console.info('         rounds_imbalance: %s (%s)', Number(treasuryState.roundsImbalance), roundsImbalancePercent)
    console.info('                  stopped: %s', formatBoolean(treasuryState.stopped))
    console.info('             instant_mint: %s', formatBoolean(treasuryState.instantMint))
    console.info('              last_staked: %s TON', formatNano(treasuryState.lastStaked))
    console.info('           last_recovered: %s TON   APY: %s', formatNano(treasuryState.lastRecovered), apyPercent)
    console.info('                   halter: %s', treasuryState.halter.toString({ testOnly }))
    console.info('                 governor: %s', treasuryState.governor.toString({ testOnly }))
    console.info('        proposed_governor: %s', (proposedGovernorAddress ?? '') + ' ' + proposedGovernorAcceptAfter)
    console.info('           governance_fee: %s (%s)', Number(treasuryState.governanceFee), governanceFeePercent)
    console.info()

    console.info('    Current Parent')
    console.info('    --------------')
    console.info('    %s    wallet code: %s', treasuryState.parent?.toString({ testOnly }), walletCode)
    console.info()

    console.info('    Old Parents')
    console.info('    -----------')
    if (treasuryState.oldParents.size > 0) {
        for (const key of treasuryState.oldParents.keys()) {
            console.info('    %s', Address.parseRaw('0:' + key.toString(16)).toString({ testOnly }))
        }
    }
    console.info()

    console.info('    Collection Codes')
    console.info('    ----------------')
    for (const key of treasuryState.collectionCodes.keys()) {
        console.info('    %s: %s', key.toString().padStart(10), treasuryState.collectionCodes.get(key))
    }
    console.info()

    console.info('    Bill Codes')
    console.info('    ----------')
    for (const key of treasuryState.billCodes.keys()) {
        console.info('    %s: %s', key.toString().padStart(10), treasuryState.billCodes.get(key))
    }
    console.info()

    console.info('    Loan Codes')
    console.info('    ----------')
    for (const key of treasuryState.loanCodes.keys()) {
        console.info('    %s: %s', key.toString().padStart(10), treasuryState.loanCodes.get(key))
    }
    console.info()

    if (treasuryState.participations.size == 0) {
        console.info('No Participations')
        console.info()
    }

    for (const key of treasuryState.participations.keys()) {
        const participation = treasuryState.participations.get(key)
        if (participation == null) {
            continue
        }
        const collectionAddress = await treasury.getCollectionAddress(key)
        console.info('Participation %s', key.toString())
        console.info('========================')
        console.info('            round_since: %s', formatDate(key))
        console.info('                  state: %s', formatState(participation.state))
        console.info('                   size: %s', participation.size?.toString())
        console.info('                 sorted: %s', participation.sorted?.size ?? '')
        console.info('               requests: %s', participation.requests?.size ?? '')
        console.info('               rejected: %s', participation.rejected?.size ?? '')
        console.info('               accepted: %s', participation.accepted?.size ?? '')
        console.info('                accrued: %s', participation.accrued?.size ?? '')
        console.info('                 staked: %s', participation.staked?.size ?? '')
        console.info('             recovering: %s', participation.recovering?.size ?? '')
        console.info('           total_staked: %s TON', formatNano(participation.totalStaked ?? 0n))
        console.info('        total_recovered: %s TON', formatNano(participation.totalRecovered ?? 0n))
        console.info('      current_vset_hash: %s', participation.currentVsetHash?.toString(16))
        console.info('         stake_held_for: %s', formatTime(participation.stakeHeldFor ?? 0n))
        console.info('       stake_held_until: %s', formatDate(participation.stakeHeldUntil ?? 0n))
        console.info('     collection address: %s', collectionAddress)
        console.info()

        if (participation.requests != null && participation.requests.size > 0) {
            console.info('    Requests')
            console.info('    --------')
            showRequests(participation.requests, testOnly)
            console.info()
        }

        if (participation.rejected != null && participation.rejected.size > 0) {
            console.info('    Rejected')
            console.info('    --------')
            showRequests(participation.rejected, testOnly)
            console.info()
        }

        if (participation.accepted != null && participation.accepted.size > 0) {
            console.info('    Accepted')
            console.info('    --------')
            showRequests(participation.accepted, testOnly)
            console.info()
        }

        if (participation.accrued != null && participation.accrued.size > 0) {
            console.info('    Accrued')
            console.info('    --------')
            showRequests(participation.accrued, testOnly)
            console.info()
        }

        if (participation.staked != null && participation.staked.size > 0) {
            console.info('    Staked')
            console.info('    --------')
            showRequests(participation.staked, testOnly)
            console.info()
        }

        if (participation.recovering != null && participation.recovering.size > 0) {
            console.info('    Recovering')
            console.info('    --------')
            showRequests(participation.recovering, testOnly)
            console.info()
        }
    }
}

function showRequests(dict: Dictionary<bigint, Request>, testOnly: boolean) {
    if (dict.size > 0) {
        for (const req of dict.keys()) {
            const request = dict.get(req)
            console.info(
                '        min: %s   take: %s   loan: %s   stake: %s   borrower: %s',
                formatNano(request?.minPayment ?? 0n).padEnd(10),
                formatPercent(Number(request?.borrowerRewardShare ?? 0n) / 255).padEnd(4),
                formatNano(request?.loanAmount ?? 0n).padEnd(9),
                formatNano(request?.stakeAmount ?? 0n).padEnd(9),
                Address.parseRaw('0:' + req.toString(16)).toString({ testOnly }),
            )
        }
    }
}

function formatNano(value: bigint): string {
    return (Number(value) / 1000000000).toLocaleString(undefined, { maximumFractionDigits: 9 })
}

function formatPercent(amount: number): string {
    return amount.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 2 })
}

function formatDate(seconds: bigint): string {
    if (seconds === 0n) {
        return ''
    }
    return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
        dateStyle: 'full',
        timeStyle: 'full',
    })
}

function formatTime(seconds: bigint): string {
    return new Date(Number(seconds) * 1000).toISOString().substring(11, 16)
}

function formatBoolean(value: boolean): string {
    return value ? 'Yes' : 'No'
}

function formatState(state: ParticipationState | undefined): string {
    if (state == null) {
        return 'undefined'
    }
    switch (state) {
        case ParticipationState.Open:
            return 'open'
        case ParticipationState.Distributing:
            return 'distributing'
        case ParticipationState.Staked:
            return 'staked'
        case ParticipationState.Validating:
            return 'validating'
        case ParticipationState.Held:
            return 'held'
        case ParticipationState.Recovering:
            return 'recovering'
        case ParticipationState.Burning:
            return 'burning'
    }
    return 'unknown'
}
