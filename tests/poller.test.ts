import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '../src/store/db.js';
import type { Config, PrInput } from '../src/types.js';

const { mockFetchOpenPrs } = vi.hoisted(() => ({ mockFetchOpenPrs: vi.fn() }));
const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }));

vi.mock('../src/github/client.js', () => ({
  fetchOpenPrs: mockFetchOpenPrs,
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

describe('createPoller', () => {
  it('does not let a slow refresh that started first overwrite a faster later refresh', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    const slow = deferred<PrInput[]>();
    const fast = deferred<PrInput[]>();
    mockFetchOpenPrs.mockImplementationOnce(() => slow.promise);
    mockFetchOpenPrs.mockImplementationOnce(() => fast.promise);

    const poller = createPoller(cfg, openStore(':memory:'));
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

    const poller = createPoller(cfg, openStore(':memory:'));
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

    const poller = createPoller(cfg, openStore(':memory:'));
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
  const store = () => openStore(':memory:');

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

  // Monday it notifies, you reply, Friday the reviewer comes back. Before the
  // observed key was recorded every poll, Friday was silent forever.
  it('notifies again when a PR returns to your court after a round trip', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));

    const poller = createPoller(cfg, store());

    mockFetchOpenPrs.mockResolvedValue([inMyCourt]);
    await poller.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-11T13:00:00Z'));
    mockFetchOpenPrs.mockResolvedValue([inTheirCourt]);
    await poller.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
    mockFetchOpenPrs.mockResolvedValue([inMyCourt]);
    await poller.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  it('stays quiet while a PR sits in the same bucket poll after poll', async () => {
    mockFetchOpenPrs.mockReset();
    mockNotify.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));

    const poller = createPoller(cfg, store());
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
    s.setDiscordPostedAt(1, '2026-09-09T12:00:00Z');
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
    const s = openStore(':memory:');
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
