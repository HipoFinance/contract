import { Address, beginCell, Dictionary } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'
import { metadataDictionaryValue, toMetadataKey } from '../wrappers/Parent'

const decimals = '9'
const symbol = 'hTON'
const name = 'Hipo Staked TON'
const description = 'Hipo liquid staking protocol'
const image = 'https://app.hipo.finance/hton.png'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Setting Metadata:')
    console.info('       decimals: %s', decimals)
    console.info('         symbol: %s', symbol)
    console.info('           name: %s', name)
    console.info('    description: %s', description)
    console.info('          image: %s', image)
    console.info()

    const treasuryAddress = await ui.input('Enter the friendly address of the treasury')
    const treasury = provider.open(Treasury.createFromAddress(Address.parse(treasuryAddress)))

    const parentAddress = await ui.input('Enter the friendly address of the parent')

    await treasury.sendProxySetContent(provider.sender(), {
        value: '0.1',
        destination: Address.parse(parentAddress),
        newContent: content,
    })

    ui.write('Done')
}

const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), metadataDictionaryValue)
    .set(toMetadataKey('decimals'), decimals)
    .set(toMetadataKey('symbol'), symbol)
    .set(toMetadataKey('name'), name)
    .set(toMetadataKey('description'), description)
    .set(toMetadataKey('image'), image)

const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()
