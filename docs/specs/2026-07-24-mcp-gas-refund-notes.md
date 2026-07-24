# Gas prepayment refund timing: MCP get_fees/get_wallet_status notes and llms.txt

## Problem

The MCP server's `get_fees` tool reports the live prepayment amounts from
`get_treasury_fees` and says "unused remainder is returned as excess", but not *when* the
remainder returns. A 2026-07-22/23 wallet-flow analysis (four-protocol staking comparison)
showed why this matters to AI clients: for an unstake, only a negligible amount returns at
request time and the unused remainder of the unstake prepayment is embedded in the final
GRAM withdrawal payout. An AI computing "actual return" from raw transfers will therefore
slightly overstate the staking reward unless it knows to net all flows (deposit attach
minus refunds, payout including its embedded gas remainder).

## Decision

Document the refund-timing mechanics qualitatively in three places: the MCP `get_fees`
tool, the MCP `get_wallet_status` pending-unstake note, and the website `llms.txt`
knowledge base.

In `get_fees` (sibling `../mcp` repo):

- Replace the single `note` string with a `notes` array (matching `get_round_timing`):
  1. Fees are gas prepayments; there is no protocol fee taken from the staked amount
     (existing note, kept).
  2. Deposit: attach the deposit fee on top of the staked amount; the unused gas returns
     shortly after as a separate excess transfer.
  3. Unstake: attach the unstake fee with the token burn; little or none returns at
     request time — the unused remainder is paid out together with the final GRAM
     withdrawal, so a raw withdrawal payout slightly overstates the pure staking reward.
  4. To measure a wallet's real return, net all flows per cycle: (deposits sent − deposit
     refunds) versus (request-time refunds + withdrawal payout).

In `get_wallet_status`: extend the existing note so a reported pending unstake explains
that its future payout will also carry the unused part of the unstake gas prepayment —
an AI reading a position then knows the incoming transfer is stake value plus gas
remainder, not reward alone.

In `../website/public/llms.txt`: add a short "Gas costs and refunds" section with the
same four facts (prepayments not protocol fees; deposit excess returns as a separate
transfer; unstake remainder arrives inside the withdrawal payout; net all flows to
measure real returns), and refresh the "Last reviewed" date. The existing claim
guardrails and terminology rules are untouched.

**Mechanics only — no hardcoded cost figures.** The MCP spec's invariant that reported
numbers come from contract getters stands; live prepayment amounts continue to come from
`get_treasury_fees`, and llms.txt states no numeric gas amounts (they drift as gas prices
change). Rejected: measured ballpark costs in the text, and a dedicated `hipo://docs/gas`
MCP resource (the knowledge is short enough to live in tool notes and llms.txt; the MCP
server already serves llms.txt as `hipo://docs/knowledge`, so it inherits the new section).

## Changes

- `../mcp/src/protocol.ts` — `getFees()`: `note` → `notes` array with the four notes
  above; `getWalletStatus()`: extend the pending-unstake note with the payout-embedded
  gas remainder.
- `../mcp/src/protocol.test.ts` — update/extend the `get_fees` and `get_wallet_status`
  unit tests for the new wording.
- `../website/public/llms.txt` — new "Gas costs and refunds" section; refreshed
  "Last reviewed" date. (`dist/llms.txt` is build output, not edited.)
- This contract repo: this spec only; no code changes.

## Invariants

No on-chain change. The server stays read-only and reports getter-sourced numbers only;
the new text is qualitative. The existing claim guardrails hold (no fixed returns, no
competitive claims — the four-protocol comparison data is deliberately not included).

## Compatibility

`get_fees` output shape changes `note: string` → `notes: string[]`. MCP tool outputs are
consumed by LLMs, not typed integrations, so this is safe; `get_wallet_status` only
rewords an existing note, and llms.txt is prose. No message-schema or storage change
anywhere.

## Test plan

- Unit tests: `get_fees` returns the `notes` array including the refund-timing and
  net-flow notes alongside getter-sourced fee amounts; `get_wallet_status` includes the
  extended pending-unstake note.
- Manual: MCP Inspector against mainnet — verify both tools read correctly next to live
  values; re-read the new llms.txt section against the avoid-list and verify it carries
  no numeric gas amounts.

## Out of scope

- Any contract, wrapper, or fee-constant change in this repo.
- Publishing measured net-cost numbers or the four-protocol comparison results.
- New MCP docs resources (`hipo://docs/gas`); docs.hipo.finance content.
