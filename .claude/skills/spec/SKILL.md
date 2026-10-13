---
name: spec
description: Interview the requester about a proposed change to the Hipo contracts, then write a short spec to docs/specs/ and get sign-off before any implementation. Use whenever a new feature, behavior change, or protocol tweak is requested, before writing code. This repo's version of team:spec, with the questions the contracts need; it keeps the shared skill's plain-terms section, definitions, acceptance criteria and the final check of each criterion.
---

# Spec: interview before implementing

These contracts hold user funds on mainnet. Before implementing any feature or behavior
change, produce a small written spec and get it approved. Do not start coding, and do not
modify contracts, wrappers, or tests, until the requester approves the spec.

This is stricter than the three levels of `team:spec` (do it, a plan in the chat, a written
spec), on purpose: here every change in behaviour gets the written spec. A rename, or an edit
with no change in behaviour, needs none. When unsure, write the spec.

## Step 1 — Understand the idea

Read the request, then read the relevant parts of `docs/architecture.md`, the affected
contracts, and the matching `graphs/*.dot` flow before asking anything — questions should
build on that context, not rediscover it.

## Step 2 — Interview

Ask focused questions (use AskUserQuestion when options are enumerable, free-form
otherwise), in as many rounds as needed but only about things that change the design.
Cover whichever of these apply:

- **Goal**: what user-visible problem is being solved? How is it observed today?
- **Scope**: which contracts and flows change? What is explicitly out of scope?
- **Protocol invariants**: does the change interact with the exchange-rate identity, the
  participation state machine, the deposit/unstake fairness rules, or loan safety? Which
  invariant statements in `docs/architecture.md` must still hold?
- **Compatibility**: does stored contract data change layout (treasury `save_data` /
  `extension`, wallet, participation)? Does the deployed mainnet state need a migration in
  the upgrade path? Do message schemas change (update `contracts/schema.tlb`,
  `docs/integration.md`, and external integrators)?
- **Economics and gas**: effect on fees, rewards split, or worst-case gas
  (`MaxGas`/`MinGas` bounds and the fee constants in `contracts/imports/`)?
- **Rollout**: pure code change vs. governance action vs. treasury/parent/wallet upgrade?
  Any ordering constraints with the running rounds?
- **Testing**: which specs cover it; what new cases prove the change and its edge cases?

## Step 3 — Write the spec

Write `docs/specs/YYYY-MM-DD-<slug>.md` with these sections, kept short and concrete:

```markdown
# <Title>

**Status:** draft

## Problem
## In plain terms      <!-- the whole change for a curious non-expert, see below -->
## Definitions         <!-- Concepts; and Formula parameters when there is a formula -->
## Decision
## Changes             <!-- per contract/file, in one or two lines each -->
## Invariants          <!-- what must remain true, and why this change preserves it -->
## Compatibility       <!-- data layout, message schemas, upgrade/migration plan -->
## Acceptance criteria <!-- - [ ] each one checkable by someone who did not write the code -->
## Out of scope
## Open questions      <!-- in everyday words, each with options and a recommendation; or "None." -->
```

Record what was decided *and why*, including rejected alternatives when the choice was not
obvious — the spec is the durable memory of the interview.

Rules that make the difference between a useful spec and decoration:

- **`## In plain terms` is written for a curious non-expert**, not a reviewer: what we are doing
  and why, how it works ("when X happens, the treasury now does Y"), what changes for stakers,
  borrowers and integrators and what stays the same, the main risk and how bad it is if it goes
  wrong, and what decisions are needed (point to Open questions, or say "No decisions needed").
  Everyday words, no file names or code unless the reader needs one to decide. Someone who
  reads only Problem, this section and Open questions must be able to make every decision the
  spec asks for.
- **`## Definitions` is never omitted.** Under **Concepts**, list every new term and every
  ordinary word used with a special meaning here (project shorthand, naming traps such as "X is
  called `y` in the identifiers"); write "None." when there is nothing. When the spec has a
  formula, add **Formula parameters** as a table: symbol | meaning | unit | rounding / range.
  Give each parameter its unit (nanoTON, TON, basis points, seconds, …) and, where it is a
  computed or divided value, its rounding direction: unit and rounding slips are where money
  gets lost. Define each symbol once, here, never beside each formula; the formulas then stand
  bare, with only their reasoning next to them. Leave the table out, heading included, when the
  spec has no formula.
- **Acceptance criteria must be verifiable by an observer who did not write the code.** "A bid
  with `loan_amount` + collateral below `min_request_stake` is refused and its collateral
  bounced (`tests/Treasury.spec.ts`)" is a criterion; "floors work correctly" is not. Name the
  test file or command that proves each one. This section is the test plan: the new cases and
  edge cases from the interview go here, as criteria. `MaxGas.spec.ts` / `MinGas.spec.ts`
  staying green is a criterion whenever gas can move.
- **No invented facts.** Every claim about current behaviour comes from a file you read.
- **Keep it short.** A spec nobody finishes reading fails at its only job.
- **The money audit.** A spec here is contract code, so `rules/money-audit.md` of the
  `claude-team` repo applies: when the spec has a formula or a concurrency design, run one
  `team:money-auditor` pass on those sections (formulas, units, rounding, race windows) before
  you present it, fix what it finds, and say that it ran and what changed. The diff later gets
  the two opposite audits without asking, whatever this skill did.

## Step 4 — Sign-off, then implement

Present the spec: the path, a pointer to `## In plain terms` (do not re-summarize it), and the
open questions in one line each. Then stop and wait for approval. Apply requested revisions to
the spec file first; when the requester edits the file, re-read it from disk, since their edits
are the spec. On approval set `**Status:** approved`.

Only after approval, implement exactly what the spec says; if implementation reveals the
spec was wrong, stop and update the spec (and confirm) before continuing. Stay in scope. Update
`docs/architecture.md`, `docs/integration.md`, and the `graphs/` diagrams whenever the change
makes them stale.

## Step 5 — Verify each criterion

Go through the acceptance criteria one at a time and check each: run the test or command, read
the output. Tick the boxes in the spec file, then report: each criterion met, not met or could
not be verified, with the evidence for anything you claim passed; any failure with its actual
output; any deviation from the spec and why. "Could not verify" is an honest result; a box
ticked from confidence is not. Finally set `**Status:** implemented`.
