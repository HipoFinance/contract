# analyzeJoiners

Analyze wallets joining Hipo as stakers over time, to gauge the Telegram ad campaign.
Spec: [`docs/specs/2026-07-19-campaign-joiner-analytics.md`](../docs/specs/2026-07-19-campaign-joiner-analytics.md).

A **joiner** is a first-time depositor: a wallet is counted once, at its **first-ever
deposit** into the treasury. hGRAM transfers between wallets are ignored — only deposits
create a joiner. A joiner's **GRAM value** is the GRAM of that first deposit. Both the binary
`deposit_coins` op and the `"d"` text-comment deposit shortcut are counted.

## Run

```sh
TONAPI_KEY=<your key> npx blueprint run analyzeJoiners --mainnet
```

Prompts:

- **Treasury address** — defaults to the mainnet treasury.
- **Campaign start date** (`--since`) — `YYYY-MM-DD` (UTC) or a unix timestamp.
- **End date** — same formats, defaults to now.
- **Bucket size** — `day` (default) or `week`. Week buckets are aligned to the campaign
  start date.

Get a free key at <https://tonconsole.com>. Without a key the script still runs on the
anonymous tier, but is more rate-limited.

## Output

- A console table: per bucket, new wallets, deposited GRAM, and running cumulatives; plus
  totals and the count of depositors that already existed before the campaign start.
- A CSV at `temp/joiners-<since>-<until>-<bucket>.csv` with columns
  `bucket_start,new_wallets,gram_value,cumulative_wallets,cumulative_gram`.

## How it works / performance

The script pages the treasury's transactions from TON API (tonapi.io) and decodes deposit
message bodies itself. Classifying "first-ever" deposits requires the full deposit history,
so the **first run scans from genesis to now** — a few minutes at the 1 RPS free tier. Progress
is checkpointed to `temp/joiners-checkpoint-<net>-<treasury>.json`, so the scan is resumable
and later runs fetch only new transactions. Delete the checkpoint file to force a full rescan.

## Caveats

- **Time-based attribution only.** The script shows the joiner trend since the start date;
  it does not tag deposits as ad-driven (the treasury discards the `deposit_coins.referrer`).
  Compare the campaign window against the prior baseline to read the lift.
- **First deposit valuation.** Only the first deposit's GRAM counts toward a joiner; later
  deposits by the same wallet are not added (they are not acquisitions).
- **`coins = 0` deposits** ("deposit everything", including all `"d"` text deposits) are
  valued as the incoming message value minus the current `deposit_coins` fee from
  `get_treasury_fees`. This uses the current fee, an approximation for old rounds.
- A wallet that fully unstakes and later deposits again is still counted only at its first
  ever deposit.
