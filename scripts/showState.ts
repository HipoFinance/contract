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

    // What reserve_tokens and burn_tokens actually spend from, mirrored here so the number on screen is
    // the one the contract uses. It deliberately does not subtract total_staking: that would hide
    // instant unstakes the treasury would in fact pay. fee::treasury_storage is 10 GRAM.
    const treasuryStorageFee = 10_000_000_000n
    // Clamped, exactly as get_max_burnable_tokens is: total_request_fees still counts a fee whose
    // proxy_new_stake half has already been sent, so mid-round this can go below zero.
    const requestFees = treasuryState.totalRequestFees > 0n ? treasuryState.totalRequestFees : 0n
    const rawAvailable = balance - treasuryStorageFee - treasuryState.totalBorrowersStake - requestFees
    const availableTon = rawAvailable > 0n ? rawAvailable : 0n

    // Share of all outstanding hGRAM that could leave right now.
    const liquidityRatio =
        treasuryState.totalTokens > 0n ? Number(maxBurnableTokens) / Number(treasuryState.totalTokens) : 0

    let walletCode = null
    if (treasuryState.parent != null) {
        const parent = provider.open(Parent.createFromAddress(treasuryState.parent))
        walletCode = (await parent.getJettonData())[4]
    }

    const exchangeRate = Number(treasuryState.totalCoins) / Number(treasuryState.totalTokens)

    // Consumers should call computeApy() from @hipo-finance/sdk rather than copy this. This script
    // deliberately does not: the SDK is derived FROM this repository -- it follows whatever shape
    // get_treasury_state grows into -- so depending on it here would point the dependency backwards
    // and make the contract's own tooling lag its downstream. It also reads this repo's
    // TreasuryConfig, not the SDK's. If the two ever disagree, this one is right by construction.
    //
    // The interval the rate pair actually grew over, which is not the same as a round length: the
    // window spans two barrier releases, so in steady state it is about two rounds, and it widens
    // further across rounds where nothing was lent. Dividing by a nominal round length instead would
    // report an unchanged APY for a pool whose true rate of growth had halved -- and would now be
    // out by a factor of two on top of that.
    const duration = Number(treasuryState.windowDuration)
    const apyPercent = apyOver(treasuryState.previousRate, treasuryState.currentRate, duration)
    // The last release alone: mid_rate at mid_round to current_rate at last_settled_round. Noisier than
    // the window, since one round chain can lend more than the other, which is why the published figure
    // is the window's.
    const lastRoundApyPercent = apyOver(
        treasuryState.midRate,
        treasuryState.currentRate,
        Number(treasuryState.lastSettledRound - treasuryState.midRound),
    )

    const testOnly = provider.network() !== 'mainnet'
    const proposedGovernorSlice = treasuryState.proposedGovernor?.beginParse()
    const proposedGovernorAcceptAfter = formatDate(proposedGovernorSlice?.loadUintBig(32) ?? 0n)
    const proposedGovernorAddress = proposedGovernorSlice?.loadAddress().toString({ testOnly })
    const proposedGovernorText = (proposedGovernorAddress ?? '') + ' ' + proposedGovernorAcceptAfter
    const roundsImbalancePercent = formatPercent((Number(treasuryState.roundsImbalance) + 1 + 256) / 512)
    const governanceFeePercent = formatPercent(Number(treasuryState.governanceFee) / 65535)
    const borrowerFeePercent = formatPercent(Number(treasuryState.borrowerFee) / 65535)

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
    console.info(
        '       %s %s',
        c.grey('total_request_fees:'),
        treasuryState.totalRequestFees < 0n
            ? c.grey('absent (treasury predates the field)')
            : formatNano(treasuryState.totalRequestFees) + ' GRAM',
    )
    console.info('                  %s %s', c.grey('deficit:'), formatDeficit(treasuryState.deficit, c))
    console.info('                  %s %s', c.grey('stopped:'), formatBoolean(treasuryState.stopped, c, false))
    console.info('             %s %s', c.grey('instant_mint:'), formatBoolean(treasuryState.instantMint, c, true))
    console.info()

    console.info('    %s', c.bold('APY'))
    console.info('    %s', c.grey('---'))
    // The window's three observations, oldest first. mid_rate is the one that makes the published
    // window two releases wide rather than one. Then the published APY, over the whole window, and the
    // last release alone.
    console.info(
        '            %s %s GRAM',
        c.grey('previous_rate:'),
        formatExchangeRate(Number(treasuryState.previousRate) / 1_000_000_000),
    )
    console.info(
        '                 %s %s GRAM',
        c.grey('mid_rate:'),
        formatExchangeRate(Number(treasuryState.midRate) / 1_000_000_000),
    )
    console.info(
        '             %s %s GRAM',
        c.grey('current_rate:'),
        formatExchangeRate(Number(treasuryState.currentRate) / 1_000_000_000),
    )
    console.info(
        '      %s %s   %s',
        c.grey('APY, 2-round window:'),
        c.green(apyPercent),
        c.grey('(previous -> current)'),
    )
    console.info(
        '          %s %s   %s',
        c.grey('APY, last round:'),
        c.green(lastRoundApyPercent),
        c.grey('(mid -> current)'),
    )
    console.info('          %s %s', c.grey('window_duration:'), formatDuration(duration))
    console.info(
        '                %s %s',
        c.grey('mid_round:'),
        treasuryState.midRound > 0n ? formatDate(treasuryState.midRound) : c.grey('never'),
    )
    console.info(
        '             %s %s',
        c.grey('last settled:'),
        treasuryState.lastSettledRound > 0n ? formatDate(treasuryState.lastSettledRound) : c.grey('never'),
    )
    console.info()

    // The auction: everything a borrower needs to price a bid, and the floors a bid must clear. All
    // of it is the protocol's; borrowers bid only min_payment, loan and max_stake.
    const fees = await treasury.getTreasuryFees(0n)
    // -1 when the treasury predates the floors, which no eff is below.
    const minEfficiency = treasuryState.minEfficiency ?? -1n
    console.info('    %s', c.bold('Auction'))
    console.info('    %s', c.grey('-------'))
    // The borrower's contractual share of every loan's reward, and therefore the pool's floor.
    // Borrowers cannot bid it, so this is the number they have to read to price a bid at all --
    // setRewardShare.ts tells the operator to verify it here after changing it.
    console.info(
        '             %s %s %s',
        c.grey('reward_share:'),
        treasuryState.rewardShare < 0n
            ? c.grey('absent (treasury predates the field)')
            : c.yellow(String(treasuryState.rewardShare)),
        treasuryState.rewardShare < 0n
            ? ''
            : c.grey(
                  '(borrower ' +
                      formatPercent(Number(treasuryState.rewardShare) / 65535) +
                      ', pool ' +
                      formatPercent(Number(65535n - treasuryState.rewardShare) / 65535) +
                      ')',
              ),
    )
    // Of each borrower's contractual share of a round's reward, charged on top of the pool's take.
    // Zero disables it, floor included, so it is worth reading as on/off before reading as a rate.
    console.info(
        '             %s %s (%s of borrower reward)%s',
        c.grey('borrower_fee:'),
        treasuryState.borrowerFee === 0n
            ? Number(treasuryState.borrowerFee)
            : c.yellow(String(treasuryState.borrowerFee)),
        borrowerFeePercent,
        treasuryState.borrowerFee === 0n ? c.grey('  disabled') : '',
    )
    console.info(
        '           %s %s (%s)   %s',
        c.grey('governance_fee:'),
        Number(treasuryState.governanceFee),
        governanceFeePercent,
        c.grey("(of the pool's part of each loan's reward, to the governor)"),
    )
    // distribute lends a round at most (rounds_imbalance + 257) / 512 of the lendable GRAM plus what the
    // previous round staked, so with two round chains alternating, this is how far one may run ahead.
    console.info(
        '         %s %s (%s)   %s',
        c.grey('rounds_imbalance:'),
        Number(treasuryState.roundsImbalance),
        roundsImbalancePercent,
        c.grey('(the most one round may lend, of what both round chains hold)'),
    )
    // The auction floors (set_auction_floors); the two stakes are stored in whole GRAM. Each row of
    // the requests below shows its eff, the number min_efficiency is compared with.
    const floor = (v: bigint | undefined, text: string) =>
        v == null || v < 0n ? c.grey('absent (treasury predates the floors)') : v > 0n ? c.yellow(text) : c.grey('off')
    console.info(
        '           %s %s   %s',
        c.grey('min_efficiency:'),
        floor(treasuryState.minEfficiency, String(treasuryState.minEfficiency)),
        c.grey('(a bid whose eff is below this is refused)'),
    )
    console.info(
        '        %s %s   %s',
        c.grey('min_request_stake:'),
        floor(treasuryState.minRequestStake, (treasuryState.minRequestStake ?? 0n).toLocaleString() + ' GRAM'),
        c.grey('(loan + collateral below this is refused)'),
    )
    console.info(
        '          %s %s   %s',
        c.grey('stake_cap_floor:'),
        floor(treasuryState.stakeCapFloor, (treasuryState.stakeCapFloor ?? 0n).toLocaleString() + ' GRAM'),
        c.grey('(a non-zero max_stake below this is raised to it)'),
    )
    console.info(
        '         %s %s GRAM   %s',
        c.grey('request_loan_fee:'),
        formatNano(fees.requestLoanFee),
        c.grey('(on top of the collateral, per request sent)'),
    )
    console.info()

    console.info('    %s', c.bold('Liquidity'))
    console.info('    %s', c.grey('---------'))
    console.info('                  %s %s GRAM', c.grey('balance:'), formatNano(balance))
    console.info(
        '            %s %s GRAM   %s',
        c.grey('available_ton:'),
        formatNano(availableTon),
        c.grey('(balance - 10 storage - borrowers stake - request fees)'),
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

    console.info('    %s', c.bold('Governor'))
    console.info('    %s', c.grey('--------'))
    console.info('                   %s %s', c.grey('halter:'), c.cyan(treasuryState.halter.toString({ testOnly })))
    console.info('                 %s %s', c.grey('governor:'), c.cyan(treasuryState.governor.toString({ testOnly })))
    console.info(
        '        %s %s',
        c.grey('proposed_governor:'),
        proposedGovernorAddress != null ? c.yellow(proposedGovernorText) : proposedGovernorText,
    )
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
        console.info(c.bold(`Participation ${key.toString()}`))
        console.info(c.grey('========================'))
        console.info('            %s %s', c.grey('round_since:'), formatDate(key))
        console.info('                  %s %s', c.grey('state:'), formatState(participation.state, c))
        // An open round shows its book, sorted and requests, which the decision empties. Every other round
        // shows its loans instead, which an open round does not have yet.
        const open = participation.state === ParticipationState.Open
        if (open) {
            // sorted is keyed by rank, and each key holds a bucket of every request tied at it, so its own
            // size counts ranks. Both are shown, so a tie reads as one rather than as a missing request.
            const ranks = participation.sorted?.size ?? 0
            let ranked = 0
            for (const bucket of participation.sorted?.values() ?? []) {
                ranked += bucket.size
            }
            console.info(
                '                 %s %s',
                c.grey('sorted:'),
                participation.sorted == null
                    ? ''
                    : `${String(ranked)} in ${String(ranks)} rank${ranks === 1 ? '' : 's'}`,
            )
            console.info('               %s %s', c.grey('requests:'), participation.requests?.size ?? '')
        } else {
            const collectionAddress = await treasury.getCollectionAddress(key)
            console.info('                 %s %s', c.grey('staked:'), participation.staked?.size ?? '')
            console.info('           %s %s GRAM', c.grey('total_staked:'), formatNano(participation.totalStaked ?? 0n))
            console.info('       %s %s', c.grey('stake_held_until:'), formatDate(participation.stakeHeldUntil ?? 0n))
            console.info('     %s %s', c.grey('collection address:'), c.cyan(String(collectionAddress)))
        }
        console.info()

        // An open round's book, best-ranked first.
        if (open && participation.requests != null && participation.requests.size > 0) {
            console.info('    %s', c.bold('Requests'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.requests, testOnly, c, minEfficiency, rankOrder(participation.sorted))
            console.info()
        }

        if (participation.staked != null && participation.staked.size > 0) {
            console.info('    %s', c.bold('Staked'))
            console.info('    %s', c.grey('--------'))
            showRequests(participation.staked, testOnly, c, minEfficiency)
            console.info()
        }
    }
}

// The order decide_loan_requests serves the round's requests in: the highest sort key first, and inside a
// bucket of tied keys the smaller address first, as its udict_get_max / udict_delete_get_min do.
function rankOrder(sorted: Dictionary<bigint, Dictionary<bigint, unknown>> | undefined): bigint[] {
    const order: bigint[] = []
    for (const key of [...(sorted?.keys() ?? [])].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))) {
        const bucket = sorted?.get(key)
        order.push(...[...(bucket?.keys() ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return order
}

// The order the auction would rank these requests in, for a list the treasury keeps no sorted dict for
// (staked, recovering): the bid's request_sort_key, highest first, and the smaller address first
// on a tie, exactly as rankOrder reads an open round. Built from the bid, so a decided loan's scaled
// min_payment does not lift it above where it ranked.
function bidOrder(dict: Dictionary<bigint, Request>): bigint[] {
    const keyed = dict.keys().map((address) => {
        const request = dict.get(address)
        return { address, key: request == null ? -1n : bidSortKey(request) }
    })
    keyed.sort((a, b) =>
        a.key !== b.key ? (a.key > b.key ? -1 : 1) : a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    )
    return keyed.map((k) => k.address)
}

// order lists the keys to show first, in that order; any key it misses follows in rank order. With no
// order given, which is every list but an open round's requests, the whole list is in rank order.
function showRequests(
    dict: Dictionary<bigint, Request>,
    testOnly: boolean,
    c: Palette,
    minEfficiency: bigint,
    order: bigint[] = [],
) {
    if (dict.size > 0) {
        const first = order.filter((k) => dict.has(k))
        const rest = bidOrder(dict).filter((k) => !first.includes(k))
        for (const req of [...first, ...rest]) {
            const request = dict.get(req)
            // No share or fee here: both are the protocol's, snapshotted from reward_share and borrower_fee
            // above, so every request in a round carries the same two.
            // Whole GRAM, right-aligned, so the columns line up down the list: the fractions are noise at
            // these sizes. A max of 0 is no cap, and a request stored before the stake-cap release has none.
            const maxStake = request?.maxStake ?? 0n
            // eff is what the auction ranked the bid on and what min_efficiency is checked against. Red
            // when below a floor that is on: a request stored before the floor, or one the floor now
            // refuses if it is sent again.
            const eff = request == null ? 0n : bidEfficiency(request)
            const effText = String(eff).padStart(4)
            console.info(
                '        eff: %s   min: %s   loan: %s   max: %s   stake: %s   borrower: %s',
                minEfficiency > 0n && eff < minEfficiency ? c.red(effText) : effText,
                formatWhole(request?.minPayment ?? 0n).padStart(6),
                formatWhole(request?.loanAmount ?? 0n).padStart(9),
                (maxStake > 0n ? formatWhole(maxStake) : 'none').padStart(9),
                formatWhole(request?.stakeAmount ?? 0n).padStart(6),
                c.cyan(Address.parseRaw('0:' + req.toString(16).padStart(64, '0')).toString({ testOnly })),
            )
        }
    }
}

// The efficiency the auction ranks a bid on: request_sort_key's top 24 bits, computed exactly as
// utils.fc does, min_payment and loan rounded down to units of 2^30 and 2^40 nanoGRAM. A decided loan
// that was given accrual carries min_payment scaled by (loan + accrue) / loan, so that is undone first:
// the row shows the rate that was bid, not one it never ranked on. Rounding up recovers the bid exactly,
// since the scaling rounded down.
function bidEfficiency(request: Request): bigint {
    const minPaymentRound = bidMinPayment(request) >> 30n
    const eff = (minPaymentRound * 1000n) / loanRound(request)
    const max = (1n << 24n) - 1n
    return eff > max ? max : eff
}

// The whole of request_sort_key, as utils.fc builds it: efficiency, then the pool's share, then the loan
// amount's complement, so the smaller loan ranks first on a tie.
function bidSortKey(request: Request): bigint {
    const treasuryShare = 65535n - request.borrowerRewardShare
    return (bidEfficiency(request) << 96n) + (treasuryShare << 80n) + ((1n << 80n) - loanRound(request))
}

function bidMinPayment(request: Request): bigint {
    const accrue = request.accrueAmount
    if (accrue > 0n && request.loanAmount > 0n) {
        const total = request.loanAmount + accrue
        return (request.minPayment * request.loanAmount + total - 1n) / total
    }
    return request.minPayment
}

function loanRound(request: Request): bigint {
    const round = request.loanAmount >> 40n
    return round < 1n ? 1n : round
}

// Annualised growth from one rate to another over seconds, '' when either is missing or the span is not
// positive (a treasury that has not settled two releases yet).
function apyOver(from: bigint, to: bigint, seconds: number): string {
    if (from <= 0n || to <= 0n || seconds <= 0) return ''
    const year = 365 * 24 * 60 * 60
    return formatPercent(Math.pow(Number(to) / Number(from), year / seconds) - 1)
}

function formatWhole(value: bigint): string {
    return (Number(value) / 1000000000).toLocaleString(undefined, { maximumFractionDigits: 0 })
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

// Whole hours and minutes, because a round is ~18h and the interesting thing about this number is
// whether it is one round or several, not the seconds.
function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${String(hours)}h ${String(minutes)}m`
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
