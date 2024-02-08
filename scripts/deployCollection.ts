import { toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { LibraryDeployer } from '../wrappers/LibraryDeployer'

export async function run(provider: NetworkProvider) {
    const collectionDeployer = provider.open(
        LibraryDeployer.createFromConfig(
            {
                libraryCode: await compile('Collection'),
            },
            await compile('LibraryDeployer'),
        ),
    )

    const ui = provider.ui()
    const confirm = await ui.input('\n\nDeploy collection as library? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await collectionDeployer.sendDeploy(provider.sender(), toNano('0.1'))
    await provider.waitForDeploy(collectionDeployer.address)

    const libraryAddress = collectionDeployer.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: provider.network() !== 'mainnet',
    })

    ui.clearActionPrompt()
    ui.write(`Library address of collection: ${libraryAddress}`)
}
