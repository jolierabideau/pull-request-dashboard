import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classify } from '../src/rules/classify.js';
import { lastReviewerActivity } from '../src/rules/activity.js';
import type { Bucket, Config, PrInput } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');
const load = (n: number): PrInput =>
  JSON.parse(readFileSync(`tests/fixtures/pr-${n}.json`, 'utf8')) as PrInput;

const run = (n: number) =>
  classify(load(n), { discordPostedAt: null }, cfg, NOW);

describe('classify against captured PRs', () => {
  const cases: [number, Bucket, string][] = [
    [2717, 'ready-to-merge', 'newest approval footer is complete!'],
    [2720, 'ready-to-merge', "approved with Reviewable's own summary thread"],
    [2664, 'ready-to-merge', 'approved; head commit is a bare merge of main'],
    [2796, 'draft', 'draft and conflicting stays quiet'],
  ];

  it.each(cases)('pr-%i → %s (%s)', (n, bucket) => {
    expect(run(n).bucket).toBe(bucket);
  });

  it('pr-2795 is not blocked by its cancelled-only checks', () => {
    expect(run(2795).bucket).not.toBe('blocked-mechanically');
  });

  it('pr-2180 sees its native inline threads as reviewer activity', () => {
    expect(lastReviewerActivity(load(2180), cfg)).not.toBeNull();
  });

  it('every classification explains itself', () => {
    for (const n of [2717, 2720, 2664, 2742, 2795, 2796, 2687, 2635, 2180]) {
      expect(run(n).receipts.length).toBeGreaterThan(0);
    }
  });
});
