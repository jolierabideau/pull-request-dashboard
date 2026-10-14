import { describe, expect, it } from 'vitest';
import { classifyReviewing } from '../src/rules/reviewing.js';
import { lastActivityOf } from '../src/rules/activity.js';
import type { CommitInput, Config, PrInput, ReviewInput } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const ALICE = 'alice';
const NOW = new Date('2026-09-11T12:00:00Z');

const commit = (over: Partial<CommitInput>): CommitInput => ({
  oid: 'abc', committedDate: '2026-09-01T00:00:00Z',
  authorLogin: ALICE, authorEmail: null, messageHeadline: 'PT-1: real work', parentCount: 1,
  ...over,
});

const pr = (over: Partial<PrInput>): PrInput => ({
  repo: 'paranext/paranext-core', number: 1, title: 't', url: 'u',
  author: ALICE, updatedAt: '2026-09-10T00:00:00Z', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [], commits: [commit({})], threads: [], checks: [], ...over,
});

const review = (over: Partial<ReviewInput>): ReviewInput => ({
  id: 'r1', author: cfg.me, state: 'COMMENTED',
  submittedAt: '2026-09-05T00:00:00Z', bodyText: '', lastEditedAt: null, ...over,
});

const footer = (waitingOn: string) =>
  `Reviewable status: all files reviewed, 1 unresolved discussion (waiting on ${waitingOn}).`;

const classify = (input: PrInput, config: Config = cfg) => classifyReviewing(input, config, NOW);

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('classifyReviewing — Reviewable footer', () => {
  it('needs you when the newest footer names the user', () => {
    const result = classify(pr({
      reviews: [review({ author: ALICE, bodyText: footer(cfg.me), submittedAt: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-needs-you');
    expect(result.receipts).toContain('Reviewable is waiting on you');
    expect(result.displayTime).toBe('2026-09-06T00:00:00Z');
  });

  it('waits on the author when the footer names the author', () => {
    const result = classify(pr({
      reviews: [review({ bodyText: footer(ALICE), submittedAt: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
    expect(result.receipts).toContain(`Reviewable is waiting on ${ALICE}`);
  });

  it('reads a footer posted by a bot', () => {
    const result = classify(pr({
      reviews: [review({
        author: 'devin-ai-integration', bodyText: footer(cfg.me), submittedAt: '2026-09-06T00:00:00Z',
      })],
    }));
    expect(result.bucket).toBe('review-needs-you');
  });

  it('beats an approval', () => {
    const result = classify(pr({
      reviews: [
        review({ id: 'a', state: 'APPROVED', submittedAt: '2026-09-04T00:00:00Z' }),
        review({ id: 'f', author: ALICE, bodyText: footer(ALICE), submittedAt: '2026-09-06T00:00:00Z' }),
      ],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });

  it('falls through when the author pushed after the footer review', () => {
    const result = classify(pr({
      reviews: [review({ bodyText: footer(ALICE), submittedAt: '2026-09-06T00:00:00Z' })],
      commits: [commit({ committedDate: '2026-09-07T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-needs-you');
    expect(result.receipts.join(' ')).toContain('pushed after your last review');
  });

  it('falls through when the user acted after the footer review', () => {
    const result = classify(pr({
      reviews: [review({ author: ALICE, bodyText: footer(cfg.me), submittedAt: '2026-09-06T00:00:00Z' })],
      comments: [{ author: cfg.me, createdAt: '2026-09-07T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });

  it('ignores a footer that names nobody', () => {
    const result = classify(pr({
      reviews: [review({
        author: ALICE, submittedAt: '2026-09-06T00:00:00Z',
        bodyText: 'Reviewable status: complete! all files reviewed, all discussions resolved',
      })],
      commits: [commit({ committedDate: '2026-09-07T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-needs-you');
    expect(result.receipts.join(' ')).not.toContain('Reviewable');
  });
});

describe('classifyReviewing — review requests are ignored', () => {
  it('leaves a requested PR where the author acting last puts it', () => {
    const result = classify({
      ...pr({
        reviews: [review({ submittedAt: '2026-09-05T00:00:00Z' })],
        commits: [commit({ committedDate: '2026-09-06T00:00:00Z' })],
      }),
      requestedReviewers: [cfg.me],
    } as PrInput);
    expect(result.bucket).toBe('review-needs-you');
    expect(result.receipts.join(' ')).not.toContain('re-requested');
  });

  it('waits on the author for a requested PR where the user acted last', () => {
    const result = classify({
      ...pr({ reviews: [review({})] }),
      requestedReviewers: [cfg.me],
    } as PrInput);
    expect(result.bucket).toBe('review-waiting-on-author');
  });
});

describe('classifyReviewing — drafts', () => {
  it('waits on the author for a draft whose author pushed after the user', () => {
    const result = classify(pr({
      isDraft: true,
      reviews: [review({})],
      commits: [commit({ committedDate: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
    expect(result.receipts).toEqual(['draft — not waiting on you']);
  });

  it('beats a footer that names the user', () => {
    const result = classify(pr({
      isDraft: true,
      reviews: [review({ author: ALICE, bodyText: footer(cfg.me), submittedAt: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });
});

describe('classifyReviewing — gone quiet', () => {
  const stale = (days: number, over: Partial<PrInput> = {}) =>
    pr({ updatedAt: daysAgo(days), reviews: [review({})], ...over });

  it('uses the normal rules at 29 days', () => {
    expect(classify(stale(29)).bucket).toBe('review-waiting-on-author');
  });

  it('goes quiet at 31 days, saying how long', () => {
    const result = classify(stale(31));
    expect(result.bucket).toBe('review-quiet');
    expect(result.receipts).toEqual(['no activity for 31 days']);
  });

  it('honours quietAfterDays', () => {
    expect(classify(stale(10), { ...cfg, quietAfterDays: 7 }).bucket).toBe('review-quiet');
    expect(classify(stale(40), { ...cfg, quietAfterDays: 60 }).bucket).not.toBe('review-quiet');
  });

  it('beats a draft', () => {
    expect(classify(stale(31, { isDraft: true })).bucket).toBe('review-quiet');
  });

  it('beats a footer that names the user', () => {
    const result = classify(stale(31, {
      reviews: [review({ author: ALICE, bodyText: footer(cfg.me), submittedAt: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-quiet');
  });
});

describe('classifyReviewing — approved', () => {
  const approval = review({ state: 'APPROVED', submittedAt: '2026-09-05T00:00:00Z' });

  it('stays approved when nothing new came from the author', () => {
    const result = classify(pr({ reviews: [approval] }));
    expect(result.bucket).toBe('review-approved');
    expect(result.receipts).toContain(`you approved; nothing new from ${ALICE} since`);
    expect(result.displayTime).toBe('2026-09-05T00:00:00Z');
  });

  it('stays approved after the author pushes', () => {
    const result = classify(pr({
      reviews: [approval],
      commits: [commit({ committedDate: '2026-09-08T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-approved');
  });

  it('flips to needs-you when the author comments afterwards', () => {
    const result = classify(pr({
      reviews: [approval],
      comments: [{ author: ALICE, createdAt: '2026-09-08T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-needs-you');
  });

  it('flips to needs-you when the author replies in a review thread afterwards', () => {
    const result = classify(pr({
      reviews: [approval],
      threads: [{ isResolved: false, lastCommentAuthor: ALICE, lastCommentAt: '2026-09-08T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-needs-you');
  });

  it('is not approved when the approval was dismissed', () => {
    const result = classify(pr({ reviews: [{ ...approval, state: 'DISMISSED' }] }));
    expect(result.bucket).not.toBe('review-approved');
  });

  it('uses the newest review, so a later comment review ends the approval', () => {
    const result = classify(pr({
      reviews: [approval, review({ id: 'r2', submittedAt: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });
});

describe('classifyReviewing — last activity', () => {
  it('needs you when the author pushed after the user last reviewed', () => {
    const result = classify(pr({
      reviews: [review({ submittedAt: '2026-09-05T00:00:00Z' })],
      commits: [commit({ committedDate: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-needs-you');
    expect(result.receipts).toContain(`${ALICE} pushed after your last review`);
    expect(result.displayTime).toBe('2026-09-06T00:00:00Z');
  });

  it('needs you when the author replied in an issue comment', () => {
    const result = classify(pr({
      reviews: [review({})],
      comments: [{ author: ALICE, createdAt: '2026-09-06T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-needs-you');
    expect(result.receipts).toContain(`${ALICE} replied after your last review`);
  });

  it('waits on the author when the user reviewed after the author acted', () => {
    const result = classify(pr({
      reviews: [review({ submittedAt: '2026-09-05T00:00:00Z' })],
      commits: [commit({ committedDate: '2026-09-01T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
    expect(result.receipts).toContain(`you reviewed after ${ALICE}'s last activity`);
    expect(result.displayTime).toBe('2026-09-05T00:00:00Z');
  });

  it('says commented when the user only left an issue comment', () => {
    const result = classify(pr({
      comments: [{ author: cfg.me, createdAt: '2026-09-05T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
    expect(result.receipts).toContain(`you commented after ${ALICE}'s last activity`);
  });

  it('counts the user being the last commenter of a thread', () => {
    const result = classify(pr({
      threads: [{ isResolved: false, lastCommentAuthor: cfg.me, lastCommentAt: '2026-09-09T00:00:00Z' }],
      commits: [commit({ committedDate: '2026-09-06T00:00:00Z' })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });

  it('treats equal timestamps as the user acting last', () => {
    const at = '2026-09-05T00:00:00Z';
    const result = classify(pr({
      reviews: [review({ submittedAt: at })],
      commits: [commit({ committedDate: at })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });

  it('ignores a bare merge of main by the author', () => {
    const result = classify(pr({
      reviews: [review({ submittedAt: '2026-09-05T00:00:00Z' })],
      commits: [commit({
        committedDate: '2026-09-08T00:00:00Z', parentCount: 2,
        messageHeadline: "Merge remote-tracking branch 'origin/main' into feature",
      })],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });

  it('ignores bots', () => {
    const result = classify(pr({
      reviews: [review({ submittedAt: '2026-09-05T00:00:00Z' }), review({
        id: 'bot', author: 'devin-ai-integration', submittedAt: '2026-09-08T00:00:00Z',
      })],
      comments: [{ author: 'devin-ai-integration', createdAt: '2026-09-09T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });

  it('ignores other reviewers', () => {
    const result = classify(pr({
      reviews: [review({ submittedAt: '2026-09-05T00:00:00Z' }), review({
        id: 'bob', author: 'bob', submittedAt: '2026-09-08T00:00:00Z',
      })],
      comments: [{ author: 'carol', createdAt: '2026-09-09T00:00:00Z' }],
      threads: [{ isResolved: false, lastCommentAuthor: 'bob', lastCommentAt: '2026-09-10T00:00:00Z' }],
    }));
    expect(result.bucket).toBe('review-waiting-on-author');
  });
});

describe('classifyReviewing — shape', () => {
  it('never escalates and carries no verdict', () => {
    const result = classify(pr({ reviews: [review({})] }));
    expect(result.escalate).toBeNull();
    expect(result.escalateReviewId).toBeNull();
    expect(result.verdict).toBeNull();
  });
});

describe('lastActivityOf', () => {
  it('counts thread replies only when asked to', () => {
    const input = pr({
      threads: [{ isResolved: false, lastCommentAuthor: cfg.me, lastCommentAt: '2026-09-09T00:00:00Z' }],
    });
    expect(lastActivityOf(input, cfg.me, { commits: false, threads: false })).toBeNull();
    expect(lastActivityOf(input, cfg.me, { commits: false, threads: true })?.at)
      .toBe('2026-09-09T00:00:00Z');
  });

  it('skips pending reviews, which have no submission time', () => {
    expect(lastActivityOf(
      pr({ reviews: [review({ state: 'PENDING' })] }), cfg.me, { commits: false, threads: false },
    )).toBeNull();
  });
});
