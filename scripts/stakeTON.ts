import { Address, toNano } from 'ton-core';
import { Root } from '../wrappers/Root';
import { NetworkProvider, sleep } from '@ton-community/blueprint';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();

    const address = Address.parse(args.length > 0 ? args[0] : await ui.input('Root address'));

    if (!(await provider.isContractDeployed(address))) {
        ui.write(`Error: Contract at address ${address} is not deployed!`);
        return;
    }

    const root = provider.open(Root.createFromAddress(address));

    const balanceBefore = await root.getStateBalance();

    await root.sendSimpleTransfer(provider.sender(), {
        value: toNano('1'),
    });

    ui.write('Waiting for balances to change...');

    let balanceAfter = await root.getStateBalance();
    let attempt = 1;
    while (balanceAfter === balanceBefore) {
        ui.setActionPrompt(`Attempt ${attempt}`);
        await sleep(2000);
        balanceAfter = await root.getStateBalance();
        attempt++;
    }

    ui.clearActionPrompt();
    ui.write('Counter increased successfully!');
}
