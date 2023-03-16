import { beginCell, Cell, Dictionary, toNano } from 'ton-core'
import { Root } from '../wrappers/Root'
import { compile, NetworkProvider } from '@ton-community/blueprint'
import { sha256 } from 'ton-crypto'

export async function run(provider: NetworkProvider) {
    const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
        .set(await toSha256("decimals"), toTextCell("9"))
        .set(await toSha256("symbol"), toTextCell("hTON"))
        .set(await toSha256("name"), toTextCell("Hipo TON"))
        .set(await toSha256("description"), toTextCell("Liquidity for staked tokens on StakeHipo protocol"))
        .set(await toSha256("image"), toTextCell("https://stakehipo.com/logo.png"))
    const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

    const root = Root.createFromConfig({
        totalActive: 0n,
        totalNext: 0n,
        totalLater: 0n,
        round: 0n,
        content,
        walletCode: await compile('Wallet'),
    }, await compile('Root'))

    const opTopUp = 0x34e5d45a
    const body = beginCell().storeUint(opTopUp, 32).endCell()
    await provider.deploy(root, toNano('0.05'), body)

    const openedContract = provider.open(root)

    console.log(
        'root address: %s\nroot balances: %o',
        openedContract.address,
        await openedContract.getTotalBalances(),
    )
}

async function toSha256(s: string): Promise<bigint> {
    return BigInt('0x' + (await sha256(s)).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
