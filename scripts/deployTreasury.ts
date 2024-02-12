import { beginCell, Cell, Dictionary } from '@ton/core'
import { emptyDictionaryValue, participationDictionaryValue, Treasury } from '../wrappers/Treasury'
import { compile, NetworkProvider } from '@ton/blueprint'
import { sha256_sync } from 'ton-crypto'
import { Parent } from '../wrappers/Parent'
import { exportLibCode, Librarian } from '../wrappers/Librarian'

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
    const librarianCode = await compile('Librarian')
    const walletCode = exportLibCode(mainWalletCode)
    const collectionCode = exportLibCode(mainCollectionCode)
    const billCode = exportLibCode(mainBillCode)
    const loanCode = exportLibCode(mainLoanCode)

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
                loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, loanCode),
                lastStaked: 0n,
                lastRecovered: 0n,
                halter: governor,
                governor: governor,
                proposedGovernor: null,
                governanceFee: 4096n,
                collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                    0n,
                    collectionCode,
                ),
                billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, billCode),
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

    const librarian = provider.open(
        Librarian.createFromConfig(
            {
                treasury: treasury.address,
            },
            librarianCode,
        ),
    )

    const confirm = await ui.input('\n\nDeploy treasury, parent, wallet, collection, bill, and librarian? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    await treasury.sendDeploy(provider.sender(), { value: '0.1' })
    await parent.sendDeploy(provider.sender(), { value: '0.1' })
    await librarian.sendDeploy(provider.sender(), { value: '0.1' })

    await provider.waitForDeploy(treasury.address)
    await provider.waitForDeploy(parent.address)
    await provider.waitForDeploy(librarian.address)

    await treasury.sendSetParent(provider.sender(), { value: '0.1', newParent: parent.address })
    await treasury.sendProxySetLibrary(provider.sender(), {
        value: '0.1',
        destination: librarian.address,
        mode: 2n,
        code: mainWalletCode,
    })
    await treasury.sendProxySetLibrary(provider.sender(), {
        value: '0.1',
        destination: librarian.address,
        mode: 2n,
        code: mainCollectionCode,
    })
    await treasury.sendProxySetLibrary(provider.sender(), {
        value: '0.1',
        destination: librarian.address,
        mode: 2n,
        code: mainBillCode,
    })
    await treasury.sendProxySetLibrary(provider.sender(), {
        value: '0.1',
        destination: librarian.address,
        mode: 2n,
        code: mainLoanCode,
    })

    const testOnly = provider.network() !== 'mainnet'
    const treasuryAddress = treasury.address.toString({ bounceable: true, urlSafe: true, testOnly })
    const parentAddress = parent.address.toString({ bounceable: true, urlSafe: true, testOnly })
    const librarianAddress = librarian.address.toString({ bounceable: true, urlSafe: true, testOnly })

    ui.clearActionPrompt()
    ui.write(`Address of treasury: ${treasuryAddress}`)
    ui.write(`Address of parent: ${parentAddress}`)
    ui.write(`Address of librarian: ${librarianAddress}`)
    ui.write('')
    ui.write(`Don't forget to top up treasury and librarian.`)
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
