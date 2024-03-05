import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { compile, NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const treasuryAddress = await ui.input('Enter the friendly address of the treasury')
    const treasury = provider.open(Treasury.createFromAddress(Address.parse(treasuryAddress)))

    const librarianAddress = await ui.input('Enter the friendly address of the librarian')

    const code = await compile('Loan')

    console.info('Code hash hex:      %s', code.hash().toString('hex'))
    console.info('Code hash base64:   %s', code.hash().toString('base64'))
    console.info()

    const confirm = await ui.input('Are you sure you want to continue? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendProxyAddLibrary(provider.sender(), {
        value: '0.3',
        destination: Address.parse(librarianAddress),
        code,
    })

    ui.write('Done')
}
