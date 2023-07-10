import { beginCell, Cell, Dictionary, fromNano, toNano } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { compile, NetworkProvider, sleep } from '@ton-community/blueprint'
import { sha256_sync } from 'ton-crypto'

const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
.set(toSha256("decimals"), toTextCell("9"))
.set(toSha256("symbol"), toTextCell("hTON"))
.set(toSha256("name"), toTextCell("Hipo TON"))
.set(toSha256("description"), toTextCell("Liquidity for staked tokens on StakeHipo protocol"))
.set(toSha256("image"), toTextCell("https://hipo.finance/hton.png"))
const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const treasury = provider.open(
        Treasury.createFromConfig({
            walletCode: await compile('Wallet'),
            loanCode: await compile('Loan'),
            content,
        }, await compile('Treasury'))
    )
    await treasury.sendDeploy(provider.sender(), toNano('0.01'))
    await provider.waitForDeploy(treasury.address)
    ui.write(`treasury address: ${treasury.address}\ntreasury ton balance: ${await treasury.getBalance()}\n`)

    const fees = await treasury.getFees()
    const choice = await ui.choose(
        `Top up treasury's balance to ${fromNano(fees.treasuryStorage)} TON?`,
        [false, true], v => v ? 'Yes' : 'No'
    )
    if (choice) {
        const balanceBefore = await treasury.getBalance();
        await treasury.sendTopUp(provider.sender(), fees.treasuryStorage)
        ui.write('Waiting for balance to change...');
        let balanceAfter = await treasury.getBalance();
        let attempt = 1;
        while (balanceAfter === balanceBefore) {
            ui.setActionPrompt(`Attempt ${attempt}`);
            await sleep(2000);
            balanceAfter = await treasury.getBalance();
            attempt += 1;
        }
    }

    ui.clearActionPrompt();
    ui.write('Done');
}

function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
