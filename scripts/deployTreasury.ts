import { beginCell, Cell, Dictionary, toNano } from '@ton/core'
import { emptyDictionaryValue, participationDictionaryValue, Treasury } from '../wrappers/Treasury'
import { compile, NetworkProvider } from '@ton/blueprint'
import { sha256_sync } from 'ton-crypto'
import { LibraryDeployer } from '../wrappers/LibraryDeployer'
import { Parent } from '../wrappers/Parent'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    const governor = provider.sender().address
    if (governor == null) {
        return
    }

    const treasuryCode = await compile('Treasury')
    const parentCode = await compile('Parent')
    const mainWalletCode = await compile('Wallet')
    const mainCollectionCode = await compile('Collection')
    const mainBillCode = await compile('Bill')
    const mainLoanCode = await compile('Loan')
    const walletCode = LibraryDeployer.exportLibCode(mainWalletCode)
    const collectionCode = LibraryDeployer.exportLibCode(mainCollectionCode)
    const billCode = LibraryDeployer.exportLibCode(mainBillCode)
    const loanCode = LibraryDeployer.exportLibCode(mainLoanCode)

    const treasury = provider.open(
        Treasury.createFromConfig(
            {
                totalCoins: 0n,
                totalTokens: 0n,
                totalStaking: 0n,
                totalUnstaking: 0n,
                totalValidatorsStake: 0n,
                parent: null,
                participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                roundsImbalance: 255n,
                stopped: false,
                loanCode,
                lastStaked: 0n,
                lastRecovered: 0n,
                halter: governor,
                governor: governor,
                proposedGovernor: null,
                governanceFee: 4096n,
                collectionCode,
                billCode,
                oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
            },
            treasuryCode,
        ),
    )

    const parent = provider.open(
        Parent.createFromConfig(
            {
                totalTokens: 0n,
                treasury: treasury.address,
                walletCode,
                content,
            },
            parentCode,
        ),
    )

    const confirm = await ui.input('\n\nDeploy treasury and parent? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendDeploy(provider.sender(), { value: toNano('0.1') })
    await parent.sendDeploy(provider.sender(), { value: toNano('0.1') })
    await treasury.sendSetParent(provider.sender(), { value: toNano('0.1'), newParent: parent.address })

    await provider.waitForDeploy(treasury.address)
    await provider.waitForDeploy(parent.address)

    const fees = await treasury.getFees()

    await treasury.sendWithdrawSurplus(provider.sender(), { value: fees.treasuryStorage })
    await treasury.sendProxyWithdrawSurplus(provider.sender(), { value: toNano('1'), destination: parent.address })

    const treasuryAddress = treasury.address.toString({
        bounceable: true,
        urlSafe: true,
        testOnly: provider.network() !== 'mainnet',
    })
    const parentAddress = parent.address.toString({
        bounceable: true,
        urlSafe: true,
        testOnly: provider.network() !== 'mainnet',
    })

    ui.clearActionPrompt()
    ui.write(`Address of treasury: ${treasuryAddress}`)
    ui.write(`Address of parent: ${parentAddress}`)
}

const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
    .set(toSha256('decimals'), toTextCell('9'))
    .set(toSha256('symbol'), toTextCell('hTON'))
    .set(toSha256('name'), toTextCell('hTON'))
    .set(toSha256('description'), toTextCell('Hipo liquid staking protocol, version 2'))
    .set(toSha256('image'), toTextCell('https://app.hipo.finance/hton.png'))

const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
