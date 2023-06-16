import { beginCell, Cell, Dictionary, fromNano, toNano } from 'ton-core'
import { Root } from '../wrappers/Root'
import { compile, NetworkProvider, sleep } from '@ton-community/blueprint'
import { sha256_sync } from 'ton-crypto'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
        .set(toSha256("decimals"), toTextCell("9"))
        .set(toSha256("symbol"), toTextCell("hTON"))
        .set(toSha256("name"), toTextCell("Hipo TON"))
        .set(toSha256("description"), toTextCell("Liquidity for staked tokens on StakeHipo protocol"))
        .set(toSha256("image"), toTextCell("https://stakehipo.com/logo.png"))
    const content = beginCell().storeUint(0, 8).storeDict(contentDict).endCell()

    const root = provider.open(
        Root.createFromConfig({
            walletCode: await compile('Wallet'),
            poolCode: await compile('Pool'),
            content,
        }, await compile('Root'))
    )

    await root.sendDeploy(provider.sender(), toNano('0.01'))

    await provider.waitForDeploy(root.address)

    ui.write(`root address: ${root.address}\nroot ton balance: ${await root.getBalance()}\n`)

    const fees = await root.getFees()

    const choice = await ui.choose(
        `Top up root's balance to ${fromNano(fees.rootStorage)} TON?`,
        [false, true], v => v ? 'Yes' : 'No'
    )

    if (choice) {
        const balanceBefore = await root.getBalance();

        await root.sendTopUp(provider.sender(), fees.rootStorage)

        ui.write('Waiting for balance to change...');

        let balanceAfter = await root.getBalance();
        let attempt = 1;
        while (balanceAfter === balanceBefore) {
            ui.setActionPrompt(`Attempt ${attempt}`);
            await sleep(2000);
            balanceAfter = await root.getBalance();
            attempt++;
        }
        ui.clearActionPrompt();
        ui.write('Topped up successfully!');
    }
}

function toSha256(s: string): bigint {
    return BigInt('0x' + sha256_sync(s).toString('hex'))
}

function toTextCell(s: string): Cell {
    return beginCell().storeUint(0, 8).storeStringTail(s).endCell()
}
