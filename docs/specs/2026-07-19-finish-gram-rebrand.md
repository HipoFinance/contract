# Finish the TON → GRAM / hTON → hGRAM rebrand

## Problem

The coin rebrand (TON → GRAM) and jetton rebrand (hTON → hGRAM) were applied piecemeal:
README, architecture.md, schema.tlb, bill.fc, showState.ts, and setContent.ts already use
the new names, but Integration.md, createTreasury.ts, the graphs, the npm package name,
FunC comments, and test output still say TON/hTON. Integrators reading Integration.md and
anyone deploying a fresh treasury via createTreasury.ts get the old branding.

## Decision

Complete the rename everywhere in this repo with these terminology rules, decided in the
interview:

- **GRAM** is the coin; **hGRAM** is the jetton; **nanoGRAM** is the smallest unit.
- **"TON blockchain" stays** — the network keeps its name; only the coin/jetton were
  rebranded. Phrases like "on TON blockchain" and "TON validation rounds" are unchanged.
- FunC comments in **our** contracts are updated; the vendored `imports/stdlib.fc` is left
  untouched so it stays diffable against upstream ("nanoTONs" there remains).
- `createTreasury.ts` adopts exactly the metadata already in `setContent.ts` (symbol
  `hGRAM`, name `Hipo Staked GRAM`, description `Hipo liquid staked GRAM`, image
  `https://hipo.finance/hgram.svg`). The mainnet parent's on-chain metadata was already
  updated via setContent, so **no governance action is in scope**.
- npm package name becomes **`hipo-contract`** (named after the project, not the jetton,
  so a future rebrand doesn't touch it again). The package is private/unpublished.
- The Jest matcher `toBeTonValue` is renamed to `toBeGramValue` (~270 call sites), and its
  failure messages say "nanoGRAM".

## Changes

- `Integration.md` — replace hTON → hGRAM and TON-the-coin → GRAM throughout (headings
  like "Calculating Exchange Rate of hTON in TON" become "… of hGRAM in GRAM");
  "TON blockchain" references stay.
- `scripts/createTreasury.ts` — metadata dict values copied from `setContent.ts`.
- `graphs/*.dot` — amount labels ("0.10 TON") → GRAM; flow titles ("deposits 10 TON to
  receive ~10 hTON") → GRAM/hGRAM. Regenerate all `graphs/img/*.svg` via
  `make build_graphviz && make graphs` (also fixes the pre-existing "finilized" typo in
  02.2/03.2 titles while touching those labels).
- `package.json` / `package-lock.json` — name `hton` → `hipo-contract`
  (lockfile via `npm install` to refresh its name fields).
- FunC comments only, no code: `treasury.fc`, `parent.fc`, `wallet.fc`, `loan.fc`,
  `librarian.fc`, `imports/constants.fc`, `imports/utils.fc` — "TON balance" → "GRAM
  balance", "10 TON" → "10 GRAM", etc. `imports/stdlib.fc` untouched.
- `tests/helper.ts`, `tests/setup-jest.ts`, `tests/*.spec.ts` — `toBeTonValue` →
  `toBeGramValue`; matcher messages "nanoTON" → "nanoGRAM".
- `CLAUDE.md` / `docs/architecture.md` — keep their "formerly TON/hTON" notes but drop the
  "some files still use the old names" caveats once the rename is complete.

## Invariants

No contract logic, cell layout, message schema, op-code, fee constant, or get-method
changes — comments and off-chain text only. Compiled contract code must be bit-identical:
verified by `npx blueprint build` producing unchanged code hashes (FunC comments do not
affect compilation output). All architecture.md invariants are untouched by construction.

## Compatibility

- No stored-data or message-schema change; no treasury/parent/wallet upgrade; no
  migration. `schema.tlb` already clean.
- No mainnet action: on-chain jetton metadata already shows hGRAM.
- External integrators are unaffected (Integration.md wording changes only).
- The `toBeTonValue` rename is test-internal API; nothing outside `tests/` imports it.

## Test plan

- `npx blueprint build` — compiles; spot-check that build output hashes match pre-change
  builds (comments-only guarantee).
- `npx blueprint test` — full suite green, including `MaxGas.spec.ts` / `MinGas.spec.ts`
  (gas bounds cannot move since code is unchanged).
- `npm run lint` — clean.
- `grep -ri hton` over the repo (excluding node_modules/build/.git and the historical
  notes in CLAUDE.md, architecture.md, and docs/specs/) returns nothing.

## Out of scope

- Renaming the vendored `imports/stdlib.fc`.
- Renaming the GitHub repo, `hipo.finance` URLs/assets, or anything outside this repo.
- Any governance/on-chain action (metadata already updated on mainnet).
- Renaming "TON blockchain" / network references.
- Historical documents: existing `docs/specs/*` entries and git history keep old names.
