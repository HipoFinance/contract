---
name: spec
description: Interview the requester about a proposed change to the Hipo contracts, then write a short spec to docs/specs/ and get sign-off before any implementation. Use whenever a new feature, behavior change, or protocol tweak is requested, before writing code.
---

# Spec: interview before implementing

These contracts hold user funds on mainnet. Before implementing any feature or behavior
change, produce a small written spec and get it approved. Do not start coding, and do not
modify contracts, wrappers, or tests, until the requester approves the spec.

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
  `Integration.md`, and external integrators)?
- **Economics and gas**: effect on fees, rewards split, or worst-case gas
  (`MaxGas`/`MinGas` bounds and the fee constants in `contracts/imports/`)?
- **Rollout**: pure code change vs. governance action vs. treasury/parent/wallet upgrade?
  Any ordering constraints with the running rounds?
- **Testing**: which specs cover it; what new cases prove the change and its edge cases?

## Step 3 — Write the spec

Write `docs/specs/YYYY-MM-DD-<slug>.md` with these sections, kept short and concrete:

```markdown
# <Title>

## Problem
## Decision
## Changes            <!-- per contract/file, in one or two lines each -->
## Invariants         <!-- what must remain true, and why this change preserves it -->
## Compatibility      <!-- data layout, message schemas, upgrade/migration plan -->
## Test plan
## Out of scope
```

Record what was decided *and why*, including rejected alternatives when the choice was not
obvious — the spec is the durable memory of the interview.

## Step 4 — Sign-off, then implement

Present the spec, ask for approval, and apply requested revisions to the spec file first.
Only after approval, implement exactly what the spec says; if implementation reveals the
spec was wrong, stop and update the spec (and confirm) before continuing. Update
`docs/architecture.md`, `Integration.md`, and the `graphs/` diagrams whenever the change
makes them stale.
