import { Address, beginCell, toNano } from 'ton-core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton-community/blueprint'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();

    const addressString = await ui.input('treasury\'s friendly address')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const roundSince = BigInt(await ui.input('participation round'))
    const value = toNano(await ui.input('value'))
    const loanAmount = toNano(await ui.input('loan amount'))
    const minPayment = toNano(await ui.input('min payment'))
    const validatorRewardShare = BigInt(await ui.input('validator reward share [0-255] (default: 102)') || '102')
    const validatorPubkey = BigInt('0x' + await ui.input('validator pubkey'))
    const maxFactor = BigInt(await ui.input('max factor'))
    const adnlAddress = BigInt('0x' + await ui.input('adnl address'))
    const signature = BigInt('0x' + await ui.input('signature'))

    await treasury.sendRequestLoan(provider.sender(), {
        value,
        roundSince,
        loanAmount,
        minPayment,
        validatorRewardShare,
        newStakeMsg: beginCell()
            .storeUint(validatorPubkey, 256)
            .storeUint(roundSince, 32)
            .storeUint(maxFactor, 32)
            .storeUint(adnlAddress, 256)
            .storeRef(beginCell().storeUint(signature, 512))
            .endCell()
    })

    ui.write('Done');
}
