import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending process-loan-requests')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('Enter round since'))

    await treasury.sendRetryDistribute(provider.sender(), { value: '0.1', roundSince })

    ui.write('Done')
}
