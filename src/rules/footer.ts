import type { Footer } from '../types.js';

const FOOTER = new RegExp(
  'Reviewable status:\\s*' +
    '(?<complete>complete!\\s*)?' +
    '(?<files>all files reviewed|\\d+ of \\d+ files reviewed)' +
    ',\\s*' +
    '(?<discussions>all discussions resolved|\\d+ unresolved discussions?)' +
    '(?:\\s*\\(waiting on (?<waiting>[^)]+)\\))?',
  'g',
);

const PARTIAL = /^(\d+) of (\d+) files reviewed$/;
const UNRESOLVED = /^(\d+) unresolved discussions?$/;

/**
 * Parses the Reviewable status line out of a review's GraphQL `bodyText`.
 *
 * The line's position varies wildly — line 1 of 122 on PR #2664, line 198 of
 * 216 on PR #2717 — so it is searched for, never read positionally. Returns
 * null when no recognizable footer exists; callers must treat that as "no
 * signal" rather than as a clean result.
 */
export function parseFooter(bodyText: string): Footer | null {
  const matches = [...bodyText.matchAll(FOOTER)];
  const last = matches.at(-1);
  if (!last?.groups) return null;

  const { complete, files, discussions, waiting } = last.groups;

  const partial = PARTIAL.exec(files ?? '');
  const unresolved = UNRESOLVED.exec(discussions ?? '');

  return {
    files: partial
      ? { reviewed: Number(partial[1]), total: Number(partial[2]) }
      : 'all',
    discussions: unresolved ? { unresolved: Number(unresolved[1]) } : 'resolved',
    waitingOn: waiting ? splitNames(waiting) : [],
    complete: complete !== undefined,
  };
}

/** "alice", "alice and bob", "alice, bob and carol" → login array. */
function splitNames(clause: string): string[] {
  return clause
    .split(/,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
