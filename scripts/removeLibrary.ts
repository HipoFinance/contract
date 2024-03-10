import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const treasuryAddress = await ui.input('Enter the friendly address of the treasury')
    const treasury = provider.open(Treasury.createFromAddress(Address.parse(treasuryAddress)))

    const librarianAddress = await ui.input('Enter the friendly address of the librarian')

    const codeHashString = await ui.input('Enter code hash of a library code to remove')
    const codeHash = BigInt('0x' + codeHashString)

    console.info()
    console.info('Note that removing a library can halt smart contracts that are using it.')
    const confirm = await ui.input('Are you sure you want to REMOVE this code hash? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendProxyRemoveLibrary(provider.sender(), {
        value: '0.1',
        destination: Address.parse(librarianAddress),
        codeHash,
    })

    ui.write('Done')
}
