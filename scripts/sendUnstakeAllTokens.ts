import { Address } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending send_unstake_all_tokens')

    const owners = [
        '',
    ]
    owners.forEach((owner) => {
        if (Address.parse(owner).toString({ bounceable: false }) !== owner) {
            throw new Error('invalid address: ' + owner)
        }
    })

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    for (const owner of owners) {
        await treasury.sendSendUnstakeAllTokens(provider.sender(), {
            value: '0.25',
            owner: Address.parse(owner),
        })
        await sleep(45000)
    }

    ui.write('Done')
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
}
