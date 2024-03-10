import { Address, toNano } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending retry_mint_bill')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('Enter round since'))
    const amount = toNano(await ui.input('Enter amount in TON'))
    const unstake = await ui.choose('Stake or Unstake?', [false, true], (f) => (f ? 'Unstake' : 'Stake'))
    const owner = Address.parse(await ui.input('Enter owner address'))
    const parent = Address.parse(await ui.input('Enter parent address'))

    console.info()
    console.info('Note that bills are minted in order.')
    const confirm = await ui.input('Are you sure you want to continue? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendRetryMintBill(provider.sender(), {
        value: '0.1',
        roundSince,
        amount,
        unstake,
        owner,
        parent,
        ownershipAssignedAmount: 1n,
    })

    ui.write('Done')
}
