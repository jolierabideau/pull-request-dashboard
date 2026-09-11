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

  // Regression: a bot's footerless review must not eclipse a human's footer.
  it('a bot review after a human footer does not discard the footer', () => {
    expect(bucketOf(pr({
      reviews: [
        review({
          id: 'h', author: 'katherinejensen00', submittedAt: '2026-09-08T00:00:00Z',
          bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on katherinejensen00).',
        }),
        review({
          id: 'bot', author: 'devin-ai-integration', submittedAt: '2026-09-09T00:00:00Z',
          bodyText: 'Automated note.',
        }),
      ],
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
