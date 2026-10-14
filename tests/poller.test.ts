import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../src/store/db.js';
import { prKey } from '../src/pr-key.js';
import type { Config, PrInput } from '../src/types.js';

const { mockFetchOpenPrs } = vi.hoisted(() => ({ mockFetchOpenPrs: vi.fn() }));
const { mockFetchReviewingPrs } = vi.hoisted(() => ({
  mockFetchReviewingPrs: vi.fn(async (): Promise<unknown[]> => []),
}));
const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }));

vi.mock('../src/github/client.js', () => ({
  fetchOpenPrs: mockFetchOpenPrs,
  fetchReviewingPrs: mockFetchReviewingPrs,
}));
vi.mock('../src/git/branches.js', () => ({
  readBranches: vi.fn(() => []),
}));
vi.mock('../src/notify/osascript.js', () => ({
  NOTIFY_BUCKETS: new Set(['needs-your-response', 'blocked-mechanically', 'ready-to-merge']),
  notify: mockNotify,
}));

const { buildBoard, createPoller } = await import('../src/server/poller.js');

/** A promise the test controls the resolution timing of. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Every test starts from the same defaults, so no mock behaviour leaks between tests.
beforeEach(() => {
  mockFetchOpenPrs.mockReset();
  mockFetchOpenPrs.mockResolvedValue([]);
  mockFetchReviewingPrs.mockReset();
  mockFetchReviewingPrs.mockResolvedValue([]);
  mockNotify.mockReset();
});

const HOME = 'paranext/paranext-core';
const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');

const pr = (over: Partial<PrInput>): PrInput => ({
  repo: HOME, number: 1, title: 't', url: 'u', author: 'jolierabideau', updatedAt: new Date().toISOString(), isDraft: false, headOid: 'abc',
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
      [], openStore(':memory:', HOME), cfg, NOW,
    );
    expect(board.items[0]?.number).toBe(2);
  });

  it('counts only items in the user court', () => {
    const board = buildBoard(
      [pr({ number: 2, mergeStateStatus: 'DIRTY' }), pr({ number: 1 })],
      [], openStore(':memory:', HOME), cfg, NOW,
    );
    expect(board.yourCourtCount).toBe(1);
  });

  it('applies the stored Discord timestamp', () => {
    const store = openStore(':memory:', HOME);
    store.setDiscordPostedAt(prKey(HOME, 1), '2026-09-11T09:00:00Z');
    const board = buildBoard([pr({ number: 1 })], [], store, cfg, NOW);
    expect(board.items[0]?.bucket).toBe('asked-no-looks');
  });

  it('carries branches through as their own items', () => {
    const board = buildBoard(
      [], [{ name: 'adr-slugs', upstreamGone: true, aheadOfMain: 0, prNumber: null }],
      openStore(':memory:', HOME), cfg, NOW,
    );
    expect(board.branches[0]?.bucket).toBe('dead-branch');
  });

  it('keeps two PRs that share a number in different repos apart', () => {
    const store = openStore(':memory:', HOME);
    store.setDiscordPostedAt(prKey('paranext/paratext-10-studio', 205), '2026-09-11T09:00:00Z');
    const board = buildBoard(
      [
        pr({ repo: HOME, number: 205 }),
        pr({ repo: 'paranext/paratext-10-studio', number: 205 }),
      ],
      [], store, cfg, NOW,
    );
    expect(board.items).toHaveLength(2);
    const core = board.items.find((i) => i.repo === HOME);
    const studio = board.items.find((i) => i.repo === 'paranext/paratext-10-studio');
    expect(core?.discordPostedAt).toBeNull();
    expect(core?.bucket).toBe('not-asked');
    expect(studio?.discordPostedAt).toBe('2026-09-11T09:00:00Z');
    expect(studio?.bucket).toBe('asked-no-looks');
  });

  it('stamps the board with when it was built', () => {
    const board = buildBoard([], [], openStore(':memory:', HOME), cfg, NOW);
    expect(board.fetchedAt).toBe(NOW.toISOString());
  });
});

describe('createPoller', () => {
  it('does not let a slow refresh that started first overwrite a faster later refresh', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    const slow = deferred<PrInput[]>();
    const fast = deferred<PrInput[]>();
    mockFetchOpenPrs.mockImplementationOnce(() => slow.promise);
    mockFetchOpenPrs.mockImplementationOnce(() => fast.promise);

    const poller = createPoller(cfg, openStore(':memory:', HOME));
    const firstRefresh = poller.refresh();
    const secondRefresh = poller.refresh();

    // The second (newer) refresh's fetch resolves first, and lands.
    fast.resolve([pr({ number: 2 })]);
    await secondRefresh;
    expect(poller.snapshot()?.items[0]?.number).toBe(2);

    // The first (older, slower) refresh's fetch resolves after — it must
    // not roll the snapshot back to its own, now-stale result.
    slow.resolve([pr({ number: 1 })]);
    await firstRefresh;
    expect(poller.snapshot()?.items[0]?.number).toBe(2);
  });

  it('does not let in-flight work land after stop()', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    const inFlight = deferred<PrInput[]>();
    mockFetchOpenPrs.mockImplementationOnce(() => inFlight.promise);

    const poller = createPoller(cfg, openStore(':memory:', HOME));
    const refreshing = poller.refresh();
    poller.stop();
    inFlight.resolve([pr({ number: 1 })]);
    await refreshing;

    expect(poller.snapshot()).toBeNull();
  });

  it('does not send notifications for a superseded refresh', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    const slow = deferred<PrInput[]>();
    const fast = deferred<PrInput[]>();
    mockFetchOpenPrs.mockImplementationOnce(() => slow.promise);
    mockFetchOpenPrs.mockImplementationOnce(() => fast.promise);

    const poller = createPoller(cfg, openStore(':memory:', HOME));
    const firstRefresh = poller.refresh();
    const secondRefresh = poller.refresh();

    // The fast refresh has nothing notify-worthy.
    fast.resolve([]);
    await secondRefresh;

    // The slow refresh's PR would normally trigger a notification
    // (blocked-mechanically is in NOTIFY_BUCKETS), but it is superseded.
    slow.resolve([pr({ number: 1, mergeStateStatus: 'DIRTY' })]);
    await firstRefresh;

    expect(mockNotify).not.toHaveBeenCalled();
  });
});


describe('notifications', () => {
  const store = () => openStore(':memory:', HOME);

  /** katherinejensen00's footer hands the ball to the user. */
  const inMyCourt = pr({
    number: 1,
    reviews: [{
      id: 'k1', author: 'katherinejensen00', state: 'COMMENTED',
      submittedAt: '2026-09-09T00:00:00Z', lastEditedAt: null,
      bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
    }],
  });

  /** The user replies through Reviewable and hands it back. */
  const inTheirCourt = pr({
    number: 1,
    reviews: [{
      id: 'k1', author: 'katherinejensen00', state: 'COMMENTED',
      submittedAt: '2026-09-09T00:00:00Z', lastEditedAt: null,
      bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on jolierabideau).',
    }, {
      id: 'm1', author: 'jolierabideau', state: 'COMMENTED',
      submittedAt: '2026-09-10T00:00:00Z', lastEditedAt: null,
      bodyText: 'Reviewable status: all files reviewed, 1 unresolved discussion (waiting on katherinejensen00).',
    }],
  });

  afterEach(() => { vi.useRealTimers(); });

  // A PR is recorded, not announced, the first time it is seen, so a board
  // that starts with PRs already in your court is quiet. Monday it notifies on
  // arrival, you reply, Friday the reviewer comes back.
  it('notifies when a PR arrives in your court, and again after a round trip', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));

    const poller = createPoller(cfg, store());

    mockFetchOpenPrs.mockResolvedValue([inTheirCourt]);
    await poller.refresh();
    expect(mockNotify).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-11T13:00:00Z'));
    mockFetchOpenPrs.mockResolvedValue([inMyCourt]);
    await poller.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-11T14:00:00Z'));
    mockFetchOpenPrs.mockResolvedValue([inTheirCourt]);
    await poller.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    mockFetchOpenPrs.mockResolvedValue([inMyCourt]);
    await poller.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  it('does not notify for a PR already in your court when first seen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));

    const poller = createPoller(cfg, store());
    mockFetchOpenPrs.mockResolvedValue([inMyCourt]);
    await poller.refresh();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    await poller.refresh();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('stays quiet while a PR sits in the same bucket poll after poll', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));

    const poller = createPoller(cfg, store());
    mockFetchOpenPrs.mockResolvedValue([inTheirCourt]);
    await poller.refresh();
    vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
    mockFetchOpenPrs.mockResolvedValue([inMyCourt]);
    await poller.refresh();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    await poller.refresh();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  // Trigger 2 from the spec: the Discord clock crossing its threshold. The
  // bucket never changes, so only the notify key can carry this.
  it('nudges when the Discord clock crosses the staleness threshold', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    vi.useFakeTimers();

    const s = store();
    s.setDiscordPostedAt(prKey(HOME, 1), '2026-09-09T12:00:00Z');
    const poller = createPoller(cfg, s);
    mockFetchOpenPrs.mockResolvedValue([pr({ number: 1 })]);

    // 24h in: asked, nobody has looked, but not yet stale (threshold 48h).
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await poller.refresh();
    expect(poller.snapshot()?.items[0]?.bucket).toBe('asked-no-looks');
    expect(mockNotify).not.toHaveBeenCalled();

    // 49h in: same bucket, but the clock has crossed.
    vi.setSystemTime(new Date('2026-09-11T13:00:00Z'));
    await poller.refresh();
    expect(poller.snapshot()?.items[0]?.bucket).toBe('asked-no-looks');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(String(mockNotify.mock.calls[0]?.[1])).toContain('asked-no-looks-stale');
  });
});

describe("Claude's verdict", () => {
  /** A COMMENTED review with no footer — the common escalation trigger. */
  const commented = {
    id: 'r1', author: 'katherinejensen00', state: 'COMMENTED' as const,
    submittedAt: '2026-09-09T00:00:00Z', bodyText: 'Some thoughts.', lastEditedAt: null,
  };

  const verdict = (court: 'me' | 'reviewer') => ({
    court, blockingCount: court === 'me' ? 2 : 0,
    asks: court === 'me' ? ['rename the hook'] : [],
    confidence: 'high' as const,
  });

  /** Priming the cache keeps resolveEscalation entirely offline. */
  const storeWithVerdict = (court: 'me' | 'reviewer') => {
    const s = openStore(':memory:', HOME);
    s.putVerdict('r1', null, verdict(court));
    return s;
  };

  it('moves a waiting-on-reviewer PR into your court when Claude says so', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    // The user pushed after the review, so the rules say waiting-on-reviewer.
    mockFetchOpenPrs.mockResolvedValue([
      pr({
        number: 1, reviews: [commented],
        commits: [{
          oid: 'z', committedDate: '2026-09-10T00:00:00Z',
          authorLogin: 'jolierabideau', authorEmail: null,
          messageHeadline: 'PT-1: address review', parentCount: 1,
        }],
      }),
      pr({ number: 2 }),
    ]);

    const poller = createPoller(cfg, storeWithVerdict('me'));
    await poller.refresh();

    const board = poller.snapshot();
    const moved = board?.items.find((i) => i.number === 1);
    expect(moved?.bucket).toBe('needs-your-response');
    expect(moved?.receipts.join(' ')).toContain('waiting-on-reviewer to needs-your-response');
    expect(board?.yourCourtCount).toBe(1);
    // The board is re-sorted after the move: #2 is merely not-asked.
    expect(board?.items[0]?.number).toBe(1);
  });

  it('moves a needs-your-response PR out of your court when Claude says so', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    // The reviewer acted last, so the rules say needs-your-response.
    mockFetchOpenPrs.mockResolvedValue([pr({ number: 1, reviews: [commented] })]);

    const poller = createPoller(cfg, storeWithVerdict('reviewer'));
    await poller.refresh();

    const board = poller.snapshot();
    expect(board?.items[0]?.bucket).toBe('waiting-on-reviewer');
    expect(board?.items[0]?.receipts.join(' '))
      .toContain('needs-your-response to waiting-on-reviewer');
    expect(board?.yourCourtCount).toBe(0);
  });

  it('attaches the verdict from the right repo when PR numbers collide', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    // Same number in both repos: only the PR in HOME has the commented
    // review, so only it may be escalated and resolved.
    mockFetchOpenPrs.mockResolvedValue([
      pr({ repo: 'paranext/paratext-10-studio', number: 7 }),
      pr({ repo: HOME, number: 7, reviews: [commented] }),
    ]);

    const poller = createPoller(cfg, storeWithVerdict('me'));
    await poller.refresh();

    const items = poller.snapshot()?.items ?? [];
    const core = items.find((i) => i.repo === HOME);
    const studio = items.find((i) => i.repo === 'paranext/paratext-10-studio');
    expect(core?.verdict?.court).toBe('me');
    expect(studio?.verdict).toBeNull();
  });

  it('titles notifications with the repo name', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    const studioPr = (mergeStateStatus: string) =>
      pr({ repo: 'paranext/paratext-10-studio', number: 202, mergeStateStatus });
    const poller = createPoller(cfg, openStore(':memory:', HOME));
    mockFetchOpenPrs.mockResolvedValueOnce([studioPr('CLEAN')]);
    await poller.refresh();
    mockFetchOpenPrs.mockResolvedValueOnce([studioPr('DIRTY')]);
    await poller.refresh();
    expect(mockNotify.mock.calls[0]?.[0]).toBe('paratext-10-studio #202');
  });

  it('leaves the bucket alone when the verdict agrees with the rules', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    mockFetchOpenPrs.mockResolvedValue([pr({ number: 1, reviews: [commented] })]);

    const poller = createPoller(cfg, storeWithVerdict('me'));
    await poller.refresh();

    const item = poller.snapshot()?.items[0];
    expect(item?.bucket).toBe('needs-your-response');
    expect(item?.receipts.join(' ')).not.toContain('moved this');
  });
});

describe('reviewing PRs', () => {
  const ALICE = 'alice';
  const theirPr = (over: Partial<PrInput>): PrInput => pr({
    author: ALICE,
    commits: [{
      oid: 'a1', committedDate: '2026-09-01T00:00:00Z',
      authorLogin: ALICE, authorEmail: null, messageHeadline: 'PT-9: work', parentCount: 1,
    }],
    ...over,
  });
  const myReview = {
    id: 'm1', author: 'jolierabideau', state: 'COMMENTED' as const,
    submittedAt: '2026-09-05T00:00:00Z', bodyText: '', lastEditedAt: null,
  };
  const needsYou = theirPr({ number: 10 });
  const waiting = theirPr({ number: 11, reviews: [myReview] });
  const approved = theirPr({
    number: 12, reviews: [{ ...myReview, id: 'm2', state: 'APPROVED' }],
  });
  const store = () => openStore(':memory:', HOME);

  it('sorts reviewing items needs-you, waiting-on-author, approved', () => {
    const board = buildBoard([], [], store(), cfg, NOW, [approved, waiting, needsYou]);
    expect(board.reviewing.map((i) => i.bucket)).toEqual([
      'review-needs-you', 'review-waiting-on-author', 'review-approved',
    ]);
    expect(board.reviewing.every((i) => i.role === 'reviewer' && i.author === ALICE)).toBe(true);
    expect(board.reviewing.every((i) => i.discordPostedAt === null)).toBe(true);
  });

  it('counts the two courts separately and sums them for the headline', () => {
    const board = buildBoard(
      [pr({ number: 1, mergeStateStatus: 'DIRTY' }), pr({ number: 2 })],
      [], store(), cfg, NOW, [needsYou, theirPr({ number: 13 }), waiting, approved],
    );
    expect(board.myCourtCount).toBe(1);
    expect(board.reviewCourtCount).toBe(2);
    expect(board.yourCourtCount).toBe(3);
    expect(board.items.every((i) => i.role === 'author')).toBe(true);
  });

  it('keeps a PR that appears in both lists on the author side only', () => {
    const board = buildBoard(
      [pr({ number: 10 })], [], store(), cfg, NOW, [theirPr({ number: 10 })],
    );
    expect(board.items.map((i) => i.number)).toEqual([10]);
    expect(board.reviewing).toEqual([]);
  });

  it('keeps the same number in a different repo on the reviewing side', () => {
    const board = buildBoard(
      [pr({ number: 10 })], [], store(), cfg, NOW,
      [theirPr({ number: 10, repo: 'paranext/paratext-10-studio' })],
    );
    expect(board.reviewing).toHaveLength(1);
  });

  it('sorts quiet PRs last and does not count them in any court', () => {
    const quiet = theirPr({ number: 14, updatedAt: '2026-06-01T00:00:00Z', reviews: [myReview] });
    const board = buildBoard([], [], store(), cfg, NOW, [quiet, approved, needsYou]);
    expect(board.reviewing.map((i) => i.bucket)).toEqual([
      'review-needs-you', 'review-approved', 'review-quiet',
    ]);
    expect(board.reviewCourtCount).toBe(1);
    expect(board.yourCourtCount).toBe(1);
  });

  it('does not notify for a quiet PR', async () => {
    mockFetchReviewingPrs.mockResolvedValue([
      theirPr({ number: 14, updatedAt: '2020-01-01T00:00:00Z' }),
    ]);
    await createPoller(cfg, store()).refresh();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('notifies once for a review that arrives waiting on you, titled with the repo name', async () => {
    const studio = 'paranext/paratext-10-studio';
    const poller = createPoller(cfg, store());

    // First seen with the user's review newest: the ball is with the author.
    mockFetchReviewingPrs.mockResolvedValue([
      theirPr({ number: 10, repo: studio, title: 'Add thing', reviews: [myReview] }), waiting,
    ]);
    await poller.refresh();
    expect(mockNotify).not.toHaveBeenCalled();

    // The author then acts, which hands the review back to the user.
    mockFetchReviewingPrs.mockResolvedValue([
      theirPr({ number: 10, repo: studio, title: 'Add thing' }), waiting,
    ]);
    await poller.refresh();
    await poller.refresh();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]?.[0]).toBe('paratext-10-studio #10');
    expect(mockNotify.mock.calls[0]?.[1]).toBe('review needed: Add thing');
    expect(poller.snapshot()?.reviewCourtCount).toBe(1);
    expect(poller.snapshot()?.yourCourtCount).toBe(1);
  });

  it('keeps own PRs fresh and the previous Others\' PRs when only the reviewing fetch fails', async () => {
    mockFetchReviewingPrs.mockResolvedValueOnce([needsYou]);
    const poller = createPoller(cfg, store());
    await poller.refresh();

    mockFetchOpenPrs.mockResolvedValue([pr({ number: 1, mergeStateStatus: 'DIRTY' })]);
    mockFetchReviewingPrs.mockRejectedValueOnce(new Error('boom'));
    await poller.refresh();

    const board = poller.snapshot();
    expect(board?.stale).toBe(false);
    expect(board?.error).toBe("Others' PRs not refreshed — boom");
    expect(board?.items.map((i) => i.number)).toEqual([1]);
    expect(board?.reviewing.map((i) => i.number)).toEqual([10]);
    expect(board?.myCourtCount).toBe(1);
    expect(board?.reviewCourtCount).toBe(1);
    expect(board?.yourCourtCount).toBe(2);
  });

  it('shows an empty Others\' PRs list with a warning when it fails on the first poll', async () => {
    mockFetchOpenPrs.mockResolvedValue([pr({ number: 1 })]);
    mockFetchReviewingPrs.mockRejectedValueOnce(new Error('boom'));
    const poller = createPoller(cfg, store());
    await poller.refresh();

    const board = poller.snapshot();
    expect(board?.stale).toBe(false);
    expect(board?.error).toContain('boom');
    expect(board?.reviewing).toEqual([]);
    expect(board?.items).toHaveLength(1);
  });

  it('goes stale and keeps the last good board when the own PRs fetch fails', async () => {
    mockFetchReviewingPrs.mockResolvedValueOnce([needsYou]);
    const poller = createPoller(cfg, store());
    await poller.refresh();
    mockFetchOpenPrs.mockRejectedValueOnce(new Error('boom'));
    await poller.refresh();

    const board = poller.snapshot();
    expect(board?.stale).toBe(true);
    expect(board?.error).toBe('boom');
    expect(board?.reviewing).toHaveLength(1);
  });

  it('puts a clean refresh after a reviewing failure back to no error', async () => {
    const poller = createPoller(cfg, store());
    mockFetchReviewingPrs.mockRejectedValueOnce(new Error('boom'));
    await poller.refresh();
    await poller.refresh();
    expect(poller.snapshot()?.error).toBeNull();
  });
});

describe('notification event log', () => {
  const blocked = (number: number) => pr({ number, mergeStateStatus: 'DIRTY' });
  const fresh = () => createPoller(cfg, openStore(':memory:', HOME));
  /** Lets the poller see the PRs in a calm state, so a later change is a transition. */
  const observeCalm = async (poller: ReturnType<typeof fresh>, numbers: number[]) => {
    mockFetchOpenPrs.mockResolvedValueOnce(numbers.map((number) => pr({ number })));
    await poller.refresh();
  };

  it('records an event with title, body and url when a notification fires', async () => {
    const poller = fresh();
    await observeCalm(poller, [3]);
    mockFetchOpenPrs.mockResolvedValue([{ ...blocked(3), url: 'https://example.test/3', title: 'Fix' }]);
    await poller.refresh();

    const board = poller.snapshot();
    expect(board?.epoch).toBeTruthy();
    expect(board?.notifications).toHaveLength(1);
    expect(board?.notifications[0]).toMatchObject({
      id: 1, title: 'paranext-core #3', body: 'blocked-mechanically: Fix', url: 'https://example.test/3',
    });
    expect(Number.isNaN(Date.parse(board?.notifications[0]?.at ?? ''))).toBe(false);
  });

  it('records nothing when no notification is decided', async () => {
    const poller = fresh();
    mockFetchOpenPrs.mockResolvedValue([pr({ number: 1 })]);
    await poller.refresh();
    await poller.refresh();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(poller.snapshot()?.notifications).toEqual([]);
  });

  it('does not record the same state twice', async () => {
    const poller = fresh();
    await observeCalm(poller, [3]);
    mockFetchOpenPrs.mockResolvedValue([blocked(3)]);
    await poller.refresh();
    await poller.refresh();
    expect(poller.snapshot()?.notifications).toHaveLength(1);
  });

  it('numbers events upward and keeps only the last 50', async () => {
    const poller = fresh();
    await observeCalm(poller, Array.from({ length: 60 }, (_, i) => i + 1));
    mockFetchOpenPrs.mockResolvedValue(Array.from({ length: 60 }, (_, i) => blocked(i + 1)));
    await poller.refresh();

    const events = poller.snapshot()?.notifications ?? [];
    expect(events).toHaveLength(50);
    expect(events.map((e) => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 11));
  });

  it('keeps the log on a stale board after a failed poll', async () => {
    const poller = fresh();
    await observeCalm(poller, [3]);
    mockFetchOpenPrs.mockResolvedValueOnce([blocked(3)]);
    await poller.refresh();
    mockFetchOpenPrs.mockRejectedValueOnce(new Error('boom'));
    await poller.refresh();
    expect(poller.snapshot()?.stale).toBe(true);
    expect(poller.snapshot()?.notifications).toHaveLength(1);
  });
});
