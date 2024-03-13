import { Address, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Treasury } from '../wrappers/Treasury'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info()
    console.info('Send Upgrade Wallet')
    console.info('===================')
    console.info()

    const treasuryAddress = Address.parse(await ui.input('Enter the friendly address of the treasury'))
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const destination = Address.parse(await ui.input('Enter the friendly address of the old parent'))
    const owner = Address.parse(await ui.input('Enter the friendly address of the owner'))

    const confirm = await ui.input(`Send upgrade wallet? [yN]`)
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendSendUpgradeWallet(provider.sender(), { value: toNano('0.1'), destination, owner })
}
