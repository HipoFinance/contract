# Hipo MCP server

## Problem

Option 2 of the AI-knowledge plan (see `2026-07-22-ai-friendly-docs-llms-txt.md`): static
docs let AI assistants explain Hipo, but they cannot answer live questions — current
hGRAM/GRAM rate, round timing ("when do my rewards land?"), a wallet's staking status.
An MCP (Model Context Protocol) server gives any MCP-capable AI client (Claude, Claude
Code, Cursor, ChatGPT, …) standardized access to Hipo docs *and* live on-chain data.

## Decision

Build a **new public sibling repo `HipoFinance/mcp`** (TypeScript, official
`@modelcontextprotocol/sdk`, reusing the published Hipo SDK for state parsing). One
codebase, two transports, **remote-first**:

- Hosted Streamable-HTTP endpoint (target `mcp.hipo.finance`), Dockerized like the Go
  `api` service. Zero-install for users.
- `npx`-runnable stdio entry point published to npm for local/offline use.

**Data source: toncenter** (v2/v3) with a configurable endpoint and API key — the hosted
instance uses Hipo's key; local users may set their own or run keyless at the public rate
limit. Rejected: own liteserver (more ops, not needed at read-only query volume) and
TonAPI (third-party indexer dependency; plain getters suffice for v1).

### v1 surface

Resources (docs, fetched from raw.githubusercontent.com at runtime with a short cache so
they are always current; the llms.txt knowledge base fetched from hipo.finance/llms.txt):

- `hipo://docs/overview` (README), `hipo://docs/architecture`, `hipo://docs/integration`,
  `hipo://docs/schema` (TL-B), `hipo://docs/knowledge` (llms.txt).

Tools (all read-only getters; treasury/parent addresses baked in with README as source
of truth):

- **Protocol status**: `get_exchange_rate` (current + previous round rate from
  `get_treasury_state`, plus round-over-round APY derived on-chain from
  `current_rate`/`previous_rate` — no external stats dependency), `get_treasury_state`
  (TVL, totals, staking/unstaking in flight, participations summary, halted flag),
  `get_round_timing` (`get_times`: current/next round boundaries, participation windows,
  when pending deposits/unstakes settle), `get_fees` (`get_treasury_fees`).
- **Per-user**: `get_wallet_status(address)` — hGRAM balance and GRAM value via
  parent `get_wallet_address` + wallet state, pending stakes/unstakes;
  `get_reward_history(address)` — proxied from the deployed Hipo rewards API
  (`https://api.hipogang.io/wallet-rewards?address=…`, which also carries Hipo Club /
  HPO rewards; corrected 2026-07-23 — the spec originally guessed the Go `api` repo's
  `/hton/rewards/{wallet}` route, but that is not what is deployed).
- **Borrower**: `get_loan_info(borrower, round_since)` (`get_loan_address` + loan state),
  `get_participation(round_since)`, `get_max_punishment(stake)`.

Every tool answer includes a one-line disclaimer pointer (no investment advice; live
numbers, not guarantees) consistent with the llms.txt answer rules.

## Changes

- New repo `../mcp` (sibling): server code, Dockerfile, npm packaging, its own README.
- This contract repo: **no code changes**; this spec only. The webapp/borrower/sdk repos
  are untouched; the Go `api` service is consumed as-is.

## Invariants

No on-chain change. The server is strictly read-only (getters + HTTP GETs); it holds no
keys and can send no messages. Reported numbers must come from contract getters — no
locally re-implemented rate math beyond what the SDK/wrappers already encode, so the
exchange-rate identity is reported, never recomputed differently.

## Compatibility

- No message-schema or storage change. If a future treasury upgrade changes getter
  signatures, the MCP repo updates alongside (it pins the SDK version).
- The parent address can change on upgrade: addresses live in one config module, and the
  README remains the source of truth.
- The rewards API keeps its current path and response shape; the MCP server adapts if it
  changes (base URL configurable via `HIPO_REWARDS_API_BASE`).

## Test plan

- Unit tests with mocked toncenter responses for each tool (happy path + toncenter
  error/rate-limit surfaced as a clean tool error, invalid address input rejected).
- One live smoke test against mainnet getters (skippable in CI without a key).
- Manual: exercise both transports with MCP Inspector and a real Claude client; verify
  docs resources resolve and tool outputs match `showState`-script values.

## Out of scope

- The public website chatbot (option 3, postponed).
- Historical APY/TVL series (stats.hipo.finance / Dune remain the source for charts).
- Write operations of any kind (deposit/unstake links may be mentioned in text only).
- Hosting/DNS rollout details for `mcp.hipo.finance` (ops task, tracked in the mcp repo).
- Any change to the rewards API itself.
