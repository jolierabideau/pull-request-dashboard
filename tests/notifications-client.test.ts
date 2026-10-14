import { describe, expect, it } from 'vitest';
import { planNotifications } from '../client/src/notifications.js';

const event = (id: number) => ({ id, title: 't', body: 'b', url: 'u', at: '2026-09-11T12:00:00Z' });

describe('planNotifications', () => {
  it('shows nothing on first load and adopts the current max id', () => {
    expect(planNotifications(null, 'e1', [event(1), event(2)]))
      .toEqual({ toShow: [], next: { epoch: 'e1', id: 2 } });
  });

  it('shows nothing and resets when the server epoch changed', () => {
    expect(planNotifications({ epoch: 'old', id: 40 }, 'e2', [event(1), event(2)]))
      .toEqual({ toShow: [], next: { epoch: 'e2', id: 2 } });
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
