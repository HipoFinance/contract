import { Address, Dictionary } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { ParticipationState, Request, Treasury } from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { makePalette } from '../wrappers/colors'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const c = makePalette()

    const defaultTreasuryAddress =
        provider.network() === 'mainnet' ? 'EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ' : ''
    const prompt = defaultTreasuryAddress
        ? `Enter the friendly address of the treasury (default: ${defaultTreasuryAddress})`
        : 'Enter the friendly address of the treasury'
    const addressString = (await ui.input(prompt)) || defaultTreasuryAddress
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const treasuryState = await treasury.getTreasuryState()
    const balance = await treasury.getBalance()
    const maxBurnableTokens = await treasury.getMaxBurnableTokens()
    const surplus = await treasury.getSurplus()
    const deficit = await treasury.getDeficit()

    // What reserve_tokens and burn_tokens actually spend from, mirrored here so the number on screen is
    // the one the contract uses. It deliberately does not subtract total_staking: that would hide
    // instant unstakes the treasury would in fact pay. fee::treasury_storage is 10 GRAM.
    const treasuryStorageFee = 10_000_000_000n
    const availableTon = balance - treasuryStorageFee - treasuryState.totalBorrowersStake

    // Share of all outstanding hGRAM that could leave right now.
    const liquidityRatio =
        treasuryState.totalTokens > 0n ? Number(maxBurnableTokens) / Number(treasuryState.totalTokens) : 0

    let walletCode = null
    if (treasuryState.parent != null) {
        const parent = provider.open(Parent.createFromAddress(treasuryState.parent))
        walletCode = (await parent.getJettonData())[4]
    }

    const exchangeRate = Number(treasuryState.totalCoins) / Number(treasuryState.totalTokens)

    const times = await treasury.getTimes()
    // Rates update once per round length while validating on both round chains.
    const duration = Number(times.nextRoundSince - times.currentRoundSince)
    const year = 365 * 24 * 60 * 60
    const compoundingFrequency = year / duration
    const growth = Number(treasuryState.currentRate) / Number(treasuryState.previousRate)
    const apy = Math.pow(growth, compoundingFrequency) - 1
    const apyPercent = treasuryState.previousRate > 0n ? formatPercent(apy) : ''

    const testOnly = provider.network() !== 'mainnet'
    const proposedGovernorSlice = treasuryState.proposedGovernor?.beginParse()
    const proposedGovernorAcceptAfter = formatDate(proposedGovernorSlice?.loadUintBig(32) ?? 0n)
    const proposedGovernorAddress = proposedGovernorSlice?.loadAddress().toString({ testOnly })
    const roundsImbalancePercent = formatPercent((Number(treasuryState.roundsImbalance) + 1 + 256) / 512)
    const governanceFeePercent = formatPercent(Number(treasuryState.governanceFee) / 65535)

    console.info()
    console.info('Treasury State')
    console.info('==============')
    console.info('              total_coins: %s GRAM', formatNano(treasuryState.totalCoins))
    console.info(
        '             total_tokens: %s hGRAM   Rate: %s',
        formatNano(treasuryState.totalTokens),
        formatExchangeRate(exchangeRate),
    )
    console.info('            total_staking: %s GRAM', formatNano(treasuryState.totalStaking))
    console.info('          total_unstaking: %s hGRAM', formatNano(treasuryState.totalUnstaking))
    console.info('    total_borrowers_stake: %s GRAM', formatNano(treasuryState.totalBorrowersStake))
    console.info('                  deficit: %s', formatDeficit(deficit, c))
    console.info('         rounds_imbalance: %s (%s)', Number(treasuryState.roundsImbalance), roundsImbalancePercent)
    console.info('                  stopped: %s', formatBoolean(treasuryState.stopped))
    console.info('             instant_mint: %s', formatBoolean(treasuryState.instantMint))
    console.info(
        '            previous_rate: %s GRAM',
        formatExchangeRate(Number(treasuryState.previousRate) / 1_000_000_000),
    )
    console.info(
        '             current_rate: %s GRAM   APY: %s',
        formatExchangeRate(Number(treasuryState.currentRate) / 1_000_000_000),
        apyPercent,
    )
    console.info('                   halter: %s', treasuryState.halter.toString({ testOnly }))
    console.info('                 governor: %s', treasuryState.governor.toString({ testOnly }))
    console.info('        proposed_governor: %s', (proposedGovernorAddress ?? '') + ' ' + proposedGovernorAcceptAfter)
    console.info('           governance_fee: %s (%s)', Number(treasuryState.governanceFee), governanceFeePercent)
    console.info()

    console.info('    Liquidity')
    console.info('    ---------')
    console.info('                  balance: %s GRAM', formatNano(balance))
    console.info(
        '            available_ton: %s GRAM   (balance - 10 storage - borrowers stake)',
        formatNano(availableTon),
    )
    console.info(
        '      max burnable tokens: %s hGRAM  (%s of total_tokens instantly unstakeable)',
        formatNano(maxBurnableTokens),
        formatPercent(liquidityRatio),
    )
    console.info(
        '                  surplus: %s GRAM   (balance - min_coins, so min_coins = %s GRAM)',
        formatNano(surplus),
        formatNano(balance - surplus),
    )
    console.info()
    // Worth stating rather than leaving to be rediscovered from a confusing pair of numbers. Mid-round
    // these read near zero and that is correct: the stake is with the elector, not in the treasury.
    // And surplus is not a withdrawable amount — calculate_min_coins subtracts each staked round's
    // total_staked, so while rounds are in flight min_coins goes negative and surplus can exceed the
    // entire balance.
    console.info('    Instant unstake is paid from available_ton. While rounds are staked most GRAM sits')
    console.info('    with the elector, so a low figure here is normal rather than a shortfall. Surplus is')
    console.info('    a solvency margin, not a withdrawable balance: min_coins goes negative mid-round.')
    console.info()

    console.info('    Current Parent')
    console.info('    --------------')
    console.info('    %s    wallet code: %s', treasuryState.parent?.toString({ testOnly }), walletCode)
    console.info()

    console.info('    Old Parents')
    console.info('    -----------')
    if (treasuryState.oldParents.size > 0) {
        for (const key of treasuryState.oldParents.keys()) {
            console.info('    %s', Address.parseRaw('0:' + key.toString(16).padStart(64, '0')).toString({ testOnly }))
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
        console.info('           total_staked: %s GRAM', formatNano(participation.totalStaked ?? 0n))
        console.info('        total_recovered: %s GRAM', formatNano(participation.totalRecovered ?? 0n))
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
                Address.parseRaw('0:' + req.toString(16).padStart(64, '0')).toString({ testOnly }),
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

function formatExchangeRate(rate: number): string {
    return rate.toLocaleString(undefined, { maximumFractionDigits: 5 })
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

// A deficit is a loan loss the borrower's collateral could not cover, so any non-zero value is an
// incident rather than a statistic. It reads as plain "0 GRAM" the rest of the time.
function formatDeficit(value: bigint, c: ReturnType<typeof makePalette>): string {
    if (value === 0n) {
        return '0 GRAM'
    }
    return c.redBold(formatNano(value) + ' GRAM  <-- UNRECOVERED LOAN LOSS, the treasury owes more than it holds')
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
        case ParticipationState.ReadyToBurn:
            return 'ready_to_burn'
        case ParticipationState.Burning:
            return 'burning'
    }
    return 'unknown'
}
