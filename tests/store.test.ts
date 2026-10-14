import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openStore } from '../src/store/db.js';
import { prKey } from '../src/pr-key.js';

const HOME = 'paranext/paranext-core';
const K = prKey(HOME, 2795);
const store = () => openStore(':memory:', HOME);

describe('discord timestamps', () => {
  it('returns null before anything is stamped', () => {
    expect(store().getDiscordPostedAt(K)).toBeNull();
  });

  it('round-trips a stamp', () => {
    const s = store();
    s.setDiscordPostedAt(K, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(K)).toBe('2026-09-11T09:00:00Z');
  });

  it('overwrites rather than duplicating', () => {
    const s = store();
    s.setDiscordPostedAt(K, '2026-09-10T09:00:00Z');
    s.setDiscordPostedAt(K, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(K)).toBe('2026-09-11T09:00:00Z');
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
    expect(store().shouldNotify(K, 'needs-your-response', NOW)).toBe(true);
  });

  it('suppresses a repeat of the same bucket', () => {
    const s = store();
    s.recordNotified(K, 'needs-your-response', NOW);
    expect(s.shouldNotify(K, 'needs-your-response', NOW)).toBe(false);
  });

  it('survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-store-'));
    const path = join(dir, 'test.db');

    const first = openStore(path, HOME);
    first.recordNotified(K, 'needs-your-response', NOW);
    first.close();

    // A genuinely separate handle on the same file — this is the restart.
    const second = openStore(path, HOME);
    try {
      expect(second.shouldNotify(K, 'needs-your-response', NOW)).toBe(false);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The user posts several comments per round, minutes apart.
  it('debounces a different bucket within 15 minutes', () => {
    const s = store();
    s.recordNotified(K, 'needs-your-response', NOW);
    const soon = new Date('2026-09-11T12:10:00Z');
    expect(s.shouldNotify(K, 'blocked-mechanically', soon)).toBe(false);
  });

  it('allows a new bucket after the debounce window', () => {
    const s = store();
    s.recordNotified(K, 'needs-your-response', NOW);
    const later = new Date('2026-09-11T12:20:00Z');
    expect(s.shouldNotify(K, 'blocked-mechanically', later)).toBe(true);
  });

  it('never notifies for a key that is not notify-worthy', () => {
    expect(store().shouldNotify(K, 'waiting-on-reviewer', NOW)).toBe(false);
  });

  // The round trip the product exists to catch: you notify, you reply, the
  // reviewer comes back days later. The observed key must be recorded on
  // every poll or the second arrival is silent forever.
  it('notifies again after the PR leaves and re-enters a notify-worthy key', () => {
    const s = store();
    s.recordNotified(K, 'needs-your-response', NOW);
    s.recordObserved(K, 'waiting-on-reviewer');

    const friday = new Date('2026-09-15T12:00:00Z');
    expect(s.shouldNotify(K, 'needs-your-response', friday)).toBe(true);
  });

  it('stays quiet while the PR sits in the same key across polls', () => {
    const s = store();
    s.recordNotified(K, 'needs-your-response', NOW);
    s.recordObserved(K, 'needs-your-response');

    const friday = new Date('2026-09-15T12:00:00Z');
    expect(s.shouldNotify(K, 'needs-your-response', friday)).toBe(false);
  });

  // Trigger 2: the Discord clock crossing its threshold, which changes the
  // key without changing the bucket.
  it('notifies when a watched PR crosses the staleness threshold', () => {
    const s = store();
    s.recordObserved(K, 'asked-no-looks');
    expect(s.shouldNotify(K, 'asked-no-looks-stale', NOW)).toBe(true);
  });

  it('only notifies once for the same staleness crossing', () => {
    const s = store();
    s.recordNotified(K, 'asked-no-looks-stale', NOW);
    const later = new Date('2026-09-11T13:00:00Z');
    expect(s.shouldNotify(K, 'asked-no-looks-stale', later)).toBe(false);
  });
});

describe('PR identity is repo plus number', () => {
  const NOW = new Date('2026-09-11T12:00:00Z');
  const core = prKey('paranext/paranext-core', 205);
  const studio = prKey('paranext/paratext-10-studio', 205);

  it('keeps Discord stamps independent for the same number in two repos', () => {
    const s = store();
    s.setDiscordPostedAt(core, '2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(core)).toBe('2026-09-11T09:00:00Z');
    expect(s.getDiscordPostedAt(studio)).toBeNull();
  });

  it('keeps notify state independent for the same number in two repos', () => {
    const s = store();
    s.recordNotified(core, 'needs-your-response', NOW);
    expect(s.shouldNotify(core, 'needs-your-response', NOW)).toBe(false);
    expect(s.shouldNotify(studio, 'needs-your-response', NOW)).toBe(true);
  });
});

describe('legacy table migration', () => {
  const LATER = new Date('2026-09-12T12:00:00Z');

  const withLegacyDb = (fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-migrate-'));
    const path = join(dir, 'legacy.db');
    try {
      const old = new Database(path);
      old.exec(`
        CREATE TABLE discord (pr INTEGER PRIMARY KEY, posted_at TEXT);
        CREATE TABLE notify_state (
          pr INTEGER PRIMARY KEY, last_key TEXT NOT NULL, last_notified_at TEXT
        );
        INSERT INTO discord VALUES (2795, '2026-09-11T09:00:00Z');
        INSERT INTO notify_state VALUES (2795, 'needs-your-response', '2026-09-11T12:00:00.000Z');
        INSERT INTO notify_state VALUES (2796, 'waiting-on-reviewer', NULL);
      `);
      old.close();
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const tables = (path: string): string[] => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as
        { name: string }[]).map((r) => r.name);
    } finally {
      db.close();
    }
  };

  it('carries old rows over under the home repo key and drops the old tables', () => {
    withLegacyDb((path) => {
      const s = openStore(path, HOME);
      try {
        expect(s.getDiscordPostedAt(prKey(HOME, 2795))).toBe('2026-09-11T09:00:00Z');
        expect(s.shouldNotify(prKey(HOME, 2795), 'needs-your-response', LATER)).toBe(false);
        // 2796 was last observed waiting on a reviewer, so arriving in your court notifies.
        expect(s.shouldNotify(prKey(HOME, 2796), 'needs-your-response', LATER)).toBe(true);
        expect(s.getDiscordPostedAt(prKey('paranext/paratext-10-studio', 2795))).toBeNull();
      } finally {
        s.close();
      }
      expect(tables(path)).not.toContain('discord');
      expect(tables(path)).not.toContain('notify_state');
    });
  });

  it('is a no-op when the store is opened again', () => {
    withLegacyDb((path) => {
      openStore(path, HOME).close();
      // A different home repo on re-open must not re-key what was already migrated.
      const again = openStore(path, 'other/repo');
      try {
        expect(again.getDiscordPostedAt(prKey(HOME, 2795))).toBe('2026-09-11T09:00:00Z');
        expect(again.getDiscordPostedAt(prKey('other/repo', 2795))).toBeNull();
      } finally {
        again.close();
      }
    });
  });
});
