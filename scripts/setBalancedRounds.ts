import { Address } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    console.log('Setting balanced-rounds')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const balancedRounds = await ui.choose('Should this treasury use balanced rounds?', [false, true], f => f ? 'Yes' : 'No')

    await treasury.sendSetBalancedRounds(provider.sender(), { value: '0.1', newBalancedRounds: balancedRounds })

    ui.write('Done');
}
