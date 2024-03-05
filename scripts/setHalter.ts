import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Setting halter')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const newHalterString = await ui.input('Enter the friendly address of the new halter')
    const newHalterAddress = Address.parse(newHalterString)

    const confirm = await ui.input('Set new halter? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendSetHalter(provider.sender(), { value: '0.1', newHalter: newHalterAddress })

    ui.write('Done')
}
