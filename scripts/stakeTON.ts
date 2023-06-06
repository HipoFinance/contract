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

    const balanceBefore = await root.getTonBalance();

    const amountTon = await ui.input('TON amount to stake')
    const amountNano = toNano(amountTon)
    const recipient = provider.sender().address
    if (recipient == null) {
        ui.write(`Error: recipient address is undefined`)
        return
    }

    await root.sendStakeTon(provider.sender(), {
        value: amountNano + toNano('0.1'),
        tokens: amountNano,
        recipient: recipient,
        returnExcess: recipient,
    })

    ui.write('Waiting for balance to change...');

    let balanceAfter = await root.getTonBalance();
    let attempt = 1;
    while (balanceAfter === balanceBefore) {
        ui.setActionPrompt(`Attempt ${attempt}`);
        await sleep(2000);
        balanceAfter = await root.getTonBalance();
        attempt++;
    }

    ui.clearActionPrompt();
    ui.write('Staked successfully!');
}
