import { Address } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const addressString = await ui.input('treasury\'s friendly address')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('participation round'))

    await treasury.sendFinishParticipation({ roundSince })

    ui.write('Done');
}
