import { Address, Cell } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider, compile } from '@ton/blueprint'
import { dryRunUpgrade, formatDryRun } from '../wrappers/migrationDryRun'
import { makePalette } from '../wrappers/colors'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Set this to the name of a migrator under wrappers/upgrade-code-test/ to run a one-off storage
// migration as part of this upgrade, or leave it null for an ordinary upgrade.
//
// The migrator is NOT deployed. It rides inside the upgrade message and the treasury executes it once,
// in the same transaction, before checking that the migrated storage still parses and still names the
// same governor. It is code, not data: it runs with the treasury's full authority. Read it before you
// sign, and read scripts/upgrade_treasury.md.
const migratorName: string | null = 'upgrade-code-test/AddDeficit'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const c = makePalette()

    const newCode = await compile('Treasury')

    // Name and code are kept together so a migration is a single either-or, rather than two values
    // that could disagree about whether one is happening.
    //
    // Absent is deliberately undefined rather than an empty cell. The treasury runs anything present,
    // and an empty cell would be blessed as a continuation with no selector.
    const migrator = migratorName == null ? null : { name: migratorName, code: await compile(migratorName) }
    const migrateCode: Cell | undefined = migrator?.code

    console.info()
    console.info(c.bold('UPGRADING CODE'))
    console.info(c.grey('=============='))
    console.info('1. Update and rebase this repo before continuing to have the correct git hash after upgrade')
    console.info('2. Check upgrade_code in treasury.fc before proceeding')
    console.info('3. Check upgrade_data in treasury.fc before proceeding')
    console.info(c.grey('=============='))
    console.info()

    console.info('New code hash hex:      %s', c.cyan(newCode.hash().toString('hex')))
    console.info('New code hash base64:   %s', c.cyan(newCode.hash().toString('base64')))
    console.info()

    if (migrator == null) {
        console.info('Migration:              %s', c.green('none — this upgrade changes code only'))
        console.info()
    } else {
        // Anything below is executed by the treasury with full authority. Show it in full, every run,
        // so it is never something the operator scrolled past on the way to the code hash.
        const bang = c.yellowBold('!!')
        const bar = c.yellowBold('!'.repeat(80))
        console.info(bar)
        console.info(c.yellowBold('!! THIS UPGRADE CARRIES A ONE-OFF MIGRATION THAT WILL REWRITE TREASURY STORAGE'))
        console.info(bar)
        console.info('%s Migrator:            %s', bang, c.cyan(migrator.name))
        console.info('%s Migrator hash hex:   %s', bang, c.cyan(migrator.code.hash().toString('hex')))
        console.info('%s Migrator bytes:      %s', bang, String(migrator.code.toBoc().byteLength))
        console.info(bang)
        console.info('%s %s', bang, c.yellow('It is CODE, not data. The treasury runs it with full authority, once,'))
        console.info('%s %s', bang, c.yellow('inside this transaction. Publish this hash alongside the code hash, and'))
        console.info('%s %s', bang, c.yellow('have every signer review the source below, not only the code hash.'))
        console.info(bar)
        console.info()
        printMigratorSource(migrator.name)
    }

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const state = await treasury.getState()
    if (state.state.type != 'active') {
        console.info(c.redBold('Treasury account is not active'))
        return
    }
    console.info('  current code bytes: %s', state.state.code?.byteLength)
    console.info('  upgrade code bytes: %s', newCode.toBoc().byteLength)

    // Rehearse the whole upgrade against the account as it exists right now, and show what moves.
    // A migration is the one thing here that cannot be undone, so the operator should approve a diff
    // of real state rather than a description of intent.
    if (state.state.code == null || state.state.data == null) {
        console.info(c.redBold('Treasury account has no code or data on chain'))
        return
    }
    const liveState = await treasury.getTreasuryState()
    console.info()
    console.info(c.grey('Replaying the upgrade against live state...'))
    const dryRun = await dryRunUpgrade({
        address: treasuryAddress,
        currentCode: Cell.fromBoc(state.state.code)[0],
        currentData: Cell.fromBoc(state.state.data)[0],
        newCode,
        migrateCode,
        governor: liveState.governor,
    })
    console.info()
    console.info(formatDryRun(dryRun, c))
    console.info()

    if (!dryRun.ok) {
        console.info(c.redBold('Aborted: the dry run says this upgrade would fail. Nothing was sent.'))
        return
    }

    if (migrator != null) {
        // A second, separate decision after the address is known, so confirming the upgrade and
        // confirming the migration are never the same keystroke.
        const confirmMigration = await ui.input(
            '\n\nA MIGRATION WILL RUN AND REWRITE STORAGE, exactly as shown in the diff above.' +
                '\nEnter the migrator hash hex shown earlier to confirm you have read both',
        )
        if (confirmMigration.trim().toLowerCase() !== migrator.code.hash().toString('hex')) {
            console.info(c.redBold('Migrator hash did not match. Aborted'))
            return
        }
    }

    const confirm = await ui.input('\n\nTo confirm the upgrade, enter yes in capital case')
    if (confirm !== 'YES') {
        console.info(c.red('Aborted'))
        return
    }

    await treasury.sendUpgradeCode(provider.sender(), { value: '0.1', newCode, migrateCode })

    ui.write('Done')

    ui.write('\n Remember to log the upgrade date and time: ' + new Date().toISOString())
}

// Prints the migrator's source so the last thing the operator sees before signing is what will run,
// not a hash standing in for it.
function printMigratorSource(name: string) {
    const c = makePalette()
    const path = migratorSourcePath(name)
    if (!existsSync(path)) {
        // The operator's only signal that they are about to sign a migration whose source was never
        // put in front of them, so it is the loudest thing on the screen.
        console.info(c.redBold('WARNING: could not locate migrator source at ' + path))
        console.info(c.redBold('         Read it manually before signing.'))
        console.info()
        return
    }
    console.info(c.grey('---- ' + path + ' ----'))
    console.info(readFileSync(path, 'utf8'))
    console.info(c.grey('---- end of migrator source ----'))
    console.info()
}

// 'upgrade-code-test/AddDeficit' -> wrappers/upgrade-code-test/add_deficit.fc
function migratorSourcePath(name: string): string {
    const cut = name.lastIndexOf('/')
    const dir = cut === -1 ? '' : name.slice(0, cut)
    const base = name.slice(cut + 1)
    const snake = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    return join(__dirname, '..', 'wrappers', dir, snake + '.fc')
}
