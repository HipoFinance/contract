import { Address } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { Collection } from '../wrappers/Collection'
import { NetworkProvider } from '@ton/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending retry_burn_all')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('Enter round since'))
    const startIndex = BigInt(await ui.input('Enter start index'))

    const collectionAddress = await treasury.getCollectionAddress(roundSince)
    const collection = provider.open(Collection.createFromAddress(collectionAddress))
    const [nextItemIndex] = await collection.getCollectionData()

    console.info()
    console.info('Collection:      ' + collectionAddress.toString())
    console.info('next_item_index: ' + nextItemIndex.toString())

    // Starting at or past next_item_index sends last_bill_burned straight away, which deletes the
    // participation. Every bill still unburned is then stranded for good: nothing can route a burn
    // to a round that is no longer in the dict.
    if (startIndex >= nextItemIndex) {
        console.info()
        console.info('Refusing: start index ' + startIndex.toString() + ' is not below next_item_index.')
        console.info('That finishes the chain immediately and deletes the participation, stranding')
        console.info('every bill that has not burned yet. Pass an index below next_item_index.')
        return
    }

    if (startIndex > 0n) {
        console.info()
        console.info('Skipping bills 0 to ' + (startIndex - 1n).toString() + '.')
        console.info('Any of those that never settled must be re-minted with retryMintBill first,')
        console.info('while the round is still burning, or they are stranded once this chain ends.')
        console.info('Never restart at 0 on a partially burned round: bills already burned throw,')
        console.info('and bills reaped for storage swallow the message, wedging the chain again.')
    }

    console.info()
    const confirm = await ui.input('Are you sure you want to continue? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendRetryBurnAll(provider.sender(), { value: '0.1', roundSince, startIndex })

    ui.write('Done')
}
