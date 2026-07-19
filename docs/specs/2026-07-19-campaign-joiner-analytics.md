# Telegram Campaign Joiner Analytics Script

## Problem

We launched a Telegram ad campaign and want to measure its performance: how many new
wallets are joining Hipo as stakers over time, and the total GRAM value they bring. Today
there is no way to observe this — every script in `scripts/` reads current contract state
via getters (`showState`, `showJettonData`, `showNftData`), and none reconstructs
historical activity. We need a time-series of joiners since the campaign start date.

## Decision

Add a read-only, off-chain analytics script `scripts/analyzeJoiners.ts` (run via
`npx blueprint run analyzeJoiners`). It reconstructs **first-time depositors** over a time
window from the treasury's `deposit_coins` history (via TON API, tonapi.io) and reports,
per time bucket, the count of new wallets and their total deposited GRAM, plus cumulative
totals, to the console and a CSV file.

Key definitions and choices (from the interview):

- **Joiner = first-time depositor.** A wallet is counted once, at its **first-ever deposit**
  into the treasury. hGRAM transfers between wallets are explicitly ignored — only
  `deposit_coins` events create a joiner. Detecting "first-ever" requires scanning the full
  treasury deposit history up to the window end and taking each depositor's earliest deposit
  as its join time; a joiner falls in bucket *B* if that earliest deposit lands in *B*. A
  wallet that deposited before the window (even before the campaign) is therefore never a
  joiner inside the window, and a wallet is never counted twice.
- **GRAM value of a joiner = the GRAM of its first deposit.** Taken directly from the
  deposit (the `coins` field, or incoming message value minus the deposit fee when
  `coins = 0`), in GRAM — no exchange-rate conversion, no hGRAM. This is the "money brought
  in at acquisition." Subsequent deposits by the same wallet are not added to the joiner
  metric (they are not acquisitions); note this in the usage doc.
- **Data source = TON API (tonapi.io)**, key from an env var (e.g. `TONAPI_KEY`). Chosen
  over a liteserver walk (considered and rejected: a liteserver can't filter by op or time,
  so it forces a sequential crawl of the hot treasury account plus per-depositor walks
  against a pruned/rate-limited public archive) and over Toncenter v3. We page the treasury
  account's raw transactions (`/v2/blockchain/accounts/{addr}/transactions`, up to 1000 per
  page) and **decode the `deposit_coins` body ourselves from the raw BOC** — tonapi does not
  know this custom op, and self-decoding with `@ton/core` matches the wrappers exactly.
- **Rate limit = design for the 1 RPS free tier.** Single-threaded paging with a ≥1 s
  spacing throttle and exponential backoff on 429/5xx. A full genesis→now scan is bounded by
  `treasury_tx_count / 1000` requests (minutes-scale even at 1 RPS). To keep repeat runs
  cheap, persist a local checkpoint (`address → first-deposit {time, gram}` map + the last
  processed `lt`); the expensive full-history "first-ever" baseline is computed once, and
  later runs fetch only the delta since the checkpoint.
- **Attribution = time-based only.** Report the trend since a `--since` campaign start date
  and let the reader compare against the prior baseline. No per-deposit referrer tagging
  (the treasury discards `deposit_coins.referrer` at `treasury.fc:196`; it is only
  recoverable by parsing raw message bodies — out of scope).
- **Bucketing = configurable** (`--bucket day|week`, default `day`). Always emit both a
  console summary and a CSV.

## Changes

- `scripts/analyzeJoiners.ts` (new) — the only code change. Flow:
  1. Resolve the treasury address (default to the mainnet address used by `showState.ts`).
  2. Load the local checkpoint if present (`address → first-deposit {time, gram}` map + last
     processed `lt`). Page the treasury account's raw transactions from tonapi
     (`/v2/blockchain/accounts/{addr}/transactions`, limit 1000), newest→oldest, stopping at
     the checkpoint `lt` (or genesis on first run). Throttle to ≤1 RPS with backoff. For each
     transaction, decode the inbound message body from its raw BOC; keep only bodies whose op
     is `op::deposit_coins` (`0x3d3761a6`). Extract the depositor (body `owner`, falling back
     to the sender when `owner` is `addr_none`), the deposited GRAM (`coins`, or incoming
     value minus deposit fee when `coins = 0`), and the transaction timestamp.
  3. Merge into the first-deposit map, keeping each depositor's earliest deposit as its join
     event (time + GRAM). This "first-ever deposit" set must reach back before `--since` so
     window joiners are classified as new vs. returning. Persist the updated checkpoint.
  4. Keep joins whose time is in `[since, until]`; bucket by day/week; per bucket compute
     new-wallet count and summed first-deposit GRAM; accumulate cumulative count and GRAM.
  5. Print a console table and write `joiners-<since>-<until>.csv` (columns:
     bucket_start, new_wallets, gram_value, cumulative_wallets, cumulative_gram).
- Checkpoint file lives under a gitignored path (e.g. a `.cache/` dir); it is a derived
  cache, safe to delete to force a full rescan.
- `scripts/analyzeJoiners.md` (new, optional) — one-page usage note: env var, flags,
  example, and the definitional caveats above. Mirrors the style of `upgrade_treasury.md`.

No contract, wrapper, or test changes.

## Invariants

Not applicable to protocol invariants — this is an off-chain, read-only script. It sends no
messages, calls only an external HTTP API (and optionally treasury getters for context),
and changes no stored state. The exchange-rate identity, participation state machine, and
deposit/unstake fairness rules are untouched. The one *analytical* invariant to preserve: a
wallet is counted as a joiner **at most once**, at its first-ever deposit, and its GRAM
value is that first deposit's amount — so re-running over the same `--until` yields
identical historical buckets regardless of `--since`.

## Compatibility

- **Stored data / message schemas**: none touched. No treasury `save_data`/`extension`,
  wallet, or participation layout change; no `schema.tlb` / `Integration.md` change; no
  upgrade or migration.
- **Gas**: none — no on-chain execution. `MaxGas`/`MinGas` bounds unaffected.
- **External dependencies (new)**: TON API HTTP access and a `TONAPI_KEY` env var. Uses
  Node's global `fetch` (Node 18+); no new npm dependency required (`@ton/core` decodes the
  raw bodies). Designed for the 1 RPS free tier: ≤1 RPS throttle, exponential backoff on
  429/5xx, and a local checkpoint cache so only the first run pays the full-history scan.
  `blueprint.config.ts` stays gitignored; the API key is read from the environment, not
  committed. The checkpoint cache is gitignored and safe to delete.
- **Networks**: mainnet by default (real campaign data); testnet supported via the standard
  blueprint network prompt for dry-runs.

## Test plan

No Jest specs (scripts are not covered by the suite, and TON API calls are not sandboxable).
Validate manually:

1. **Deposit decoding + rate-budget check (do first — the main technical risk).** Confirm we
   can page the treasury's full transaction history from tonapi.io (limit-1000 pages) and
   reliably decode `deposit_coins` bodies from the raw BOC (op, `owner`, `coins`), including
   the `coins = 0` "deposit everything" case. Estimate the treasury's lifetime transaction
   count and confirm the full first-run scan completes within an acceptable wall-clock at
   ≤1 RPS; verify the checkpoint cache makes a second run fetch only the delta. If the free
   tier is too slow or pagination/decoding is unreliable, fall back to Toncenter v3, and
   record the choice in the usage doc; if neither works, stop and revise this spec.
2. Run over a known past window and sanity-check: cumulative new-wallet count and deposited
   GRAM move monotonically; totals are plausible vs. `showState` `total_coins` and the
   known depositor base.
3. Spot-check a few joiner wallets on tonscan/tonviewer — the detected first-deposit
   timestamp and GRAM amount match the explorer.
4. Idempotency: re-running with the same `--until` produces identical historical buckets;
   changing only `--since` shifts the window but not any bucket's numbers.
5. Flags: `--bucket day` vs `week` bucket correctly; CSV columns and console summary agree.

## Out of scope

- hGRAM transfers as a join signal (explicitly excluded — only deposits count).
- Referrer-based / per-ad attribution and organic-vs-ad segmentation.
- Counting repeat deposits, deposit volume beyond first-deposit acquisition value, or
  wallets that fully unstake and later re-deposit (still counted only at their first ever).
- Unstake/churn, retention, or net-flow analysis; dashboards or charts (CSV is the handoff).
- Any contract, wrapper, schema, or on-chain change.
