import { Address, fromNano, toNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Treasury } from '../wrappers/Treasury'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Gift Coins')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const amount = await ui.input('Enter the gift amount in TON')
    const coins = toNano(amount)

    const confirm = await ui.input(`Gift ${fromNano(coins)} TON ? [yN]`)
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendGiftCoins(provider.sender(), { value: toNano('0.1') + coins, coins })

    ui.write('Done')
}
