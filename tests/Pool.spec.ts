import { Blockchain } from '@ton-community/sandbox';
import { Address, Cell, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import '@ton-community/test-utils';
import { compile } from '@ton-community/blueprint';

const emptyAddress = Address.parse("EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c")

describe('Pool', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('Pool');
    });

    it('should deploy', async () => {
        const blockchain = await Blockchain.create();

        const pool = blockchain.openContract(Pool.createFromConfig({
            root: emptyAddress,
            validatorOwner: emptyAddress,
        }, code));

        const deployer = await blockchain.treasury('deployer');

        const deployResult = await pool.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: pool.address,
            deploy: true,
        });
    });
});
