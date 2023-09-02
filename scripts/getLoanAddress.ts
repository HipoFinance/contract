import { Address } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('participation round'))
    const validatorAddress = provider.sender().address
    if (validatorAddress == null) {
        return
    }

    const loanAddress = await treasury.getLoanAddress(validatorAddress, roundSince)
    console.info('Loan Address:\n  Raw: %s\n  Friendly: %s\n', loanAddress.toRawString(), loanAddress.toString({ urlSafe: true, bounceable: true, testOnly: true }))

    ui.write('Done');
}
