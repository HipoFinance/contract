import { Address, beginCell, Cell, Dictionary } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'
import { sha256_sync } from 'ton-crypto'

const name = 'hTON'
const description = 'Hipo liquid staking protocol'
const image = 'https://hipo.finance/hton.png'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    console.info('Setting metadata to:\n\tname: \t\t%s\n\tdescription: \t%s\n\timage: \t\t%s\n', name, description, image)

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    await treasury.sendSetContent(provider.sender(), { value: '0.1', newContent: content })

    ui.write('Done');
}

const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
    .set(toSha256('decimals'), toTextCell('9'))
    .set(toSha256('symbol'), toTextCell('hTON'))
    .set(toSha256('name'), toTextCell(name))
    .set(toSha256('description'), toTextCell(description))
    .set(toSha256('image'), toTextCell(image))

const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
