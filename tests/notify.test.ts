import { describe, expect, it } from 'vitest';
import { NOTIFY_KEYS, notifyKey } from '../src/rules/notify.js';
import type { Config } from '../src/types.js';

const cfg: Config = {
  repoPath: '/tmp', owner: 'paranext', name: 'paranext-core',
  me: 'jolierabideau', botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180000, staleAfterHours: 48,
};
const NOW = new Date('2026-09-11T12:00:00Z');

describe('notifyKey', () => {
  it('is just the bucket for an ordinary item', () => {
    expect(notifyKey({ bucket: 'needs-your-response', discordPostedAt: null }, cfg, NOW))
      .toBe('needs-your-response');
  });

  it('is the plain bucket while the Discord clock is inside the threshold', () => {
    expect(notifyKey(
      { bucket: 'asked-no-looks', discordPostedAt: '2026-09-11T09:00:00Z' }, cfg, NOW,
    )).toBe('asked-no-looks');
  });

  // Crossing the threshold changes no bucket, so it needs its own key.
  it('becomes asked-no-looks-stale once the clock passes the threshold', () => {
    expect(notifyKey(
      { bucket: 'asked-no-looks', discordPostedAt: '2026-09-08T09:00:00Z' }, cfg, NOW,
    )).toBe('asked-no-looks-stale');
  });

  it('never goes stale for a bucket that is not asked-no-looks', () => {
    expect(notifyKey(
      { bucket: 'waiting-on-reviewer', discordPostedAt: '2026-09-01T09:00:00Z' }, cfg, NOW,
    )).toBe('waiting-on-reviewer');
  });

  it('treats the stale key as notify-worthy alongside the three court buckets', () => {
    expect([...NOTIFY_KEYS].sort()).toEqual([
      'asked-no-looks-stale', 'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
    ]);
  });
});
