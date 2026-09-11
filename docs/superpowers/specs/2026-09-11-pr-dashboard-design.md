# PR Dashboard — Design

**Date:** 2026-09-11
**Status:** Revised after adversarial review. Awaiting approval.

## Purpose

A locally-run web dashboard that answers one question in ten seconds: **which of my
pull requests are waiting on me right now?**

It watches `paranext/paranext-core` for PRs authored by `jolierabideau`, classifies
each into a ball-in-court bucket, and notifies on transitions into the author's
court. It also tracks local branches, and tracks PRs the author has posted to
Discord for review so that silence can be surfaced as a nudge.

## Revision note

The first draft of this spec generalized from roughly eight recent PRs. An
adversarial review against the full 100-PR history falsified several of its central
claims. The corrections are load-bearing and are recorded in **Appendix A** rather
than quietly dropped, because they are the reason several rules look the way they do.
The short version: the Reviewable footer is richer and more authoritative than the
first draft thought, and commit timestamps are far less trustworthy.

## Background: how reviews actually arrive

All claims below were verified against all 100 PRs authored by the user.

**Reviews arrive mainly as review bodies, via Reviewable.** Most review content is
posted by [Reviewable](https://reviewable.io) into GitHub *review bodies*, including
per-file comment blocks embedded in the body text.

**But GitHub inline threads are not empty.** Four of the user's PRs carry native
review threads (`#2180` with 13, `#2586` with 3, `#2182` with 2, `#2160` with 1).
Several repo colleagues use native GitHub review. Inline threads must be queried;
ignoring them makes a native-GitHub reviewer completely invisible.

**Reviewers are many, and one is a bot.** Review counts across the user's PRs:

```
katherinejensen00: 110   tjcouch-sil: 46   lyonsil: 37   Sebastian-ubs: 21
irahopkinson: 19   rolfheij-sil: 16   devin-ai-integration: 10 (BOT)
imnasnainaec: 3   merchako: 3   tombogle: 3
```

`devin-ai-integration` submits automated `COMMENTED` reviews. Bot activity must never
set `lastReviewerActivity`.

**The Reviewable footer is the primary court signal, and it has four shapes.** It
appears once per review and is authored by the review tool, not inferred. Its
position in the body varies — line 1 of 122 on `#2664`, line 198 of 216 on `#2717` —
so it must be found by search, never by reading the last line.

| Shape | Meaning |
| --- | --- |
| `complete! all files reviewed, all discussions resolved.` | Fully reviewed, nothing open |
| `all files reviewed, N unresolved discussion[s] (waiting on X[ and Y])` | Fully reviewed, N open |
| `M of N files reviewed, K unresolved discussions (waiting on ...)` | Partial review, K open |
| `M of N files reviewed, all discussions resolved.` | Partial review, nothing open |

A clean review **omits the count entirely** rather than reporting zero. Any rule
requiring "the footer reports zero unresolved" is unsatisfiable. The `waiting on`
parenthetical may name **two** people (`waiting on jolierabideau and
katherinejensen00`) and the discussion noun alternates singular/plural.

**The footer text differs by GraphQL field.** In `body` (raw markdown) it reads
`...)* status: <span>:shipit:</span> complete! ...`; in `bodyText` (plaintext) it
reads `Reviewable status:  complete! ...` with a double space. **The parser reads
`bodyText`**, and this is a deliberate choice, not an accident.

**The author replies through Reviewable too.** On at least eleven PRs the user
submitted a `COMMENTED` review whose footer reads `(waiting on katherinejensen00)`.
This is the clearest "ball is in the reviewer's court" signal in the dataset, and it
exists even when the user has not pushed. Footers from *all* reviews are parsed, not
just reviewers'.

**`1 unresolved discussion (waiting on jolierabideau)` on an APPROVED review is
noise.** It is Reviewable counting its own review-summary thread. It appears on the
final, merge-triggering approval of `#2687`, `#2699`, `#2704`, `#2708`, `#2712`,
`#2715`, `#2717`, `#2720`, `#2742`, and others; `#2720` merged **two minutes** after
such an approval, `#2712` after six. An explicit human approval outranks this count.

**Commit timestamps are not a reliable record of author activity.** The user merges
`origin/main` into branches constantly — 8 of 12 recent commits on `#2664`, 6 of 12
on `#2742` — and such a merge is frequently the head commit. Rebases rewrite
`committedDate` wholesale: `#2742` carries three commits sharing a single
`committedDate` four days after they were authored. `pushedDate` is `null` on every
commit (GitHub removed it). Reviewers occasionally push to the user's branches
(`#1983` by `tjcouch-sil`, `#2480` by `tombogle`), and on 15 older PRs
`commit.author.user` is `null` because of an unmapped email.

**`Verdict: N blocking` is rare.** It occurs in 2 of 92 reviews, both on `#2742`. It
is a property of one review, not of a reviewer's style, and is not load-bearing here.

## Scope

**In scope:** open PRs authored by the user in one configured repository; local
branches in the configured working copy; Discord-post tracking; classification;
macOS notifications.

**Out of scope:** Discord integration of any kind (the button is a manual stamp);
reviewing others' PRs; writing to GitHub (no merging, commenting, closing, or branch
deletion from the dashboard); multi-user support; hosting anywhere but localhost.

## Architecture

Two processes, started by one `npm run dev`.

### Server — Node + Fastify + TypeScript

- **Auth.** Reads `gh auth token` at startup, and **re-reads it on any 401**, since
  tokens rotate under a long-running dev server. If `gh` is absent or logged out, the
  server exits with an actionable message.
- **Poller.** Every 3 minutes (configurable): one GitHub GraphQL query per page of the
  user's open PRs, plus `git for-each-ref` against the configured repo path.
- **Rules engine.** A pure function `classify(pr, local, now) → Classification`. No
  I/O, no network, no clock access — `now` is injected. This is the testable core.
- **Store.** SQLite via `better-sqlite3`: Discord post timestamps, cached Claude
  verdicts, and per-PR last-notified state.
- **Notifier.** Diffs each new classification against the previous and shells out to
  `osascript` on transitions into the user's court.

Routes: `GET /api/board`, `POST /api/pr/:number/discord`.

### Client — Vite + React + TypeScript

Polls `GET /api/board` every 30 seconds against the server's snapshot, not GitHub.
No websockets. Classification happens in exactly one place.

### The GraphQL query must include

Beyond the obvious fields: `reviews(bodyText, state, author, submittedAt)`,
`reviewThreads(isResolved, comments)`, `mergeStateStatus` alongside `mergeable`,
`statusCheckRollup` with **per-context conclusions** (not just the rolled-up state),
and `timelineItems` filtered to `PullRequestCommit` and `HeadRefForcePushedEvent`.

### Configuration

A gitignored `config.json` (with a committed example) holding repo path,
`owner/name`, the login to treat as "me", a bot-login denylist, poll interval, and
the staleness threshold in **hours**.

## The rules engine

### Step 1 — the footer is the primary court signal

Parse the Reviewable footer from the `bodyText` of **every** review, by any author,
against the four-shape grammar above. Take the footer from the **newest** review.

- If that footer's `waiting on` set contains only the user → **court = me**.
- If it contains only other people → **court = reviewer**.
- If it names both → **court = me** (conservative: if you're named, you're on the hook).
- If it reports all discussions resolved → **court = nobody; work is done**.
- If no footer exists anywhere → fall through to Step 2.

The footer is a snapshot taken when its review was submitted. **If any qualifying
activity occurred after that review, the footer is stale** and Step 2 decides instead.

### Step 2 — timestamp fallback

Used only when there is no footer, or the footer is stale.

- `lastReviewerActivity` — newest review or comment by a **non-bot human who is not
  the user**, excluding reviews in state `DISMISSED`, and including the newest comment
  on an unresolved native inline thread.
- `lastMyActivity` — newest of: the user's issue comments, the user's own reviews, and
  the user's **substantive** commits.

A commit is **substantive** when it is authored by the user *and* is not a bare merge
of `origin/main` (detected by the merge-commit shape plus a message match). Bare merges
and reviewer-authored commits do not count as the user handing work back. Where
`commit.author.user` is null, fall back to matching `author.email` / `author.name`.

### Step 3 — buckets, in priority order

`classify` returns the first bucket that matches.

**Drafts are excluded from buckets 1 through 4 unless they have reviewer activity.**
A draft with no reviews goes straight to bucket 7 regardless of conflicts or CI. This
matters today: five of the user's open drafts are currently `CONFLICTING` and would
otherwise fill the loudest bucket and fire notifications for unfinished work.

1. **Blocked on you, mechanically** — a check context with `conclusion == FAILURE` on
   the current head, or `mergeStateStatus == DIRTY`. Defined precisely in the next
   section.
2. **Needs your response** — court is `me`.
3. **Ready to merge** — court is `nobody`, or the newest human review is `APPROVED`
   with no later reviewer activity. An explicit approval outranks the footer's
   unresolved count, per the merge-within-minutes evidence above. If the approval body
   contains blocking language, the PR is escalated to Claude before landing here.
4. **Waiting on reviewer** — court is `reviewer`.
5. **Asked, nobody's looked** — a Discord timestamp exists and there has never been
   reviewer activity. Turns amber past the staleness threshold.
6. **Not asked yet** — open, non-draft, no Discord timestamp.
7. **Draft.**

Plus two branch-only buckets: **unsubmitted work** (a local branch ahead of `main`
with no PR) and **dead branches** (upstream gone), the latter collapsed and
**display-only** — the dashboard does not delete branches.

### Step 4 — CI and mergeability, precisely

`statusCheckRollup.state` is **not** usable: `#2795` rolls up to `FAILURE` with only
cancelled runs and successes. Instead:

| Condition | Treatment |
| --- | --- |
| Any context `conclusion == FAILURE`, `TIMED_OUT`, or `ACTION_REQUIRED` | Bucket 1 |
| `CANCELLED`, `NEUTRAL`, `SKIPPED` | Ignored, shown as a grey dot |
| `PENDING` / in-progress | Shown as a pulsing dot; never bucket 1 |
| No checks at all (`rollup == null`) | No dot |
| Checks attached to a non-head commit | Ignored as stale |

`mergeable` is `UNKNOWN` on five of eleven open PRs right now, because GitHub computes
it lazily. **`UNKNOWN` is never treated as clean:** the poller re-requests that PR once
after a short delay, and until resolved the card shows "conflict status unknown."
`mergeStateStatus == DIRTY` is the conflict test; `BLOCKED` (branch protection, as on
`#2664` today) is surfaced on the card but does not change the bucket.

### Receipts

Every classification carries `receipts: string[]` — the signals that produced the
bucket, e.g. `["footer @ Katherine's review 4h ago: all discussions resolved",
"your last push 2d ago was a bare merge of main (not counted)"]` — plus the bucket, a
display timestamp, and an optional Claude verdict. A wrong call must be legible on the
card. This field is the main defense against the failure mode that produced this
revision.

## Claude escalation

The rules engine never calls Claude; it returns `escalate: EscalationReason | null`
and a separate layer acts on that. The engine stays pure and its tests stay offline.

**Triggers — two, narrowed from the original three:**

1. The newest human review is `COMMENTED` with no usable footer. This state carries no
   verdict and has meant anything from "2 blocking" to a compliment.
2. The newest human review is `APPROVED` but its body contains blocking language.
   Approval normally wins outright; this is the one case worth a second look.

The original trigger "approved but the footer shows unresolved discussions" is
**deleted**. It fired on roughly half of all approvals and keyed on what Appendix A
shows is noise.

**Call shape.** `@anthropic-ai/sdk`, model `claude-opus-5`, adaptive thinking
(`thinking: { type: "adaptive" }`), structured output via `output_config.format` — not
the deprecated `output_format`. Schema:

```ts
{ court: "me" | "reviewer", blockingCount: number, asks: string[], confidence: "high" | "low" }
```

**Caching.** Verdicts are cached in SQLite keyed on the review's node ID **plus its
`lastEditedAt`** — review bodies are editable, so the node ID alone is not a safe key.

**Auth.** A zero-argument client works when `ANTHROPIC_API_KEY` is set or an
`ant auth login` profile is active. Checked at startup; degrades rather than failing.

## Board and interactions

**One prioritized column, not a kanban.** Buckets are labeled section headers in
priority order, "Blocked on you" first. The count of items in the user's court renders
in the document title so a backgrounded tab still reports.

Buckets 4–7 collapse to one-line summaries by default and expand on click. Dead
branches stay collapsed.

**A card** shows number and title, a bucket-appropriate age, the receipts line, CI
state as a dot, any `BLOCKED` merge state, and Claude's `asks` when consulted.

**One action per card:** "Posted to Discord" — the one thing the dashboard cannot
observe. Overrides and snoozes are cut; see Scope decisions.

## Notifications

Fire on **transitions only**: a PR entering the user's court, a Discord clock crossing
the threshold, or a check failing on a head the user just pushed. Deduped against the
SQLite last-notified state. Delivered via `osascript`, which works with the browser
closed.

The user frequently posts several comments per round, including corrections minutes
later. Notifications are therefore debounced: a PR that has notified within the last
15 minutes will not notify again.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| GitHub unreachable or rate-limited | Serve the last good snapshot with a staleness banner. On failure at startup, with no snapshot yet, render the board shell with an explicit "no data yet — retrying" state. |
| HTTP 401 | Re-read `gh auth token` and retry once before reporting an auth error, distinctly from "unreachable". |
| Claude call fails or unauthenticated | The PR lands in the bucket it would have had with the escalation resolved **against** escalation (bucket 3 for an approval, bucket 2 for a `COMMENTED`), and the card says the tie-break is unavailable. |
| Repo path missing or not a git repo | PRs still work; branch buckets show an explanatory empty state. |
| `gh` absent or logged out | Exit at startup with an actionable message. |
| SQLite corrupt or unwritable | Run read-only with a banner naming what was lost. The dashboard's core job does not depend on it. |

## Scope decisions (cut)

Cut deliberately, with reasons, because a single-user local tool has a low complexity
budget:

- **Manual bucket overrides** — a persisted entity, expiry rule, route, and control.
  If a classification is wrong, the fix is a fixture and a rule change, which the
  testing workflow already provides.
- **Snoozes** — eleven PRs fit on one screen.
- **Branch pruning** — `git branch -vv | grep gone` already does this, and the spec
  otherwise forbids destructive actions.
- **Business-day math** — the staleness threshold is in hours.

## Testing

**Fixtures from real history**, each pinning a case that must not regress:

| Fixture | Pins |
| --- | --- |
| `#2717` | Two approvals; the newest has a `complete! all discussions resolved` footer → **ready to merge** |
| `#2720` | Approved with `1 unresolved (waiting on jolierabideau)`, merged 2 min later → **ready to merge**, not blocked |
| `#2664` | Approved, `mergeState=BLOCKED`, head commit is a bare merge of main → **ready to merge**, *not* "waiting on reviewer" |
| `#2742` | Rebase collapses three `committedDate`s; later `COMMENTED` review with findings |
| `#2795` | Cancelled checks only, `rollup == FAILURE` → **not** bucket 1 |
| `#2796` / `#2801` | Draft + `CONFLICTING` → bucket 7, **not** bucket 1 |
| `#2687` | Footer names two people → court = me |
| `#2635` | The user's own `COMMENTED` review, footer `waiting on katherinejensen00` → court = reviewer |
| `#2180` | 13 native inline threads → reviewer activity is detected |
| A `devin-ai-integration` review | Bot activity does not set `lastReviewerActivity` |
| A `DISMISSED` review | Does not set `lastReviewerActivity` |

Table-driven: fixture in, expected bucket and receipts out. When the engine is wrong
in real use, capture that PR as a new fixture, write the failing assertion, then change
the rules.

**Claude escalation is tested at the boundary** — trigger conditions only, no network.
**Thin layers, thin tests:** one mapping test for the GitHub client; store tests for
the Discord clock and notification dedupe. No React unit tests.

Vitest throughout, matching `pr-review-bot`.

## Open risks

- **The footer grammar is a third-party contract.** Reviewable could change it. The
  parser must fail soft: an unrecognized footer means "no signal", which degrades to
  Step 2, not to a wrong answer. A metric counting unparsed footers is worth having.
- **The approval-outranks-footer rule is calibrated on this reviewer.** It is right on
  every case in the dataset, but it is a judgment call, and it is the rule most likely
  to hide a real blocker. The blocking-language escalation exists to cover it.
- **Bare-merge detection is heuristic.** A merge of main that also resolves conflicts
  meaningfully is real work that this rule will discount.
- **Nine humans review these PRs, with different habits.** Only Katherine's are
  well-characterized here. The fixture workflow is the remedy.

## Appendix A — corrections from adversarial review

Recorded so the reasoning behind the rules stays visible.

1. **"A clean footer reports zero unresolved."** False. It omits the count and says
   `all discussions resolved`. The original bucket 3 was unsatisfiable, which would
   have routed every approved PR to "Needs your response" — the exact false-alarm
   failure the dashboard exists to prevent.
2. **"`1 unresolved (waiting on jolierabideau)` on an approval proves `APPROVED` is
   untrustworthy."** False. It is Reviewable's own summary thread, present on a dozen
   merge-triggering approvals. The original design built an escalation trigger on it.
3. **"`reviewThreads.totalCount` is 0 on every PR."** False; four of the user's PRs
   have native threads. Generalized from too small a sample.
4. **"Katherine is the only reviewer."** False; nine humans and one bot.
5. **"Head `committedDate` represents author activity."** False under bare merges of
   main, rebases, and reviewer pushes.
6. **Drafts.** The original priority order contradicted its own prose; five current
   drafts would have filled bucket 1.
7. **`statusCheckRollup.state` and `mergeable`.** `FAILURE` on cancelled-only;
   `UNKNOWN` on five of eleven open PRs.
