# Fix APY formula in showState script

## Problem

`scripts/showState.ts` computes the per-period growth rate as
`(current_rate - previous_rate) / 1e9`. Both rates are nano-scaled exchange rates
(`total_coins * 1e9 / total_tokens`, updated in `treasury.fc` when a participation
finishes recovering), so the correct per-period growth factor is
`current_rate / previous_rate`. Dividing the diff by `1e9` is only correct while the
exchange rate is exactly 1.0 GRAM/hGRAM; as the rate grows, the displayed APY is
inflated by a factor of about `previous_rate / 1e9` on the per-period rate (e.g. at
rate 1.08, a true 4.00% APY shows as ~4.32%), and the error grows with the rate.

## Decision

Normalize by `previous_rate`:

```ts
const growth = Number(currentRate) / Number(previousRate) // only when previousRate > 0
const apy = Math.pow(growth, year / duration) - 1
```

- Guard `previousRate > 0` (fresh treasury); show no APY in that case instead of
  dividing by zero.
- Keep `duration = nextRoundSince - currentRoundSince` (one round length). This
  assumes Hipo validates on both round chains, so the rate updates once per round
  length — true for current operations (see commit 963de9e). Rejected alternatives:
  detecting single-chain rounds from active participations (the finished round's
  chain activity isn't stored, so it can still guess wrong) and an operator input
  (extra friction for a display heuristic). Record the assumption in a code comment.

## Changes

- `scripts/showState.ts` — replace the `/ 1_000_000_000` diff with the
  `currentRate / previousRate` growth factor, guard `previousRate == 0`, and add a
  comment stating the both-chains duration assumption.

## Invariants

None affected — display-only script; no contract, wrapper, or message changes. The
exchange-rate identity and rate-update points in `treasury.fc` are unchanged.

## Compatibility

No stored-data or schema impact. No upgrade or governance action needed.

## Test plan

Manual: run `npx blueprint run showState` against mainnet and check the APY is
plausible (slightly lower than before, by roughly the current exchange rate factor).
Scripts have no Jest coverage; none added.

## Out of scope

- Any on-chain change (e.g. storing rate-update timestamps to make the period exact).
- Handling single-chain rounds in the APY display.
- Other display values in showState.
