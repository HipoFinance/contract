import { Address } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Setting rounds imbalance')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundsImbalance = await ui.input('What should be the rounds imbalance rate? [0-255]')

    await treasury.sendSetRoundsImbalance(provider.sender(), {
        value: '0.1',
        newRoundsImbalance: BigInt(roundsImbalance),
    })

    ui.write('Done')
}
