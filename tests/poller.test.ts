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
