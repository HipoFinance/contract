import { beginCell, Cell, Dictionary, toNano } from 'ton-core'
import { Root, loanDataToCell } from '../wrappers/Root'
import { compile, NetworkProvider } from '@ton-community/blueprint'
import { sha256_sync } from 'ton-crypto'

export async function run(provider: NetworkProvider) {
    const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
        .set(toSha256("decimals"), toTextCell("9"))
        .set(toSha256("symbol"), toTextCell("hTON"))
        .set(toSha256("name"), toTextCell("Hipo TON"))
        .set(toSha256("description"), toTextCell("Liquidity for staked tokens on StakeHipo protocol"))
        .set(toSha256("image"), toTextCell("https://stakehipo.com/logo.png"))
    const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

    const emptyLoanData = loanDataToCell({
        currentReward: 0n,
        currentTotal: 0n,
        activeNext: 0n,
        rewardNext: 0n,
        activeLater: 0n,
        rewardLater: 0n,
    })

    const root = provider.open(
        Root.createFromConfig(
            {
                state: Root.state.stakeHeld,
                roundSince: 0,
                totalActive: 0n,
                totalNext: 0n,
                totalLater: 0n,
                walletCode: await compile('Wallet'),
                poolCode: await compile('Pool'),
                loanData: emptyLoanData,
                roundNext: 0,
                durationNext: 0,
                heldNext: 0,
                participationStart: 0,
                roundLater: 0,
                durationLater: 0,
                heldLater: 0,
                content,
            },
            await compile('Root')
        )
    )

    await root.sendDeploy(provider.sender(), toNano('0.05'))

    await provider.waitForDeploy(root.address)

    console.log(
        'root address: %s\nroot balances: %o',
        root.address,
        await root.getTotalBalances(),
    )
}

function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
