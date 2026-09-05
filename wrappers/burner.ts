import { Address } from '@ton/core'
import { readFileSync } from 'fs'
import { join } from 'path'

// The recipient of the borrower fee is a constant in contracts/imports/constants.fc rather than
// stored state, because the treasury's extension cell has all four refs taken and an inline address
// would not fit its bit budget either. Changing it is a treasury upgrade.
//
// Read it out of the source rather than repeating it. A copy would keep printing the old address in
// a confirmation prompt the day it changes -- which is the one moment an operator is relying on it
// to be right -- and would keep a test passing against an address the contract no longer uses.
export function burnerAddress(): Address {
    const source = readFileSync(join(__dirname, '..', 'contracts', 'imports', 'constants.fc'), 'utf8')
    const wc = /const int burner::wc = (-?\d+);/.exec(source)
    const addr = /const int burner::addr = 0x([0-9a-f]{64});/.exec(source)
    if (wc == null || addr == null) {
        throw new Error('cannot read burner::wc / burner::addr from contracts/imports/constants.fc')
    }
    return Address.parseRaw(wc[1] + ':' + addr[1])
}
