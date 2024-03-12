import { beginCell, Dictionary } from '@ton/core'
import { emptyDictionaryValue, participationDictionaryValue, Treasury } from '../wrappers/Treasury'
import { compile, NetworkProvider } from '@ton/blueprint'
import { metadataDictionaryValue, Parent, toMetadataKey } from '../wrappers/Parent'
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
                totalBorrowersStake: 0n,
                parent: null,
                participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                roundsImbalance: 255n,
                stopped: false,
                instantMint: false,
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

    const confirm = await ui.input('Deploy treasury, parent, wallet, collection, bill, loan, and librarian? [yN]')
    if (confirm.toLowerCase() !== 'y') {
        return
    }

    const testOnly = provider.network() !== 'mainnet'
    const treasuryAddress = treasury.address.toString({ bounceable: true, urlSafe: true, testOnly })
    const parentAddress = parent.address.toString({ bounceable: true, urlSafe: true, testOnly })
    const librarianAddress = librarian.address.toString({ bounceable: true, urlSafe: true, testOnly })

    console.info('Deploying treasury')
    if (await provider.isContractDeployed(treasury.address)) {
        console.info('    Already deployed at address: %s', treasuryAddress)
    } else {
        await treasury.sendDeploy(provider.sender(), { value: '0.01' })
        await provider.waitForDeploy(treasury.address)
        console.info('    Deployed at address: %s', treasuryAddress)
    }

    console.info('Deploying parent')
    if (await provider.isContractDeployed(parent.address)) {
        console.info('    Already deployed at address: %s', parentAddress)
    } else {
        await parent.sendDeploy(provider.sender(), { value: '0.01' })
        await provider.waitForDeploy(parent.address)
        console.info('    Deployed at address: %s', parentAddress)
    }

    console.info('Deploying librarian')
    if (await provider.isContractDeployed(librarian.address)) {
        console.info('    Already deployed at address: %s', librarianAddress)
    } else {
        await librarian.sendDeploy(provider.sender(), { value: '0.02' })
        await provider.waitForDeploy(librarian.address)
        console.info('    Deployed at address: %s', librarianAddress)
    }

    console.info('Setting parent address in treasury')
    const treasuryState = await treasury.getTreasuryState()
    if (treasuryState.parent != null && parent.address.equals(treasuryState.parent)) {
        console.info('    Already set')
    } else {
        await treasury.sendSetParent(provider.sender(), { value: '0.02', newParent: parent.address })
        await waitForStateChange(10, 2000, async () => {
            const state = await treasury.getTreasuryState()
            return state.parent != null && parent.address.equals(state.parent)
        })
        console.info('    Set')
    }

    console.info('Deploying wallet as a library')
    await treasury.sendProxyAddLibrary(provider.sender(), {
        value: '0.3',
        destination: librarian.address,
        code: mainWalletCode,
    })
    await sleep(10000)

    console.info('Deploying collection as a library')
    await treasury.sendProxyAddLibrary(provider.sender(), {
        value: '0.2',
        destination: librarian.address,
        code: mainCollectionCode,
    })
    await sleep(10000)

    console.info('Deploying bill as a library')
    await treasury.sendProxyAddLibrary(provider.sender(), {
        value: '0.2',
        destination: librarian.address,
        code: mainBillCode,
    })
    await sleep(10000)

    console.info('Deploying loan as a library')
    await treasury.sendProxyAddLibrary(provider.sender(), {
        value: '0.1',
        destination: librarian.address,
        code: mainLoanCode,
    })
    await sleep(10000)

    ui.clearActionPrompt()
    ui.write(`Address of treasury:  ${treasuryAddress}`)
    ui.write(`Address of parent:    ${parentAddress}`)
    ui.write(`Address of librarian: ${librarianAddress}`)
    ui.write('')
    ui.write(`Don't forget to top them up.`)
}

const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), metadataDictionaryValue)
    .set(toMetadataKey('decimals'), '9')
    .set(toMetadataKey('symbol'), 'thTON')
    .set(toMetadataKey('name'), 'Testnet Hipo TON')
    .set(toMetadataKey('description'), 'Hipo liquid staking protocol on testnet, version 2')
    .set(toMetadataKey('image'), 'https://app.hipo.finance/thton.png')

const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms))
}

async function waitForStateChange(attempts: number, sleepDuration: number, check: () => Promise<boolean>) {
    for (let i = 0; i < attempts; i += 1) {
        const done = await check()
        if (done) {
            return
        }
        await sleep(sleepDuration)
    }
    throw new Error('State check failed after ' + attempts + ' attempts')
}
