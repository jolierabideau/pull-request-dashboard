import type { CheckContext, PrInput } from '../types.js';

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED']);

/**
 * statusCheckRollup.state is unusable: PR #2795 rolls up to FAILURE with only
 * cancelled runs and successes. Judge per context instead.
 */
export function hasFailingCheck(checks: CheckContext[]): boolean {
  return checks.some((c) => c.conclusion !== null && FAILING.has(c.conclusion));
}

export function checkDot(
  checks: CheckContext[],
): 'fail' | 'pending' | 'pass' | 'none' {
  if (checks.length === 0) return 'none';
  if (hasFailingCheck(checks)) return 'fail';
  if (checks.some((c) => c.status !== 'COMPLETED')) return 'pending';
  return 'pass';
}

/**
 * GitHub computes mergeability lazily, so UNKNOWN is common and must never be
 * read as clean — the poller re-requests those PRs.
 */
export function conflictState(pr: PrInput): 'conflicting' | 'clean' | 'unknown' {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return 'conflicting';
  }
  if (pr.mergeable === 'UNKNOWN') return 'unknown';
  return 'clean';
}
