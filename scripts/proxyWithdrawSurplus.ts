import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Withdraw surplus of other parent or librarian')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const destinationString = await ui.input('Enter the friendly address of the destination')
    const destinationAddress = Address.parse(destinationString)

    await treasury.sendProxyWithdrawSurplus(provider.sender(), { value: '0.1', destination: destinationAddress })

    ui.write('Done')
}
