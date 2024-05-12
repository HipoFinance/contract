import { Address, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Treasury } from '../wrappers/Treasury'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info()
    console.info('Send Upgrade Wallet Batch')
    console.info('=========================')
    console.info()

    const owners = ['']
    owners.forEach((owner) => {
        if (Address.parse(owner).toString({ bounceable: false }) !== owner) {
            throw new Error('invalid address: ' + owner)
        }
    })

    const treasuryAddress = Address.parse(await ui.input('Enter the friendly address of the treasury'))
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const destination = Address.parse(await ui.input('Enter the friendly address of the old parent'))

    const confirm = await ui.input(`Send upgrade wallet to ${owners.length.toString()} addresses? [yN]`)
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    for (const owner of owners) {
        await treasury.sendSendUpgradeWallet(provider.sender(), {
            value: toNano('0.075'),
            destination,
            owner: Address.parse(owner),
        })
        await sleep(36000)
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
}
