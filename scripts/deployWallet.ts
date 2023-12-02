import { toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { LibraryDeployer } from '../wrappers/LibraryDeployer'

export async function run(provider: NetworkProvider) {
    const walletDeployer = provider.open(
        LibraryDeployer.createFromConfig(
            {
                libraryCode: await compile('Wallet'),
            },
            await compile('LibraryDeployer'),
        ),
    )

    const ui = provider.ui()
    const confirm = await ui.input('\n\nDeploy a new wallet as library? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await walletDeployer.sendDeploy(provider.sender(), toNano('0.1'))
    await provider.waitForDeploy(walletDeployer.address)

    const libraryAddress = walletDeployer.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: provider.network() !== 'mainnet',
    })

    ui.clearActionPrompt()
    ui.write(`Library Address: ${libraryAddress}`)
    ui.write('Done')
}
