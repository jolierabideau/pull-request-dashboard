import { execFileSync } from 'node:child_process';
import type { BranchInput } from '../types.js';

const FORMAT = '%(refname:short)\t%(upstream:track)\t%(upstream)';

export function parseBranchLines(
  lines: string[],
  prBranchNames: Set<string>,
): BranchInput[] {
  return lines
    .map((line) => line.split('\t'))
    .filter((parts) => (parts[0] ?? '') !== '' && parts[0] !== 'main')
    .map(([name = '', track = '', upstream = '']) => ({
      name,
      upstreamGone: track.includes('[gone]'),
      aheadOfMain: 0,
      prNumber: prBranchNames.has(name) ? 1 : null,
      _hasUpstream: upstream !== '',
    }))
    .map(({ _hasUpstream, ...branch }) => branch);
}

export function readBranches(
  repoPath: string,
  prBranchNames: Set<string>,
): BranchInput[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'for-each-ref', '--format', FORMAT, 'refs/heads'],
      { encoding: 'utf8' },
    );
    return parseBranchLines(out.split('\n'), prBranchNames);
  } catch {
    // Repo path missing or not a git repo: PR buckets still work.
    return [];
  }
}
