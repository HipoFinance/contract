import { beginCell, Cell, Dictionary, toNano } from '@ton/core'
import { participationDictionaryValue, Treasury } from '../wrappers/Treasury'
import { compile, NetworkProvider } from '@ton/blueprint'
import { sha256_sync } from 'ton-crypto'
import { LibraryDeployer } from '../wrappers/LibraryDeployer'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const governor = provider.sender().address
    if (governor == null) {
        return
    }

    const treasury = provider.open(
        Treasury.createFromConfig(
            {
                totalCoins: 0n,
                totalTokens: 0n,
                totalStaking: 0n,
                totalUnstaking: 0n,
                totalValidatorsStake: 0n,
                lastStaked: 0n,
                lastRecovered: 0n,
                participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                roundsImbalance: 255n,
                stopped: false,
                walletCode: LibraryDeployer.exportLibCode(await compile('Wallet')),
                loanCode: await compile('Loan'),
                driver: governor,
                halter: governor,
                governor: governor,
                proposedGovernor: null,
                governanceFee: 4096n,
                content,
            },
            await compile('Treasury'),
        ),
    )
    const confirm = await ui.input('\n\nDeploy a new contract? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }
    await treasury.sendDeploy(provider.sender(), { value: toNano('10.01') })
    await provider.waitForDeploy(treasury.address)

    ui.clearActionPrompt()
    ui.write('Done')
}

const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
    .set(toSha256('decimals'), toTextCell('9'))
    .set(toSha256('symbol'), toTextCell('hTON'))
    .set(toSha256('name'), toTextCell('hTON'))
    .set(toSha256('description'), toTextCell('Hipo liquid staking protocol'))
    .set(toSha256('image'), toTextCell('https://app.hipo.finance/hton.png'))

const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
