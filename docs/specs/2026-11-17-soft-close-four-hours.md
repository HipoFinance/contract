# Soft close for loan requests, four hours ahead

**Status:** implemented (not deployed)

## Problem

A borrower can place or replace a loan request until `participate_since`, 15 minutes before the
election ends (`request_loan`, `treasury.fc`: `now() < participate_since`). Every request is public
the moment it lands. So the last sender sees every bid and nobody can answer theirs.

The rounds show the pattern. A bidder sends a small request in the final seconds (T−6 s) at
exactly the efficiency of the standing requests. The tie goes to the smaller loan
(`request_sort_key`), so the small request outranks them. In a round where the pool holds only
some of the requests, the standing request that drops to the bottom no longer fits, and
`decide_loan_requests` skips it. Its validator sits the round out. Standing bidders can't defend
by answering, because the close comes first. Their only defence is to bid late themselves,
which brings back what `2026-09-22-commit-reveal-bids.md` recorded: requests aimed at the final
seconds, and refusals when they arrive after the close.

The idea was rejected twice before.
- **`2026-09-19-soft-close.md`** rejected a soft close with 60-second extensions under a cap.
  Burning the extensions with no-op revisions cost about 3.6 GRAM, after which the deadline was
  fixed and the snipe came back.
- **`2026-09-22-commit-reveal-bids.md`** rejected sealed bids as disproportionate.

This design differs from the first in the one number that decided it. The fixed close is four
hours before the cap, not five minutes. A sniper acting alone must pay for about 16 requests
(about 11.6 GRAM at today's request fee of 0.725) to hold the auction open to the cap. That is
more than a borrower has earned from a whole round so far in this auction. The snipe is priced,
not removed:
- if a rival answers late in each window, the sniper's own share of the cost can fall by about
  half;
- a genuine bidding war that lasts four hours reaches the cap, where the last move returns in
  full.

## In plain terms

Today a loan auction ends at a fixed moment, 15 minutes before the validator election ends. A
bidder who waits until the last few seconds can see everyone's bids and copy the best one with a
smaller loan, which wins the tie. Nobody can respond, because the auction is already over.

With this change the auction normally ends **four hours earlier**. But a bid placed in the last
15 minutes before the close pushes the close to 15 minutes after that bid. Anyone outbid then has
15 minutes to answer, and every answer gives the others 15 minutes too. The close never moves
past today's deadline. To hold the auction open until that deadline, a sniper would have to keep
re-sending a paid request every 15 minutes for four hours. That costs more than a borrower has
earned from a whole round so far.

Once the auction has closed, nobody can join. A borrower who is already in can still make their
loan **smaller**: never larger, never at a lower price per GRAM, and never in a way that moves
them past another bid. Between the
close and the moment loans are handed out, people who withdraw shrink the pool. A borrower whose
loan no longer fits can then shrink it to fit, instead of being skipped. If nobody bids at all
before the close, the first bid after it opens a 15-minute window.

**What changes:**
- For **borrowers**: bids must arrive before the close, and they can watch and answer for as long
  as the bidding goes on.
- For **stakers**: in rounds where bidders compete, more of the reward. The pool already takes a
  fixed share of every reward, so higher bids only add income in rounds where they are bid up
  past that share.
- For **integrators**: one new getter. One existing field now means something else while a round
  is still taking bids, and has to be checked in every reader.

**What stays the same:** the election timing, when loans are handed out, the fees, the ranking
rule, and how leftover pool money is shared out.

**The main risk:** a bug in the new checks could refuse a request that should be accepted, or let
a late bid in that should be refused. The first costs a borrower one round's validation. The
second is no worse than today.

The pool's money is touched in one place. A shrink after the close changes the bid's
`min_payment`, and the pool is paid at least that. A first draft allowed a shrink to lower the
price per GRAM, so a bidder could bid high, scare rivals off and cut its price once nobody could
answer. The money audit found that, and the rule now forbids it.

Decisions needed: see Open questions.

## Definitions

### Concepts

- **Deadline (D):** `participate_since` from `get_times`, the current last moment for any request.
  It is also the cap on every extension. `participate_in_election` keeps it as its start gate.
- **Base close (B):** `D − 14400`, four hours before the deadline.
- **Close (E):** the moment new bids stop for the round. Stored per round, with 0 meaning "not
  extended yet". E = B while nothing is stored.
- **Extension zone:** the last 15 minutes before E. An accepted request in it moves E.
- **Normal request:** a new request, or a replacement of one's own request, while `now < E`. It
  is checked exactly as today.
- **Shrink revision:** a replacement of one's own standing request while `E ≤ now < D`. It is
  accepted only under the shrink rule. It never moves E.
- **Sort key:** `request_sort_key(min_payment, share, loan)`. It is efficiency, then the
  protocol share, then the complement of the rounded loan, so of two equal efficiencies the
  smaller loan ranks higher. Requests with an equal key share a bucket, and
  `decide_loan_requests` takes a bucket lowest address first. A request's **place** is its key and,
  inside its bucket, its address.
- **Passes nobody:** a revision does not move the request ahead of any request that was decided
  before it, by key or by address inside a bucket (exact test under the shrink rule).
- **Empty auction:** the round has no participation entry at all (no request was ever accepted).

### Formula parameters

| Symbol | Meaning | Unit | Range / rounding |
|---|---|---|---|
| D | `participate_since` from `get_times()` at the moment of the request | unix seconds | uint32 |
| B | base close, D − 14400 | unix seconds | exact |
| S | close stored in the participation, 0 when not extended | unix seconds | uint32; 0, or ≤ D at the time it was written |
| E | effective close, max(B, S) | unix seconds | exact |
| W | extension window, 900 | seconds | constant |
| t | `now()` of the request's transaction | unix seconds | |
| k₀, k₁ | old and new sort key of the sender's request | 120-bit int | as `request_sort_key`: payment >> 30, loan >> 40 |
| P₀, P₁ | old and new `min_payment` | nanoGRAM | exact; products P·L < 2^240, no overflow |
| L₀, L₁ | old and new `loan_amount` | nanoGRAM | exact |
| M₀, M₁ | old and new `max_stake`, 0 meaning uncapped | nanoGRAM | M₁ after the existing raise to `stake_cap_floor` |

**Accepting a normal request.** Accepted when t < E (plus every existing check). In the empty
auction, accepted when t < D.

**Moving the close.** After a normal request is accepted:
- Empty auction with t ≥ B: S := min(t + W, D). The first bid after the base close opens a
  window.
- Otherwise, if t ≥ E − W: S := max(S, min(t + W, D)).
- Otherwise S is unchanged.

So S only grows, and is never written past the D of that moment. D is recomputed from the
election config on every call: if a config change moves D earlier, the existing `t < D` check
still refuses everything after the new D; if it moves D later, E = max(B, S) never closes
before the new base close.

A new request that the max_validators eviction removes at once is still an accepted request: it
paid `total_fee` and it moves S. Its fee stays with the pool, as today.

**Shrink rule** (E ≤ t < D, sender has a standing request). Accepted only when all of the
following hold:
- L₁ ≤ L₀;
- the price per GRAM doesn't fall: P₁ · L₀ ≥ P₀ · L₁;
- it passes nobody: k₁ ≤ k₀; or, when k₁ > k₀, both of these hold:
  - `sorted` (after removing the old entry) holds no key in (k₀, k₁];
  - the old bucket k₀, after removing the sender, holds no address lower than the sender's;
- the max_stake doesn't rise: M₀ = 0, or 0 < M₁ ≤ M₀;
- every existing `request_loan` check passes;
- `borrower_reward_share` and `request_fee` are carried over from the old request, not taken from
  the current `loan_config`. The key's share term is therefore the same on both sides of the
  comparison. A governor change to the share after E then can't reach a loan through a no-op
  "shrink". The collateral check's `min_burn` uses the carried `request_fee` as well. A normal
  request before E still takes the current values, as today.
- the shrink path skips the max_validators eviction. A shrink never grows `size`, so the eviction
  could only fire after config 16 lowered max_validators below `size`. Then it would remove the
  bottom request, whose borrower can't re-enter after E. Before E the eviction runs as today.

Any other request in this period is refused with `err::not_accepting_loan_requests` (201) and
bounced. A new request from a borrower with no standing request is refused the same way.

Why the price is checked exactly and not through the key:
- The pool is paid `max(min_payment, reward × treasury share)`, and accrued capital is priced at
  `min_payment × (L + a) / L`. So a lower price per GRAM lowers the pool's income one for one in
  the rounds where bids are above the share.
- The key would allow such a cut: the efficiency in it is rounded (payment >> 30, loan >> 40),
  and a lower key is always "not higher".

Why "passes nobody" and not "key not higher":
- Rounding and the smaller-loan tie-break can raise the key of an honest shrink that keeps its
  exact price.
- Forbidding every raise blocked a valid shrink within 20 rounding steps in about 6% of random
  order books in the audit's simulation.
- A raise that passes no other request changes no one's outcome. It is checked against keys
  above the old one **and** against equal-key peers with a lower address. Those peers are
  decided first today, so a rise out of the bucket would otherwise jump them. That is the tie
  snipe this spec exists to stop; the re-check of the money audit found it.

Do not replace either check with "efficiency may fall one step per revision". Repeated, that
cuts the price step by step: one step on a 3.5M loan is worth about 3.5 GRAM, against a fee of
0.725.

## Decision

Adopt the soft close above with B = D − 4 h, W = 15 min and the cap at D, together with shrink
revisions after the close. The governor approved all three in chat on 2026-11-17.

**Why B is four hours.**
- **Cost of the snipe:** holding the auction to D takes about ⌈(D − B)/W⌉ = 16 accepted
  requests, each paying `total_fee` (a replacement pays the full fee again; `request_loan`).
  That is the sniper's cost when acting alone. It falls when a rival's answers do part of the
  extending, and is zero in a genuine war that runs to D.
- **Room for a war:** a war of one efficiency step at a time fits in about 16 alternating
  answers.
- **The trade-off:** a later B is cheaper to burn. An earlier B leaves loan sizes frozen for
  longer while withdrawals shrink the pool.
- **The margin today:** in the rounds measured on 2026-11-17, the collateral of the round before
  last came back about 2.5 h before B. A borrower that funds its bid from that return then has
  about 2.5 h to bid. A future change to `stake_held_for` or to the round length could close
  that margin; re-check it whenever they change.

**The empty auction** brings the last move back in one case: if nobody bids before B, a first
bid at D − 5 s sets S = D and cannot be answered. Everyone had until B to bid first, so this is
accepted.

**Why the close is fixed and not "15 minutes after the first bid",** as first proposed. Requests
are accepted throughout the current round, not only after the earlier round's hold ends, so the
first bidder would choose when the clock starts. A borrower whose collateral is still coming back
from the round before last could find the auction closed before it can bid. Closing hours early
whenever nobody contests would also freeze every loan size for most of the gap.

**Why shrink revisions are safe enough.** Ranking is greedy: `decide_loan_requests` walks the
sort keys top-down and accepts each loan that still fits. A shrink revision passes no other request,
grows no loan and doesn't lower the price per GRAM. So anyone it pushes out is pushed out by a
request that already outranked them at the close. That request was skipped only because the
shrinker's larger loan filled the room. The pool is paid at least the price per GRAM bid before
the close.

A shrink can still take some of the water-fill leftover from other borrowers. A capped loan's
room (max_stake − loan − collateral) grows as its loan shrinks, and added collateral can unlock
accrual. That capital is priced at the bid's rate, so the pool loses nothing. The rejected alternative was to allow nothing after the close: then a loan that
withdrawals have made too large is skipped, and its validator sits out the round.

**Considered and rejected:**
- **Only a price raise extends:** blind to a late squeeze by size (`2026-09-19`).
- **A candle close:** relies on block randomness that the bidders, who are validators, can bias.
- **A new field in the participation:** a stored-layout change and a getter reshape, against
  reusing a field that is always 0 in an open round (below).

## Changes

- **`contracts/treasury.fc`, `request_loan`:**
  - Read S from the participation's `stake_held_until` slot. While a round is open, that slot is
    always written as 0 today (`request_loan` packs zeros), and `distribute` overwrites it with
    the real `stake_held_until` in both branches.
  - Compute E.
  - Choose between a normal request and a shrink revision, apply the rules above, and write S
    back when it moves.
  - Today the round is repacked with zeros; it will be repacked with S instead.
- **`contracts/treasury.fc`, `participate_in_election`:** no change. It already carries the field
  through, and `distribute` replaces it.
- **`contracts/treasury.fc`, new getter `get_auction_close(round_since)`:** returns
  (status, E, B, D), so readers get E without knowing the overloaded slot. It never returns the
  slot for a round that isn't open.

  | status | Round | E | Who may send |
  |---|---|---|---|
  | 0 | `round_since` is the next round, and has no participation yet | B | anyone until D; the first bid after B opens a 15-minute window |
  | 1 | state `open` and `round_since` is the next round | max(B, S) | new and normal requests while t < min(E, D); shrinks while E ≤ t < D |
  | 2 | anything else (another round, or any other state) | 0 | nobody |

  It checks that the participation exists before unpacking it: `get_participation` throws (exit 7)
  on a missing round. Readers use min(E, D): after a config change moves D earlier, E can exceed
  D.
- **`contracts/imports/constants.fc`:** `auction::base_close_before = 14400` and
  `auction::extension = 900`.
- **`contracts/imports/constants.fc`, gas:** re-measure `gas::request_loan`. If it rises,
  `request_loan_fee` rises with it.
- **`wrappers/Treasury.ts`:** `getAuctionClose`.
- **`docs/architecture.md`:** the open state, the overloaded slot and the shrink rule.
- **`docs/integration.md`:**
  - the close and the new getter;
  - refusal 201 after the close;
  - a request must be sent with bounce = true, or a refused one's value stays on the treasury as
    surplus (the refusal window grows from seconds to hours);
  - governor changes after E can refuse shrinks:
    - a raised `stake_cap_floor` lifts M₁ above M₀;
    - a changed reward share moves the share term of the key;
    - a lowered max_validators makes a shrink evict the lowest request, which cannot re-enter.
- **`graphs/`:** update the loan request flow if it shows the deadline.

## Invariants

- **No request is accepted after the snapshot of available funds.**
  - Every acceptance, normal or shrink, keeps today's `now() < D` and `state == open`.
    `participate_in_election` commits `distributing` before `distribute` runs.
  - E ≤ D is not needed for this, and doesn't hold after a config change that moves D earlier.
  - `participate_in_election` and `distribute` are untouched, so the election timing is as today.
- **Funds:**
  - The shrink revision goes through the same collateral, floor, punishment and fee checks as
    today.
  - It cannot lower the price per GRAM the pool is owed. That covers min_payment, the accrued
    pricing P·(L+a)/L (which rounds down, monotone in the rate) and the carried reward share.
  - A refused request throws before any state is saved, with no `commit()` on the path. So the
    participation and both counters stay byte-identical, the old request and its collateral
    stand, and the bounce returns the new value.
- **After E no request passes another by its own move, grows its loan or lowers its price per
  GRAM.**
  - The decision order is total: key descending, then lowest address first inside a bucket. The
    pair order flips only when the request that was ahead moves itself down.
  - A request X can still lose its place by its own shrink. Say Y has risen into the gap just
    above X, and X's only valid shrink drops it one step. X then lands below Y.
  - Daemons must re-read the book right before a shrink.
- **S never decreases, and E ≥ B always.**
  - E is monotone in time while the election config stays the same.
  - If a config change moves D later, B can rise past a close that has already passed. The round
    then reopens to new requests and to price changes, with a 15-minute window for answers, as
    before the close.
  - If it moves D earlier, the close comes at the new D with no window, as today.
  - The single repack in `request_loan` writes S on every path, the eviction path included.
- **The overloaded slot is read as S only while `state == open`.** Every other state keeps
  today's meaning, because `distribute` writes the real value before the round leaves
  `distributing`.
  - `send_message_to_loan` reads the slot in every state. For an open round it is now blocked
    until S instead of never. That is harmless: an open round has no loan contracts yet.

## Compatibility

- **Stored layout:** unchanged. A live open participation at upgrade time has S = 0, so E = B.
- **Upgrade timing:** if an upgrade lands between B and D of a live round, that round becomes
  shrink-only at once. Schedule the upgrade outside that window (`scripts/upgrade_treasury.md`).
- **Getters:** `get_participation` keeps its shape. For an open round, its last value is now S
  instead of 0. `get_times` and `get_loan_request` are unchanged. `get_auction_close` is new.
- **Readers of a participation's `stake_held_until` to check:**
  - **poker** reads it only in state `held` (`poke/due.go`), so it is unaffected; confirm.
  - Also check sealed-borrower, borrower, sdk, mcp, website, gauge, club-server and opentonapi's
    Hipo actions, per `scripts/upgrade_treasury.md` § *Changing the shape of a getter*.
- **Message schemas:** none change.
- **Off chain:**
  - Borrower daemons must send before E, not before D. To compete they must also watch until E
    and answer, and after E shrink when withdrawals make their loan too large.
  - The poker needs no new poke: nothing on chain acts at E.

## Acceptance criteria

All in `tests/SoftClose.spec.ts` unless named.

**Normal requests and the close:**
- [x] A new request at t = B − W − 1 (before the extension zone) is accepted, and S stays 0.
- [x] A request at t = B − 600 (inside the zone) sets S = B + 300. A second request at
  t = B + 200 sets S = B + 1100.
- [x] A new request at t = E from a borrower with no standing request is refused with 201. The
  value comes back, and the participation is unchanged byte for byte.
- [x] A config change that moves D earlier below a stored S, then a zone request: S does not
  decrease, and requests after the new D are refused. A change that moves D later: E is never
  earlier than the new B.
- [x] A new request that evicts itself at once (book full, lowest key) still moves S.
- [x] Chained requests, each within W of the current E, never push S past D. A request at
  t = D − 100 sets S = D. A request at t = D is refused (as today), and so is a shrink at t = D.
- [x] Empty auction: the first request at t₁ = B + 3600 is accepted and sets S = t₁ + 900. A
  second borrower's request at t₁ + 899 is accepted and sets S = t₁ + 1799. A third borrower's
  request at t₁ + 1799 is refused.

**Shrink revisions:**
- [x] After E, a revision with L₁ < L₀ and k₁ ≤ k₀ is accepted, total_borrowers_stake is updated
  as in a normal replacement, and S is unchanged.
- [x] After E, each of these is refused with 201. The participation cell, `total_borrowers_stake`
  and `total_request_fees` stay byte-identical:
  - L₁ > L₀;
  - L₁ = L₀ with P₁ < P₀ (the price cut);
  - L₁ < L₀ with P₁ · L₀ < P₀ · L₁;
  - a shrink whose key rises past another request's key;
  - a shrink whose new key k₁ equals a rival's key where the rival has a higher address (the
    interval's closed end at k₁);
  - a shrink at exact price whose key rises out of a bucket in which an equal-key peer has a lower
    address (the peer stays decided first);
  - M₁ > M₀;
  - M₀ ≠ 0 and M₁ = 0.
- [x] After E, a shrink with P₁ · L₀ ≥ P₀ · L₁ whose key rises (rounding or tie-break) but passes
  no other request is accepted. That includes leaving a bucket in which every peer has a higher
  address.
- [x] After E, a no-op shrink sent after the governor changed the reward share and the borrower
  fee:
  - keeps the old request's `borrower_reward_share` and `request_fee`;
  - stays in the bucket of its old key;
  - its collateral check used the carried fee's `min_burn`.
- [x] After config 16 lowers max_validators below `size`, a shrink after E is accepted and evicts
  nobody.

**Ordering and decisions:**
- [x] Greedy property: with three requests where the middle one was skipped before a shrink of
  the top one, the shrink makes the middle one fit and the third may drop. Assert that each
  refused request's loan exceeded the room left by the accepted requests ranked above it, and
  that no request's key rose past another's after E. Only the last assertion targets the new
  rule; the rest exercises the unchanged decide.
- [x] The tie-snipe case: two standing requests and a late equal-efficiency smaller request in
  the extension zone; the outranked borrower answers within W and is accepted, and the decision
  ranks the answer.
- [x] `participate_in_election` at D and `distribute` behave as today with S ≠ 0, in both branches
  of `distribute` (decide, and too-late/elected). Afterwards, `stake_held_until` holds the real
  value (`next_round_until + stake_held_for + 60`), not S.
- [x] Upgrade path, as a real sandbox code upgrade:
  - the live code holds an open round with a standing request;
  - upgrade to the new code;
  - at a time in [B, D), a new borrower's bid is refused and a valid shrink is accepted.

**Getters and gas:**
- [x] `get_auction_close` returns:
  - status 0 with E = B for the next round with no participation;
  - status 1 with E = max(B, S) for the next round in state `open`;
  - status 2 with E = 0 for a past or unknown `round_since` (without throwing) and for any state
    other than `open`.
- [x] `MaxGas.spec.ts` and `MinGas.spec.ts` are green, and `gas::request_loan` covers the worst
  path (a shrink revision with the max_validators eviction not taken, and a normal request in
  the zone with the eviction taken).

**Release:**
- [x] `npm run check` passes.
- [ ] Each reader listed under Compatibility has been checked and either needs no change or has
  its change listed in `scripts/upgrade_treasury.md`.

## Out of scope

- **The ranking rule itself**, including tie to the smaller loan. Inside the window a tie can be
  answered by one step, so it is no longer free.
- **A governor-set B or W:** constants for now, so a change needs a treasury upgrade.
- **The borrower and sealed-borrower daemon changes** to watch, answer and shrink. They are
  separate work in their own repos.
- **Commit–reveal and candle close:** see the earlier specs.

## Open questions

None. Decided by the governor on 2026-11-17:

1. **A shrink after the close may push out a lower-ranked bidder.** Accepted, option (a).
   - **Example:** pool 3.0M; at the close A 1.5M, B 1.6M, C 1.0M, in rank order. As things stand
     A and C are lent, and B is skipped because it doesn't fit after A. If A shrinks to 1.3M, B
     fits and C is skipped.
   - **Why it was accepted:** the push-out only ever favours a bidder who outranked C at the
     close. C's place came from the skip, not from its rank. Shrinking also protects borrowers
     from withdrawals that make the pool smaller.
   - **Rejected:**
     - (b) only the lowest-ranked request may shrink: a large loan made too big by withdrawals
       is skipped.
     - (c) no changes after the close.
2. **A size bluff** (post a large loan to scare others off, shrink after the close). Accepted,
   option (a); watch for it. The bluffer keeps paying its bid price per GRAM on what remains.
   - **Rejected:** (b) a limit per shrink, which would also limit honest shrinks after a large
     withdrawal.
