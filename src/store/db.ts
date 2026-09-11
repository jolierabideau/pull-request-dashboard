import Database from 'better-sqlite3';
import type { Bucket, ClaudeVerdict } from '../types.js';

const DEBOUNCE_MS = 15 * 60 * 1000;

export interface Store {
  getDiscordPostedAt(pr: number): string | null;
  setDiscordPostedAt(pr: number, at: string | null): void;
  getVerdict(reviewId: string, lastEditedAt: string | null): ClaudeVerdict | null;
  putVerdict(reviewId: string, lastEditedAt: string | null, v: ClaudeVerdict): void;
  shouldNotify(pr: number, bucket: Bucket, now: Date): boolean;
  recordNotified(pr: number, bucket: Bucket, now: Date): void;
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
    CREATE TABLE IF NOT EXISTS notified (
      pr INTEGER PRIMARY KEY, bucket TEXT NOT NULL, at TEXT NOT NULL
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
    shouldNotify(pr, bucket, now) {
      const row = db.prepare('SELECT bucket, at FROM notified WHERE pr = ?').get(pr) as
        | { bucket: string; at: string } | undefined;
      if (row === undefined) return true;
      if (row.bucket === bucket) return false;
      return now.getTime() - Date.parse(row.at) >= DEBOUNCE_MS;
    },
    recordNotified(pr, bucket, now) {
      db.prepare(
        `INSERT INTO notified (pr, bucket, at) VALUES (?, ?, ?)
         ON CONFLICT(pr) DO UPDATE SET bucket = excluded.bucket, at = excluded.at`,
      ).run(pr, bucket, now.toISOString());
    },
    close() { db.close(); },
  };
}
