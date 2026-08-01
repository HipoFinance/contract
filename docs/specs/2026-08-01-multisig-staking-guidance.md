# Multisig detection and comment-based staking guidance in the dapp

> Target repo: `website` (hipo.finance/app). No contract changes.

## Problem

Multisig accounts (e.g. Tonkeeper Pro multisig, based on `multisig-contract-v2`) can
connect to the dapp over TonConnect, but every `sendTransaction` request is rejected by the
wallet app — a k-of-n multisig cannot sign and broadcast within the request's 5-minute
`validUntil`, and most wallet apps don't implement dapp signing for multisig accounts at
all. The user only sees TonConnect UI's generic "Transaction canceled" notification and has
no path forward, even though the treasury already supports staking via a plain transfer
with a text comment (`treasury.fc` op `0`: comment `d` = deposit, `w` = unstake all).

## Decision

Detect multisig accounts proactively by on-chain code hash and, when the user clicks
Stake/Unstake, show an instructions modal instead of issuing a doomed `sendTransaction`.
The modal is tab-specific: the Stake tab's modal shows only the deposit instructions, the
Unstake tab's modal only the unstake-all instructions. Each modal includes a `ton://`
transfer deep link with the address, amount, and comment pre-filled, plus copyable fields
as a fallback. For undetected setups (custom multisigs, cold wallets), catch
`sendTransaction` rejections and show a soft hint pointing at the same instructions.

Rejected alternatives:

- *Replacing the form or adding a banner* — user chose the modal-on-click presentation; the
  form stays usable for amount entry and fee estimates.
- *Raising `validUntil` / dropping the `from` field* — doesn't help; wallet apps reject
  multisig dapp signing regardless, and a days-long `validUntil` breaks the dapp's
  completion tracking.
- *Detecting via TonConnect device/feature flags* — wallet apps don't reliably distinguish
  multisig accounts in their declared features; the account's code hash is authoritative.
- *Pre-selecting the sending wallet in the deep link* — the `ton://transfer` scheme has no
  sender parameter; the wallet app always chooses the source wallet. Mitigated by a note
  under the deep link telling the user to select their multisig (shown by short address)
  before confirming.

## Changes

All in the `website` repo, `src/components/app/`:

- `Model.ts`
  - New observable `isMultisig` (default `false`). When the connected address is set,
    fetch the account via the existing `TonClient4` (`getAccountLite`) and compare its code
    hash against a new `multisigCodeHashes` constant containing the `multisig-contract-v2`
    code hash (value computed at implementation time and verified against a live
    Tonkeeper Pro multisig; base64, network-independent).
  - New observable `showMultisigGuidance` with actions to open/close the modal.
  - `send()`: when `isMultisig`, open the modal instead of calling `sendTransaction`.
  - Rejection fallback: attach a `.catch` to both `sendTransaction` call sites; on
    rejection show a timed message ("Using a multisig or cold wallet? You can stake with a
    plain transfer — see instructions") with an action that opens the same modal.
- New `MultisigGuidance.tsx` — modal, network-aware, rendering only the active tab's flow:
  - **Stake tab**: send the desired amount plus a 0.1 GRAM fee buffer (`feeStake`) to the
    treasury address with text comment `d`; unused fee is refunded and hGRAM is minted to
    the sender (the multisig). If the form has a valid amount, show it as the suggested
    total.
  - **Unstake tab**: send 0.1 GRAM (`feeUnstake`) with text comment `w`; notes that the
    comment flow always unstakes the full hGRAM balance (partial unstake needs the normal
    dapp flow).
  - A prominent deep link, `ton://transfer/<treasury>?amount=<nano>&text=d` (stake; amount
    = form amount + fee buffer, omitted when no valid amount is entered) or
    `ton://transfer/<treasury>?amount=100000000&text=w` (unstake), so a click pre-fills
    the transfer in wallet apps that register the `ton://` scheme.
  - As fallback, the treasury address (bounceable, current network) and the comment
    letter, each with a copy button.
- `src/components/FAQ.astro` — new entry "Can I stake with a multisig or cold wallet?"
  describing the comment-based method.

## Invariants

No on-chain behavior changes. The comment flows used (`d`/`w`) already exist in the
deployed treasury and are covered by its tests; the dapp must always instruct users to
include the 0.1 GRAM fee buffer so deposits aren't bounced for insufficient fee. Detection
must fail open: if the code-hash lookup errors, `isMultisig` stays `false` and behavior is
unchanged (the rejection hint still covers the user).

## Compatibility

No message schemas, stored data, or SDK changes. Pure static-site change; deployment is
automatic on push to the website repo's `main`.

## Test plan

The website repo has no test infrastructure; verification is manual:

- Regular wallet on mainnet/testnet: flows unchanged, no modal, no hint.
- Multisig: connect a testnet `multisig-contract-v2` account (or temporarily add one's own
  wallet code hash to `multisigCodeHashes`) and verify each tab's modal shows only its own
  flow, the right network's treasury address, amounts, and working copy buttons, and that
  the deep link opens a wallet with address, amount, and comment pre-filled.
- Rejection hint: cancel a transaction in a regular wallet and verify the hint message and
  its link to the modal.
- Network switch (`#network=testnet`) re-runs detection against the new address.

## Out of scope

- The legacy-wallet upgrade flow (`OldWalletUpgrade.tsx`) — legacy hTON holders on
  multisigs are not a known audience; the rejection hint still appears there.
- Legacy `multisig-contract` (v1) code-hash detection — covered by the rejection fallback.
- Partial unstake via comments (the contract only supports unstake-all by comment).
