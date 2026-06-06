import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Setting governance fee')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const governanceFee = await ui.input('What should be the governance fee? [0-65535]')

    await treasury.sendSetGovernanceFee(provider.sender(), {
        value: '0.1',
        newGovernanceFee: BigInt(governanceFee),
    })

    ui.write('Done')
}
