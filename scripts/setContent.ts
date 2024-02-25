import { Address, beginCell, Dictionary } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'
import { metadataDictionaryValue, toMetadataKey } from '../wrappers/Parent'

const name = 'hTON'
const description = 'Hipo liquid staking protocol'
const image = 'https://hipo.finance/hton.png'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info(
        'Setting metadata to:\n\tname: \t\t%s\n\tdescription: \t%s\n\timage: \t\t%s\n',
        name,
        description,
        image,
    )

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
    .set(toMetadataKey('decimals'), '9')
    .set(toMetadataKey('symbol'), 'hTON')
    .set(toMetadataKey('name'), name)
    .set(toMetadataKey('description'), description)
    .set(toMetadataKey('image'), image)

const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()
