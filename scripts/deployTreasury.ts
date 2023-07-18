import { beginCell, Cell, Dictionary, fromNano, toNano } from 'ton-core'
import { participationDictionaryValue, rewardDictionaryValue, Treasury } from '../wrappers/Treasury'
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

    const governor = provider.sender().address
    if (governor == null) {
        return
    }

    const treasury = provider.open(
        Treasury.createFromConfig({
            totalCoins: 0n,
            totalTokens: 0n,
            totalStaking: 0n,
            totalUnstaking: 0n,
            totalValidatorsStake: 0n,
            participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
            stopped: false,
            walletCode: await compile('Wallet'),
            loanCode: await compile('Loan'),
            driver: governor,
            halter: governor,
            governor: governor,
            proposedGovernor: null,
            rewardShare: 4096n,
            rewardsHistory: Dictionary.empty(Dictionary.Keys.BigUint(32), rewardDictionaryValue),
            content,
        }, await compile('Treasury'))
    )
    await treasury.sendDeploy(provider.sender(), { value: toNano('0.01') })
    await provider.waitForDeploy(treasury.address)
    ui.write(`Treasury address: ${treasury.address}\nTreasury ton balance: ${await treasury.getBalance()}\n`)

    const fees = await treasury.getFees()
    const choice = await ui.choose(
        `Top up treasury's balance to ${fromNano(fees.treasuryStorage)} TON?`,
        [false, true], v => v ? 'Yes' : 'No'
    )
    if (choice) {
        const balanceBefore = await treasury.getBalance();
        await treasury.sendTopUp(provider.sender(), { value: fees.treasuryStorage })
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
