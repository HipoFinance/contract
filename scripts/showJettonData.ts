import { Address, Dictionary } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Parent, metadataDictionaryValue, toMetadataKey } from '../wrappers/Parent'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const addressString = await ui.input('Enter the friendly address of the jetton')
    const parentAddress = Address.parse(addressString)
    const parent = provider.open(Parent.createFromAddress(parentAddress))

    const cell = (await parent.getJettonData())[3]
    const slice = cell.beginParse()
    const prefix = slice.loadUint(8)
    if (prefix !== 0) {
        console.info('Expected a zero prefix for metadata but got %s', prefix)
        return
    }
    const metadata = slice.loadDict(Dictionary.Keys.BigUint(256), metadataDictionaryValue)

    const labelsMap: Record<string, string | undefined> = {}
    labelsMap[toMetadataKey('decimals').toString()] = 'decimals'
    labelsMap[toMetadataKey('symbol').toString()] = 'symbol'
    labelsMap[toMetadataKey('name').toString()] = 'name'
    labelsMap[toMetadataKey('description').toString()] = 'description'
    labelsMap[toMetadataKey('image').toString()] = 'image'

    console.info()
    console.info('Jetton Metadata')
    console.info('===============')
    for (const key of ['decimals', 'symbol', 'name', 'description', 'image']) {
        console.info('    %s: %s', key.padStart(12), metadata.get(toMetadataKey(key)) ?? '')
        metadata.delete(toMetadataKey(key))
    }
    console.info()

    if (metadata.size > 0) {
        console.info('Unknown Keys')
        console.info('------------')
        for (const key of metadata.keys()) {
            console.info('    %s: %s', key.toString(), metadata.get(key))
        }
        console.info()
    }
}
