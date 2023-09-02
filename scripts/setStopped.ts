import { Address } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    console.info('Setting stopped')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const stopped = await ui.choose('Should this treasury be stopped?', [false, true], f => f ? 'Yes' : 'No')

    await treasury.sendSetStopped(provider.sender(), { value: '0.1', newStopped: stopped })

    ui.write('Done');
}
