import { toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { LibraryDeployer } from '../wrappers/LibraryDeployer'

export async function run(provider: NetworkProvider) {
    const billDeployer = provider.open(
        LibraryDeployer.createFromConfig(
            {
                libraryCode: await compile('Bill'),
            },
            await compile('LibraryDeployer'),
        ),
    )

    const ui = provider.ui()
    const confirm = await ui.input('\n\nDeploy bill as library? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await billDeployer.sendDeploy(provider.sender(), toNano('0.1'))
    await provider.waitForDeploy(billDeployer.address)

    const libraryAddress = billDeployer.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: provider.network() !== 'mainnet',
    })

    ui.clearActionPrompt()
    ui.write(`Library address of bill: ${libraryAddress}`)
}
