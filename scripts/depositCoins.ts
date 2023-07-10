import { Address, toNano } from 'ton-core';
import { Treasury } from '../wrappers/Treasury';
import { NetworkProvider, sleep } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const address = Address.parse(args.length > 0 ? args[0] : await ui.input('Treasury address'));
    if (!(await provider.isContractDeployed(address))) {
        ui.write(`Error: Contract at address ${address} is not deployed`);
        return;
    }

    const treasury = provider.open(Treasury.createFromAddress(address));
    const balanceBefore = await treasury.getBalance();
    const amount = await ui.input('TON amount to deposit')
    const recipient = provider.sender().address
    if (recipient == null) {
        ui.write(`Error: recipient address is undefined`)
        return
    }

    await treasury.sendDepositCoins(provider.sender(), { value: toNano(amount) })

    ui.write('Waiting for balance to change...');
    let balanceAfter = await treasury.getBalance();
    let attempt = 1;
    while (balanceAfter === balanceBefore) {
        ui.setActionPrompt(`Attempt ${attempt}`);
        await sleep(2000);
        balanceAfter = await treasury.getBalance();
        attempt += 1;
    }

    ui.clearActionPrompt();
    ui.write('Done');
}
