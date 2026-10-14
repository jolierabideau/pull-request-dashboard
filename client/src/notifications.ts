import type { Board, NotificationEvent } from './api';

export interface LastShown { epoch: string; id: number }

export interface NotificationPlan {
  toShow: NotificationEvent[];
  next: LastShown;
}

/**
 * Decides which of the server's events to show. With nothing stored, or after
 * the server restarted (a new epoch, so ids restarted), the current maximum id
 * is adopted without showing anything, so a backlog never floods the screen.
 */
export function planNotifications(
  stored: LastShown | null,
  epoch: string,
  events: NotificationEvent[],
): NotificationPlan {
  const maxId = events.reduce((max, e) => Math.max(max, e.id), 0);
  if (stored === null || stored.epoch !== epoch) {
    return { toShow: [], next: { epoch, id: maxId } };
  }
  return {
    toShow: events.filter((e) => e.id > stored.id),
    next: { epoch, id: Math.max(stored.id, maxId) },
  };
}

const STORAGE_KEY = 'pr-dashboard.last-notification';

/** Used when localStorage is unavailable, so the tab still shows each event once. */
let memoryLastShown: LastShown | null = null;

function readLastShown(): LastShown | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return memoryLastShown;
    const parsed = JSON.parse(raw) as Partial<LastShown>;
    if (typeof parsed.epoch === 'string' && typeof parsed.id === 'number') {
      return { epoch: parsed.epoch, id: parsed.id };
    }
  } catch {
    // Storage is blocked or the value is corrupt; fall back to memory.
  }
  return memoryLastShown;
}

function writeLastShown(value: LastShown): void {
  memoryLastShown = value;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Kept in memory only.
  }
}

export const notificationPermission = (): NotificationPermission | null =>
  typeof Notification === 'undefined' ? null : Notification.permission;

/** Shows the board's new notification events as browser notifications. */
export function showNewNotifications(board: Board): void {
  const { toShow, next } = planNotifications(readLastShown(), board.epoch, board.notifications);
  // Stored before showing, so a second tab polling at the same moment skips
  // them; stored even without permission, so enabling later shows no backlog.
  writeLastShown(next);
  if (notificationPermission() !== 'granted') return;
  for (const event of toShow) {
    const shown = new Notification(event.title, {
      body: event.body,
      tag: `${board.epoch}:${event.id}`,
    });
    shown.onclick = () => {
      window.open(event.url, '_blank');
      shown.close();
    };
  }
}
