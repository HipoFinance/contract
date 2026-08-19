import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending retry_recover_stakes')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('Enter round since'))

    console.info()
    console.info('Note that the round must be in state recovering for this op to succeed.')
    console.info('If it is in any other state, retry_recover_stakes is refused.')

    await treasury.sendRetryRecoverStakes(provider.sender(), { value: '0.1', roundSince })

    ui.write('Done')
}
