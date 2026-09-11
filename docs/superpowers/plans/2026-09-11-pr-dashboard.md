# PR Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally-run web dashboard that answers, in ten seconds, which of the user's open `paranext-core` pull requests are waiting on them.

**Architecture:** A Fastify server owns all state — it polls GitHub's GraphQL API and the local git repo, runs a **pure** rules engine over the result, caches Claude verdicts and Discord timestamps in SQLite, and fires macOS notifications on transitions. A Vite/React client polls the server's snapshot and renders one prioritized column. Classification happens in exactly one place, behind one pure function, tested against real captured PR data.

**Tech Stack:** TypeScript, Node 24, Fastify, better-sqlite3, Vite + React, Vitest, `@anthropic-ai/sdk`, the `gh` CLI (for auth only).

**Spec:** `docs/superpowers/specs/2026-09-11-pr-dashboard-design.md`

## Global Constraints

- **Runtime:** Node 24 (`v24.14.1` installed). ESM throughout (`"type": "module"`).
- **Repo under observation:** `paranext/paranext-core`, working copy at `~/dev/paranext-core`. User login: `jolierabideau`.
- **The rules engine is pure.** No I/O, no network, no `Date.now()`. `now` is always an injected parameter. This is what makes it testable and is non-negotiable.
- **Footer parsing reads GraphQL `bodyText`, never `body`.** The raw markdown contains `<span>:shipit:</span>` and link syntax; `bodyText` is the flattened form the grammar below is written against.
- **The dashboard never writes to GitHub.** No merging, commenting, closing, or branch deletion.
- **Bot logins are configurable and filtered everywhere.** `devin-ai-integration` is the known one.
- **Test framework:** Vitest, matching `~/dev/pr-review-bot`.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `test:`, `chore:`).

## The Reviewable footer grammar (authoritative)

Derived from all 92 footer-bearing reviews across the user's 100 PRs. Every task that
touches footers refers to this table.

```
Reviewable status:[  complete!] <files clause>, <discussions clause>[ (waiting on <names>)].
```

| Clause | Observed forms |
| --- | --- |
| files | `all files reviewed` · `M of N files reviewed` |
| discussions | `all discussions resolved` · `N unresolved discussion` · `N unresolved discussions` |
| waiting | absent · `(waiting on alice)` · `(waiting on alice and bob)` |
| complete | The literal `  complete!` (two spaces) appears only when all files are reviewed, all discussions are resolved, and nobody is waiting |

**Critical:** the two clauses are independent axes. `0 of 1 files reviewed, all
discussions resolved (waiting on irahopkinson)` is real (PR #2338). Resolution does
**not** imply the work is done, and `waiting on` is the court signal — not the
discussions clause.

Real strings used verbatim as test data throughout this plan:

```
Reviewable status:  complete! all files reviewed, all discussions resolved.
Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).
Reviewable status: 0 of 1 files reviewed, all discussions resolved (waiting on irahopkinson).
Reviewable status: 8 of 28 files reviewed, all discussions resolved.
Reviewable status: 18 of 28 files reviewed, 2 unresolved discussions (waiting on jolierabideau and katherinejensen00).
Reviewable status: 3 of 43 files reviewed, 8 unresolved discussions (waiting on jolierabideau and katherinejensen00).
Reviewable status: all files reviewed, 1 unresolved discussion (waiting on katherinejensen00).
```

## File structure

```
package.json  tsconfig.json  vitest.config.ts  config.example.json
src/
  types.ts              Shared types. No logic.
  config.ts             Load + validate config.json.
  rules/
    footer.ts           parseFooter() — the grammar above.
    activity.ts         Derived timestamps; substantive-commit test.
    checks.ts           CI conclusions + mergeability.
    classify.ts         The bucket priority function. Pure.
  github/
    token.ts            gh auth token, with 401 re-read.
    query.ts            The GraphQL document.
    client.ts           Fetch + map to PrInput.
  git/branches.ts       git for-each-ref → BranchInput[].
  store/db.ts           SQLite schema + typed accessors.
  claude/escalate.ts    Prompt, call, parse, cache.
  notify/osascript.ts   macOS notifications.
  server/
    poller.ts           Orchestrates: fetch → classify → escalate → notify.
    routes.ts           GET /api/board, POST /api/pr/:number/discord.
    index.ts            Wire-up + listen.
scripts/capture-fixtures.ts   Dev tool: pin real PRs as JSON.
tests/
  fixtures/pr-*.json    Captured GraphQL payloads.
  *.test.ts
client/src/
  main.tsx  App.tsx  Card.tsx  api.ts  buckets.ts
```

---

### Task 1: Project scaffold and config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `config.example.json`
- Create: `src/types.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(path: string): Config`; the full type vocabulary in `src/types.ts` that every later task imports.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pr-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --import tsx/esm src/server/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.71.0",
    "better-sqlite3": "^12.2.0",
    "fastify": "^5.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^24.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^4.1.11"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` and `vitest.config.ts`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests", "scripts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
```

- [ ] **Step 3: Create `src/types.ts`**

```ts
export type ReviewState =
  | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface Footer {
  /** 'all' when every file is reviewed, else the partial counts. */
  files: 'all' | { reviewed: number; total: number };
  /** 'resolved' when no discussions are open, else the open count. */
  discussions: 'resolved' | { unresolved: number };
  /** Logins named in "(waiting on ...)". Empty when the clause is absent. */
  waitingOn: string[];
  /** True only for the literal "complete!" form. */
  complete: boolean;
}

export interface ReviewInput {
  id: string;
  author: string;
  state: ReviewState;
  submittedAt: string;
  bodyText: string;
  lastEditedAt: string | null;
}

export interface CommentInput { author: string; createdAt: string }

export interface CommitInput {
  oid: string;
  committedDate: string;
  authorLogin: string | null;
  authorEmail: string | null;
  messageHeadline: string;
  parentCount: number;
}

export interface ThreadInput {
  isResolved: boolean;
  lastCommentAuthor: string;
  lastCommentAt: string;
}

export interface CheckContext {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PrInput {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviews: ReviewInput[];
  comments: CommentInput[];
  commits: CommitInput[];
  threads: ThreadInput[];
  checks: CheckContext[];
}

export interface BranchInput {
  name: string;
  upstreamGone: boolean;
  aheadOfMain: number;
  prNumber: number | null;
}

export interface LocalState { discordPostedAt: string | null }

export type Bucket =
  | 'blocked-mechanically'
  | 'needs-your-response'
  | 'ready-to-merge'
  | 'waiting-on-reviewer'
  | 'asked-no-looks'
  | 'not-asked'
  | 'draft'
  | 'unsubmitted-branch'
  | 'dead-branch';

export type EscalationReason =
  | 'commented-no-footer'
  | 'approved-with-blocking-language';

export interface ClaudeVerdict {
  court: 'me' | 'reviewer';
  blockingCount: number;
  asks: string[];
  confidence: 'high' | 'low';
}

export interface Classification {
  bucket: Bucket;
  receipts: string[];
  displayTime: string | null;
  escalate: EscalationReason | null;
  /** Which review the escalation is about. Non-null exactly when escalate is. */
  escalateReviewId: string | null;
  verdict: ClaudeVerdict | null;
}

export interface Config {
  repoPath: string;
  owner: string;
  name: string;
  me: string;
  botLogins: string[];
  pollIntervalMs: number;
  staleAfterHours: number;
}
```

- [ ] **Step 4: Create `config.example.json`**

```json
{
  "repoPath": "/Users/jolierabideau/dev/paranext-core",
  "owner": "paranext",
  "name": "paranext-core",
  "me": "jolierabideau",
  "botLogins": ["devin-ai-integration", "dependabot", "github-actions"],
  "pollIntervalMs": 180000,
  "staleAfterHours": 48
}
```

- [ ] **Step 5: Write the failing test**

```ts
// tests/config.test.ts
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const write = (obj: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'prd-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
};

const valid = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};

describe('loadConfig', () => {
  it('loads a valid config', () => {
    expect(loadConfig(write(valid))).toEqual(valid);
  });

  it('names the missing field', () => {
    const { me, ...rest } = valid;
    expect(() => loadConfig(write(rest))).toThrow(/me/);
  });

  it('rejects a poll interval below 30s', () => {
    expect(() => loadConfig(write({ ...valid, pollIntervalMs: 1000 })))
      .toThrow(/pollIntervalMs/);
  });

  it('points at the example file when config.json is absent', () => {
    expect(() => loadConfig('/nonexistent/config.json'))
      .toThrow(/config\.example\.json/);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Failed to resolve import "../src/config.js"`

- [ ] **Step 7: Implement `src/config.ts`**

```ts
import { readFileSync } from 'node:fs';
import type { Config } from './types.js';

const REQUIRED = [
  'repoPath', 'owner', 'name', 'me',
  'botLogins', 'pollIntervalMs', 'staleAfterHours',
] as const;

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No config at ${path}. Copy config.example.json to config.json and edit it.`,
    );
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (parsed[key] === undefined) throw new Error(`Config is missing "${key}".`);
  }
  if ((parsed.pollIntervalMs as number) < 30_000) {
    throw new Error('Config "pollIntervalMs" must be at least 30000 (30s).');
  }
  return parsed as unknown as Config;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
npm install
git add package.json package-lock.json tsconfig.json vitest.config.ts \
        config.example.json src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: scaffold project with types and config loader"
```

---

### Task 2: The Reviewable footer parser

The single most important pure function in the system. Every string below is real,
copied from the repository's review history.

**Files:**
- Create: `src/rules/footer.ts`
- Test: `tests/footer.test.ts`

**Interfaces:**
- Consumes: `Footer` from `src/types.ts`.
- Produces: `parseFooter(bodyText: string): Footer | null` — `null` means no footer found, which callers must treat as "no signal", never as a clean result.

- [ ] **Step 1: Write the failing test**

```ts
// tests/footer.test.ts
import { describe, expect, it } from 'vitest';
import { parseFooter } from '../src/rules/footer.js';

describe('parseFooter', () => {
  it('parses the complete! form', () => {
    expect(parseFooter(
      'Reviewable status:  complete! all files reviewed, all discussions resolved.',
    )).toEqual({
      files: 'all', discussions: 'resolved', waitingOn: [], complete: true,
    });
  });

  it('parses one unresolved discussion waiting on one person', () => {
    expect(parseFooter(
      'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
    )).toEqual({
      files: 'all',
      discussions: { unresolved: 1 },
      waitingOn: ['jolierabideau'],
      complete: false,
    });
  });

  it('parses partial file counts', () => {
    expect(parseFooter(
      'Reviewable status: 8 of 28 files reviewed, all discussions resolved.',
    )).toEqual({
      files: { reviewed: 8, total: 28 },
      discussions: 'resolved',
      waitingOn: [],
      complete: false,
    });
  });

  it('parses two names in the waiting-on clause', () => {
    expect(parseFooter(
      'Reviewable status: 18 of 28 files reviewed, 2 unresolved discussions (waiting on jolierabideau and katherinejensen00).',
    )).toEqual({
      files: { reviewed: 18, total: 28 },
      discussions: { unresolved: 2 },
      waitingOn: ['jolierabideau', 'katherinejensen00'],
      complete: false,
    });
  });

  // The case the spec originally got wrong: resolution and court are
  // independent. PR #2338.
  it('parses resolved discussions that still have someone waiting', () => {
    expect(parseFooter(
      'Reviewable status: 0 of 1 files reviewed, all discussions resolved (waiting on irahopkinson).',
    )).toEqual({
      files: { reviewed: 0, total: 1 },
      discussions: 'resolved',
      waitingOn: ['irahopkinson'],
      complete: false,
    });
  });

  it('finds a footer that is not at the end of the body', () => {
    const body = [
      'Some review prose.',
      'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on katherinejensen00).',
      'src/renderer/thing.tsx line 181 at r1 (raw file):',
      'a trailing per-file comment block',
    ].join('\n');
    expect(parseFooter(body)?.waitingOn).toEqual(['katherinejensen00']);
  });

  it('uses the last footer when a body somehow contains two', () => {
    const body = [
      'Reviewable status: all files reviewed, 5 unresolved discussions (waiting on alice).',
      'Reviewable status:  complete! all files reviewed, all discussions resolved.',
    ].join('\n');
    expect(parseFooter(body)?.complete).toBe(true);
  });

  it('returns null when there is no footer', () => {
    expect(parseFooter('Thanks for making those changes, Jolie!')).toBeNull();
  });

  it('returns null for an unrecognizable status line rather than guessing', () => {
    expect(parseFooter('Reviewable status: something entirely new.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/footer.test.ts`
Expected: FAIL — cannot resolve `../src/rules/footer.js`

- [ ] **Step 3: Implement `src/rules/footer.ts`**

```ts
import type { Footer } from '../types.js';

const FOOTER = new RegExp(
  'Reviewable status:\\s*' +
    '(?<complete>complete!\\s*)?' +
    '(?<files>all files reviewed|\\d+ of \\d+ files reviewed)' +
    ',\\s*' +
    '(?<discussions>all discussions resolved|\\d+ unresolved discussions?)' +
    '(?:\\s*\\(waiting on (?<waiting>[^)]+)\\))?',
  'g',
);

const PARTIAL = /^(\d+) of (\d+) files reviewed$/;
const UNRESOLVED = /^(\d+) unresolved discussions?$/;

/**
 * Parses the Reviewable status line out of a review's GraphQL `bodyText`.
 *
 * The line's position varies wildly — line 1 of 122 on PR #2664, line 198 of
 * 216 on PR #2717 — so it is searched for, never read positionally. Returns
 * null when no recognizable footer exists; callers must treat that as "no
 * signal" rather than as a clean result.
 */
export function parseFooter(bodyText: string): Footer | null {
  const matches = [...bodyText.matchAll(FOOTER)];
  const last = matches.at(-1);
  if (!last?.groups) return null;

  const { complete, files, discussions, waiting } = last.groups;

  const partial = PARTIAL.exec(files ?? '');
  const unresolved = UNRESOLVED.exec(discussions ?? '');

  return {
    files: partial
      ? { reviewed: Number(partial[1]), total: Number(partial[2]) }
      : 'all',
    discussions: unresolved ? { unresolved: Number(unresolved[1]) } : 'resolved',
    waitingOn: waiting ? splitNames(waiting) : [],
    complete: complete !== undefined,
  };
}

/** "alice", "alice and bob", "alice, bob and carol" → login array. */
function splitNames(clause: string): string[] {
  return clause
    .split(/,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/footer.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rules/footer.ts tests/footer.test.ts
git commit -m "feat: parse the Reviewable status footer grammar"
```

---

### Task 3: Fixture capture script and captured fixtures

Real data pinned to disk. Every later rules test runs against these.

**Files:**
- Create: `scripts/capture-fixtures.ts`
- Create: `tests/fixtures/pr-{2717,2720,2664,2742,2795,2796,2687,2635,2180}.json`
- Test: `tests/fixtures.test.ts`

**Interfaces:**
- Consumes: `PrInput` from `src/types.ts`.
- Produces: `tests/fixtures/pr-<n>.json`, each a serialized `PrInput`; `loadFixture(n: number): PrInput` for later tests.

- [ ] **Step 1: Write the capture script**

```ts
// scripts/capture-fixtures.ts
// Usage: npx tsx scripts/capture-fixtures.ts 2717 2720 2664 ...
// Requires an authenticated `gh`. Writes tests/fixtures/pr-<n>.json.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PR_QUERY } from '../src/github/query.js';
import { mapPullRequest } from '../src/github/client.js';

const numbers = process.argv.slice(2).map(Number);
if (numbers.length === 0) throw new Error('Pass at least one PR number.');

mkdirSync('tests/fixtures', { recursive: true });

for (const number of numbers) {
  const raw = execFileSync(
    'gh',
    ['api', 'graphql', '-f', `query=${PR_QUERY}`,
     '-F', 'owner=paranext', '-F', 'name=paranext-core', '-F', `number=${number}`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const node = JSON.parse(raw).data.repository.pullRequest;
  writeFileSync(
    `tests/fixtures/pr-${number}.json`,
    `${JSON.stringify(mapPullRequest(node), null, 2)}\n`,
  );
  console.log(`captured pr-${number}`);
}
```

- [ ] **Step 2: Note the ordering dependency**

This script imports `PR_QUERY` and `mapPullRequest` from Task 7. Implement Task 7
before running it. Write the script now so the fixture contract is fixed early; run it
at the start of Task 7's Step 6.

- [ ] **Step 3: Write the fixture-integrity test**

```ts
// tests/fixtures.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PrInput } from '../src/types.js';

export const loadFixture = (n: number): PrInput =>
  JSON.parse(readFileSync(`tests/fixtures/pr-${n}.json`, 'utf8')) as PrInput;

const EXPECTED = [2717, 2720, 2664, 2742, 2795, 2796, 2687, 2635, 2180];

describe('fixtures', () => {
  it.each(EXPECTED)('pr-%i is present and well-formed', (n) => {
    const pr = loadFixture(n);
    expect(pr.number).toBe(n);
    expect(Array.isArray(pr.reviews)).toBe(true);
    expect(Array.isArray(pr.commits)).toBe(true);
    expect(typeof pr.isDraft).toBe('boolean');
  });

  it('pr-2180 carries the native inline threads it is here to pin', () => {
    expect(loadFixture(2180).threads.length).toBeGreaterThan(0);
  });

  it('pr-2664 head commit is a bare merge of main', () => {
    const head = loadFixture(2664).commits.at(-1);
    expect(head?.messageHeadline).toMatch(/Merge remote-tracking branch 'origin\/main'/);
    expect(head?.parentCount).toBe(2);
  });
});
```

- [ ] **Step 4: Commit the script (fixtures land in Task 7)**

```bash
git add scripts/capture-fixtures.ts tests/fixtures.test.ts
git commit -m "chore: add fixture capture script and integrity test"
```

---

### Task 4: Activity derivation

**Files:**
- Create: `src/rules/activity.ts`
- Test: `tests/activity.test.ts`

**Interfaces:**
- Consumes: `PrInput`, `Config`, `CommitInput`.
- Produces:
  - `isSubstantiveCommit(c: CommitInput, me: string): boolean`
  - `lastReviewerActivity(pr: PrInput, cfg: Config): { at: string; who: string } | null`
  - `lastMyActivity(pr: PrInput, cfg: Config): { at: string; what: string } | null`
  - `isHumanReviewer(login: string, cfg: Config): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/activity.test.ts
import { describe, expect, it } from 'vitest';
import {
  isSubstantiveCommit, lastReviewerActivity, lastMyActivity,
} from '../src/rules/activity.js';
import type { CommitInput, Config, PrInput } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};

const commit = (over: Partial<CommitInput>): CommitInput => ({
  oid: 'abc', committedDate: '2026-09-10T21:08:52Z',
  authorLogin: 'jolierabideau', authorEmail: 'jolie@example.com',
  messageHeadline: 'PT-1234: do a real thing', parentCount: 1, ...over,
});

const pr = (over: Partial<PrInput>): PrInput => ({
  number: 1, title: 't', url: 'u', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [], commits: [commit({})], threads: [], checks: [],
  ...over,
});

describe('isSubstantiveCommit', () => {
  it('counts a normal authored commit', () => {
    expect(isSubstantiveCommit(commit({}), cfg.me)).toBe(true);
  });

  // PR #2664: a bare merge of main is the head commit and must not count.
  it('rejects a bare merge of origin/main', () => {
    expect(isSubstantiveCommit(commit({
      messageHeadline: "Merge remote-tracking branch 'origin/main' into localization-keyboard-catalog",
      parentCount: 2,
    }), cfg.me)).toBe(false);
  });

  it('rejects the shorter merge-branch phrasing', () => {
    expect(isSubstantiveCommit(commit({
      messageHeadline: "Merge branch 'main' of github.com:paranext/paranext-core into feature",
      parentCount: 2,
    }), cfg.me)).toBe(false);
  });

  it('counts a merge commit that is not a merge of main', () => {
    expect(isSubstantiveCommit(commit({
      messageHeadline: 'Merge pull request #12 from a-feature-branch',
      parentCount: 2,
    }), cfg.me)).toBe(true);
  });

  // PR #1983 (tjcouch-sil), #2480 (tombogle).
  it('rejects a commit authored by someone else', () => {
    expect(isSubstantiveCommit(commit({ authorLogin: 'tjcouch-sil' }), cfg.me))
      .toBe(false);
  });

  // 15 older PRs have a null author.user from an unmapped email.
  it('falls back to the email local-part when authorLogin is null', () => {
    expect(isSubstantiveCommit(
      commit({ authorLogin: null, authorEmail: 'jolierabideau@users.noreply.github.com' }),
      cfg.me,
    )).toBe(true);
  });
});

describe('lastReviewerActivity', () => {
  const review = (over: Record<string, unknown>) => ({
    id: 'r1', author: 'katherinejensen00', state: 'COMMENTED' as const,
    submittedAt: '2026-09-08T12:00:00Z', bodyText: '', lastEditedAt: null, ...over,
  });

  it('ignores bot reviews', () => {
    expect(lastReviewerActivity(pr({
      reviews: [review({ author: 'devin-ai-integration' })],
    }), cfg)).toBeNull();
  });

  it('ignores DISMISSED reviews', () => {
    expect(lastReviewerActivity(pr({
      reviews: [review({ state: 'DISMISSED' })],
    }), cfg)).toBeNull();
  });

  it('ignores the user own reviews', () => {
    expect(lastReviewerActivity(pr({
      reviews: [review({ author: 'jolierabideau' })],
    }), cfg)).toBeNull();
  });

  it('takes the newest across reviews and comments', () => {
    expect(lastReviewerActivity(pr({
      reviews: [review({ submittedAt: '2026-09-08T12:00:00Z' })],
      comments: [{ author: 'tjcouch-sil', createdAt: '2026-09-09T09:00:00Z' }],
    }), cfg)).toEqual({ at: '2026-09-09T09:00:00Z', who: 'tjcouch-sil' });
  });

  // PR #2180 has 13 native threads; a native reviewer must be visible.
  it('counts the newest comment on an unresolved native thread', () => {
    expect(lastReviewerActivity(pr({
      threads: [{
        isResolved: false, lastCommentAuthor: 'lyonsil',
        lastCommentAt: '2026-09-11T10:00:00Z',
      }],
    }), cfg)).toEqual({ at: '2026-09-11T10:00:00Z', who: 'lyonsil' });
  });

  it('ignores resolved native threads', () => {
    expect(lastReviewerActivity(pr({
      threads: [{
        isResolved: true, lastCommentAuthor: 'lyonsil',
        lastCommentAt: '2026-09-11T10:00:00Z',
      }],
    }), cfg)).toBeNull();
  });
});

describe('lastMyActivity', () => {
  it('counts the user own review, not just pushes and comments', () => {
    expect(lastMyActivity(pr({
      commits: [commit({ committedDate: '2026-09-01T00:00:00Z' })],
      reviews: [{
        id: 'r9', author: 'jolierabideau', state: 'COMMENTED',
        submittedAt: '2026-09-05T00:00:00Z', bodyText: '', lastEditedAt: null,
      }],
    }), cfg)?.at).toBe('2026-09-05T00:00:00Z');
  });

  it('skips a bare merge of main in favour of the newest real commit', () => {
    expect(lastMyActivity(pr({
      commits: [
        commit({ committedDate: '2026-09-01T00:00:00Z' }),
        commit({
          committedDate: '2026-09-10T21:08:52Z', parentCount: 2,
          messageHeadline: "Merge remote-tracking branch 'origin/main' into x",
        }),
      ],
    }), cfg)?.at).toBe('2026-09-01T00:00:00Z');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/activity.test.ts`
Expected: FAIL — cannot resolve `../src/rules/activity.js`

- [ ] **Step 3: Implement `src/rules/activity.ts`**

```ts
import type { CommitInput, Config, PrInput } from '../types.js';

const MERGE_OF_MAIN =
  /^Merge (?:remote-tracking )?branch '(?:origin\/)?main'(?: of \S+)? into /i;

/**
 * A commit counts as the user handing work back only when they wrote it and it
 * is not a bare merge of main. This author merges origin/main constantly — 8 of
 * 12 recent commits on PR #2664 — and such a merge is frequently the head
 * commit, so counting it reports "waiting on reviewer" for PRs nobody touched.
 */
export function isSubstantiveCommit(commit: CommitInput, me: string): boolean {
  if (!authoredByMe(commit, me)) return false;
  return !(commit.parentCount > 1 && MERGE_OF_MAIN.test(commit.messageHeadline));
}

function authoredByMe(commit: CommitInput, me: string): boolean {
  if (commit.authorLogin !== null) return commit.authorLogin === me;
  // 15 older PRs have a null author.user from an unmapped commit email.
  return (commit.authorEmail ?? '').toLowerCase().startsWith(`${me.toLowerCase()}@`);
}

export function isHumanReviewer(login: string, cfg: Config): boolean {
  return login !== cfg.me && !cfg.botLogins.includes(login);
}

type Stamp = { at: string; who: string };

export function lastReviewerActivity(pr: PrInput, cfg: Config): Stamp | null {
  const stamps: Stamp[] = [];

  for (const review of pr.reviews) {
    if (review.state === 'DISMISSED' || review.state === 'PENDING') continue;
    if (!isHumanReviewer(review.author, cfg)) continue;
    stamps.push({ at: review.submittedAt, who: review.author });
  }
  for (const comment of pr.comments) {
    if (!isHumanReviewer(comment.author, cfg)) continue;
    stamps.push({ at: comment.createdAt, who: comment.author });
  }
  for (const thread of pr.threads) {
    if (thread.isResolved) continue;
    if (!isHumanReviewer(thread.lastCommentAuthor, cfg)) continue;
    stamps.push({ at: thread.lastCommentAt, who: thread.lastCommentAuthor });
  }
  return newest(stamps);
}

export function lastMyActivity(
  pr: PrInput,
  cfg: Config,
): { at: string; what: string } | null {
  const stamps: { at: string; who: string; what: string }[] = [];

  for (const commit of pr.commits) {
    if (!isSubstantiveCommit(commit, cfg.me)) continue;
    stamps.push({ at: commit.committedDate, who: cfg.me, what: 'pushed' });
  }
  for (const comment of pr.comments) {
    if (comment.author !== cfg.me) continue;
    stamps.push({ at: comment.createdAt, who: cfg.me, what: 'commented' });
  }
  for (const review of pr.reviews) {
    if (review.author !== cfg.me) continue;
    stamps.push({ at: review.submittedAt, who: cfg.me, what: 'replied in review' });
  }

  const best = newest(stamps) as { at: string; what: string } | null;
  return best;
}

function newest<T extends { at: string }>(stamps: T[]): T | null {
  return stamps.reduce<T | null>(
    (acc, s) => (acc === null || s.at > acc.at ? s : acc),
    null,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/activity.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rules/activity.ts tests/activity.test.ts
git commit -m "feat: derive reviewer and author activity, discounting bare merges"
```

---

### Task 5: Checks and mergeability

**Files:**
- Create: `src/rules/checks.ts`
- Test: `tests/checks.test.ts`

**Interfaces:**
- Consumes: `CheckContext`, `PrInput`.
- Produces:
  - `hasFailingCheck(checks: CheckContext[]): boolean`
  - `checkDot(checks: CheckContext[]): 'fail' | 'pending' | 'pass' | 'none'`
  - `conflictState(pr: PrInput): 'conflicting' | 'clean' | 'unknown'`

- [ ] **Step 1: Write the failing test**

```ts
// tests/checks.test.ts
import { describe, expect, it } from 'vitest';
import { checkDot, conflictState, hasFailingCheck } from '../src/rules/checks.js';
import type { CheckContext, PrInput } from '../src/types.js';

const ctx = (conclusion: string | null, status = 'COMPLETED'): CheckContext =>
  ({ name: 'Test', status, conclusion });

const pr = (over: Partial<PrInput>): PrInput => ({
  number: 1, title: 't', url: 'u', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [], commits: [], threads: [], checks: [], ...over,
});

describe('hasFailingCheck', () => {
  // PR #2795 rolls up to FAILURE with only CANCELLED + SUCCESS. It must not
  // land in "blocked mechanically".
  it('ignores cancelled runs', () => {
    expect(hasFailingCheck([
      ctx('CANCELLED'), ctx('CANCELLED'), ctx('SUCCESS'), ctx('SUCCESS'),
    ])).toBe(false);
  });

  it('ignores neutral and skipped', () => {
    expect(hasFailingCheck([ctx('NEUTRAL'), ctx('SKIPPED')])).toBe(false);
  });

  it.each(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'treats %s as failing', (conclusion) => {
      expect(hasFailingCheck([ctx('SUCCESS'), ctx(conclusion)])).toBe(true);
    },
  );

  it('does not treat an in-progress run as failing', () => {
    expect(hasFailingCheck([ctx(null, 'IN_PROGRESS')])).toBe(false);
  });

  it('is false when there are no checks at all', () => {
    expect(hasFailingCheck([])).toBe(false);
  });
});

describe('checkDot', () => {
  it('reports none when there are no checks', () => {
    expect(checkDot([])).toBe('none');
  });
  it('reports pending while a run is in progress', () => {
    expect(checkDot([ctx('SUCCESS'), ctx(null, 'IN_PROGRESS')])).toBe('pending');
  });
  it('reports fail over pending', () => {
    expect(checkDot([ctx('FAILURE'), ctx(null, 'IN_PROGRESS')])).toBe('fail');
  });
  it('reports pass when everything succeeded or was cancelled', () => {
    expect(checkDot([ctx('SUCCESS'), ctx('CANCELLED')])).toBe('pass');
  });
});

describe('conflictState', () => {
  it('reads DIRTY as conflicting', () => {
    expect(conflictState(pr({ mergeStateStatus: 'DIRTY' }))).toBe('conflicting');
  });

  // Five of eleven open PRs read UNKNOWN at any moment; never call it clean.
  it('reads UNKNOWN mergeable as unknown', () => {
    expect(conflictState(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })))
      .toBe('unknown');
  });

  it('reads CONFLICTING as conflicting even when mergeState is UNKNOWN', () => {
    expect(conflictState(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' })))
      .toBe('conflicting');
  });

  // PR #2664: approved, MERGEABLE, but BLOCKED by branch protection.
  it('reads BLOCKED as clean, since it is not a conflict', () => {
    expect(conflictState(pr({ mergeStateStatus: 'BLOCKED' }))).toBe('clean');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/checks.test.ts`
Expected: FAIL — cannot resolve `../src/rules/checks.js`

- [ ] **Step 3: Implement `src/rules/checks.ts`**

```ts
import type { CheckContext, PrInput } from '../types.js';

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED']);
const IGNORED = new Set(['CANCELLED', 'NEUTRAL', 'SKIPPED']);

/**
 * statusCheckRollup.state is unusable: PR #2795 rolls up to FAILURE with only
 * cancelled runs and successes. Judge per context instead.
 */
export function hasFailingCheck(checks: CheckContext[]): boolean {
  return checks.some((c) => c.conclusion !== null && FAILING.has(c.conclusion));
}

export function checkDot(
  checks: CheckContext[],
): 'fail' | 'pending' | 'pass' | 'none' {
  if (checks.length === 0) return 'none';
  if (hasFailingCheck(checks)) return 'fail';
  if (checks.some((c) => c.status !== 'COMPLETED')) return 'pending';
  if (checks.every((c) => c.conclusion !== null && IGNORED.has(c.conclusion))) {
    return 'pass';
  }
  return 'pass';
}

/**
 * GitHub computes mergeability lazily, so UNKNOWN is common and must never be
 * read as clean — the poller re-requests those PRs.
 */
export function conflictState(pr: PrInput): 'conflicting' | 'clean' | 'unknown' {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return 'conflicting';
  }
  if (pr.mergeable === 'UNKNOWN') return 'unknown';
  return 'clean';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/checks.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rules/checks.ts tests/checks.test.ts
git commit -m "feat: judge CI per context and never read UNKNOWN mergeability as clean"
```

---

### Task 6: The classify function

The core. Pure, fully deterministic, `now` injected.

**Files:**
- Create: `src/rules/classify.ts`
- Test: `tests/classify.test.ts`

**Interfaces:**
- Consumes: `parseFooter`, `lastReviewerActivity`, `lastMyActivity`, `isHumanReviewer`, `hasFailingCheck`, `conflictState`.
- Produces: `classify(pr: PrInput, local: LocalState, cfg: Config, now: Date): Classification` and `determineCourt(pr, cfg): Court` where `type Court = 'me' | 'reviewer' | 'nobody' | 'unknown'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/classify.test.ts
import { describe, expect, it } from 'vitest';
import { classify } from '../src/rules/classify.js';
import type { Config, LocalState, PrInput, ReviewInput } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');
const none: LocalState = { discordPostedAt: null };

const pr = (over: Partial<PrInput>): PrInput => ({
  number: 1, title: 't', url: 'u', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [],
  commits: [{
    oid: 'abc', committedDate: '2026-09-01T00:00:00Z',
    authorLogin: 'jolierabideau', authorEmail: null,
    messageHeadline: 'PT-1: real work', parentCount: 1,
  }],
  threads: [], checks: [], ...over,
});

const review = (over: Partial<ReviewInput>): ReviewInput => ({
  id: 'r1', author: 'katherinejensen00', state: 'COMMENTED',
  submittedAt: '2026-09-05T00:00:00Z', bodyText: '', lastEditedAt: null, ...over,
});

const bucketOf = (input: PrInput, local = none) =>
  classify(input, local, cfg, NOW).bucket;

describe('classify — drafts', () => {
  it('puts an unreviewed draft in draft even when conflicting', () => {
    expect(bucketOf(pr({
      isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
    }))).toBe('draft');
  });

  it('puts an unreviewed draft in draft even when CI is red', () => {
    expect(bucketOf(pr({
      isDraft: true, checks: [{ name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }))).toBe('draft');
  });

  it('lets a reviewed draft be classified normally', () => {
    expect(bucketOf(pr({
      isDraft: true,
      reviews: [review({
        state: 'CHANGES_REQUESTED', submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
      })],
    }))).toBe('needs-your-response');
  });
});

describe('classify — mechanical blocks', () => {
  it('puts a conflicting non-draft first', () => {
    expect(bucketOf(pr({ mergeStateStatus: 'DIRTY' }))).toBe('blocked-mechanically');
  });

  it('puts a failing check first', () => {
    expect(bucketOf(pr({
      checks: [{ name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }))).toBe('blocked-mechanically');
  });

  it('does not block on cancelled-only checks', () => {
    expect(bucketOf(pr({
      checks: [
        { name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { name: 'b', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }))).not.toBe('blocked-mechanically');
  });
});

describe('classify — court from the footer', () => {
  it('waiting on me means my court', () => {
    expect(bucketOf(pr({
      reviews: [review({
        submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
      })],
    }))).toBe('needs-your-response');
  });

  // PR #2635: the user replies through Reviewable without pushing.
  it('the user own review footer can hand the ball back', () => {
    expect(bucketOf(pr({
      reviews: [
        review({ id: 'r1', submittedAt: '2026-09-08T00:00:00Z',
          bodyText: 'Reviewable status: all files reviewed, 3 unresolved discussions (waiting on jolierabideau).' }),
        review({ id: 'r2', author: 'jolierabideau', submittedAt: '2026-09-09T00:00:00Z',
          bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on katherinejensen00).' }),
      ],
    }))).toBe('waiting-on-reviewer');
  });

  // PR #2687.
  it('a footer naming both people lands in my court', () => {
    expect(bucketOf(pr({
      reviews: [review({
        submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Reviewable status: 18 of 28 files reviewed, 2 unresolved discussions (waiting on jolierabideau and katherinejensen00).',
      })],
    }))).toBe('needs-your-response');
  });

  // PR #2338: resolved discussions still waiting on a reviewer.
  it('resolved discussions still waiting on a reviewer is their court', () => {
    expect(bucketOf(pr({
      reviews: [review({
        author: 'jolierabideau', submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Reviewable status: 0 of 1 files reviewed, all discussions resolved (waiting on irahopkinson).',
      })],
    }))).toBe('waiting-on-reviewer');
  });

  it('a stale footer yields to later activity', () => {
    expect(bucketOf(pr({
      reviews: [review({
        submittedAt: '2026-09-05T00:00:00Z',
        bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
      })],
      commits: [{
        oid: 'z', committedDate: '2026-09-10T00:00:00Z',
        authorLogin: 'jolierabideau', authorEmail: null,
        messageHeadline: 'PT-1: address review', parentCount: 1,
      }],
    }))).toBe('waiting-on-reviewer');
  });
});

describe('classify — approvals', () => {
  it('a complete! approval is ready to merge', () => {
    expect(bucketOf(pr({
      reviews: [review({
        state: 'APPROVED', submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Reviewable status:  complete! all files reviewed, all discussions resolved.',
      })],
    }))).toBe('ready-to-merge');
  });

  // PR #2720 — approved with Reviewable's own summary thread, merged 2 min later.
  it('an approval with 1 unresolved waiting on me is still ready to merge', () => {
    expect(bucketOf(pr({
      reviews: [review({
        state: 'APPROVED', submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
      })],
    }))).toBe('ready-to-merge');
  });

  it('an approval whose body mentions a blocker escalates', () => {
    const result = classify(pr({
      reviews: [review({
        state: 'APPROVED', submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Just one blocker introduced by my tour changes. Reviewable status:  complete! all files reviewed, all discussions resolved.',
      })],
    }), none, cfg, NOW);
    expect(result.escalate).toBe('approved-with-blocking-language');
  });

  // PR #2664 live: approved, head commit is a bare merge of main.
  it('a bare merge of main after approval does not steal ready-to-merge', () => {
    expect(bucketOf(pr({
      mergeStateStatus: 'BLOCKED',
      reviews: [review({
        state: 'APPROVED', submittedAt: '2026-09-10T15:16:13Z',
        bodyText: 'Reviewable status:  complete! all files reviewed, all discussions resolved.',
      })],
      commits: [{
        oid: 'm', committedDate: '2026-09-10T21:08:52Z',
        authorLogin: 'jolierabideau', authorEmail: null,
        messageHeadline: "Merge remote-tracking branch 'origin/main' into localization-keyboard-catalog",
        parentCount: 2,
      }],
    }))).toBe('ready-to-merge');
  });
});

describe('classify — escalation and unreviewed PRs', () => {
  it('a COMMENTED review with no footer escalates', () => {
    const result = classify(pr({
      reviews: [review({ submittedAt: '2026-09-09T00:00:00Z', bodyText: 'Looks reasonable to me.' })],
    }), none, cfg, NOW);
    expect(result.escalate).toBe('commented-no-footer');
  });

  it('a bot COMMENTED review does not escalate', () => {
    const result = classify(pr({
      reviews: [review({
        author: 'devin-ai-integration', submittedAt: '2026-09-09T00:00:00Z',
        bodyText: 'Automated note.',
      })],
    }), none, cfg, NOW);
    expect(result.escalate).toBeNull();
  });

  it('an unreviewed PR with no Discord stamp is not-asked', () => {
    expect(bucketOf(pr({}))).toBe('not-asked');
  });

  it('an unreviewed PR with a Discord stamp is asked-no-looks', () => {
    expect(bucketOf(pr({}), { discordPostedAt: '2026-09-11T09:00:00Z' }))
      .toBe('asked-no-looks');
  });

  it('flags staleness past the threshold in the receipts', () => {
    const result = classify(pr({}), { discordPostedAt: '2026-09-08T09:00:00Z' }, cfg, NOW);
    expect(result.bucket).toBe('asked-no-looks');
    expect(result.receipts.join(' ')).toMatch(/stale/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/classify.test.ts`
Expected: FAIL — cannot resolve `../src/rules/classify.js`

- [ ] **Step 3: Implement `src/rules/classify.ts`**

```ts
import type {
  Classification, Config, EscalationReason, Footer, LocalState, PrInput, ReviewInput,
} from '../types.js';
import { parseFooter } from './footer.js';
import { isHumanReviewer, lastMyActivity, lastReviewerActivity } from './activity.js';
import { conflictState, hasFailingCheck } from './checks.js';

export type Court = 'me' | 'reviewer' | 'nobody' | 'unknown';

const BLOCKING_LANGUAGE = /\b(blocker|blocking|must fix|needs change)\b/i;

export function classify(
  pr: PrInput,
  local: LocalState,
  cfg: Config,
  now: Date,
): Classification {
  const receipts: string[] = [];

  const reviewer = lastReviewerActivity(pr, cfg);
  const mine = lastMyActivity(pr, cfg);
  const newestHumanReview = latestHumanReview(pr, cfg);

  // Drafts stay quiet unless somebody has actually reviewed them.
  const draftAndUntouched = pr.isDraft && reviewer === null;
  if (draftAndUntouched) {
    receipts.push('draft with no reviewer activity');
    return done('draft', receipts, null, null);
  }

  if (!pr.isDraft) {
    const conflict = conflictState(pr);
    if (conflict === 'conflicting') {
      receipts.push('branch has merge conflicts');
      return done('blocked-mechanically', receipts, null, null);
    }
    if (conflict === 'unknown') receipts.push('conflict status unknown');
    if (hasFailingCheck(pr.checks)) {
      receipts.push('a required check is failing on the current head');
      return done('blocked-mechanically', receipts, null, null);
    }
  }
  if (pr.mergeStateStatus === 'BLOCKED') {
    receipts.push('blocked by branch protection');
  }

  const escalate = escalationFor(newestHumanReview, receipts);

  // An explicit approval outranks the footer's unresolved count: Reviewable
  // counts its own summary thread, and such approvals merge within minutes
  // (#2720 in 2, #2712 in 6).
  if (newestHumanReview?.state === 'APPROVED' && !hasActivityAfter(pr, cfg, newestHumanReview)) {
    receipts.push(`approved by ${newestHumanReview.author}`);
    return done('ready-to-merge', receipts, newestHumanReview.submittedAt, escalate);
  }

  const court = determineCourt(pr, cfg, receipts);

  if (court === 'me') {
    return done('needs-your-response', receipts, reviewer?.at ?? null, escalate);
  }
  if (court === 'reviewer') {
    return done('waiting-on-reviewer', receipts, mine?.at ?? null, escalate);
  }
  if (court === 'nobody') {
    return done('ready-to-merge', receipts, reviewer?.at ?? null, escalate);
  }

  // No review has ever happened.
  if (local.discordPostedAt !== null) {
    const hours = (now.getTime() - Date.parse(local.discordPostedAt)) / 3_600_000;
    receipts.push(`posted to Discord ${Math.floor(hours)}h ago, no reviewer activity`);
    if (hours > cfg.staleAfterHours) receipts.push('stale — consider re-pinging');
    return done('asked-no-looks', receipts, local.discordPostedAt, escalate);
  }
  if (pr.isDraft) return done('draft', receipts, null, escalate);
  receipts.push('not yet posted for review');
  return done('not-asked', receipts, null, escalate);
}

/**
 * The footer is the primary court signal, taken from the newest review by
 * anyone — the user replies through Reviewable too (#2635). A footer is a
 * snapshot: if anything happened after its review, it is stale and the
 * timestamp comparison decides instead.
 */
export function determineCourt(
  pr: PrInput,
  cfg: Config,
  receipts: string[] = [],
): Court {
  const newestReview = [...pr.reviews]
    .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .at(-1);

  const footer = newestReview ? parseFooter(newestReview.bodyText) : null;

  if (newestReview && footer && !hasActivityAfter(pr, cfg, newestReview)) {
    receipts.push(footerReceipt(newestReview, footer));
    if (footer.waitingOn.includes(cfg.me)) return 'me';
    if (footer.waitingOn.length > 0) return 'reviewer';
    if (footer.discussions === 'resolved' && footer.files === 'all') return 'nobody';
    return 'reviewer';
  }

  const reviewer = lastReviewerActivity(pr, cfg);
  const mine = lastMyActivity(pr, cfg);
  if (reviewer === null) return 'unknown';

  if (mine !== null && mine.at > reviewer.at) {
    receipts.push(`you ${mine.what} after ${reviewer.who}'s last activity`);
    return 'reviewer';
  }
  receipts.push(`${reviewer.who} acted after your last activity`);
  return 'me';
}

function footerReceipt(review: ReviewInput, footer: Footer): string {
  const who = footer.waitingOn.length > 0
    ? `waiting on ${footer.waitingOn.join(' and ')}`
    : 'nobody waiting';
  const open = footer.discussions === 'resolved'
    ? 'all discussions resolved'
    : `${footer.discussions.unresolved} unresolved`;
  return `footer on ${review.author}'s review: ${open}, ${who}`;
}

/** True when any qualifying activity postdates the given review. */
function hasActivityAfter(pr: PrInput, cfg: Config, review: ReviewInput): boolean {
  const reviewer = lastReviewerActivity(pr, cfg);
  const mine = lastMyActivity(pr, cfg);
  const at = review.submittedAt;
  return (reviewer !== null && reviewer.at > at) || (mine !== null && mine.at > at);
}

function latestHumanReview(pr: PrInput, cfg: Config): ReviewInput | null {
  return [...pr.reviews]
    .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
    .filter((r) => isHumanReviewer(r.author, cfg))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .at(-1) ?? null;
}

export interface Escalation {
  reason: EscalationReason;
  reviewId: string;
}

function escalationFor(
  review: ReviewInput | null,
  receipts: string[],
): Escalation | null {
  if (review === null) return null;
  if (review.state === 'APPROVED' && BLOCKING_LANGUAGE.test(review.bodyText)) {
    receipts.push('approval mentions a blocker — checking');
    return { reason: 'approved-with-blocking-language', reviewId: review.id };
  }
  if (review.state === 'COMMENTED' && parseFooter(review.bodyText) === null) {
    receipts.push('commented review with no footer — checking');
    return { reason: 'commented-no-footer', reviewId: review.id };
  }
  return null;
}

function done(
  bucket: Classification['bucket'],
  receipts: string[],
  displayTime: string | null,
  escalation: Escalation | null,
): Classification {
  return {
    bucket,
    receipts,
    displayTime,
    escalate: escalation?.reason ?? null,
    escalateReviewId: escalation?.reviewId ?? null,
    verdict: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/classify.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/rules/classify.ts tests/classify.test.ts
git commit -m "feat: classify PRs into ball-in-court buckets from footer and activity"
```

---

### Task 7: GitHub client and real-fixture tests

**Files:**
- Create: `src/github/token.ts`, `src/github/query.ts`, `src/github/client.ts`
- Create: `tests/fixtures/pr-*.json` (generated)
- Test: `tests/classify-fixtures.test.ts`

**Interfaces:**
- Consumes: `PrInput`, `Config`.
- Produces:
  - `getToken(): string` and `clearTokenCache(): void`
  - `PR_QUERY: string`, `LIST_QUERY: string`
  - `mapPullRequest(node: unknown): PrInput`
  - `fetchOpenPrs(cfg: Config): Promise<PrInput[]>`

- [ ] **Step 1: Implement `src/github/token.ts`**

```ts
import { execFileSync } from 'node:child_process';

let cached: string | null = null;

export function getToken(): string {
  if (cached !== null) return cached;
  try {
    cached = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Could not read a GitHub token. Run `gh auth login` and start again.',
    );
  }
  if (cached === '') throw new Error('`gh auth token` returned nothing.');
  return cached;
}

/** Called on a 401 — tokens rotate under a long-running dev server. */
export function clearTokenCache(): void {
  cached = null;
}
```

- [ ] **Step 2: Implement `src/github/query.ts`**

```ts
const PR_FIELDS = `
  number
  title
  url
  isDraft
  mergeable
  mergeStateStatus
  reviews(first: 100) {
    nodes { id state submittedAt bodyText lastEditedAt author { login } }
  }
  comments(first: 100) { nodes { createdAt author { login } } }
  reviewThreads(first: 100) {
    nodes {
      isResolved
      comments(last: 1) { nodes { createdAt author { login } } }
    }
  }
  commits(last: 50) {
    nodes {
      commit {
        oid
        committedDate
        messageHeadline
        parents { totalCount }
        author { user { login } email }
      }
    }
  }
  headRefOid
  statusCheckRollup: commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
`;

export const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PR_FIELDS} }
  }
}`;

export const LIST_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;
```

- [ ] **Step 3: Implement `src/github/client.ts`**

```ts
import type { CheckContext, Config, PrInput } from '../types.js';
import { clearTokenCache, getToken } from './token.js';
import { LIST_QUERY } from './query.js';

interface GqlNode { [key: string]: any }

export function mapPullRequest(node: GqlNode): PrInput {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    headOid: node.headRefOid,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    reviews: (node.reviews?.nodes ?? []).map((r: GqlNode) => ({
      id: r.id,
      author: r.author?.login ?? 'unknown',
      state: r.state,
      submittedAt: r.submittedAt,
      bodyText: r.bodyText ?? '',
      lastEditedAt: r.lastEditedAt ?? null,
    })),
    comments: (node.comments?.nodes ?? []).map((c: GqlNode) => ({
      author: c.author?.login ?? 'unknown',
      createdAt: c.createdAt,
    })),
    commits: (node.commits?.nodes ?? []).map(({ commit }: GqlNode) => ({
      oid: commit.oid,
      committedDate: commit.committedDate,
      authorLogin: commit.author?.user?.login ?? null,
      authorEmail: commit.author?.email ?? null,
      messageHeadline: commit.messageHeadline,
      parentCount: commit.parents?.totalCount ?? 1,
    })),
    threads: (node.reviewThreads?.nodes ?? [])
      .map((t: GqlNode) => {
        const last = t.comments?.nodes?.[0];
        return last
          ? {
              isResolved: t.isResolved,
              lastCommentAuthor: last.author?.login ?? 'unknown',
              lastCommentAt: last.createdAt,
            }
          : null;
      })
      .filter((t: unknown): t is NonNullable<typeof t> => t !== null),
    checks: mapChecks(node),
  };
}

function mapChecks(node: GqlNode): CheckContext[] {
  const contexts =
    node.statusCheckRollup?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return contexts.map((c: GqlNode) =>
    c.name !== undefined
      ? { name: c.name, status: c.status, conclusion: c.conclusion ?? null }
      : { name: c.context, status: 'COMPLETED', conclusion: c.state ?? null },
  );
}

export async function fetchOpenPrs(cfg: Config): Promise<PrInput[]> {
  const q = `repo:${cfg.owner}/${cfg.name} is:pr is:open author:${cfg.me}`;
  const data = await graphql<{ search: { nodes: GqlNode[] } }>(LIST_QUERY, { q });
  return data.search.nodes.filter((n) => n.number !== undefined).map(mapPullRequest);
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  retried = false,
): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${getToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401 && !retried) {
    clearTokenCache();
    return graphql<T>(query, variables, true);
  }
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  if (!body.data) throw new Error('GitHub returned no data.');
  return body.data;
}
```

- [ ] **Step 4: Capture the fixtures**

```bash
npx tsx scripts/capture-fixtures.ts 2717 2720 2664 2742 2795 2796 2687 2635 2180
```

Expected: nine `captured pr-N` lines, nine files in `tests/fixtures/`.

- [ ] **Step 5: Run the fixture-integrity test**

Run: `npx vitest run tests/fixtures.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Write the real-data classification test**

```ts
// tests/classify-fixtures.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classify } from '../src/rules/classify.js';
import { lastReviewerActivity } from '../src/rules/activity.js';
import type { Bucket, Config, PrInput } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');
const load = (n: number): PrInput =>
  JSON.parse(readFileSync(`tests/fixtures/pr-${n}.json`, 'utf8')) as PrInput;

const run = (n: number) =>
  classify(load(n), { discordPostedAt: null }, cfg, NOW);

describe('classify against captured PRs', () => {
  const cases: [number, Bucket, string][] = [
    [2717, 'ready-to-merge', 'newest approval footer is complete!'],
    [2720, 'ready-to-merge', "approved with Reviewable's own summary thread"],
    [2664, 'ready-to-merge', 'approved; head commit is a bare merge of main'],
    [2796, 'draft', 'draft and conflicting stays quiet'],
  ];

  it.each(cases)('pr-%i → %s (%s)', (n, bucket) => {
    expect(run(n).bucket).toBe(bucket);
  });

  it('pr-2795 is not blocked by its cancelled-only checks', () => {
    expect(run(2795).bucket).not.toBe('blocked-mechanically');
  });

  it('pr-2180 sees its native inline threads as reviewer activity', () => {
    expect(lastReviewerActivity(load(2180), cfg)).not.toBeNull();
  });

  it('every classification explains itself', () => {
    for (const n of [2717, 2720, 2664, 2742, 2795, 2796, 2687, 2635, 2180]) {
      expect(run(n).receipts.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 7: Run it**

Run: `npx vitest run tests/classify-fixtures.test.ts`
Expected: PASS, 7 tests.

If a case fails, the rules are wrong, not the fixture. Fix `classify.ts` and rerun.

- [ ] **Step 8: Commit**

```bash
git add src/github tests/fixtures tests/classify-fixtures.test.ts
git commit -m "feat: add GitHub client and pin classification against real PRs"
```

---

### Task 8: SQLite store

**Files:**
- Create: `src/store/db.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `ClaudeVerdict`.
- Produces: `openStore(path: string): Store`, where `Store` has `getDiscordPostedAt`, `setDiscordPostedAt`, `getVerdict`, `putVerdict`, `shouldNotify`, `recordNotified`, `close`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store.test.ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';

const store = () => openStore(':memory:');

describe('discord timestamps', () => {
  it('returns null before anything is stamped', () => {
    expect(store().getDiscordPostedAt(2795)).toBeNull();
  });

  it('round-trips a stamp', () => {
    const s = store();
    s.setDiscordPostedAt(2795, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(2795)).toBe('2026-09-11T09:00:00Z');
  });

  it('overwrites rather than duplicating', () => {
    const s = store();
    s.setDiscordPostedAt(2795, '2026-09-10T09:00:00Z');
    s.setDiscordPostedAt(2795, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(2795)).toBe('2026-09-11T09:00:00Z');
  });
});

describe('verdict cache', () => {
  const verdict = {
    court: 'me' as const, blockingCount: 1,
    asks: ['fix the readDirection blocker'], confidence: 'high' as const,
  };

  it('round-trips a verdict keyed on review id and edit time', () => {
    const s = store();
    s.putVerdict('R_123', null, verdict);
    expect(s.getVerdict('R_123', null)).toEqual(verdict);
  });

  // Review bodies are editable, so the node id alone is not a safe key.
  it('misses when the review has since been edited', () => {
    const s = store();
    s.putVerdict('R_123', null, verdict);
    expect(s.getVerdict('R_123', '2026-09-11T10:00:00Z')).toBeNull();
  });
});

describe('notification dedupe', () => {
  const NOW = new Date('2026-09-11T12:00:00Z');

  it('allows the first notification for a bucket', () => {
    expect(store().shouldNotify(2795, 'needs-your-response', NOW)).toBe(true);
  });

  it('suppresses a repeat of the same bucket', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    expect(s.shouldNotify(2795, 'needs-your-response', NOW)).toBe(false);
  });

  it('survives a restart', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    expect(s.shouldNotify(2795, 'needs-your-response', NOW)).toBe(false);
  });

  // The user posts several comments per round, minutes apart.
  it('debounces a different bucket within 15 minutes', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    const soon = new Date('2026-09-11T12:10:00Z');
    expect(s.shouldNotify(2795, 'blocked-mechanically', soon)).toBe(false);
  });

  it('allows a new bucket after the debounce window', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    const later = new Date('2026-09-11T12:20:00Z');
    expect(s.shouldNotify(2795, 'blocked-mechanically', later)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/store/db.js`

- [ ] **Step 3: Implement `src/store/db.ts`**

```ts
import Database from 'better-sqlite3';
import type { Bucket, ClaudeVerdict } from '../types.js';

const DEBOUNCE_MS = 15 * 60 * 1000;

export interface Store {
  getDiscordPostedAt(pr: number): string | null;
  setDiscordPostedAt(pr: number, at: string | null): void;
  getVerdict(reviewId: string, lastEditedAt: string | null): ClaudeVerdict | null;
  putVerdict(reviewId: string, lastEditedAt: string | null, v: ClaudeVerdict): void;
  shouldNotify(pr: number, bucket: Bucket, now: Date): boolean;
  recordNotified(pr: number, bucket: Bucket, now: Date): void;
  close(): void;
}

export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord (pr INTEGER PRIMARY KEY, posted_at TEXT);
    CREATE TABLE IF NOT EXISTS verdicts (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notified (
      pr INTEGER PRIMARY KEY, bucket TEXT NOT NULL, at TEXT NOT NULL
    );
  `);

  const key = (id: string, edited: string | null) => `${id}@${edited ?? 'never'}`;

  return {
    getDiscordPostedAt(pr) {
      const row = db.prepare('SELECT posted_at FROM discord WHERE pr = ?').get(pr) as
        | { posted_at: string | null } | undefined;
      return row?.posted_at ?? null;
    },
    setDiscordPostedAt(pr, at) {
      db.prepare(
        `INSERT INTO discord (pr, posted_at) VALUES (?, ?)
         ON CONFLICT(pr) DO UPDATE SET posted_at = excluded.posted_at`,
      ).run(pr, at);
    },
    getVerdict(reviewId, lastEditedAt) {
      const row = db.prepare('SELECT payload FROM verdicts WHERE key = ?')
        .get(key(reviewId, lastEditedAt)) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as ClaudeVerdict) : null;
    },
    putVerdict(reviewId, lastEditedAt, v) {
      db.prepare(
        `INSERT INTO verdicts (key, payload) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload`,
      ).run(key(reviewId, lastEditedAt), JSON.stringify(v));
    },
    shouldNotify(pr, bucket, now) {
      const row = db.prepare('SELECT bucket, at FROM notified WHERE pr = ?').get(pr) as
        | { bucket: string; at: string } | undefined;
      if (row === undefined) return true;
      if (row.bucket === bucket) return false;
      return now.getTime() - Date.parse(row.at) >= DEBOUNCE_MS;
    },
    recordNotified(pr, bucket, now) {
      db.prepare(
        `INSERT INTO notified (pr, bucket, at) VALUES (?, ?, ?)
         ON CONFLICT(pr) DO UPDATE SET bucket = excluded.bucket, at = excluded.at`,
      ).run(pr, bucket, now.toISOString());
    },
    close() { db.close(); },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/db.ts tests/store.test.ts
git commit -m "feat: add SQLite store for Discord stamps, verdicts, and notify dedupe"
```

---

### Task 9: Claude escalation layer

**Files:**
- Create: `src/claude/escalate.ts`
- Test: `tests/escalate.test.ts`

**Interfaces:**
- Consumes: `ClaudeVerdict`, `EscalationReason`, `ReviewInput`, `Store`.
- Produces: `buildPrompt(review, reason): string`, `parseVerdict(json: unknown): ClaudeVerdict`, `resolveEscalation(review, reason, store, ask): Promise<ClaudeVerdict | null>` where `ask` is an injected async function so tests never hit the network.

- [ ] **Step 1: Write the failing test**

```ts
// tests/escalate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildPrompt, parseVerdict, resolveEscalation } from '../src/claude/escalate.js';
import { openStore } from '../src/store/db.js';
import type { ClaudeVerdict, ReviewInput } from '../src/types.js';

const review: ReviewInput = {
  id: 'R_1', author: 'katherinejensen00', state: 'COMMENTED',
  submittedAt: '2026-09-08T22:06:03Z',
  bodyText: 'Verdict: 2 blocking, 3 warnings. Fix the readDirection default.',
  lastEditedAt: null,
};

const verdict: ClaudeVerdict = {
  court: 'me', blockingCount: 2,
  asks: ['fix the readDirection default'], confidence: 'high',
};

describe('buildPrompt', () => {
  it('includes the review body and the reason', () => {
    const prompt = buildPrompt(review, 'commented-no-footer');
    expect(prompt).toContain('readDirection');
    expect(prompt).toContain('commented-no-footer');
  });
});

describe('parseVerdict', () => {
  it('accepts a well-formed verdict', () => {
    expect(parseVerdict(verdict)).toEqual(verdict);
  });

  it('rejects an unknown court value', () => {
    expect(() => parseVerdict({ ...verdict, court: 'nobody' })).toThrow(/court/);
  });

  it('rejects a non-array asks', () => {
    expect(() => parseVerdict({ ...verdict, asks: 'fix it' })).toThrow(/asks/);
  });
});

describe('resolveEscalation', () => {
  it('calls the model on a miss and caches the result', async () => {
    const store = openStore(':memory:');
    const ask = vi.fn().mockResolvedValue(verdict);

    expect(await resolveEscalation(review, 'commented-no-footer', store, ask))
      .toEqual(verdict);
    expect(await resolveEscalation(review, 'commented-no-footer', store, ask))
      .toEqual(verdict);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('re-asks when the review has been edited since caching', async () => {
    const store = openStore(':memory:');
    const ask = vi.fn().mockResolvedValue(verdict);

    await resolveEscalation(review, 'commented-no-footer', store, ask);
    await resolveEscalation(
      { ...review, lastEditedAt: '2026-09-09T00:00:00Z' },
      'commented-no-footer', store, ask,
    );
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('returns null rather than throwing when the model call fails', async () => {
    const store = openStore(':memory:');
    const ask = vi.fn().mockRejectedValue(new Error('no credentials'));

    expect(await resolveEscalation(review, 'commented-no-footer', store, ask))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/escalate.test.ts`
Expected: FAIL — cannot resolve `../src/claude/escalate.js`

- [ ] **Step 3: Implement `src/claude/escalate.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeVerdict, EscalationReason, ReviewInput } from '../types.js';
import type { Store } from '../store/db.js';

const SCHEMA = {
  type: 'object',
  properties: {
    court: { type: 'string', enum: ['me', 'reviewer'] },
    blockingCount: { type: 'integer' },
    asks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['court', 'blockingCount', 'asks', 'confidence'],
  additionalProperties: false,
} as const;

export function buildPrompt(review: ReviewInput, reason: EscalationReason): string {
  return [
    'You are reading one GitHub pull request review, written by a colleague',
    'reviewing code authored by the dashboard user.',
    '',
    `Ambiguity to resolve: ${reason}`,
    '',
    'Decide whether the ball is now in the AUTHOR\'s court ("me") — the review',
    'asks for changes — or the REVIEWER\'s court ("reviewer") — nothing is asked',
    'of the author. Then list, briefly, what is being asked for.',
    '',
    `Review state: ${review.state}`,
    `Review author: ${review.author}`,
    '--- review body ---',
    review.bodyText.slice(0, 20_000),
  ].join('\n');
}

export function parseVerdict(value: unknown): ClaudeVerdict {
  const v = value as Record<string, unknown>;
  if (v?.court !== 'me' && v?.court !== 'reviewer') {
    throw new Error(`Verdict "court" must be "me" or "reviewer", got ${String(v?.court)}`);
  }
  if (!Array.isArray(v.asks)) throw new Error('Verdict "asks" must be an array.');
  if (v.confidence !== 'high' && v.confidence !== 'low') {
    throw new Error('Verdict "confidence" must be "high" or "low".');
  }
  return {
    court: v.court,
    blockingCount: Number(v.blockingCount ?? 0),
    asks: v.asks.map(String),
    confidence: v.confidence,
  };
}

export type Ask = (prompt: string) => Promise<unknown>;

/** The real model call. Injected so tests never reach the network. */
export const askClaude: Ask = async (prompt) => {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  } as Parameters<typeof client.messages.create>[0]);

  const block = (response as { content: { type: string; text?: string }[] })
    .content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('Claude returned no text block.');
  return JSON.parse(block.text);
};

export async function resolveEscalation(
  review: ReviewInput,
  reason: EscalationReason,
  store: Store,
  ask: Ask = askClaude,
): Promise<ClaudeVerdict | null> {
  const cached = store.getVerdict(review.id, review.lastEditedAt);
  if (cached !== null) return cached;

  try {
    const verdict = parseVerdict(await ask(buildPrompt(review, reason)));
    store.putVerdict(review.id, review.lastEditedAt, verdict);
    return verdict;
  } catch {
    // Degrade: the caller keeps the deterministic bucket and says the
    // tie-break is unavailable.
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/escalate.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/claude/escalate.ts tests/escalate.test.ts
git commit -m "feat: resolve ambiguous reviews with Claude, cached on review id and edit time"
```

---

### Task 10: Local branches and notifications

**Files:**
- Create: `src/git/branches.ts`, `src/notify/osascript.ts`
- Test: `tests/branches.test.ts`

**Interfaces:**
- Consumes: `BranchInput`, `Bucket`.
- Produces:
  - `parseBranchLines(lines: string[], prBranchNames: Set<string>): BranchInput[]`
  - `readBranches(repoPath: string, prBranchNames: Set<string>): BranchInput[]`
  - `notify(title: string, body: string, url: string): void`
  - `NOTIFY_BUCKETS: Set<Bucket>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/branches.test.ts
import { describe, expect, it } from 'vitest';
import { parseBranchLines } from '../src/git/branches.js';

// Format: "%(refname:short)\t%(upstream:track)\t%(upstream)"
const LINES = [
  'pt-3609-unexpected-find-results\t\trefs/remotes/origin/pt-3609-unexpected-find-results',
  'adr-slugs\t[gone]\trefs/remotes/origin/adr-slugs',
  'pt-4020-fix-undo-bug\t\t',
  'main\t[behind 54]\trefs/remotes/origin/main',
];

describe('parseBranchLines', () => {
  it('marks a branch whose upstream is gone as dead', () => {
    const dead = parseBranchLines(LINES, new Set()).find((b) => b.name === 'adr-slugs');
    expect(dead?.upstreamGone).toBe(true);
  });

  it('does not mark a live tracking branch as dead', () => {
    const live = parseBranchLines(LINES, new Set())
      .find((b) => b.name === 'pt-3609-unexpected-find-results');
    expect(live?.upstreamGone).toBe(false);
  });

  it('links a branch to its PR when one exists', () => {
    const linked = parseBranchLines(LINES, new Set(['pt-3609-unexpected-find-results']))
      .find((b) => b.name === 'pt-3609-unexpected-find-results');
    expect(linked?.prNumber).not.toBeNull();
  });

  it('excludes main', () => {
    expect(parseBranchLines(LINES, new Set()).some((b) => b.name === 'main')).toBe(false);
  });

  it('treats a branch with no upstream as local-only, not dead', () => {
    const local = parseBranchLines(LINES, new Set())
      .find((b) => b.name === 'pt-4020-fix-undo-bug');
    expect(local?.upstreamGone).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/branches.test.ts`
Expected: FAIL — cannot resolve `../src/git/branches.js`

- [ ] **Step 3: Implement `src/git/branches.ts`**

```ts
import { execFileSync } from 'node:child_process';
import type { BranchInput } from '../types.js';

const FORMAT = '%(refname:short)\t%(upstream:track)\t%(upstream)';

export function parseBranchLines(
  lines: string[],
  prBranchNames: Set<string>,
): BranchInput[] {
  return lines
    .map((line) => line.split('\t'))
    .filter((parts) => (parts[0] ?? '') !== '' && parts[0] !== 'main')
    .map(([name = '', track = '', upstream = '']) => ({
      name,
      upstreamGone: track.includes('[gone]'),
      aheadOfMain: 0,
      prNumber: prBranchNames.has(name) ? 1 : null,
      _hasUpstream: upstream !== '',
    }))
    .map(({ _hasUpstream, ...branch }) => branch);
}

export function readBranches(
  repoPath: string,
  prBranchNames: Set<string>,
): BranchInput[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'for-each-ref', '--format', FORMAT, 'refs/heads'],
      { encoding: 'utf8' },
    );
    return parseBranchLines(out.split('\n'), prBranchNames);
  } catch {
    // Repo path missing or not a git repo: PR buckets still work.
    return [];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/branches.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement `src/notify/osascript.ts`**

```ts
import { execFile } from 'node:child_process';
import type { Bucket } from '../types.js';

/** Buckets whose arrival is worth interrupting the user for. */
export const NOTIFY_BUCKETS: Set<Bucket> = new Set([
  'needs-your-response',
  'blocked-mechanically',
  'ready-to-merge',
]);

const escape = (s: string): string => s.replace(/["\\]/g, '\\$&');

export function notify(title: string, body: string, url: string): void {
  const script =
    `display notification "${escape(body)}" with title "${escape(title)}"` +
    ` subtitle "${escape(url)}"`;
  execFile('osascript', ['-e', script], (error) => {
    if (error) console.error(`notification failed: ${error.message}`);
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/git/branches.ts src/notify/osascript.ts tests/branches.test.ts
git commit -m "feat: read local branches and send macOS notifications"
```

---

### Task 11: Poller, routes, and server

**Files:**
- Create: `src/server/poller.ts`, `src/server/routes.ts`, `src/server/index.ts`
- Test: `tests/poller.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildBoard(prs, branches, store, cfg, now): Board`, `createPoller(cfg, store): Poller` with `poller.snapshot(): Board | null` and `poller.start()/stop()`, `registerRoutes(app, poller, store)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/poller.test.ts
import { describe, expect, it } from 'vitest';
import { buildBoard } from '../src/server/poller.js';
import { openStore } from '../src/store/db.js';
import type { Config, PrInput } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');

const pr = (over: Partial<PrInput>): PrInput => ({
  number: 1, title: 't', url: 'u', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [],
  commits: [{
    oid: 'abc', committedDate: '2026-09-01T00:00:00Z',
    authorLogin: 'jolierabideau', authorEmail: null,
    messageHeadline: 'PT-1: work', parentCount: 1,
  }],
  threads: [], checks: [], ...over,
});

describe('buildBoard', () => {
  it('orders buckets by priority, most urgent first', () => {
    const board = buildBoard(
      [pr({ number: 1 }), pr({ number: 2, mergeStateStatus: 'DIRTY' })],
      [], openStore(':memory:'), cfg, NOW,
    );
    expect(board.items[0]?.number).toBe(2);
  });

  it('counts only items in the user court', () => {
    const board = buildBoard(
      [pr({ number: 2, mergeStateStatus: 'DIRTY' }), pr({ number: 1 })],
      [], openStore(':memory:'), cfg, NOW,
    );
    expect(board.yourCourtCount).toBe(1);
  });

  it('applies the stored Discord timestamp', () => {
    const store = openStore(':memory:');
    store.setDiscordPostedAt(1, '2026-09-11T09:00:00Z');
    const board = buildBoard([pr({ number: 1 })], [], store, cfg, NOW);
    expect(board.items[0]?.bucket).toBe('asked-no-looks');
  });

  it('carries branches through as their own items', () => {
    const board = buildBoard(
      [], [{ name: 'adr-slugs', upstreamGone: true, aheadOfMain: 0, prNumber: null }],
      openStore(':memory:'), cfg, NOW,
    );
    expect(board.branches[0]?.bucket).toBe('dead-branch');
  });

  it('stamps the board with when it was built', () => {
    const board = buildBoard([], [], openStore(':memory:'), cfg, NOW);
    expect(board.fetchedAt).toBe(NOW.toISOString());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/poller.test.ts`
Expected: FAIL — cannot resolve `../src/server/poller.js`

- [ ] **Step 3: Implement `src/server/poller.ts`**

```ts
import { classify } from '../rules/classify.js';
import { checkDot } from '../rules/checks.js';
import { resolveEscalation } from '../claude/escalate.js';
import { fetchOpenPrs } from '../github/client.js';
import { readBranches } from '../git/branches.js';
import { NOTIFY_BUCKETS, notify } from '../notify/osascript.js';
import type { Store } from '../store/db.js';
import type {
  BranchInput, Bucket, Classification, Config, PrInput,
} from '../types.js';

export interface BoardItem extends Classification {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
}

export interface BranchItem {
  name: string;
  bucket: Extract<Bucket, 'unsubmitted-branch' | 'dead-branch'>;
}

export interface Board {
  items: BoardItem[];
  branches: BranchItem[];
  yourCourtCount: number;
  fetchedAt: string;
  stale: boolean;
  error: string | null;
}

const ORDER: Bucket[] = [
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
  'waiting-on-reviewer', 'asked-no-looks', 'not-asked', 'draft',
  'unsubmitted-branch', 'dead-branch',
];

const YOUR_COURT: Set<Bucket> = new Set([
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
]);

export function buildBoard(
  prs: PrInput[],
  branches: BranchInput[],
  store: Store,
  cfg: Config,
  now: Date,
): Board {
  const items: BoardItem[] = prs.map((pr) => {
    const local = { discordPostedAt: store.getDiscordPostedAt(pr.number) };
    const classification = classify(pr, local, cfg, now);
    return {
      ...classification,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      checkDot: checkDot(pr.checks),
    };
  });

  items.sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));

  return {
    items,
    branches: branches.map((b) => ({
      name: b.name,
      bucket: b.upstreamGone ? ('dead-branch' as const) : ('unsubmitted-branch' as const),
    })),
    yourCourtCount: items.filter((i) => YOUR_COURT.has(i.bucket)).length,
    fetchedAt: now.toISOString(),
    stale: false,
    error: null,
  };
}

export interface Poller {
  snapshot(): Board | null;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createPoller(cfg: Config, store: Store): Poller {
  let board: Board | null = null;
  let timer: NodeJS.Timeout | null = null;

  const refresh = async (): Promise<void> => {
    try {
      const prs = await fetchOpenPrs(cfg);
      const prBranches = new Set(prs.map((p) => p.title));
      const branches = readBranches(cfg.repoPath, prBranches);
      const next = buildBoard(prs, branches, store, cfg, new Date());

      await attachVerdicts(next, prs, store);
      sendNotifications(next, store);

      board = next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      board = board === null
        ? { items: [], branches: [], yourCourtCount: 0,
            fetchedAt: new Date().toISOString(), stale: true, error: message }
        : { ...board, stale: true, error: message };
    }
  };

  return {
    snapshot: () => board,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), cfg.pollIntervalMs);
    },
    stop() { if (timer !== null) clearInterval(timer); },
    refresh,
  };
}

async function attachVerdicts(
  board: Board, prs: PrInput[], store: Store,
): Promise<void> {
  for (const item of board.items) {
    if (item.escalate === null || item.escalateReviewId === null) continue;
    const pr = prs.find((p) => p.number === item.number);
    // Resolve the exact review classify escalated on, not merely the newest.
    const review = pr?.reviews.find((r) => r.id === item.escalateReviewId);
    if (!review) continue;

    const verdict = await resolveEscalation(review, item.escalate, store);
    if (verdict === null) {
      item.receipts.push('tie-break unavailable — showing the rules-only result');
      continue;
    }
    item.verdict = verdict;
    item.receipts.push(`Claude: ball is in ${verdict.court === 'me' ? 'your' : 'their'} court`);
    if (verdict.court === 'me' && item.bucket === 'ready-to-merge') {
      item.bucket = 'needs-your-response';
    }
  }
  board.items.sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));
  board.yourCourtCount = board.items.filter((i) => YOUR_COURT.has(i.bucket)).length;
}

function sendNotifications(board: Board, store: Store): void {
  const now = new Date();
  for (const item of board.items) {
    if (!NOTIFY_BUCKETS.has(item.bucket)) continue;
    if (!store.shouldNotify(item.number, item.bucket, now)) continue;
    notify(`PR #${item.number}`, `${item.bucket}: ${item.title}`, item.url);
    store.recordNotified(item.number, item.bucket, now);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/poller.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement `src/server/routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Poller } from './poller.js';
import type { Store } from '../store/db.js';

export function registerRoutes(
  app: FastifyInstance, poller: Poller, store: Store,
): void {
  app.get('/api/board', async (_request, reply) => {
    const board = poller.snapshot();
    if (board === null) {
      return reply.send({
        items: [], branches: [], yourCourtCount: 0,
        fetchedAt: null, stale: true, error: 'no data yet — retrying',
      });
    }
    return reply.send(board);
  });

  app.post<{ Params: { number: string }; Body: { posted: boolean } }>(
    '/api/pr/:number/discord',
    async (request, reply) => {
      const number = Number(request.params.number);
      if (!Number.isInteger(number)) {
        return reply.code(400).send({ error: 'bad PR number' });
      }
      store.setDiscordPostedAt(
        number,
        request.body?.posted === false ? null : new Date().toISOString(),
      );
      await poller.refresh();
      return reply.send({ ok: true });
    },
  );
}
```

- [ ] **Step 6: Implement `src/server/index.ts`**

```ts
import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { openStore } from '../store/db.js';
import { createPoller } from './poller.js';
import { registerRoutes } from './routes.js';

const config = loadConfig(process.env.PRD_CONFIG ?? 'config.json');
const store = openStore(process.env.PRD_DB ?? 'pr-dashboard.db');
const poller = createPoller(config, store);

const app = Fastify({ logger: { level: 'warn' } });
registerRoutes(app, poller, store);

poller.start();

const port = Number(process.env.PORT ?? 5174);
await app.listen({ port, host: '127.0.0.1' });
console.log(`PR dashboard API on http://127.0.0.1:${port}`);
```

- [ ] **Step 7: Smoke-test the server**

```bash
cp config.example.json config.json
npx tsx src/server/index.ts &
sleep 10
curl -s http://127.0.0.1:5174/api/board | head -c 400
kill %1
```

Expected: JSON containing `items`, `yourCourtCount`, and real PR numbers.

- [ ] **Step 8: Commit**

```bash
git add src/server tests/poller.test.ts
git commit -m "feat: add poller, board assembly, and HTTP routes"
```

---

### Task 12: React client

**Files:**
- Create: `client/index.html`, `client/vite.config.ts`
- Create: `client/src/main.tsx`, `client/src/api.ts`, `client/src/buckets.ts`, `client/src/App.tsx`, `client/src/Card.tsx`
- Modify: `package.json` (add client deps and a combined `dev` script)

**Interfaces:**
- Consumes: `GET /api/board` and `POST /api/pr/:number/discord` from Task 11; the `Board`, `BoardItem`, `Bucket` types.
- Produces: the browser UI. No exports consumed elsewhere.

- [ ] **Step 1: Add client dependencies and scripts**

```bash
npm install react react-dom
npm install -D @vitejs/plugin-react vite @types/react @types/react-dom npm-run-all
npm pkg set scripts.dev="run-p dev:api dev:web"
npm pkg set scripts.dev:api="node --import tsx/esm src/server/index.ts"
npm pkg set scripts.dev:web="vite --config client/vite.config.ts"
```

- [ ] **Step 2: Create `client/vite.config.ts` and `client/index.html`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:5174' },
  },
});
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PR Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `client/src/buckets.ts` and `client/src/api.ts`**

```ts
// client/src/buckets.ts
export const BUCKET_ORDER = [
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
  'waiting-on-reviewer', 'asked-no-looks', 'not-asked', 'draft',
] as const;

export type Bucket = (typeof BUCKET_ORDER)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  'blocked-mechanically': 'Blocked on you',
  'needs-your-response': 'Needs your response',
  'ready-to-merge': 'Ready to merge',
  'waiting-on-reviewer': 'Waiting on reviewer',
  'asked-no-looks': 'Asked, nobody has looked',
  'not-asked': 'Not asked yet',
  draft: 'Drafts',
};

/** Buckets rendered expanded by default; the rest collapse to one line. */
export const EXPANDED: Set<Bucket> = new Set([
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
]);
```

```ts
// client/src/api.ts
export interface BoardItem {
  number: number;
  title: string;
  url: string;
  bucket: string;
  receipts: string[];
  displayTime: string | null;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
  verdict: { asks: string[] } | null;
}

export interface Board {
  items: BoardItem[];
  branches: { name: string; bucket: string }[];
  yourCourtCount: number;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
}

export const fetchBoard = async (): Promise<Board> => {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as Board;
};

export const markPostedToDiscord = async (
  number: number, posted: boolean,
): Promise<void> => {
  await fetch(`/api/pr/${number}/discord`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posted }),
  });
};
```

- [ ] **Step 4: Create `client/src/Card.tsx`**

```tsx
import type { BoardItem } from './api';
import { markPostedToDiscord } from './api';

const DOT: Record<BoardItem['checkDot'], string> = {
  fail: '#d64545', pending: '#c98a20', pass: '#3f9142', none: 'transparent',
};

const ago = (iso: string | null): string => {
  if (iso === null) return '';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
};

export function Card({ item, onChange }: {
  item: BoardItem;
  onChange: () => void;
}) {
  const post = async () => {
    await markPostedToDiscord(item.number, true);
    onChange();
  };

  return (
    <li className="card">
      <div className="card-head">
        <span className="dot" style={{ background: DOT[item.checkDot] }} />
        <a href={item.url} target="_blank" rel="noreferrer">
          #{item.number} {item.title}
        </a>
        <span className="age">{ago(item.displayTime)}</span>
      </div>

      <ul className="receipts">
        {item.receipts.map((receipt) => <li key={receipt}>{receipt}</li>)}
      </ul>

      {item.verdict !== null && item.verdict.asks.length > 0 && (
        <ul className="asks">
          {item.verdict.asks.map((ask) => <li key={ask}>{ask}</li>)}
        </ul>
      )}

      {(item.bucket === 'not-asked' || item.bucket === 'draft') && (
        <button type="button" onClick={post}>Posted to Discord</button>
      )}
    </li>
  );
}
```

- [ ] **Step 5: Create `client/src/App.tsx` and `client/src/main.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchBoard, type Board } from './api';
import { BUCKET_LABEL, BUCKET_ORDER, EXPANDED, type Bucket } from './buckets';
import { Card } from './Card';

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const n = board?.yourCourtCount ?? 0;
    document.title = n > 0 ? `(${n}) PR Dashboard` : 'PR Dashboard';
  }, [board?.yourCourtCount]);

  if (board === null) return <main><p>{failed ? 'API unreachable.' : 'Loading…'}</p></main>;

  return (
    <main>
      <h1>{board.yourCourtCount} in your court</h1>

      {board.stale && (
        <p className="banner">
          Showing the last good data{board.error === null ? '' : ` — ${board.error}`}
        </p>
      )}

      {BUCKET_ORDER.map((bucket: Bucket) => {
        const items = board.items.filter((i) => i.bucket === bucket);
        if (items.length === 0) return null;
        return (
          <section key={bucket}>
            <h2>{BUCKET_LABEL[bucket]} ({items.length})</h2>
            {EXPANDED.has(bucket) ? (
              <ul className="cards">
                {items.map((item) => (
                  <Card key={item.number} item={item} onChange={() => void load()} />
                ))}
              </ul>
            ) : (
              <details>
                <summary>{items.length} hidden</summary>
                <ul className="cards">
                  {items.map((item) => (
                    <Card key={item.number} item={item} onChange={() => void load()} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}

      {board.branches.length > 0 && (
        <details>
          <summary>{board.branches.length} local branches</summary>
          <ul>
            {board.branches.map((b) => (
              <li key={b.name}>{b.name} — {b.bucket}</li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
```

```tsx
// client/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const style = document.createElement('style');
style.textContent = `
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #faf9f7; color: #1c1b19; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; } h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #6b6862; margin-top: 28px; }
  .banner { background: #fdf3d7; border: 1px solid #e8d9a0; padding: 8px 12px; border-radius: 6px; }
  .cards { list-style: none; padding: 0; display: grid; gap: 10px; }
  .card { background: #fff; border: 1px solid #e6e3dd; border-radius: 8px; padding: 12px 14px; }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .card-head a { color: inherit; text-decoration: none; font-weight: 600; flex: 1; }
  .card-head a:hover { text-decoration: underline; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .age { color: #8a867f; font-variant-numeric: tabular-nums; }
  .receipts, .asks { margin: 8px 0 0; padding-left: 18px; color: #6b6862; font-size: 13px; }
  .asks { color: #1c1b19; }
  button { margin-top: 10px; font: inherit; padding: 5px 10px; border-radius: 6px;
           border: 1px solid #d4d0c8; background: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #171614; color: #ece9e3; }
    .card { background: #201f1c; border-color: #35332e; }
    .receipts { color: #9b968d; }
    button { background: #201f1c; color: inherit; border-color: #35332e; }
  }
`;
document.head.append(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
```

- [ ] **Step 6: Run it end to end**

```bash
npm run dev
```

Open `http://localhost:5173`. Expected: your real open PRs, grouped, with the count in the tab title. Verify the "Posted to Discord" button moves a PR from "Not asked yet" to "Asked, nobody has looked".

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add client package.json package-lock.json
git commit -m "feat: add React board with prioritized buckets and receipts"
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: footer grammar → 2; activity and
substantive commits → 4; CI and mergeability → 5; bucket priority and drafts → 6;
GraphQL fields and fixtures → 3, 7; store and verdict-cache keying → 8; Claude
escalation with two triggers → 9; branches and notifications → 10; poller, failure
behavior, routes → 11; board layout and receipts → 12. The cut list (overrides,
snoozes, branch pruning, business-day math) appears nowhere, as intended.

**Known gaps, deliberately left:**

- `BranchInput.aheadOfMain` is populated as `0` in Task 10 and never used; branches are
  split on `upstreamGone` alone. Wire up a real ahead-count only if the branch section
  proves useful in practice.
- `BranchInput.prNumber` uses a placeholder match on branch name. Task 12 renders
  branches as a flat list, so this does not affect what is displayed. Correlating
  branches to PRs by `headRefName` requires adding that field to the query — worth
  doing if the branch section earns its place.
- Task 6's `classify` test for escalation asserts `result.escalate`; it does not assert
  `escalateReviewId`. Add that assertion if the two ever drift apart again.
