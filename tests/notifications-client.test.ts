import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  planNotifications, resetNotificationStateForTests, showNewNotifications,
} from '../client/src/notifications.js';
import type { Board } from '../client/src/api.js';

const event = (id: number) => ({ id, title: `t${id}`, body: 'b', url: 'u', at: '2026-09-11T12:00:00Z' });

describe('planNotifications', () => {
  it('shows nothing on first load and adopts the current max id', () => {
    expect(planNotifications(null, 'e1', [event(1), event(2)]))
      .toEqual({ toShow: [], next: { epoch: 'e1', id: 2 } });
  });

  it('shows every event of the new epoch when the server restarted', () => {
    const plan = planNotifications({ epoch: 'old', id: 40 }, 'e2', [event(1), event(2)]);
    expect(plan.toShow.map((e) => e.id)).toEqual([1, 2]);
    expect(plan.next).toEqual({ epoch: 'e2', id: 2 });
  });

  it('shows only events newer than the last shown', () => {
    const plan = planNotifications({ epoch: 'e1', id: 2 }, 'e1', [event(1), event(2), event(3), event(4)]);
    expect(plan.toShow.map((e) => e.id)).toEqual([3, 4]);
    expect(plan.next).toEqual({ epoch: 'e1', id: 4 });
  });

  it('shows nothing when already up to date', () => {
    expect(planNotifications({ epoch: 'e1', id: 4 }, 'e1', [event(3), event(4)]))
      .toEqual({ toShow: [], next: { epoch: 'e1', id: 4 } });
  });

  it('handles an empty log', () => {
    expect(planNotifications(null, 'e1', []).next).toEqual({ epoch: 'e1', id: 0 });
  });
});

describe('showNewNotifications', () => {
  const STORAGE_KEY = 'pr-dashboard.last-notification';
  const shownBy: { title: string; options: { body: string; tag: string } }[] = [];
  let storage: Map<string, string>;

  const board = (epoch: string, ids: number[]): Board => (
    { epoch, notifications: ids.map(event) } as unknown as Board
  );

  const stubNotification = (permission: string) => {
    class FakeNotification {
      static permission = permission;
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body: string; tag: string }) {
        shownBy.push({ title, options });
      }
      close(): void {}
    }
    vi.stubGlobal('Notification', FakeNotification);
  };

  const stubStorage = () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    });
  };

  beforeEach(() => {
    shownBy.length = 0;
    storage = new Map();
    resetNotificationStateForTests();
    stubStorage();
    vi.stubGlobal('navigator', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNotificationStateForTests();
  });

  it('stores the last shown id even without permission, and shows nothing', async () => {
    stubNotification('default');
    await showNewNotifications(board('e1', [1, 2]));
    expect(shownBy).toEqual([]);
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? 'null')).toEqual({ epoch: 'e1', id: 2 });
  });

  it('shows only newer events, tagged with epoch and id', async () => {
    stubNotification('granted');
    await showNewNotifications(board('e1', [1, 2]));
    expect(shownBy).toEqual([]);
    await showNewNotifications(board('e1', [1, 2, 3]));
    expect(shownBy.map((s) => s.title)).toEqual(['t3']);
    expect(shownBy[0]?.options).toEqual({ body: 'b', tag: 'e1:3' });
  });

  it('shows the new events after a server restart', async () => {
    stubNotification('granted');
    await showNewNotifications(board('e1', [1, 2]));
    await showNewNotifications(board('e2', [1, 2]));
    expect(shownBy.map((s) => s.options.tag)).toEqual(['e2:1', 'e2:2']);
  });

  it('runs under a Web Lock when the browser has one', async () => {
    stubNotification('granted');
    const request = vi.fn(async (_name: string, callback: () => void) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    await showNewNotifications(board('e1', [1]));
    await showNewNotifications(board('e1', [1, 2]));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe('pr-dashboard-notifications');
    expect(shownBy.map((s) => s.title)).toEqual(['t2']);
  });

  it('shows each event once from memory when localStorage throws', async () => {
    stubNotification('granted');
    const blocked = () => { throw new Error('blocked'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    await showNewNotifications(board('e1', [1]));
    await showNewNotifications(board('e1', [1, 2]));
    await showNewNotifications(board('e1', [1, 2]));
    expect(shownBy.map((s) => s.title)).toEqual(['t2']);
  });

  it('does not throw when the browser has no Notification support', async () => {
    vi.stubGlobal('Notification', undefined);
    await expect(showNewNotifications(board('e1', [1, 2]))).resolves.toBeUndefined();
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? 'null')).toEqual({ epoch: 'e1', id: 2 });
  });
});
