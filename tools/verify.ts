// Publishes a contract's source on verifier.ton.org without a prompt, for use after each mainnet deploy.
//
//   npm run verify                         Treasury and Parent, at their README addresses
//   npm run verify -- Treasury [address]   one contract; the address is optional for contracts not listed below
//   npm run verify -- --new-wallet         creates the testnet wallet that pays the verifier, prints its address
//
// The verifier charges a small fee in testnet GRAM per new code hash, bound to the hash by the transfer's comment.
// This script pays it from its own testnet wallet, then hands the payment to `blueprint verify --payment-tx-hash`,
// which uploads the sources. Code that is already verified costs nothing, and a payment already made for the same
// code hash is reused instead of paying again (the verifier allows three attempts per payment).
//
// The wallet's mnemonic is read from VERIFY_WALLET_MNEMONIC, or else from the file ~/.config/hipo/verify-testnet-wallet.
// Set TONCENTER_TESTNET_API_KEY to lift toncenter's anonymous rate limit.

import { compile } from '@ton/blueprint'
import { Address, beginCell, fromNano, internal, SendMode, Transaction } from '@ton/core'
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto'
import { TonClient, WalletContractV4 } from '@ton/ton'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// The release whose `verify` speaks the verifier's current API. It runs through npx, so the project keeps its own.
const blueprintWithVerify = '@ton/blueprint@0.47.1'

// Our FunC compiler reports itself as 0.4.6-wasmfix.debugger.1, which the verifier does not offer, and an unknown
// version fails after the payment is taken. Its 0.4.6-wasmfix.0 compiles our contracts to the same code hashes.
const verifierFuncVersion = '0.4.6-wasmfix.0'

const deployed: Record<string, string> = {
    Treasury: 'EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ',
    Parent: 'EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w',
}

const verifierApi = 'https://verifier.ton.org/api/v1'
const userAgent = 'hipo-contract-verify'
const maxFee = 20_000_000_000n // refuse a quote above 20 GRAM instead of paying it
const walletFile = join(homedir(), '.config', 'hipo', 'verify-testnet-wallet')

interface Status {
    code_hash: string
    verified: boolean
}

type Ticket =
    | { status: 'already_verified'; code_hash: string }
    | {
          status: 'payment_required'
          code_hash: string
          network: string
          payment_address: string
          amount_nano: string
          comment: string
      }

async function main() {
    const args = process.argv.slice(2)
    if (args[0] === '--new-wallet') {
        await newWallet()
        return
    }
    const targets: [string, string | undefined][] =
        args.length === 0 ? Object.entries(deployed) : [[args[0], args[1] ?? deployed[args[0]]]]
    for (const [name, address] of targets) {
        await verify(name, address)
    }
}

async function verify(name: string, address: string | undefined) {
    const codeHash = (await compile(name)).hash().toString('hex')
    console.info(`\n${name}: local build ${codeHash}`)
    if (address !== undefined) {
        const onChain = await get<Status>(`verification/status?address=${encodeURIComponent(address)}`)
        if (onChain.code_hash !== codeHash) {
            throw new Error(
                `${name} at ${address} runs code ${onChain.code_hash}, not this build. Check out the commit that was ` +
                    'deployed, or deploy this one first.',
            )
        }
    }
    const ticket = await post<Ticket>('take_ticket', {
        code_hash: codeHash,
        compiler: 'func',
        compiler_version: verifierFuncVersion,
    })
    if (ticket.status === 'already_verified') {
        console.info(`${name}: already verified, nothing to pay`)
        return
    }
    const paymentHash = await pay(ticket)
    const flags = ['--payment-tx-hash', paymentHash, '--compiler-version', verifierFuncVersion]
    if (address !== undefined) {
        flags.push('--address', address)
    }
    // Without a terminal, blueprint exits 1 after a successful run ("readline was closed" as it closes its prompt),
    // so its exit code says nothing; the verifier's status below is the check.
    let failure: Error | undefined
    try {
        execFileSync('npx', ['-y', '-p', blueprintWithVerify, 'blueprint', 'verify', name, ...flags], {
            stdio: 'inherit',
        })
    } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e))
    }
    const after = await get<Status>(`verification/status?code_hash=${codeHash}`)
    if (!after.verified) {
        throw failure ?? new Error(`${name}: the verifier does not list ${codeHash} as verified`)
    }
    console.info(`${name}: verified, https://verifier.ton.org/${codeHash}`)
}

// Pays the ticket from the testnet wallet, or finds the payment an earlier run already made. Returns the hash of the
// verifier's incoming transaction, which is what `--payment-tx-hash` takes.
async function pay(ticket: Extract<Ticket, { status: 'payment_required' }>): Promise<string> {
    if (ticket.network !== 'testnet') {
        throw new Error(`The verifier asks for payment on ${ticket.network}; this script only pays on testnet`)
    }
    if (ticket.comment !== `acton-verify:v1:${ticket.code_hash}`) {
        throw new Error(`The verifier's payment comment ${ticket.comment} does not name this code hash`)
    }
    const amount = BigInt(ticket.amount_nano)
    if (amount <= 0n || amount > maxFee) {
        throw new Error(`The verifier quotes ${fromNano(amount)} GRAM; the limit here is ${fromNano(maxFee)}`)
    }
    const recipient = Address.parse(ticket.payment_address)
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_TESTNET_API_KEY,
    })
    const keys = await mnemonicToPrivateKey(readMnemonic())
    const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey }))
    const matches = (tx: Transaction) => isPayment(tx, wallet.address, amount, ticket.comment)

    const earlier = (await paced(() => client.getTransactions(recipient, { limit: 100 }))).find(matches)
    if (earlier !== undefined) {
        const hash = earlier.hash().toString('hex')
        console.info(`Reusing the earlier payment ${hash}`)
        return hash
    }

    const balance = await paced(() => wallet.getBalance())
    const needed = amount + 50_000_000n
    if (balance < needed) {
        throw new Error(
            `The testnet wallet ${friendly(wallet.address)} holds ${fromNano(balance)} GRAM and needs ` +
                `${fromNano(needed)}. Top it up on testnet.`,
        )
    }
    console.info(
        `Paying ${fromNano(amount)} testnet GRAM from ${friendly(wallet.address)} (holds ${fromNano(balance)})`,
    )
    const body = beginCell().storeUint(0, 32).storeStringTail(ticket.comment).endCell()
    const seqno = await paced(() => wallet.getSeqno())
    // A resend after a 429 is harmless: once one copy is accepted, the seqno rejects the rest.
    await paced(() =>
        wallet.sendTransfer({
            seqno,
            secretKey: keys.secretKey,
            // Fees are paid on top: taken from the amount, the verifier would receive less than it asked for.
            sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
            messages: [internal({ to: recipient, value: amount, bounce: true, body })],
        }),
    )
    for (let attempt = 0; attempt < 60; attempt++) {
        await sleep(3000)
        const paid = (await paced(() => client.getTransactions(recipient, { limit: 20 }))).find(matches)
        if (paid !== undefined) {
            const hash = paid.hash().toString('hex')
            console.info(`Payment landed: ${hash}`)
            await sleep(5000) // let it finalize before the verifier looks it up
            return hash
        }
    }
    throw new Error('The payment did not reach the verifier within 3 minutes; run again to pick it up once it does')
}

function isPayment(tx: Transaction, from: Address, amount: bigint, comment: string): boolean {
    const message = tx.inMessage
    if (message?.info.type !== 'internal' || message.info.bounced || !message.info.src.equals(from)) {
        return false
    }
    if (message.info.value.coins < amount || tx.description.type !== 'generic' || tx.description.aborted) {
        return false
    }
    try {
        const body = message.body.beginParse()
        return body.loadUint(32) === 0 && body.loadStringTail() === comment
    } catch {
        return false
    }
}

function readMnemonic(): string[] {
    const words = (
        process.env.VERIFY_WALLET_MNEMONIC ?? (existsSync(walletFile) ? readFileSync(walletFile, 'utf8') : '')
    )
        .trim()
        .split(/\s+/)
    if (words.length !== 24) {
        throw new Error(`No testnet wallet: set VERIFY_WALLET_MNEMONIC, or run \`npm run verify -- --new-wallet\``)
    }
    return words
}

async function newWallet() {
    if (existsSync(walletFile)) {
        throw new Error(`${walletFile} already exists; remove it first to replace that wallet`)
    }
    const words = await mnemonicNew(24)
    mkdirSync(join(homedir(), '.config', 'hipo'), { recursive: true, mode: 0o700 })
    writeFileSync(walletFile, words.join(' ') + '\n', { mode: 0o600, flag: 'wx' })
    const keys = await mnemonicToPrivateKey(words)
    const address = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey }).address
    console.info(`Created ${walletFile}. Send testnet GRAM to ${friendly(address)}`)
}

function friendly(address: Address): string {
    return address.toString({ testOnly: true, bounceable: false })
}

async function get<T>(path: string): Promise<T> {
    return response<T>(await fetch(`${verifierApi}/${path}`, { headers: { 'User-Agent': userAgent } }))
}

async function post<T>(path: string, body: object): Promise<T> {
    const init = {
        method: 'POST',
        headers: { 'User-Agent': userAgent, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }
    return response<T>(await fetch(`${verifierApi}/${path}`, init))
}

async function response<T>(res: Response): Promise<T> {
    if (!res.ok) {
        throw new Error(`${res.url}: HTTP ${res.status.toString()} ${await res.text()}`)
    }
    return (await res.json()) as T
}

// Toncenter allows about one request a second without an API key and answers 429 beyond it.
async function paced<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        await sleep(1100)
        try {
            return await call()
        } catch (e) {
            if (attempt === 8 || !String(e).includes('429')) {
                throw e
            }
            await sleep(1000 * attempt)
        }
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
})
