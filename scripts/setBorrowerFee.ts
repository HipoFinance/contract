import { Address } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { ParticipationState, Treasury } from '../wrappers/Treasury'
import { makePalette } from '../wrappers/colors'
import { burnerAddress } from '../wrappers/burner'

// Sets the borrower fee: the share of each borrower's contractual reward that is sent to the burner
// at loan recovery, out of 65535.
//
// This does more than send the message, because the number on its own says very little. The fee is
// charged as a fraction of `reward * borrower_reward_share / 65535`, so what it actually costs a
// borrower depends on the share THEY bid — the same rate is a different deal for each of them. The
// script therefore reads the live bids and shows what the new rate would take from each, before
// asking for confirmation.
//
// Two properties worth remembering while using it:
//
//   - 0 disables the mechanism completely, floor included. It is the kill switch.
//   - The rate is snapshotted into each request when it is made, so this never reprices a loan that
//     has already been requested. It applies from the next request onwards.

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

    const state = await treasury.getTreasuryState()
    const current = state.borrowerFee

    console.info()
    console.info('  %s', c.bold('Borrower fee'))
    console.info('  %s', c.grey('------------'))
    console.info(
        '  %s %s %s',
        c.grey('current:'),
        String(current),
        current === 0n ? c.grey('/ 65535  (disabled)') : c.grey(`/ 65535  (${percent(current)} of borrower reward)`),
    )

    const answer = await ui.input('What should be the borrower fee? [0-65535, 0 disables]')
    if (!/^\d+$/.test(answer.trim())) {
        ui.write(c.red('Not a number. Nothing was sent.'))
        return
    }
    const next = BigInt(answer.trim())
    if (next > 65535n) {
        ui.write(c.red('Out of range: the fee is a fraction out of 65535. Nothing was sent.'))
        return
    }
    if (next === current) {
        ui.write(c.grey('Already set to that value. Nothing was sent.'))
        return
    }

    console.info()
    console.info(
        '  %s %s %s %s',
        c.grey('new:'),
        c.yellowBold(String(next)),
        c.grey('/ 65535'),
        next === 0n ? c.grey('(disabled)') : c.grey(`(${percent(next)} of borrower reward)`),
    )

    // What this costs the borrowers who are currently in the book. Their bid is what turns the rate
    // into an amount, so this is the only place the number becomes concrete before it is live.
    showImpact(state, next, c)

    console.info()
    if (next === 0n) {
        console.info('  %s', c.yellowBold('This DISABLES the borrower fee, including the 1 GRAM floor.'))
        console.info('  %s', c.grey('Loans already requested keep the rate snapshotted in their request.'))
    } else if (current === 0n) {
        console.info('  %s', c.yellowBold('This ENABLES the borrower fee. Borrowers start paying from their next request.'))
        console.info('  %s', c.grey('Confirm the burner is deployed and still the contract you expect:'))
        console.info('  %s', c.cyan('  ' + burnerAddress().toString()))
    }
    if (next > 32767n) {
        console.info(
            '  %s',
            c.redBold('Above half of every borrower\'s contractual reward. At 65535 they keep none of it.'),
        )
    }

    console.info()
    const confirm = await ui.input(`Type the new fee again to confirm, or anything else to abort [${String(next)}]`)
    if (confirm.trim() !== String(next)) {
        ui.write(c.red('Aborted. Nothing was sent.'))
        return
    }

    await treasury.sendSetBorrowerFee(provider.sender(), {
        value: '0.1',
        newBorrowerFee: next,
    })

    ui.write(c.green('Sent. Check with showState that borrower_fee reads ' + String(next) + '.'))
}

function percent(fee: bigint): string {
    return (Number(fee) / 65535).toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 2 })
}

// Reads every request the treasury is currently holding and reports what the rate would take from
// each borrower's own share. A borrower who bid a small share pays a larger slice of their own
// income for the same rate, which is the thing a single number hides.
function showImpact(
    state: Awaited<ReturnType<Treasury['getTreasuryState']>>,
    next: bigint,
    c: ReturnType<typeof makePalette>,
) {
    const rows: { round: bigint; borrower: bigint; share: bigint }[] = []
    for (const roundSince of state.participations.keys()) {
        const participation = state.participations.get(roundSince)
        if (participation == null) continue
        // A burning round has already settled every loan it held, so its rate is spent.
        if (participation.state === ParticipationState.Burning) continue

        for (const dict of [participation.requests, participation.accrued, participation.staked]) {
            if (dict == null) continue
            for (const borrower of dict.keys()) {
                const request = dict.get(borrower)
                if (request == null) continue
                rows.push({ round: roundSince, borrower, share: request.borrowerRewardShare })
            }
        }
    }

    console.info()
    if (rows.length === 0) {
        console.info('  %s', c.grey('No requests are being held right now, so nothing is affected yet.'))
        return
    }

    console.info('  %s', c.grey('Borrowers currently in the book, and the share each bid:'))
    for (const row of rows) {
        // A share of 0 earns nothing contractually and pays only the floor, which is worth saying
        // rather than printing a percentage of nothing.
        const effect =
            next === 0n
                ? c.grey('nothing')
                : row.share === 0n
                  ? c.grey('contracted for no reward; pays the 1 GRAM floor')
                  : percent(next) + c.grey(' of their share')
        console.info(
            '    %s %s  %s %s %s  %s %s',
            c.grey('round'),
            row.round.toString(),
            c.grey('borrower'),
            shortHash(row.borrower),
            c.grey('share ' + row.share.toString() + '/65535'),
            c.grey('->'),
            effect,
        )
    }
    console.info(
        '  %s',
        c.grey('Requests already made keep their snapshotted rate; this applies from their next one.'),
    )
}

function shortHash(borrower: bigint): string {
    const hex = borrower.toString(16).padStart(64, '0')
    return hex.slice(0, 6) + '…' + hex.slice(-4)
}
