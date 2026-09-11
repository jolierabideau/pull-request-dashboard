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
