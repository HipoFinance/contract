import { Address, beginCell } from '@ton/core'
import { Treasury } from '../wrappers/Treasury'
import { NetworkProvider } from '@ton/blueprint'
import { op } from '../wrappers/common'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()

    console.info('Sending send_message_to_loan')

    const addressString = await ui.input('Enter the friendly address of the treasury')
    const treasuryAddress = Address.parse(addressString)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const borrowerAddressString = await ui.input('Enter the friendly address of the borrower')
    const borrower = Address.parse(borrowerAddressString)

    const roundSince = BigInt(await ui.input('Enter round since'))

    const queryId = 0n
    const message = beginCell().storeUint(op.proxyRecoverStake, 32).storeUint(queryId, 64).endCell()

    const loanAddress = await treasury.getLoanAddress(borrower, roundSince)
    console.info(
        'Loan Address:\n  Raw: %s\n  Friendly: %s\n',
        loanAddress.toRawString(),
        loanAddress.toString({ urlSafe: true, bounceable: true, testOnly: true }),
    )

    console.info()
    console.info('Note that this forwards proxy_recover_stake to the loan above, and the treasury only')
    console.info('accepts this for the given round if both hold:')
    console.info("  1. the round's current_vset_hash differs from both the current and the previous")
    console.info('     validator set')
    console.info("  2. now() is at or past the round's stake_held_until")
    console.info('A round no longer present in participations passes both guards trivially, so this op')
    console.info('is effectively unrestricted for stale or already-removed rounds.')

    const confirm = await ui.input('\n\nTo confirm sending the message, enter yes in capital case')
    if (confirm !== 'YES') {
        console.info('Aborted')
        return
    }

    await treasury.sendSendMessageToLoan(provider.sender(), { value: '0.1', borrower, roundSince, message })

    ui.write('Done')
}
