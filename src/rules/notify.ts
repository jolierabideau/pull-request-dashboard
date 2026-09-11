import type { Bucket, Config } from '../types.js';

/**
 * What a notification is keyed on. Richer than the bucket, because one
 * transition the spec asks us to notify on — the Discord clock crossing the
 * staleness threshold — does not change the bucket at all.
 */
export type NotifyKey = Bucket | 'asked-no-looks-stale';

/** Keys whose arrival is worth interrupting the user for. */
export const NOTIFY_KEYS: Set<NotifyKey> = new Set([
  'needs-your-response',
  'blocked-mechanically',
  'ready-to-merge',
  'asked-no-looks-stale',
]);

export interface NotifyKeyInput {
  bucket: Bucket;
  discordPostedAt: string | null;
}

/** Pure: `now` is injected, no I/O. */
export function notifyKey(item: NotifyKeyInput, cfg: Config, now: Date): NotifyKey {
  if (item.bucket === 'asked-no-looks' && item.discordPostedAt !== null) {
    const hours = (now.getTime() - Date.parse(item.discordPostedAt)) / 3_600_000;
    if (hours > cfg.staleAfterHours) return 'asked-no-looks-stale';
  }
  return item.bucket;
}
