import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Address, Cell, fromNano } from '@ton/core'
import { NetworkProvider } from '@ton/blueprint'
import { Treasury } from '../wrappers/Treasury'
import { op } from '../wrappers/common'

// Analyze wallets joining Hipo as stakers over time, to gauge the Telegram ad campaign.
// A "joiner" is a first-time depositor: a wallet is counted once, at its first-ever deposit
// into the treasury. hGRAM transfers are ignored — only deposits create a joiner. Its GRAM
// value is the GRAM of that first deposit. See docs/specs/2026-07-19-campaign-joiner-analytics.md.
//
// Data source: TON API (tonapi.io), designed for the 1 RPS free tier. The full genesis→now
// scan needed to classify first-ever deposits runs once and is checkpointed to temp/; later
// runs fetch only the delta. Set TONAPI_KEY in the environment for higher rate limits.

const TONAPI_KEY = process.env.TONAPI_KEY ?? ''
const PAGE_LIMIT = 1000 // tonapi max transactions per page
const MIN_REQUEST_INTERVAL = 1100 // ms between requests, to respect the 1 RPS free tier
const MAX_RETRIES = 6

const mainnetTreasury = 'EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ'

interface FirstDeposit {
    t: number // unix seconds of the first deposit
    g: string // deposited GRAM in nanocoins, as a string (bigint-safe for JSON)
}

interface Checkpoint {
    map: Record<string, FirstDeposit> // depositor raw address -> first deposit
    newestLt: string | null // highest lt fully covered
    oldestLt: string | null // lowest lt reached so far (backfill cursor)
    complete: boolean // whether the backfill has reached genesis
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const testOnly = provider.network() !== 'mainnet'
    const apiBase = testOnly ? 'https://testnet.tonapi.io' : 'https://tonapi.io'

    const defaultTreasury = testOnly ? '' : mainnetTreasury
    const treasuryPrompt = defaultTreasury
        ? `Enter the friendly address of the treasury (default: ${defaultTreasury})`
        : 'Enter the friendly address of the treasury'
    const treasuryAddress = Address.parse((await ui.input(treasuryPrompt)) || defaultTreasury)
    const treasury = provider.open(Treasury.createFromAddress(treasuryAddress))

    const since = parseDate(await ui.input('Campaign start date (YYYY-MM-DD or unix seconds)'))
    const untilInput = (await ui.input('End date (YYYY-MM-DD or unix seconds, default: now)')).trim()
    const until = untilInput ? parseDate(untilInput) : Math.floor(Date.now() / 1000)
    const bucketInput = (await ui.input('Bucket size [day|week] (default: day)')).trim().toLowerCase()
    const bucket = bucketInput === 'week' ? 'week' : 'day'

    if (since >= until) {
        throw new Error('Campaign start date must be before the end date')
    }
    if (!TONAPI_KEY) {
        ui.write('Warning: TONAPI_KEY is not set — using the anonymous tier, which is more rate-limited.')
    }

    // Deposit fee lookup (for "deposit everything" deposits where coins == 0), cached per
    // ownership_assigned_amount. Uses the current on-chain fee, an approximation for old rounds.
    const feeCache = new Map<string, bigint>()
    const depositFeeFor = async (ownershipAssignedAmount: bigint): Promise<bigint> => {
        const key = ownershipAssignedAmount.toString()
        const cached = feeCache.get(key)
        if (cached != null) {
            return cached
        }
        const fee = (await treasury.getTreasuryFees(ownershipAssignedAmount)).depositCoinsFee
        feeCache.set(key, fee)
        return fee
    }

    const cachePath = checkpointPath(treasuryAddress, testOnly)
    const cp = loadCheckpoint(cachePath)
    const priorNewestLt = cp.newestLt != null ? BigInt(cp.newestLt) : null

    let requests = 0
    let deposits = 0
    let lastRequestAt = 0

    const throttle = async () => {
        const wait = MIN_REQUEST_INTERVAL - (Date.now() - lastRequestAt)
        if (wait > 0) {
            await sleep(wait)
        }
        lastRequestAt = Date.now()
    }

    const fetchPage = async (beforeLt: bigint | null): Promise<TonApiTx[]> => {
        const url = new URL(`${apiBase}/v2/blockchain/accounts/${treasuryAddress.toRawString()}/transactions`)
        url.searchParams.set('limit', String(PAGE_LIMIT))
        if (beforeLt != null) {
            url.searchParams.set('before_lt', beforeLt.toString())
        }
        for (let attempt = 0; ; attempt++) {
            await throttle()
            requests++
            const res = await fetch(url, {
                headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
            })
            if (res.status === 429 || res.status >= 500) {
                if (attempt >= MAX_RETRIES) {
                    throw new Error(`tonapi ${String(res.status)} after ${String(MAX_RETRIES)} retries`)
                }
                const backoff = 2000 * 2 ** attempt
                ui.write(`  tonapi ${String(res.status)}, retrying in ${String(backoff / 1000)}s...`)
                await sleep(backoff)
                continue
            }
            if (!res.ok) {
                throw new Error(`tonapi ${String(res.status)}: ${await res.text()}`)
            }
            const body = (await res.json()) as { transactions?: TonApiTx[] }
            return body.transactions ?? []
        }
    }

    // Merge one deposit into the map, keeping the earliest per depositor.
    const record = (ownerRaw: string, t: number, gram: bigint) => {
        deposits++
        const existing = cp.map[ownerRaw] as FirstDeposit | undefined
        if (existing == null || t < existing.t) {
            cp.map[ownerRaw] = { t, g: gram.toString() }
        }
    }

    const handleTx = async (tx: TonApiTx) => {
        const decoded = decodeDeposit(tx)
        if (decoded == null) {
            return
        }
        let gram = decoded.coins
        if (gram === 0n) {
            const value = BigInt(tx.in_msg?.value ?? 0)
            const fee = await depositFeeFor(decoded.ownershipAssignedAmount)
            gram = value > fee ? value - fee : 0n
        }
        record(decoded.owner, tx.utime, gram)
    }

    // Phase A — catch up transactions newer than the last completed scan. Ordering within a
    // page is not assumed: every tx is examined and the cursor advances by the page's min lt.
    if (priorNewestLt != null) {
        ui.write('Fetching new deposits since last run...')
        let beforeLt: bigint | null = null
        let newNewest = priorNewestLt
        for (;;) {
            const page = await fetchPage(beforeLt)
            if (page.length === 0) {
                break
            }
            const lts = page.map((tx) => BigInt(tx.lt))
            const minLt = lts.reduce((a, b) => (b < a ? b : a))
            const maxLt = lts.reduce((a, b) => (b > a ? b : a))
            if (maxLt > newNewest) {
                newNewest = maxLt
            }
            let reachedKnown = false
            for (const tx of page) {
                if (BigInt(tx.lt) > priorNewestLt) {
                    await handleTx(tx)
                } else {
                    reachedKnown = true
                }
            }
            cp.newestLt = newNewest.toString()
            if (reachedKnown || page.length < PAGE_LIMIT) {
                break
            }
            beforeLt = minLt
        }
    }

    // Phase B — backfill downward to genesis (resumable via oldestLt).
    if (!cp.complete) {
        ui.write('Scanning full deposit history (first run may take a few minutes at 1 RPS)...')
        let beforeLt = cp.oldestLt != null ? BigInt(cp.oldestLt) : null
        for (;;) {
            const page = await fetchPage(beforeLt)
            if (page.length === 0) {
                cp.complete = true
                break
            }
            const lts = page.map((tx) => BigInt(tx.lt))
            const minLt = lts.reduce((a, b) => (b < a ? b : a))
            const maxLt = lts.reduce((a, b) => (b > a ? b : a))
            cp.newestLt ??= maxLt.toString()
            for (const tx of page) {
                await handleTx(tx)
            }
            beforeLt = minLt
            cp.oldestLt = minLt.toString()
            saveCheckpoint(cachePath, cp)
            ui.write(`  ...${String(Object.keys(cp.map).length)} depositors so far (${String(requests)} requests)`)
            if (page.length < PAGE_LIMIT) {
                cp.complete = true
                break
            }
        }
    }
    saveCheckpoint(cachePath, cp)

    // Bucket the joiners whose first-ever deposit falls in [since, until].
    const sinceMidnight = utcMidnight(since)
    const buckets = new Map<number, { count: number; gram: bigint }>()
    let baselineBefore = 0
    for (const first of Object.values(cp.map)) {
        if (first.t < since) {
            baselineBefore++
            continue
        }
        if (first.t > until) {
            continue
        }
        const start = bucket === 'week' ? weekStart(first.t, sinceMidnight) : utcMidnight(first.t)
        const entry = buckets.get(start) ?? { count: 0, gram: 0n }
        entry.count++
        entry.gram += BigInt(first.g)
        buckets.set(start, entry)
    }

    const sortedEntries = [...buckets.entries()].sort((a, b) => a[0] - b[0])
    let cumWallets = 0
    let cumGram = 0n
    const rows: string[] = ['bucket_start,new_wallets,gram_value,cumulative_wallets,cumulative_gram']

    ui.write('')
    ui.write(`Joiners since ${fmtDate(since)} (bucket: ${bucket})`)
    ui.write('='.repeat(72))
    ui.write(pad('bucket', 12) + pad('new', 8) + pad('GRAM', 18) + pad('cum wallets', 14) + 'cum GRAM')
    ui.write('-'.repeat(72))
    for (const [start, b] of sortedEntries) {
        cumWallets += b.count
        cumGram += b.gram
        ui.write(
            pad(fmtDate(start), 12) +
                pad(String(b.count), 8) +
                pad(fmtGram(b.gram), 18) +
                pad(String(cumWallets), 14) +
                fmtGram(cumGram),
        )
        rows.push(
            [fmtDate(start), String(b.count), fromNano(b.gram), String(cumWallets), fromNano(cumGram)].join(','),
        )
    }
    ui.write('-'.repeat(72))
    ui.write('')
    ui.write(`Total new wallets: ${String(cumWallets)}`)
    ui.write(`Total GRAM value:  ${fmtGram(cumGram)}`)
    ui.write(`Existing depositors before campaign: ${String(baselineBefore)}`)
    ui.write(
        `(${String(deposits)} deposits over ${String(requests)} tonapi requests; ` +
            `${String(Object.keys(cp.map).length)} lifetime depositors)`,
    )

    const outDir = join(process.cwd(), 'temp')
    mkdirSync(outDir, { recursive: true })
    const csvPath = join(outDir, `joiners-${fmtDate(since)}-${fmtDate(until)}-${bucket}.csv`)
    writeFileSync(csvPath, rows.join('\n') + '\n')
    ui.write('')
    ui.write(`CSV written to ${csvPath}`)
    ui.write(`Checkpoint cached at ${cachePath} (safe to delete to force a full rescan)`)
}

interface TonApiTx {
    lt: string | number
    utime: number
    in_msg?: {
        value?: string | number
        source?: { address: string } | null
        raw_body?: string
    }
}

interface DecodedDeposit {
    owner: string // raw address string of the staker
    coins: bigint // deposited GRAM from the body (0 means "deposit everything")
    ownershipAssignedAmount: bigint
}

// Decode a treasury inbound message as a deposit, or return null if it is not one.
// Handles both the binary deposit_coins op and the "d" text-comment shortcut.
function decodeDeposit(tx: TonApiTx): DecodedDeposit | null {
    const inMsg = tx.in_msg
    if (inMsg?.source?.address == null || inMsg.raw_body == null) {
        return null // external-in or bodyless — not a user deposit
    }
    const sender = Address.parseRaw(inMsg.source.address).toRawString()
    let slice
    try {
        slice = Cell.fromBoc(Buffer.from(inMsg.raw_body, 'hex'))[0].beginParse()
    } catch {
        return null
    }
    if (slice.remainingBits < 32) {
        return null
    }
    const opCode = slice.loadUint(32)

    if (opCode === op.depositCoins) {
        try {
            slice.loadUintBig(64) // query_id
            const owner = slice.loadMaybeAddress()
            const coins = slice.loadCoins()
            const ownershipAssignedAmount = slice.loadCoins()
            const ownerRaw = owner != null ? owner.toRawString() : sender
            return { owner: ownerRaw, coins, ownershipAssignedAmount }
        } catch {
            return null
        }
    }

    // Text-comment deposit: body is op 0 followed by exactly the single char "d"/"D".
    if (opCode === 0 && slice.remainingBits === 8 && slice.remainingRefs === 0) {
        const c = slice.loadUint(8) | 0x20
        if (c === 0x64) {
            return { owner: sender, coins: 0n, ownershipAssignedAmount: 0n }
        }
    }
    return null
}

function checkpointPath(treasury: Address, testOnly: boolean): string {
    const dir = join(process.cwd(), 'temp')
    mkdirSync(dir, { recursive: true })
    const net = testOnly ? 'testnet' : 'mainnet'
    return join(dir, `joiners-checkpoint-${net}-${treasury.toRawString().replace(':', '_')}.json`)
}

function loadCheckpoint(path: string): Checkpoint {
    if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf8')) as Checkpoint
    }
    return { map: {}, newestLt: null, oldestLt: null, complete: false }
}

function saveCheckpoint(path: string, cp: Checkpoint) {
    writeFileSync(path, JSON.stringify(cp))
}

function parseDate(input: string): number {
    const trimmed = input.trim()
    if (/^\d+$/.test(trimmed)) {
        return Number(trimmed)
    }
    const iso = trimmed.includes('T') ? trimmed : `${trimmed}T00:00:00Z`
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) {
        throw new Error(`Could not parse date: ${input}`)
    }
    return Math.floor(ms / 1000)
}

function utcMidnight(t: number): number {
    return t - (t % 86400)
}

function weekStart(t: number, anchor: number): number {
    const anchorMidnight = utcMidnight(anchor)
    const weeks = Math.floor((t - anchorMidnight) / (7 * 86400))
    return anchorMidnight + weeks * 7 * 86400
}

function fmtDate(t: number): string {
    return new Date(t * 1000).toISOString().substring(0, 10)
}

function fmtGram(nano: bigint): string {
    return Number(fromNano(nano)).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' GRAM'
}

function pad(s: string, width: number): string {
    return s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
