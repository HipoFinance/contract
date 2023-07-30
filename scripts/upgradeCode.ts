import { Address, beginCell } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider, compile } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const newCode = await compile('Treasury')
    const additionalData = beginCell()

    console.log()
    console.log('UPGRADING CODE')
    console.log("==============")
    console.log("1. Check upgrade_code in treasury.fc before proceeding\n")
    console.log("2. Check upgrade_data in treasury.fc before proceeding\n")
    console.log("3. Check additional data to be sent alongside the upgrade in this deployer script")
    console.log("==============")
    console.log()

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const state = await treasury.getState()
    if (state.state.type != 'active') {
        console.log('Treasury account is not active')
        return
    }
    console.log('  current code bytes: %s', state.state.code?.byteLength)
    console.log('  upgrade code bytes: %s', newCode.toBoc().byteLength)

    const confirm = await ui.input('\n\nTo confirm the upgrade, enter yes in capital case')
    if (confirm !== 'YES') {
        console.log('Aborted')
        return
    }

    await treasury.sendUpgradeCode(provider.sender(), { value: '0.1', newCode, rest: additionalData })

    ui.write('Done');
}
