import { describe, expect, it } from 'vitest';
import { buildDemoBoard, DEMO_CONFIG } from '../src/server/demo.js';

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
    expect(buildDemoBoard().fetchedAt).toBe(buildDemoBoard().fetchedAt);
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
