import { Address, Dictionary } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { ParticipationState, Request, Treasury } from '../wrappers/Treasury'
import { Parent } from '../wrappers/Parent'
import { makePalette, Palette } from '../wrappers/colors'

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
    const proposedGovernorText = (proposedGovernorAddress ?? '') + ' ' + proposedGovernorAcceptAfter
    const roundsImbalancePercent = formatPercent((Number(treasuryState.roundsImbalance) + 1 + 256) / 512)
    const governanceFeePercent = formatPercent(Number(treasuryState.governanceFee) / 65535)

    console.info()
    console.info(c.bold('Treasury State'))
    console.info(c.grey('=============='))
    console.info('              %s %s GRAM', c.grey('total_coins:'), formatNano(treasuryState.totalCoins))
    console.info(
        '             %s %s hGRAM   %s %s',
        c.grey('total_tokens:'),
        formatNano(treasuryState.totalTokens),
        c.grey('Rate:'),
        c.green(formatExchangeRate(exchangeRate)),
    )
    console.info('            %s %s GRAM', c.grey('total_staking:'), formatNano(treasuryState.totalStaking))
    console.info('          %s %s hGRAM', c.grey('total_unstaking:'), formatNano(treasuryState.totalUnstaking))
    console.info('    %s %s GRAM', c.grey('total_borrowers_stake:'), formatNano(treasuryState.totalBorrowersStake))
    console.info('                  %s %s', c.grey('deficit:'), formatDeficit(deficit, c))
    console.info(
        '         %s %s (%s)',
        c.grey('rounds_imbalance:'),
        Number(treasuryState.roundsImbalance),
        roundsImbalancePercent,
    )
    console.info('                  %s %s', c.grey('stopped:'), formatBoolean(treasuryState.stopped, c, false))
    console.info('             %s %s', c.grey('instant_mint:'), formatBoolean(treasuryState.instantMint, c, true))
    console.info(
        '            %s %s GRAM',
        c.grey('previous_rate:'),
        formatExchangeRate(Number(treasuryState.previousRate) / 1_000_000_000),
    )
    console.info(
        '             %s %s GRAM   %s %s',
        c.grey('current_rate:'),
        formatExchangeRate(Number(treasuryState.currentRate) / 1_000_000_000),
        c.grey('APY:'),
        c.green(apyPercent),
    )
    console.info('                   %s %s', c.grey('halter:'), c.cyan(treasuryState.halter.toString({ testOnly })))
    console.info('                 %s %s', c.grey('governor:'), c.cyan(treasuryState.governor.toString({ testOnly })))
    console.info(
        '        %s %s',
        c.grey('proposed_governor:'),
        proposedGovernorAddress != null ? c.yellow(proposedGovernorText) : proposedGovernorText,
    )
    console.info(
        '           %s %s (%s)',
        c.grey('governance_fee:'),
        Number(treasuryState.governanceFee),
        governanceFeePercent,
    )
    console.info()

    console.info('    %s', c.bold('Liquidity'))
    console.info('    %s', c.grey('---------'))
    console.info('                  %s %s GRAM', c.grey('balance:'), formatNano(balance))
    console.info(
        '            %s %s GRAM   %s',
        c.grey('available_ton:'),
        formatNano(availableTon),
        c.grey('(balance - 10 storage - borrowers stake)'),
    )
    console.info(
        '      %s %s hGRAM  %s%s%s',
        c.grey('max burnable tokens:'),
        formatNano(maxBurnableTokens),
        c.grey('('),
        formatPercent(liquidityRatio),
        c.grey(' of total_tokens instantly unstakeable)'),
    )
    console.info(
        '                  %s %s GRAM   %s%s%s',
        c.grey('surplus:'),
        formatNano(surplus),
        c.grey('(balance - min_coins, so min_coins = '),
        formatNano(balance - surplus),
        c.grey(' GRAM)'),
    )
    console.info()
    // Worth stating rather than leaving to be rediscovered from a confusing pair of numbers. Mid-round
    // these read near zero and that is correct: the stake is with the elector, not in the treasury.
    // And surplus is not a withdrawable amount — calculate_min_coins subtracts each staked round's
    // total_staked, so while rounds are in flight min_coins goes negative and surplus can exceed the
    // entire balance.
    console.info('    %s', c.grey('Instant unstake is paid from available_ton. While rounds are staked most GRAM sits'))
    console.info(
        '    %s',
        c.grey('with the elector, so a low figure here is normal rather than a shortfall. Surplus is'),
    )
    console.info('    %s', c.grey('a solvency margin, not a withdrawable balance: min_coins goes negative mid-round.'))
    console.info()

    console.info('    %s', c.bold('Current Parent'))
    console.info('    %s', c.grey('--------------'))
    console.info(
        '    %s    %s %s',
        treasuryState.parent != null ? c.cyan(treasuryState.parent.toString({ testOnly })) : treasuryState.parent,
        c.grey('wallet code:'),
        walletCode != null ? c.grey(String(walletCode)) : walletCode,
    )
    console.info()

    console.info('    %s', c.bold('Old Parents'))
    console.info('    %s', c.grey('-----------'))
    if (treasuryState.oldParents.size > 0) {
        for (const key of treasuryState.oldParents.keys()) {
            console.info(
                '    %s',
                c.cyan(Address.parseRaw('0:' + key.toString(16).padStart(64, '0')).toString({ testOnly })),
            )
        }
    } else {
        console.info('    %s', c.grey('(none)'))
    }
    console.info()

    console.info('    %s', c.bold('Collection Codes'))
    console.info('    %s', c.grey('----------------'))
    for (const key of treasuryState.collectionCodes.keys()) {
        console.info('    %s: %s', key.toString().padStart(10), c.grey(String(treasuryState.collectionCodes.get(key))))
    }
    console.info()

    console.info('    %s', c.bold('Bill Codes'))
    console.info('    %s', c.grey('----------'))
    for (const key of treasuryState.billCodes.keys()) {
        console.info('    %s: %s', key.toString().padStart(10), c.grey(String(treasuryState.billCodes.get(key))))
    }
    console.info()

    console.info('    %s', c.bold('Loan Codes'))
    console.info('    %s', c.grey('----------'))
    for (const key of treasuryState.loanCodes.keys()) {
        console.info('    %s: %s', key.toString().padStart(10), c.grey(String(treasuryState.loanCodes.get(key))))
    }
    console.info()

    if (treasuryState.participations.size == 0) {
        console.info(c.grey('No Participations'))
        console.info()
    }

    for (const key of treasuryState.participations.keys()) {
        const participation = treasuryState.participations.get(key)
        if (participation == null) {
            continue
        }
        const collectionAddress = await treasury.getCollectionAddress(key)
        console.info(c.bold(`Participation ${key.toString()}`))
        console.info(c.grey('========================'))
        console.info('            %s %s', c.grey('round_since:'), formatDate(key))
        console.info('                  %s %s', c.grey('state:'), formatState(participation.state, c))
        console.info('                   %s %s', c.grey('size:'), participation.size?.toString())
        console.info('                 %s %s', c.grey('sorted:'), participation.sorted?.size ?? '')
        console.info('               %s %s', c.grey('requests:'), participation.requests?.size ?? '')
        console.info('               %s %s', c.grey('rejected:'), participation.rejected?.size ?? '')
        console.info('               %s %s', c.grey('accepted:'), participation.accepted?.size ?? '')
        console.info('                %s %s', c.grey('accrued:'), participation.accrued?.size ?? '')
        console.info('                 %s %s', c.grey('staked:'), participation.staked?.size ?? '')
        console.info('             %s %s', c.grey('recovering:'), participation.recovering?.size ?? '')
        console.info('           %s %s GRAM', c.grey('total_staked:'), formatNano(participation.totalStaked ?? 0n))
        console.info('        %s %s GRAM', c.grey('total_recovered:'), formatNano(participation.totalRecovered ?? 0n))
        console.info(
            '      %s %s',
            c.grey('current_vset_hash:'),
            participation.currentVsetHash != null
                ? c.grey(participation.currentVsetHash.toString(16))
                : participation.currentVsetHash,
        )
        console.info('         %s %s', c.grey('stake_held_for:'), formatTime(participation.stakeHeldFor ?? 0n))
        console.info('       %s %s', c.grey('stake_held_until:'), formatDate(participation.stakeHeldUntil ?? 0n))
        console.info('     %s %s', c.grey('collection address:'), c.cyan(String(collectionAddress)))
        console.info()

        if (participation.requests != null && participation.requests.size > 0) {
            console.info('    %s', c.bold('Requests'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.requests, testOnly, c)
            console.info()
        }

        if (participation.rejected != null && participation.rejected.size > 0) {
            console.info('    %s', c.bold('Rejected'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.rejected, testOnly, c)
            console.info()
        }

        if (participation.accepted != null && participation.accepted.size > 0) {
            console.info('    %s', c.bold('Accepted'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.accepted, testOnly, c)
            console.info()
        }

        if (participation.accrued != null && participation.accrued.size > 0) {
            console.info('    %s', c.bold('Accrued'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.accrued, testOnly, c)
            console.info()
        }

        if (participation.staked != null && participation.staked.size > 0) {
            console.info('    %s', c.bold('Staked'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.staked, testOnly, c)
            console.info()
        }

        if (participation.recovering != null && participation.recovering.size > 0) {
            console.info('    %s', c.bold('Recovering'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.recovering, testOnly, c)
            console.info()
        }
    }
}

function showRequests(dict: Dictionary<bigint, Request>, testOnly: boolean, c: Palette) {
    if (dict.size > 0) {
        for (const req of dict.keys()) {
            const request = dict.get(req)
            console.info(
                '        min: %s   take: %s   loan: %s   stake: %s   borrower: %s',
                formatNano(request?.minPayment ?? 0n).padEnd(10),
                formatPercent(Number(request?.borrowerRewardShare ?? 0n) / 255).padEnd(4),
                formatNano(request?.loanAmount ?? 0n).padEnd(9),
                formatNano(request?.stakeAmount ?? 0n).padEnd(9),
                c.cyan(Address.parseRaw('0:' + req.toString(16).padStart(64, '0')).toString({ testOnly })),
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
function formatDeficit(value: bigint, c: Palette): string {
    if (value === 0n) {
        return '0 GRAM'
    }
    return c.redBold(formatNano(value) + ' GRAM  <-- UNRECOVERED LOAN LOSS, the treasury owes more than it holds')
}

function formatBoolean(value: boolean, c: Palette, goodIsTrue: boolean): string {
    const text = value ? 'Yes' : 'No'
    const good = value === goodIsTrue
    if (good) {
        return c.green(text)
    }
    return goodIsTrue ? c.yellow(text) : c.redBold(text)
}

function formatState(state: ParticipationState | undefined, c: Palette): string {
    if (state == null) {
        return c.red('undefined')
    }
    switch (state) {
        case ParticipationState.Open:
            return c.green('open')
        case ParticipationState.Distributing:
            return c.cyan('distributing')
        case ParticipationState.Staked:
            return c.yellow('staked')
        case ParticipationState.Validating:
            return c.yellow('validating')
        case ParticipationState.Held:
            return c.yellow('held')
        case ParticipationState.Recovering:
            return c.cyan('recovering')
        case ParticipationState.ReadyToBurn:
            return c.grey('ready_to_burn')
        case ParticipationState.Burning:
            return c.grey('burning')
    }
    return c.red('unknown')
}
