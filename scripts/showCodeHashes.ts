import { compile } from '@ton/blueprint'

export async function run() {
    const treasuryCode = await compile('Treasury')
    const walletCode = await compile('Wallet')
    const loanCode = await compile('Loan')

    const treasuryCodeHash = treasuryCode.hash()
    const walletCodeHash = walletCode.hash()
    const loanCodeHash = loanCode.hash()

    console.info()

    console.info(`treasury code hash hex:    ${treasuryCodeHash.toString('hex')}`)
    console.info(`treasury code hash base64: ${treasuryCodeHash.toString('base64')}`)
    console.info()

    console.info(`wallet code hash hex:    ${walletCodeHash.toString('hex')}`)
    console.info(`wallet code hash base64: ${walletCodeHash.toString('base64')}`)
    console.info()

    console.info(`loan code hash hex:    ${loanCodeHash.toString('hex')}`)
    console.info(`loan code hash base64: ${loanCodeHash.toString('base64')}`)
    console.info()
}
