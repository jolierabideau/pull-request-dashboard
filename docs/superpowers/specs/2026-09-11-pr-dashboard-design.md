# PR Dashboard — Design

**Date:** 2026-09-11
**Status:** Approved for planning

## Purpose

A locally-run web dashboard that answers one question in ten seconds: **which of my
pull requests are waiting on me right now?**

It watches `paranext/paranext-core` for PRs authored by `jolierabideau`, classifies
each into a ball-in-court bucket, and notifies on transitions into the author's
court. It also tracks local branches, and tracks PRs the author has posted to
Discord for review so that silence can be surfaced as a nudge.

## Background: how reviews actually arrive

The design rests on findings from the repository's real review history, not on
assumptions about how GitHub is usually used.

**Reviews do not use GitHub's inline threads.** `reviewThreads.totalCount` is `0`
on every PR examined. Reviewer `katherinejensen00` works through
[Reviewable](https://reviewable.io), which posts its output as GitHub *review
bodies*. The REST endpoint `/pulls/{n}/comments` returns an empty array. Any
design that reads inline comments reads nothing.

**`reviewDecision` is misleading.** Two concrete cases:

- **PR #2742** ends in state `APPROVED`. That review body says *"Just one blocker
  introduced by my tour changes. Feel free to push back on it as out of scope. I am
  approving just in case..."*, and its Reviewable footer reads
  `status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau)`.
- **PR #2765** was `APPROVED` with *"There is only one blocker and I think you can
  fix it so going ahead and approving"*, then received a later `COMMENTED` review
  carrying further findings.

A dashboard trusting `APPROVED` alone would report "done" on both.

**The Reviewable footer is the strongest single signal.** Review bodies end with a
line of the form:

```
status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).
```

The parenthetical names whose court the review tool believes the PR is in, and the
unresolved count is a number. Both are machine-readable and authored by the review
tool rather than inferred by us.

**`COMMENTED` reviews carry verdicts.** Katherine's format includes lines such as
`**Verdict: 1 blocking, 15 warnings, 16 suggestions.**`. GitHub's `COMMENTED` state
conveys none of that.

**The workflow is round-based.** A review lands; the author posts an issue comment
titled `## Round-N response` / `## Response to round N` and pushes a commit; a
re-review follows. "Ready for re-review" is therefore computable from timestamps
alone, with no text analysis: *the author acted after the reviewer last did.*

## Scope

**In scope:** open PRs authored by the user in one configured repository; local
branches in the configured working copy; Discord-post tracking; classification;
macOS notifications.

**Out of scope:** Discord integration of any kind (the button is a manual stamp);
reviewing others' PRs; writing to GitHub (no merging, commenting, or closing from
the dashboard); multi-user support; hosting anywhere but localhost.

## Architecture

Two processes, started by one `npm run dev`.

### Server — Node + Fastify + TypeScript

- **Auth.** Reads `gh auth token` once at startup into memory. No PAT file, no new
  credential to manage; it inherits the existing keyring login. If `gh` is absent or
  logged out, the server exits with an actionable message.
- **Poller.** Every 3 minutes (configurable): one GitHub GraphQL query for the
  user's open PRs with reviews, comments, commits, check rollup, and mergeability;
  plus `git for-each-ref` against the configured repo path for branch state. Writes
  an in-memory snapshot.
- **Rules engine.** A pure function `classify(pr, local, now) → Classification`.
  No I/O, no network, no clock access — `now` is injected. This is the testable core.
- **Store.** SQLite via `better-sqlite3`, one file, holding only what GitHub cannot
  report: Discord post timestamps, cached Claude verdicts, manual overrides, snoozes,
  and per-PR last-notified state.
- **Notifier.** Diffs each new classification against the previous and shells out to
  `osascript` on transitions into the user's court.

Routes:

| Route | Purpose |
| --- | --- |
| `GET /api/board` | The full classified board |
| `POST /api/pr/:number/discord` | Stamp/clear the Discord post time |
| `POST /api/pr/:number/override` | Force a bucket |
| `POST /api/pr/:number/snooze` | Hide until a date |

### Client — Vite + React + TypeScript

Polls `GET /api/board` every 30 seconds. Hits the server's snapshot, not GitHub, so
the cadence is free. No websockets. The client never contacts GitHub directly;
classification happens in exactly one place.

### Configuration

A `config.json` (gitignored, with a committed `config.example.json`) holding the
repo path, `owner/name`, the GitHub login to treat as "me", poll interval, and the
staleness threshold. Nothing about the repository is hardcoded.

## The rules engine

### Derived timestamps

- `lastReviewerActivity` — newest review or issue comment by anyone who is not the
  configured user.
- `lastMyActivity` — newest of the user's pushes (head commit `committedDate`) and
  the user's issue comments.

For the large majority of PRs, comparing these two answers "whose court" correctly,
because the round-response workflow is so consistent. The remaining rules are
exceptions to that comparison.

### Parsed signals

From the most recent reviewer review body:

- **Reviewable footer** — regex for `status: ...` capturing the unresolved-discussion
  count and the `(waiting on <login>)` parenthetical. Absent on non-Reviewable reviews;
  treated as "no signal", never as "zero unresolved".
- **Verdict line** — regex for `(\d+) blocking`, capturing a blocking count.
- **Blocking language** — a conservative word list (`blocker`, `blocking`,
  `must fix`, `needs change`) used only as an *escalation trigger*, never on its own
  to decide a bucket. Text matching decides nothing; it only asks Claude to look.

### Buckets, in priority order

A PR lands in the first bucket that matches. **Buckets 2, 3, and 4 require
`lastReviewerActivity` to be non-null** — a PR that has never been reviewed skips
them entirely and falls through to 5, 6, or 7. `lastMyActivity` is always non-null
(a PR has at least one commit), so the comparison is only ever made between two real
timestamps.

1. **Blocked on you, mechanically** — `mergeable == CONFLICTING`, or a failing check
   on the current head. Outranks review state: a red build is the author's court
   regardless of what anyone said.
2. **Needs your response** — `lastReviewerActivity > lastMyActivity` and the last
   reviewer action is not a clean approval.
3. **Ready to merge** — last reviewer action is `APPROVED`, **and** the Reviewable
   footer reports zero unresolved discussions, **and** no blocking language is
   present. All three conditions, per #2742 and #2765.
4. **Waiting on reviewer** — `lastMyActivity > lastReviewerActivity`. Shows elapsed
   time since the author's last action.
5. **Asked, nobody's looked** — a Discord timestamp exists and there has never been
   reviewer activity. Turns amber past the staleness threshold (default 2 business
   days).
6. **Not asked yet** — open, non-draft, no Discord timestamp.
7. **Draft** — quiet by default.

Plus two branch-only buckets: **unsubmitted work** (a local branch ahead of `main`
with no PR) and **dead branches** (upstream gone), the latter collapsed with a prune
action.

Manual overrides take precedence over all of the above and expire automatically on
the next reviewer activity. Snoozed PRs are hidden until their date.

### Ties, and what a Classification carries

Every classification carries `receipts: string[]` — the human-readable signals that
produced the bucket, e.g. `["Katherine commented 4h ago", "you pushed 2d ago",
"footer: 1 unresolved, waiting on you"]` — plus the bucket, a timestamp to display,
and an optional Claude verdict. A wrong call must be legible on the card.

## Claude escalation

The rules engine never calls Claude. It returns `escalate: EscalationReason | null`
as part of its result, and a separate layer acts on that. This keeps the engine pure
and keeps the deterministic tests offline.

**Escalation triggers — only these three:**

1. The last reviewer review is `APPROVED`, but the footer shows unresolved
   discussions, or names the author in `waiting on`, or the body contains blocking
   language.
2. The last reviewer review is `COMMENTED`. This state carries no verdict, and in
   this repository's history has meant anything from "2 blocking" to a compliment.
3. The footer and the derived timestamps disagree about whose court it is.

**Call shape.** `@anthropic-ai/sdk`, model `claude-opus-5`, adaptive thinking
(`thinking: { type: "adaptive" }`), and structured output via
`output_config: { format: { ... } }` — not the deprecated `output_format` parameter.
The schema returns:

```ts
{ court: "me" | "reviewer", blockingCount: number, asks: string[], confidence: "high" | "low" }
```

The prompt receives the review body and the escalation reason, and is asked only to
resolve the court and list what is being asked for. It is not asked to re-derive
bucket priority; that stays in code.

**Caching.** Verdicts are cached forever in SQLite against the review's GraphQL node
ID. Review bodies are immutable, so each review is paid for exactly once. A cache hit
costs nothing, which is what makes 30-second client polling viable.

**Auth.** Per the Anthropic SDK credential chain, a zero-argument client works when
`ANTHROPIC_API_KEY` is set *or* an `ant auth login` profile is active. The server
checks at startup and degrades rather than failing if neither is present.

## Board and interactions

**One prioritized column, not a kanban.** Ten-second triage means no horizontal
scanning. Buckets are labeled section headers in priority order, "Blocked on you"
first. The count of items in the user's court renders in the document title so a
backgrounded tab still reports.

Buckets 4–7 collapse to one-line summaries by default (*"4 waiting on Katherine,
oldest 3 days"*) and expand on click. Dead branches stay collapsed. The default view
is short enough that things needing attention cannot hide.

**A card** shows number and title, a bucket-appropriate age, the receipts line, CI
state as a small dot, and Claude's extracted `asks` when it was consulted. Clicking
the title opens the PR on GitHub; everything else stays inline.

**Three actions per card:** "Posted to Discord" (the most prominent, since it is the
one thing the dashboard cannot observe), an override control, and a snooze.

## Notifications

Fire on **transitions only**, never on steady state:

- a PR entering the user's court,
- a Discord clock crossing the staleness threshold,
- CI going red on a head the user just pushed.

One notification per transition, deduped against the SQLite last-notified state so a
server restart does not re-announce everything already seen. Delivered via
`osascript`, which works with the browser closed. Clicking opens the PR.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| GitHub unreachable or rate-limited | Serve the last good snapshot with a visible staleness banner. Never blank. |
| Claude call fails or is unauthenticated | Fall back to the deterministic bucket; the card states that the tie-break is unavailable. Degraded, never wrong-and-silent. |
| Repo path missing or not a git repo | PRs still work; branch buckets show an explanatory empty state. |
| `gh` absent or logged out | Exit at startup with an actionable message. |
| SQLite file corrupt or unwritable | Exit at startup; the store holds the only non-reconstructible state. |

## Testing

**Fixtures from real history.** Captured GraphQL responses committed as JSON, each
pinning a case the engine must not get wrong:

| Fixture | Pins |
| --- | --- |
| #2742 | Approved with one blocker, `1 unresolved discussion (waiting on jolierabideau)` → must **not** be "ready to merge" |
| #2765 | Approved, then a later `COMMENTED` review with findings → must return to the author's court |
| #2717 | A genuinely clean approval → must reach "ready to merge" |
| #2772 | `CHANGES_REQUESTED` followed by a clean approval |
| #2795 | Open, no reviews, cancelled checks |
| A draft PR | Bucket 7 |

Tests are table-driven over these: fixture in, expected bucket and receipts out. When
the engine is wrong in real use, the fix is to capture that PR as a new fixture, write
the failing assertion, then change the rules — so the suite grows along the axis where
this is most likely to be wrong.

**Claude escalation is tested at the boundary.** Deterministic tests assert the
*trigger conditions* (approved-with-unresolved escalates; clean approval does not;
`COMMENTED` always does) without any network. The prompt-and-parse layer gets a small
number of tests against recorded responses.

**Thin layers, thin tests.** The GitHub client gets one test that a recorded payload
maps into the engine's input shape. The store gets tests for the Discord clock and
notification dedupe, since "have I already notified about this" is stateful and easy
to break across restarts. The React layer gets no unit tests; it renders a
classification computed elsewhere.

Vitest throughout, matching `pr-review-bot`'s existing tooling.

## Open risks

- **Reviewable footer format is not contractual.** It is a third-party tool's output
  and could change. The parser must fail soft: an unparseable footer means "no
  signal", which degrades to timestamp comparison, not to a wrong answer.
- **Single-reviewer history.** Every PR examined was reviewed by the same person. The
  rules are written against signals, not against that login, but a second reviewer
  with different habits may expose gaps. The fixture workflow above is the remedy.
- **Business-day math.** The staleness threshold is in business days, which needs a
  weekend-aware helper. Holidays are ignored.
