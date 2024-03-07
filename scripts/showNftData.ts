import { Address } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { toMetadataKey } from '../wrappers/Parent'
import { Bill } from '../wrappers/Bill'
import { Collection } from '../wrappers/Collection'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const addressString = await ui.input('Enter the friendly address of the bill')
    const billAddress = Address.parse(addressString)
    const bill = provider.open(Bill.createFromAddress(billAddress))

    const labelsMap: Record<string, string | undefined> = {}
    labelsMap[toMetadataKey('name').toString()] = 'name'
    labelsMap[toMetadataKey('description').toString()] = 'description'

    const [inited, index, collectionAddress, owner, metadata] = await bill.getNftData()
    const revoked = await bill.getRevokedTime()
    const collection = provider.open(Collection.createFromAddress(collectionAddress))
    const [nextItemIndex, collectionMetadata, collectionOwner] = await collection.getCollectionData()
    const billMetadata = await collection.getNftContent(index, metadata)
    const testOnly = provider.network() !== 'mainnet'

    console.info()
    console.info('Collection Data')
    console.info('===============')
    console.info('        length: %s', nextItemIndex.toString())
    console.info('      treasury: %s', collectionOwner.toString({ testOnly }))
    console.info()

    console.info('    Collection Metadata')
    console.info('    -------------------')
    for (const key of ['name', 'description', 'image']) {
        console.info('        %s: %s', key.padStart(12), collectionMetadata.get(toMetadataKey(key)) ?? '')
        collectionMetadata.delete(toMetadataKey(key))
    }
    console.info()

    if (collectionMetadata.size > 0) {
        console.info('    Unknown Keys')
        console.info('    ------------')
        for (const key of collectionMetadata.keys()) {
            console.info('        %s: %s', key.toString(), collectionMetadata.get(key))
        }
        console.info()
    }

    console.info('Bill Data')
    console.info('=========')
    console.info('       revoked: %s', formatDate(revoked))
    console.info('        inited: %s', inited)
    console.info('         index: %s', index.toString())
    console.info('    collection: %s', collectionAddress.toString({ testOnly }))
    console.info('         owner: %s', owner.toString({ testOnly }))
    console.info()

    console.info('    Bill Metadata')
    console.info('    -------------')
    for (const key of ['name', 'description', 'image']) {
        console.info('        %s: %s', key.padStart(12), billMetadata.get(toMetadataKey(key)) ?? '')
        billMetadata.delete(toMetadataKey(key))
    }
    console.info()

    if (billMetadata.size > 0) {
        console.info('    Unknown Keys')
        console.info('    ------------')
        for (const key of billMetadata.keys()) {
            console.info('        %s: %s', key.toString(), billMetadata.get(key))
        }
        console.info()
    }
}

function formatDate(seconds: bigint): string {
    if (seconds === 0n) {
        return ''
    }
    return new Date(Number(seconds) * 1000).toLocaleString(undefined, {
        dateStyle: 'full',
        timeStyle: 'full',
    })
}
