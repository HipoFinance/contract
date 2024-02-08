import { toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { LibraryDeployer } from '../wrappers/LibraryDeployer'

export async function run(provider: NetworkProvider) {
    const loanDeployer = provider.open(
        LibraryDeployer.createFromConfig(
            {
                libraryCode: await compile('Loan'),
            },
            await compile('LibraryDeployer'),
        ),
    )

    const ui = provider.ui()
    const confirm = await ui.input('\n\nDeploy loan as library? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await loanDeployer.sendDeploy(provider.sender(), toNano('0.1'))
    await provider.waitForDeploy(loanDeployer.address)

    const libraryAddress = loanDeployer.address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: provider.network() !== 'mainnet',
    })

    ui.clearActionPrompt()
    ui.write(`Library address of loan: ${libraryAddress}`)
}
