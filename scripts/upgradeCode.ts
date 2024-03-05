import { Address, beginCell } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider, compile } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const newCode = await compile('Treasury')
    const newData = beginCell().endCell()

    console.info()
    console.info('UPGRADING CODE')
    console.info('==============')
    console.info('1. Check upgrade_code in treasury.fc before proceeding')
    console.info('2. Check upgrade_data in treasury.fc before proceeding')
    console.info('3. Check new data to be sent alongside the upgrade in this script')
    console.info('4. Update and rebase this repo before continuing to have the correct git hash after upgrade')
    console.info('==============')
    console.info()

    console.info('New code hash hex:      %s', newCode.hash().toString('hex'))
    console.info('New code hash base64:   %s', newCode.hash().toString('base64'))
    console.info()

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

    const confirm = await ui.input('\n\nTo confirm the upgrade, enter yes in capital case')
    if (confirm !== 'YES') {
        console.info('Aborted')
        return
    }

    await treasury.sendUpgradeCode(provider.sender(), { value: '1', newCode, newData })

    ui.write('Done')

    ui.write('\n Remember to log the upgrade date and time: ' + new Date().toISOString())
}
