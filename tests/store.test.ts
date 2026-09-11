import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';

const store = () => openStore(':memory:');

describe('discord timestamps', () => {
  it('returns null before anything is stamped', () => {
    expect(store().getDiscordPostedAt(2795)).toBeNull();
  });

  it('round-trips a stamp', () => {
    const s = store();
    s.setDiscordPostedAt(2795, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(2795)).toBe('2026-09-11T09:00:00Z');
  });

  it('overwrites rather than duplicating', () => {
    const s = store();
    s.setDiscordPostedAt(2795, '2026-09-10T09:00:00Z');
    s.setDiscordPostedAt(2795, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(2795)).toBe('2026-09-11T09:00:00Z');
  });
});

describe('verdict cache', () => {
  const verdict = {
    court: 'me' as const, blockingCount: 1,
    asks: ['fix the readDirection blocker'], confidence: 'high' as const,
  };

  it('round-trips a verdict keyed on review id and edit time', () => {
    const s = store();
    s.putVerdict('R_123', null, verdict);
    expect(s.getVerdict('R_123', null)).toEqual(verdict);
  });

  // Review bodies are editable, so the node id alone is not a safe key.
  it('misses when the review has since been edited', () => {
    const s = store();
    s.putVerdict('R_123', null, verdict);
    expect(s.getVerdict('R_123', '2026-09-11T10:00:00Z')).toBeNull();
  });
});

describe('notification dedupe', () => {
  const NOW = new Date('2026-09-11T12:00:00Z');

  it('allows the first notification for a bucket', () => {
    expect(store().shouldNotify(2795, 'needs-your-response', NOW)).toBe(true);
  });

  it('suppresses a repeat of the same bucket', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    expect(s.shouldNotify(2795, 'needs-your-response', NOW)).toBe(false);
  });

  it('survives a restart', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    expect(s.shouldNotify(2795, 'needs-your-response', NOW)).toBe(false);
  });

  // The user posts several comments per round, minutes apart.
  it('debounces a different bucket within 15 minutes', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    const soon = new Date('2026-09-11T12:10:00Z');
    expect(s.shouldNotify(2795, 'blocked-mechanically', soon)).toBe(false);
  });

  it('allows a new bucket after the debounce window', () => {
    const s = store();
    s.recordNotified(2795, 'needs-your-response', NOW);
    const later = new Date('2026-09-11T12:20:00Z');
    expect(s.shouldNotify(2795, 'blocked-mechanically', later)).toBe(true);
  });
});
