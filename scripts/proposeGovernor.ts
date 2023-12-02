import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Proposing governor')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const governorString = await ui.input('Enter the friendly address of the new governor')
    const governorAddress = Address.parse(governorString)

    await treasury.sendProposeGovernor(provider.sender(), { value: '0.1', newGovernor: governorAddress })

    ui.write('Done')
}
