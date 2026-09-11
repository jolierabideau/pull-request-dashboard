import { describe, expect, it, vi } from 'vitest';
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
