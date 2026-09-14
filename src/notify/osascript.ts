import { execFile } from 'node:child_process';

/** `display notification` is macOS-only; elsewhere the board is the whole UI. */
const SUPPORTED = process.platform === 'darwin';

const escape = (s: string): string => s.replace(/["\\]/g, '\\$&');

export function notificationsSupported(): boolean {
  return SUPPORTED;
}

export function notify(title: string, body: string, url: string): void {
  if (!SUPPORTED) return;
  const script =
    `display notification "${escape(body)}" with title "${escape(title)}"` +
    ` subtitle "${escape(url)}"`;
  execFile('osascript', ['-e', script], (error) => {
    if (error) console.error(`notification failed: ${error.message}`);
  });
}
