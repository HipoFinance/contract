import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending retry_burn_ready')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    console.info()
    const confirm = await ui.input('Are you sure you want to continue? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendRetryBurnReady(provider.sender(), { value: '0.1' })

    ui.write('Done')
}
