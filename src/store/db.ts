import Database from 'better-sqlite3';
import { NOTIFY_KEYS, type NotifyKey } from '../rules/notify.js';
import type { ClaudeVerdict } from '../types.js';

const DEBOUNCE_MS = 15 * 60 * 1000;

export interface Store {
  getDiscordPostedAt(pr: number): string | null;
  setDiscordPostedAt(pr: number, at: string | null): void;
  getVerdict(reviewId: string, lastEditedAt: string | null): ClaudeVerdict | null;
  putVerdict(reviewId: string, lastEditedAt: string | null, v: ClaudeVerdict): void;
  /**
   * True only when `key` is notify-worthy, differs from the last key we
   * OBSERVED for this PR, and the debounce since the last notification that
   * actually fired has elapsed.
   */
  shouldNotify(pr: number, key: NotifyKey, now: Date): boolean;
  /** Called for every item on every poll, notification or not. */
  recordObserved(pr: number, key: NotifyKey): void;
  /** Called only when a notification actually fired. */
  recordNotified(pr: number, key: NotifyKey, now: Date): void;
  close(): void;
}

export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord (pr INTEGER PRIMARY KEY, posted_at TEXT);
    CREATE TABLE IF NOT EXISTS verdicts (
      key TEXT PRIMARY KEY, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notify_state (
      pr INTEGER PRIMARY KEY,
      last_key TEXT NOT NULL,
      last_notified_at TEXT
    );
  `);

  const key = (id: string, edited: string | null) => `${id}@${edited ?? 'never'}`;

  return {
    getDiscordPostedAt(pr) {
      const row = db.prepare('SELECT posted_at FROM discord WHERE pr = ?').get(pr) as
        | { posted_at: string | null } | undefined;
      return row?.posted_at ?? null;
    },
    setDiscordPostedAt(pr, at) {
      db.prepare(
        `INSERT INTO discord (pr, posted_at) VALUES (?, ?)
         ON CONFLICT(pr) DO UPDATE SET posted_at = excluded.posted_at`,
      ).run(pr, at);
    },
    getVerdict(reviewId, lastEditedAt) {
      const row = db.prepare('SELECT payload FROM verdicts WHERE key = ?')
        .get(key(reviewId, lastEditedAt)) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as ClaudeVerdict) : null;
    },
    putVerdict(reviewId, lastEditedAt, v) {
      db.prepare(
        `INSERT INTO verdicts (key, payload) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload`,
      ).run(key(reviewId, lastEditedAt), JSON.stringify(v));
    },
    shouldNotify(pr, key, now) {
      if (!NOTIFY_KEYS.has(key)) return false;
      const row = db.prepare(
        'SELECT last_key, last_notified_at FROM notify_state WHERE pr = ?',
      ).get(pr) as { last_key: string; last_notified_at: string | null } | undefined;
      if (row === undefined) return true;
      // The PR has not actually moved since we last looked at it.
      if (row.last_key === key) return false;
      if (row.last_notified_at === null) return true;
      return now.getTime() - Date.parse(row.last_notified_at) >= DEBOUNCE_MS;
    },
    recordObserved(pr, key) {
      db.prepare(
        `INSERT INTO notify_state (pr, last_key, last_notified_at) VALUES (?, ?, NULL)
         ON CONFLICT(pr) DO UPDATE SET last_key = excluded.last_key`,
      ).run(pr, key);
    },
    recordNotified(pr, key, now) {
      db.prepare(
        `INSERT INTO notify_state (pr, last_key, last_notified_at) VALUES (?, ?, ?)
         ON CONFLICT(pr) DO UPDATE SET
           last_key = excluded.last_key,
           last_notified_at = excluded.last_notified_at`,
      ).run(pr, key, now.toISOString());
    },
    close() { db.close(); },
  };
}
