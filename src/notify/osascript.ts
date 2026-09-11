import { execFile } from 'node:child_process';
import type { Bucket } from '../types.js';

/** Buckets whose arrival is worth interrupting the user for. */
export const NOTIFY_BUCKETS: Set<Bucket> = new Set([
  'needs-your-response',
  'blocked-mechanically',
  'ready-to-merge',
]);

const escape = (s: string): string => s.replace(/["\\]/g, '\\$&');

export function notify(title: string, body: string, url: string): void {
  const script =
    `display notification "${escape(body)}" with title "${escape(title)}"` +
    ` subtitle "${escape(url)}"`;
  execFile('osascript', ['-e', script], (error) => {
    if (error) console.error(`notification failed: ${error.message}`);
  });
}
