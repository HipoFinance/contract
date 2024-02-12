import { compile } from '@ton/blueprint'

export async function run() {
    const treasuryCode = await compile('Treasury')
    const parentCode = await compile('Parent')
    const walletCode = await compile('Wallet')
    const collectionCode = await compile('Collection')
    const billCode = await compile('Bill')
    const loanCode = await compile('Loan')
    const librarianCode = await compile('Librarian')

    const treasuryCodeHash = treasuryCode.hash()
    const parentCodeHash = parentCode.hash()
    const walletCodeHash = walletCode.hash()
    const collectionCodeHash = collectionCode.hash()
    const billCodeHash = billCode.hash()
    const loanCodeHash = loanCode.hash()
    const librarianCodeHash = librarianCode.hash()

    console.info()

    console.info(`treasury code hash hex:      ${treasuryCodeHash.toString('hex')}`)
    console.info(`treasury code hash base64:   ${treasuryCodeHash.toString('base64')}`)
    console.info()

    console.info(`parent code hash hex:        ${parentCodeHash.toString('hex')}`)
    console.info(`parent code hash base64:     ${parentCodeHash.toString('base64')}`)
    console.info()

    console.info(`wallet code hash hex:        ${walletCodeHash.toString('hex')}`)
    console.info(`wallet code hash base64:     ${walletCodeHash.toString('base64')}`)
    console.info()

    console.info(`collection code hash hex:    ${collectionCodeHash.toString('hex')}`)
    console.info(`collection code hash base64: ${collectionCodeHash.toString('base64')}`)
    console.info()

    console.info(`bill code hash hex:          ${billCodeHash.toString('hex')}`)
    console.info(`bill code hash base64:       ${billCodeHash.toString('base64')}`)
    console.info()

    console.info(`loan code hash hex:          ${loanCodeHash.toString('hex')}`)
    console.info(`loan code hash base64:       ${loanCodeHash.toString('base64')}`)
    console.info()

    console.info(`librarian code hash hex:     ${librarianCodeHash.toString('hex')}`)
    console.info(`librarian code hash base64:  ${librarianCodeHash.toString('base64')}`)
    console.info()
}
