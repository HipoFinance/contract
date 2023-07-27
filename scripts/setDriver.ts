import { Address, beginCell, Cell, Dictionary } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'
import { sha256_sync } from 'ton-crypto'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    console.log('Setting driver')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const driverString = await ui.input('Enter the friendly address of the driver')
    const driverAddress = Address.parse(driverString)

    await treasury.sendSetDriver(provider.sender(), { value: '0.1', newDriver: driverAddress })

    ui.write('Done');
}
