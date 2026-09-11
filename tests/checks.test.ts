import { describe, expect, it } from 'vitest';
import { checkDot, conflictState, hasFailingCheck } from '../src/rules/checks.js';
import type { CheckContext, PrInput } from '../src/types.js';

const ctx = (conclusion: string | null, status = 'COMPLETED'): CheckContext =>
  ({ name: 'Test', status, conclusion });

const pr = (over: Partial<PrInput>): PrInput => ({
  number: 1, title: 't', url: 'u', isDraft: false, headOid: 'abc',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviews: [], comments: [], commits: [], threads: [], checks: [], ...over,
});

describe('hasFailingCheck', () => {
  // PR #2795 rolls up to FAILURE with only CANCELLED + SUCCESS. It must not
  // land in "blocked mechanically".
  it('ignores cancelled runs', () => {
    expect(hasFailingCheck([
      ctx('CANCELLED'), ctx('CANCELLED'), ctx('SUCCESS'), ctx('SUCCESS'),
    ])).toBe(false);
  });

  it('ignores neutral and skipped', () => {
    expect(hasFailingCheck([ctx('NEUTRAL'), ctx('SKIPPED')])).toBe(false);
  });

  it.each(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'treats %s as failing', (conclusion) => {
      expect(hasFailingCheck([ctx('SUCCESS'), ctx(conclusion)])).toBe(true);
    },
  );

  it('does not treat an in-progress run as failing', () => {
    expect(hasFailingCheck([ctx(null, 'IN_PROGRESS')])).toBe(false);
  });

  it('is false when there are no checks at all', () => {
    expect(hasFailingCheck([])).toBe(false);
  });
});

describe('checkDot', () => {
  it('reports none when there are no checks', () => {
    expect(checkDot([])).toBe('none');
  });
  it('reports pending while a run is in progress', () => {
    expect(checkDot([ctx('SUCCESS'), ctx(null, 'IN_PROGRESS')])).toBe('pending');
  });
  it('reports fail over pending', () => {
    expect(checkDot([ctx('FAILURE'), ctx(null, 'IN_PROGRESS')])).toBe('fail');
  });
  it('reports pass when everything succeeded or was cancelled', () => {
    expect(checkDot([ctx('SUCCESS'), ctx('CANCELLED')])).toBe('pass');
  });
});

describe('conflictState', () => {
  it('reads DIRTY as conflicting', () => {
    expect(conflictState(pr({ mergeStateStatus: 'DIRTY' }))).toBe('conflicting');
  });

  // Five of eleven open PRs read UNKNOWN at any moment; never call it clean.
  it('reads UNKNOWN mergeable as unknown', () => {
    expect(conflictState(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })))
      .toBe('unknown');
  });

  it('reads CONFLICTING as conflicting even when mergeState is UNKNOWN', () => {
    expect(conflictState(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' })))
      .toBe('conflicting');
  });

  // PR #2664: approved, MERGEABLE, but BLOCKED by branch protection.
  it('reads BLOCKED as clean, since it is not a conflict', () => {
    expect(conflictState(pr({ mergeStateStatus: 'BLOCKED' }))).toBe('clean');
  });
});
