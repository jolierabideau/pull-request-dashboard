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
