# PR Dashboard

A local dashboard that answers one question about your open pull requests: **whose
court is the ball in?** It polls GitHub, sorts your PRs into prioritized buckets
(blocked, needs your response, ready to merge, waiting on a reviewer, …), shows the
receipts behind each verdict, and notifies you when a PR changes court.

It runs entirely on your machine. Each person runs their own copy, tracking their own
GitHub login.

## Prerequisites

| | |
| --- | --- |
| **Node 22+** | `better-sqlite3` builds a native module, so an older Node fails at install. |
| **GitHub CLI, logged in** | The server reads your token from `gh auth token` at startup. Run `gh auth login` first. No token is ever stored in this repo. |
| **A local clone of the repo you're tracking** | Branch buckets read it with `git -C`. Nothing is written to it. |
| **`ANTHROPIC_API_KEY`** | Optional. Used only to break ties on ambiguous reviews — see [Review escalation](#review-escalation). |
| **macOS, for notifications** | The board itself works everywhere; desktop notifications don't. See [Known limits](#known-limits). |

## Quickstart

```bash
npm install
cp config.example.json config.json   # then edit it — see below
npm run dev
```

Open <http://localhost:5173>.

`npm run dev` starts two processes: the API on port 5174 and the Vite dev server on
5173, which proxies `/api` to the API. On startup the server prints which login and
repo it is tracking — check that line says *you*.

## Configuration

`config.json` is gitignored, so your copy stays yours. Every field is required.

| Field | Meaning |
| --- | --- |
| `repoPath` | Absolute path to your local clone. Used for branch buckets. |
| `owner` / `name` | The GitHub repo to poll, e.g. `paranext` / `paranext-core`. |
| `me` | **Your** GitHub login. This is what "your court" is measured against. |
| `botLogins` | Logins whose reviews and comments don't count as human activity. |
| `pollIntervalMs` | How often to poll GitHub. Minimum 30000; 180000 (3 min) is the default. |
| `staleAfterHours` | How long a PR sits unlooked-at before the Discord nudge goes stale. |

The example file ships with placeholders in angle brackets for the two fields that
must be yours. The server refuses to start while any placeholder is left in place, and
refuses to start if `repoPath` doesn't exist — both produce a message naming the field.

Environment overrides, all optional:

| Variable | Default |
| --- | --- |
| `PRD_CONFIG` | `config.json` |
| `PRD_DB` | `pr-dashboard.db` |
| `PORT` | `5174` (the API; the web port lives in `client/vite.config.ts`) |

## Review escalation

Most reviews are classified deterministically from the Reviewable footer and review
timestamps. Two cases are genuinely ambiguous — a `COMMENTED` review with no footer,
and an approval whose body still asks for changes — and those are sent to Claude to
decide whose court the PR is in. Verdicts are cached in SQLite per review revision, so
each review is escalated at most once.

This needs `ANTHROPIC_API_KEY` in your environment. **Without it the dashboard still
works**: the ambiguous PR falls back to its deterministic bucket and the card says the
tie-break is unavailable. Nothing crashes and nothing is retried in a loop.

## Development

```bash
npm test          # vitest, one pass
npm run test:watch
npm run typecheck
```

Classification is covered by unit tests plus fixture tests built from nine real PRs in
`tests/fixtures/`. `scripts/capture-fixtures.ts` refreshes them.

## Known limits

- **Notifications are macOS-only.** They shell out to `osascript`. On Linux and
  Windows `notify()` is a no-op and the server says so once at startup — the board,
  buckets, and receipts all work normally; you just have to look at the tab.
- **One user per checkout.** `me` is a single login, and the SQLite file holds that
  person's notification and Discord state. Teammates each clone and configure their
  own; don't share a working copy.
- **Polling, not webhooks.** Changes show up within one `pollIntervalMs`, not
  instantly.
- **`gh` is required at startup.** If it's missing or logged out, the server exits
  with an actionable message rather than running blind.
