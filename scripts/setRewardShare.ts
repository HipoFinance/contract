import { Address } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { ParticipationState, Treasury } from '../wrappers/Treasury'
import { makePalette } from '../wrappers/colors'

// Sets the reward share: the fraction of each loan's reward the BORROWER contracts for, out of 65535.
// The pool takes the rest, so this is the single number that decides what stakers earn from lending.
//
// Borrowers do not bid it — `request_loan` snapshots this value into every request — so the two things
// worth holding in mind while using it are the two it makes possible:
//
//   - The pool can never be paid less than `reward * (65535 - reward_share) / 65535` from a loan,
//     whatever anybody bids. Raising this number lowers that floor, one for one.
//   - It is also the borrower's entire income. Set it below what running a validator costs and nobody
//     bids, the pool goes unlent, and stakers earn nothing at all — which costs them far more than the
//     share ever could.
//
// Send it BETWEEN rounds. The value is snapshotted per request, so changing it while a participation
// is open leaves that round holding two different shares, which is the one case where the auction's
// sort key is not exactly monotone in what the pool receives. The script warns when a round is open.
//
// See docs/specs/2026-09-19-protocol-set-reward-share.md.

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
    const current = state.rewardShare

    console.info()
    console.info('  %s', c.bold('Reward share'))
    console.info('  %s', c.grey('------------'))
    console.info(
        '  %s %s %s',
        c.grey('current:'),
        String(current),
        c.grey(`/ 65535  (borrower ${percent(current)}, pool ${percent(65535n - current)})`),
    )

    const answer = await ui.input('What should be the reward share? [0-65534]')
    if (!/^\d+$/.test(answer.trim())) {
        ui.write(c.red('Not a number. Nothing was sent.'))
        return
    }
    const next = BigInt(answer.trim())
    if (next >= 65535n) {
        ui.write(c.red('The contract refuses 65535: it would leave the pool nothing. Nothing was sent.'))
        return
    }
    if (next === current) {
        ui.write(c.grey('Already set to that value. Nothing was sent.'))
        return
    }

    console.info()
    console.info(
        '  %s %s %s',
        c.grey('new:'),
        c.yellowBold(String(next)),
        c.grey(`/ 65535  (borrower ${percent(next)}, pool ${percent(65535n - next)})`),
    )
    console.info(
        '  %s',
        next > current
            ? c.yellowBold(
                  `The pool's floor falls from ${percent(65535n - current)} to ${percent(65535n - next)} of every reward.`,
              )
            : c.grey(
                  `The pool's floor rises from ${percent(65535n - current)} to ${percent(65535n - next)} of every reward.`,
              ),
    )
    if (next === 0n) {
        console.info(
            '  %s',
            c.redBold('At 0 a borrower earns nothing and still pays the 1 GRAM burn floor from collateral.'),
        )
    }

    warnIfRoundOpen(state, c)

    console.info()
    const confirm = await ui.input(`Type the new share again to confirm, or anything else to abort [${String(next)}]`)
    if (confirm.trim() !== String(next)) {
        ui.write(c.red('Aborted. Nothing was sent.'))
        return
    }

    await treasury.sendSetRewardShare(provider.sender(), {
        value: '0.1',
        newRewardShare: next,
    })

    ui.write(c.green('Sent. Check with showState that reward_share reads ' + String(next) + '.'))
}

function percent(share: bigint): string {
    return (Number(share) / 65535).toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 3 })
}

// A round still collecting requests is the one case where this call splits a round in two: bids made
// before it keep the old share, bids after it get the new one, and the sort key can then order two
// bids by price when the other carried the better share.
function warnIfRoundOpen(state: Awaited<ReturnType<Treasury['getTreasuryState']>>, c: ReturnType<typeof makePalette>) {
    const open: bigint[] = []
    for (const roundSince of state.participations.keys()) {
        const participation = state.participations.get(roundSince)
        if (participation?.state === ParticipationState.Open) {
            open.push(roundSince)
        }
    }
    if (open.length === 0) {
        return
    }
    console.info()
    console.info('  %s', c.redBold('A round is still collecting requests: ' + open.join(', ')))
    console.info('  %s', c.grey('Bids already made keep the old share; bids after this get the new one, so that'))
    console.info('  %s', c.grey('round would hold two. Wait for it to close unless you mean to split it.'))
}
