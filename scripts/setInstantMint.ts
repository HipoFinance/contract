import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Setting instant_mint')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const instantMint = await ui.choose('Enable instant mint?', [false, true], (f) => (f ? 'Yes' : 'No'))

    await treasury.sendSetInstantMint(provider.sender(), { value: '0.1', newInstantMint: instantMint })

    ui.write('Done')
}
