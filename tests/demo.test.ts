import { describe, expect, it } from 'vitest';
import { buildDemoBoard, DEMO_CONFIG, DEMO_NOW } from '../src/server/demo.js';
import { openStore } from '../src/store/db.js';

describe('demo board', () => {
  it('classifies every captured fixture', () => {
    expect(buildDemoBoard().items).toHaveLength(9);
  });

  // The screenshot in the README is only useful if the board it shows has
  // something in more than one bucket.
  it('spreads those fixtures across several buckets', () => {
    const buckets = new Set(buildDemoBoard().items.map((i) => i.bucket));
    expect(buckets.size).toBeGreaterThan(2);
  });

  it('is pinned to a fixed clock so the screenshot is reproducible', () => {
    expect(buildDemoBoard().fetchedAt).toBe('2026-09-11T12:00:00.000Z');
    expect(DEMO_NOW.toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  // What the "Posted to Discord" button does, via the store the demo server
  // holds open: the PR has to actually leave "not asked" for the button to be
  // worth advertising in the README.
  it('moves a PR out of not-asked when it is marked posted to Discord', () => {
    const store = openStore(':memory:');
    try {
      const before = buildDemoBoard(store).items.filter((i) => i.bucket === 'not-asked');
      expect(before.length).toBeGreaterThan(0);

      store.setDiscordPostedAt(before[0]!.number, DEMO_NOW.toISOString());

      const after = buildDemoBoard(store).items.find((i) => i.number === before[0]!.number);
      expect(after?.bucket).toBe('asked-no-looks');
    } finally {
      store.close();
    }
  });

  it('presents as a healthy board rather than a stale one', () => {
    const board = buildDemoBoard();
    expect(board.stale).toBe(false);
    expect(board.error).toBeNull();
  });

  it('shows local branches so that section is not empty', () => {
    expect(buildDemoBoard().branches.length).toBeGreaterThan(0);
  });

  // Demo mode must never read the real config, touch gh, or shell into a repo.
  it('tracks the same login the fixtures were captured against', () => {
    expect(DEMO_CONFIG.me).toBe('jolierabideau');
  });
});
