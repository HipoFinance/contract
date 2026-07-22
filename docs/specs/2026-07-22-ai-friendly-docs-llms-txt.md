# AI-friendly docs: rewrite the website llms.txt

## Problem

AI assistants (option 1 of the "give Hipo knowledge to everyone" plan) answer Hipo
questions from public material. The website already serves an `llms.txt`
(`website/public/llms.txt`, last reviewed 2026-06-11), but it is marketing-oriented:
strong on naming/rebrand rules, claim guardrails, and FAQ, yet it has no contract
addresses, no links to the technical docs in this repo (`docs/architecture.md`,
`docs/integration.md`, `contracts/schema.tlb`, `graphs/`), and it mixes in internal
website-authoring content (SEO titles, meta descriptions, hero copy) that dilutes the
file for its actual audience.

## Decision

Rewrite `website/public/llms.txt` (sibling repo `../website`) as a public-facing AI
index, keeping the good existing content and adding a technical layer:

- **Keep** (edited for concision where needed): core identity, naming and terminology
  rules (GRAM/hGRAM rebrand, transition wording, avoid-list), how Hipo works,
  staking/unstaking/rewards explanations, security and risk disclosures, suggested FAQ
  answers, LLM answer rules, and the links section.
- **Drop**: SEO title options, meta descriptions, homepage hero copy — internal
  authoring guidance, not material for answering user questions.
- **Add** a "Technical resources" section:
  - Raw GitHub links to `README.md`, `docs/architecture.md`, `docs/integration.md`,
    `contracts/schema.tlb`, and the `graphs/img` folder of this repo.
  - Current mainnet addresses — treasury `EQCLyZHP4Xe8fpchQz76O-_RmUhaVc_9BAoGyJrwJrcbz2eZ`,
    parent `EQDPdq8xjAhytYqfGSX8KcFWIReCufsB9Wdg0pLlYSO_h76w` — labeled "current" with the
    repo README named as the source of truth (the parent can change on upgrade).
- Refresh "Last reviewed" date.

Rejected alternatives: hosting the index in this repo (llms.txt convention expects the
website root, and the website already serves one); adding new prose docs (staker FAQ,
protocol reference sheet, round-mechanics and fee summaries) — declined for now, the
technical section links to existing docs instead.

## Changes

- `Integration.md` → `docs/integration.md` (git mv, done ahead of publishing links so the
  llms.txt URLs are permanent). References updated in `CLAUDE.md`,
  `docs/architecture.md`, and `.claude/skills/spec/SKILL.md`; historical specs in
  `docs/specs/` keep the old name as point-in-time records. Other docs stay put:
  `README.md`/`CLAUDE.md` are root conventions, `scripts/*.md` are runbooks colocated
  with their scripts, `contracts/schema.tlb` and `graphs/` are already at stable paths.
- `../website/public/llms.txt` — rewritten as above. `dist/llms.txt` is build output and
  is not edited by hand.

## Invariants

No contract change. The existing claim guardrails ("never risk-free", no fixed returns,
no hardcoded APY/TVL, no "instant native withdrawal in all cases") and the
naming/terminology rules must survive the rewrite intact.

## Compatibility

None on-chain. Addresses are stated as "current" and defer to the repo README so an
upgrade that changes the parent address does not silently invalidate the file.

## Test plan

Manual: verify every link in the final file resolves (docs.hipo.finance pages, raw
GitHub URLs, stats dashboard); verify addresses match README.md; re-read against the
avoid-list for wording violations.

## Out of scope

- New prose docs in this repo (staker FAQ, protocol reference sheet).
- The MCP server (option 2 — separate spec).
- Updating docs.hipo.finance content or the webapp/borrower repos.
- llms-full.txt or per-page markdown mirrors.
