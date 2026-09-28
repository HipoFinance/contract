import { Address } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Treasury } from '../wrappers/Treasury'
import { makePalette } from '../wrappers/colors'

// Sets the three auction floors that request_loan enforces. Each is 0 for off.
//
//   - min_efficiency: the least a bid's efficiency (min_payment per loan, the first part of the sort
//     key, as showState prints it) may be. A loan the elector returns unelected pays the pool only its
//     min_payment, so this is what makes holding capacity that earns nothing cost the holder. Keep it a
//     little under the pool's contractual share at current yield: above it, honest bids that the
//     contractual share already out-earns are refused.
//   - min_request_stake: the least loan + collateral a request may carry, in WHOLE GRAM. Keep it a
//     little under the smallest stake the elector elects, so a request that could never be elected is
//     refused and one that could is not.
//   - stake_cap_floor: the lowest max_stake honoured, in WHOLE GRAM; a lower non-zero cap is raised to
//     it. Keep it a little under the elector's per-validator limit (max_factor times the smallest
//     elected stake), so a cap still stops stake that would earn nothing but cannot leave the leftover
//     unlent. It must be 0 or at least min_request_stake; the contract refuses anything else.
//
// The rate and stake floors are checked when a request arrives, and the cap floor is written into the
// request then, so a change applies to the requests sent after it. Revisit the values when the
// election's floor or limit moves.
//
// See docs/specs/2026-09-28-auction-floors-and-forced-accrual.md.

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const c = makePalette()

    const defaultTreasuryAddress =
        provider.network() === 'mainnet' ? 'EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ' : ''
    const prompt = defaultTreasuryAddress
        ? `Enter the friendly address of the treasury (default: ${defaultTreasuryAddress})`
        : 'Enter the friendly address of the treasury'
    const treasuryAddress = Address.parse((await ui.input(prompt)) || defaultTreasuryAddress)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const state = await treasury.getTreasuryState()
    if ((state.minEfficiency ?? -1n) < 0n) {
        ui.write(c.red('This treasury predates the auction floors: upgrade it first. Nothing was sent.'))
        return
    }
    const current = {
        minEfficiency: state.minEfficiency ?? 0n,
        minRequestStake: state.minRequestStake ?? 0n,
        stakeCapFloor: state.stakeCapFloor ?? 0n,
    }

    console.info()
    console.info('  %s', c.bold('Auction floors'))
    console.info('  %s', c.grey('--------------'))
    show(c, 'current', current)

    const read = async (question: string, fallback: bigint, max: bigint): Promise<bigint | null> => {
        const answer = (await ui.input(`${question} (default: ${String(fallback)})`)).trim()
        if (answer === '') {
            return fallback
        }
        if (!/^\d+$/.test(answer) || BigInt(answer) > max) {
            ui.write(c.red(`Not a whole number in [0, ${String(max)}]. Nothing was sent.`))
            return null
        }
        return BigInt(answer)
    }
    const minEfficiency = await read('Minimum efficiency', current.minEfficiency, (1n << 24n) - 1n)
    if (minEfficiency == null) return
    const minRequestStake = await read(
        'Minimum loan + collateral, whole GRAM',
        current.minRequestStake,
        (1n << 32n) - 1n,
    )
    if (minRequestStake == null) return
    const stakeCapFloor = await read('Stake cap floor, whole GRAM', current.stakeCapFloor, (1n << 32n) - 1n)
    if (stakeCapFloor == null) return

    if (stakeCapFloor > 0n && stakeCapFloor < minRequestStake) {
        ui.write(
            c.red('The cap floor must be 0 or at least the minimum stake; the contract refuses it. Nothing was sent.'),
        )
        return
    }
    const next = { minEfficiency, minRequestStake, stakeCapFloor }
    if (
        next.minEfficiency === current.minEfficiency &&
        next.minRequestStake === current.minRequestStake &&
        next.stakeCapFloor === current.stakeCapFloor
    ) {
        ui.write(c.grey('Already set to those values. Nothing was sent.'))
        return
    }

    console.info()
    show(c, 'new', next)
    console.info()
    const confirm = await ui.input('Type "yes" to send')
    if (confirm.trim() !== 'yes') {
        ui.write(c.red('Aborted. Nothing was sent.'))
        return
    }

    await treasury.sendSetAuctionFloors(provider.sender(), { value: '0.1', ...next })
    ui.write(c.green('Sent. Check with showState that the floors read as above.'))
}

function show(
    c: ReturnType<typeof makePalette>,
    label: string,
    v: { minEfficiency: bigint; minRequestStake: bigint; stakeCapFloor: bigint },
) {
    const floor = (x: bigint, unit: string) => (x > 0n ? c.yellow(x.toLocaleString() + unit) : c.grey('off'))
    console.info(
        '  %s min_efficiency %s   min_request_stake %s   stake_cap_floor %s',
        c.grey(label + ':'),
        floor(v.minEfficiency, ''),
        floor(v.minRequestStake, ' GRAM'),
        floor(v.stakeCapFloor, ' GRAM'),
    )
}
