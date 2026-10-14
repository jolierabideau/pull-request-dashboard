import type { Board, NotificationEvent } from './api';

export interface LastShown { epoch: string; id: number }

export interface NotificationPlan {
  toShow: NotificationEvent[];
  next: LastShown;
}

/**
 * Decides which of the server's events to show. With nothing stored, the
 * current maximum id is adopted without showing anything, so a board opened
 * fresh never floods the screen with a backlog. After the server restarted (a
 * new epoch, so ids restarted), every event in the log was fired by the new
 * process and is shown.
 */
export function planNotifications(
  stored: LastShown | null,
  epoch: string,
  events: NotificationEvent[],
): NotificationPlan {
  const maxId = events.reduce((max, e) => Math.max(max, e.id), 0);
  if (stored === null) {
    return { toShow: [], next: { epoch, id: maxId } };
  }
  if (stored.epoch !== epoch) {
    return { toShow: events, next: { epoch, id: maxId } };
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

/** Clears the in-memory fallback; tests only. */
export function resetNotificationStateForTests(): void {
  memoryLastShown = null;
}

const LOCK_NAME = 'pr-dashboard-notifications';

/**
 * Shows the board's new notification events as browser notifications.
 *
 * Read, plan, store and show run under a Web Lock shared by all tabs of the
 * origin, so a second tab polling at the same moment waits and then finds the
 * events already stored. Where Web Locks are unavailable the steps run
 * unlocked, and each notification's tag (`epoch:id`) makes the browser replace
 * a duplicate instead of showing it twice.
 */
export async function showNewNotifications(board: Board): Promise<void> {
  const run = (): void => {
    const { toShow, next } = planNotifications(readLastShown(), board.epoch, board.notifications);
    // Stored before showing, and even without permission, so enabling
    // notifications later shows no backlog.
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
  };
  if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
    await navigator.locks.request(LOCK_NAME, run);
  } else {
    run();
  }
}
