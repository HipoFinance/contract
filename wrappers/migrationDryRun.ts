import { Address, Cell, Dictionary, toNano } from '@ton/core'
import { Blockchain, SandboxContract, createShardAccount } from '@ton/sandbox'
import { Treasury } from './Treasury'
import { Palette, makePalette } from './colors'

// Rehearses an upgrade against a real treasury account inside a local sandbox, so an operator can see
// what a migration actually does to live state before signing anything.
//
// This is deliberately generic rather than written around any one migration: it snapshots everything
// the treasury exposes, runs the upgrade, snapshots again, and reports every field that moved. A
// migration that changes something nobody intended shows up as a line in the diff rather than as a
// surprise on chain.

export interface Snapshot {
    codeHash: string
    dataHash: string
    dataBits: number
    dataRefs: number
    fields: [string, string][]
}

export interface FieldChange {
    field: string
    before: string
    after: string
}

export interface DryRunResult {
    ok: boolean
    /** Why the upgrade would fail, when ok is false. */
    failure?: string
    exitCode?: number
    before: Snapshot
    after?: Snapshot
    changes: FieldChange[]
}

function dictSize(dict: Dictionary<bigint, unknown> | undefined): string {
    return dict == null ? 'absent' : `${String(dict.size)} entries`
}

function rate(totalCoins: bigint, totalTokens: bigint): string {
    if (totalTokens === 0n) return 'n/a'
    // Six decimal places, computed in integers so a rate change is never hidden by float rounding.
    const scaled = (totalCoins * 1_000_000n) / totalTokens
    return (Number(scaled) / 1_000_000).toFixed(6)
}

// Reads everything the treasury exposes. Ordered, so two snapshots line up positionally and a field
// appearing or disappearing between code versions is itself visible.
async function snapshot(treasury: SandboxContract<Treasury>, code: Cell, data: Cell): Promise<Snapshot> {
    const shell = {
        codeHash: code.hash().toString('hex'),
        dataHash: data.hash().toString('hex'),
        dataBits: data.bits.length,
        dataRefs: data.refs.length,
    }

    // A migration that changes the shape of get_treasury_state makes this wrapper unable to read the
    // side of the upgrade it was not built for -- and that is precisely the upgrade an operator most
    // wants to rehearse. Report what is still knowable from the raw cells rather than throwing, so
    // the run reaches its verdict; the field-by-field diff is what degrades, not the pass/fail.
    let s
    try {
        s = await treasury.getTreasuryState()
    } catch {
        return { ...shell, fields: [['state', 'not readable by this wrapper (get_treasury_state shape differs)']] }
    }

    const fields: [string, string][] = [
        ['total_coins', String(s.totalCoins)],
        ['total_tokens', String(s.totalTokens)],
        ['exchange rate', rate(s.totalCoins, s.totalTokens)],
        ['total_staking', String(s.totalStaking)],
        ['total_unstaking', String(s.totalUnstaking)],
        ['total_borrowers_stake', String(s.totalBorrowersStake)],
        ['deficit', String(s.deficit)],
        ['parent', s.parent?.toString() ?? 'null'],
        ['participations', dictSize(s.participations)],
        ['rounds_imbalance', String(s.roundsImbalance)],
        ['stopped', String(s.stopped)],
        ['instant_mint', String(s.instantMint)],
        ['loan_codes', dictSize(s.loanCodes)],
        ['previous_rate', String(s.previousRate)],
        ['current_rate', String(s.currentRate)],
        ['window_duration', String(s.windowDuration)],
        ['last_settled_round', String(s.lastSettledRound)],
        // Listed in STORAGE order, which is where these two live; the getter returns them last.
        ['mid_rate', String(s.midRate)],
        ['mid_round', String(s.midRound)],
        ['halter', s.halter.toString()],
        ['governor', s.governor.toString()],
        ['proposed_governor', s.proposedGovernor == null ? 'null' : s.proposedGovernor.hash().toString('hex')],
        ['governance_fee', String(s.governanceFee)],
        ['borrower_fee', String(s.borrowerFee)],
        ['collection_codes', dictSize(s.collectionCodes)],
        ['bill_codes', dictSize(s.billCodes)],
        ['old_parents', dictSize(s.oldParents)],
    ]

    return { ...shell, fields }
}

async function accountCells(blockchain: Blockchain, address: Address): Promise<{ code: Cell; data: Cell }> {
    const contract = await blockchain.getContract(address)
    const state = contract.account.account?.storage.state
    if (state?.type !== 'active' || state.state.code == null || state.state.data == null) {
        throw new Error('treasury account is not active in the sandbox')
    }
    return { code: state.state.code, data: state.state.data }
}

export async function dryRunUpgrade(opts: {
    address: Address
    currentCode: Cell
    currentData: Cell
    newCode: Cell
    migrateCode?: Cell
    governor: Address
}): Promise<DryRunResult> {
    const blockchain = await Blockchain.create()
    await blockchain.setShardAccount(
        opts.address,
        createShardAccount({
            workchain: opts.address.workChain,
            address: opts.address,
            code: opts.currentCode,
            data: opts.currentData,
            balance: toNano('100'),
        }),
    )
    const treasury = blockchain.openContract(Treasury.createFromAddress(opts.address))

    const before = await snapshot(treasury, opts.currentCode, opts.currentData)

    const result = await treasury.sendUpgradeCode(blockchain.sender(opts.governor), {
        value: toNano('1'),
        newCode: opts.newCode,
        migrateCode: opts.migrateCode,
    })

    // Only the treasury's own transaction is judged. The gas_excess refund is addressed to the real
    // governor, which does not exist as an account in this sandbox, so it lands uninitialized and
    // reports as aborted — an artifact of replaying mainnet state locally, not a real failure.
    const own = result.transactions.filter((t) => t.inMessage?.info.dest?.toString() === opts.address.toString())
    for (const tx of own) {
        if (tx.description.type !== 'generic') continue
        const compute = tx.description.computePhase
        if (compute.type === 'skipped') {
            return { ok: false, failure: `compute phase skipped: ${compute.reason}`, before, changes: [] }
        }
        if (!compute.success) {
            return {
                ok: false,
                failure: `upgrade would FAIL with exit code ${String(compute.exitCode)}`,
                exitCode: compute.exitCode,
                before,
                changes: [],
            }
        }
        if (tx.description.actionPhase != null && !tx.description.actionPhase.success) {
            return {
                ok: false,
                failure: `action phase would fail with code ${String(tx.description.actionPhase.resultCode)}`,
                before,
                changes: [],
            }
        }
    }

    const cells = await accountCells(blockchain, opts.address)
    const after = await snapshot(treasury, cells.code, cells.data)

    const changes: FieldChange[] = []
    for (let i = 0; i < before.fields.length; i++) {
        const [field, wasValue] = before.fields[i]
        const nowValue = after.fields[i]?.[1] ?? '(missing)'
        if (wasValue !== nowValue) changes.push({ field, before: wasValue, after: nowValue })
    }

    return { ok: true, before, after, changes }
}

// Renders the result for a terminal. Kept here so the script stays about the upgrade flow and this
// stays testable on its own. The palette is a parameter rather than read from the environment, so a
// test can pin colour on or off instead of depending on how the runner attaches stdout.
export function formatDryRun(result: DryRunResult, palette: Palette = makePalette()): string {
    const c = palette
    const rule = c.grey('================================================================================')
    const lines: string[] = []
    lines.push(rule)
    lines.push(c.bold('DRY RUN — this upgrade replayed against the live account in a local sandbox'))
    lines.push(rule)

    if (!result.ok) {
        lines.push('')
        lines.push('  ' + c.redBold('RESULT: ' + (result.failure ?? 'unknown failure')))
        lines.push('')
        lines.push(c.red('  Nothing would change on chain: the treasury would stay on its current code'))
        lines.push(c.red('  with its current data. Do not send this upgrade.'))
        lines.push(rule)
        return lines.join('\n')
    }

    const after = result.after
    if (after == null) return lines.join('\n')

    const move = (was: string, now: string) => `${c.red(was)} ${c.grey('->')} ${c.green(now)}`

    lines.push('')
    lines.push(`  code hash   ${move(result.before.codeHash.slice(0, 16), after.codeHash.slice(0, 16))}`)
    lines.push(`  data hash   ${move(result.before.dataHash.slice(0, 16), after.dataHash.slice(0, 16))}`)
    lines.push(
        '  data size   ' +
            move(
                `${String(result.before.dataBits)} bits / ${String(result.before.dataRefs)} refs`,
                `${String(after.dataBits)} bits / ${String(after.dataRefs)} refs`,
            ),
    )
    lines.push('')

    // An empty change list means two very different things, and an operator must not have to guess
    // which. Say so explicitly when the state could not be itemised at all.
    const unreadable = (s: Snapshot) => s.fields.length === 1 && s.fields[0][0] === 'state'
    if (unreadable(result.before) || unreadable(after)) {
        lines.push('  ' + c.yellowBold('STATE DIFF: not readable across this upgrade.'))
        lines.push(
            '  ' +
                c.yellow(
                    'get_treasury_state changes shape here, so fields cannot be compared. The hashes above' +
                        ' still hold. Verify this one by reading the migrator.',
                ),
        )
    } else if (result.changes.length === 0) {
        lines.push('  ' + c.green('STATE DIFF: no field changed. This upgrade replaces code only.'))
    } else {
        lines.push('  ' + c.yellowBold(`STATE DIFF: ${String(result.changes.length)} field(s) would change.`))
        lines.push('  ' + c.yellow('Read every line. Anything here that you did not intend is a reason to stop.'))
        lines.push('')
        const width = Math.max(...result.changes.map((ch) => ch.field.length))
        for (const change of result.changes) {
            lines.push(`    ${c.cyan(change.field.padEnd(width))}  ${c.red('- ' + change.before)}`)
            lines.push(`    ${' '.repeat(width)}  ${c.green('+ ' + change.after)}`)
        }
    }

    lines.push('')
    lines.push(c.grey('  Fields NOT covered by this diff: the contents of participations, loan_codes,'))
    lines.push(c.grey('  collection_codes, bill_codes and old_parents. Only their entry counts are compared,'))
    lines.push(c.grey('  because the migration moves them as opaque refs.'))
    lines.push(rule)
    return lines.join('\n')
}
