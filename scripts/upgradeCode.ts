import { Address, Cell } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider, compile } from '@ton/blueprint'
import { dryRunUpgrade, formatDryRun } from '../wrappers/migrationDryRun'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Set this to the name of a migrator under wrappers/upgrade-code-test/ to run a one-off storage
// migration as part of this upgrade, or leave it null for an ordinary upgrade.
//
// The migrator is NOT deployed. It rides inside the upgrade message and the treasury executes it once,
// in the same transaction, before checking that the migrated storage still parses and still names the
// same governor. It is code, not data: it runs with the treasury's full authority. Read it before you
// sign, and read scripts/upgrade_treasury.md.
const migratorName: string | null = null // e.g. 'upgrade-code-test/AddDeficit'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const newCode = await compile('Treasury')

    // Name and code are kept together so a migration is a single either-or, rather than two values
    // that could disagree about whether one is happening.
    //
    // Absent is deliberately undefined rather than an empty cell. The treasury runs anything present,
    // and an empty cell would be blessed as a continuation with no selector.
    const migrator = migratorName == null ? null : { name: migratorName, code: await compile(migratorName) }
    const migrateCode: Cell | undefined = migrator?.code

    console.info()
    console.info('UPGRADING CODE')
    console.info('==============')
    console.info('1. Check upgrade_code in treasury.fc before proceeding')
    console.info('2. Check upgrade_data in treasury.fc before proceeding')
    console.info('3. Update and rebase this repo before continuing to have the correct git hash after upgrade')
    console.info('==============')
    console.info()

    console.info('New code hash hex:      %s', newCode.hash().toString('hex'))
    console.info('New code hash base64:   %s', newCode.hash().toString('base64'))
    console.info()

    if (migrator == null) {
        console.info('Migration:              none — this upgrade changes code only')
        console.info()
    } else {
        // Anything below is executed by the treasury with full authority. Show it in full, every run,
        // so it is never something the operator scrolled past on the way to the code hash.
        console.info('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        console.info('!! THIS UPGRADE CARRIES A ONE-OFF MIGRATION THAT WILL REWRITE TREASURY STORAGE')
        console.info('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        console.info('!! Migrator:            %s', migrator.name)
        console.info('!! Migrator hash hex:   %s', migrator.code.hash().toString('hex'))
        console.info('!! Migrator bytes:      %s', migrator.code.toBoc().byteLength)
        console.info('!!')
        console.info('!! It is CODE, not data. The treasury runs it with full authority, once, inside')
        console.info('!! this transaction. Publish this hash alongside the code hash, and have every')
        console.info('!! signer review the source below rather than only the code hash.')
        console.info('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        console.info()
        printMigratorSource(migrator.name)
    }

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const state = await treasury.getState()
    if (state.state.type != 'active') {
        console.info('Treasury account is not active')
        return
    }
    console.info('  current code bytes: %s', state.state.code?.byteLength)
    console.info('  upgrade code bytes: %s', newCode.toBoc().byteLength)

    // Rehearse the whole upgrade against the account as it exists right now, and show what moves.
    // A migration is the one thing here that cannot be undone, so the operator should approve a diff
    // of real state rather than a description of intent.
    if (state.state.code == null || state.state.data == null) {
        console.info('Treasury account has no code or data on chain')
        return
    }
    const liveState = await treasury.getTreasuryState()
    console.info()
    console.info('Replaying the upgrade against live state...')
    const dryRun = await dryRunUpgrade({
        address: treasuryAddress,
        currentCode: Cell.fromBoc(state.state.code)[0],
        currentData: Cell.fromBoc(state.state.data)[0],
        newCode,
        migrateCode,
        governor: liveState.governor,
    })
    console.info()
    console.info(formatDryRun(dryRun))
    console.info()

    if (!dryRun.ok) {
        console.info('Aborted: the dry run says this upgrade would fail. Nothing was sent.')
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
            console.info('Migrator hash did not match. Aborted')
            return
        }
    }

    const confirm = await ui.input('\n\nTo confirm the upgrade, enter yes in capital case')
    if (confirm !== 'YES') {
        console.info('Aborted')
        return
    }

    await treasury.sendUpgradeCode(provider.sender(), { value: '0.1', newCode, migrateCode })

    ui.write('Done')

    ui.write('\n Remember to log the upgrade date and time: ' + new Date().toISOString())
}

// Prints the migrator's source so the last thing the operator sees before signing is what will run,
// not a hash standing in for it.
function printMigratorSource(name: string) {
    const path = migratorSourcePath(name)
    if (!existsSync(path)) {
        console.info('WARNING: could not locate migrator source at %s. Read it manually before signing.', path)
        console.info()
        return
    }
    console.info('---- %s ----', path)
    console.info(readFileSync(path, 'utf8'))
    console.info('---- end of migrator source ----')
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
