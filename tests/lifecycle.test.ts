import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ancestorsOf,
  describeAddressInUse,
  exitWhenOrphaned,
  parseListenerPid,
  parseProcessTable,
} from '../src/server/lifecycle.js';

// `lsof -nP -iTCP:5174 -sTCP:LISTEN`, header included.
const LSOF = [
  'COMMAND   PID          USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'node    50210 jolierabideau   20u  IPv4 0xe3e3de52897cc810      0t0  TCP 127.0.0.1:5174 (LISTEN)',
].join('\n');

// `ps -A -o pid=,ppid=` for the orphaned run: run-p (50161) is already gone,
// so npm (50162) has been reparented to 1 while the API (50210) lives on.
const PS = ['    1     0', '50162     1', '50210 50162'].join('\n');

describe('parseListenerPid', () => {
  it('reads the pid of the process holding the port', () => {
    expect(parseListenerPid(LSOF)).toBe(50210);
  });

  it('returns undefined when nothing is listening', () => {
    expect(parseListenerPid('')).toBeUndefined();
  });
});

describe('describeAddressInUse', () => {
  it('names the port, the holder, and the command that frees it', () => {
    const message = describeAddressInUse(5174, {
      pid: 50210,
      command: 'node --import tsx/esm src/server/index.ts',
    });
    expect(message).toContain('5174');
    expect(message).toContain('50210');
    expect(message).toContain('node --import tsx/esm src/server/index.ts');
    expect(message).toContain('kill 50210');
  });

  it('still points somewhere useful when the holder cannot be identified', () => {
    const message = describeAddressInUse(5174, undefined);
    expect(message).toContain('5174');
    expect(message).toContain('lsof');
  });
});

describe('parseProcessTable', () => {
  it('maps each pid to its parent', () => {
    expect(parseProcessTable(PS).get(50210)).toBe(50162);
  });
});

describe('ancestorsOf', () => {
  it('lists the chain above a process', () => {
    const parents = new Map([[50210, 50162], [50162, 50161], [50161, 400]]);
    expect(ancestorsOf(50210, parents)).toEqual([50162, 50161, 400]);
  });

  it('stops at init rather than watching pid 1', () => {
    expect(ancestorsOf(50210, parseProcessTable(PS))).toEqual([50162]);
  });

  it('does not hang on a cycle in the table', () => {
    const parents = new Map([[10, 20], [20, 10]]);
    expect(ancestorsOf(10, parents)).toEqual([20]);
  });
});

describe('exitWhenOrphaned', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits once a watched ancestor dies, even if the direct parent lives', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    // The shape that stranded the API on port 5174: run-p (50161) dies, npm
    // (50162) does not, so nothing in the process itself notices.
    const live = new Set([50162, 50161]);
    exitWhenOrphaned({
      ancestors: [50162, 50161],
      livePids: () => live,
      onOrphaned,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(onOrphaned).not.toHaveBeenCalled();

    live.delete(50161);
    vi.advanceTimersByTime(1000);
    expect(onOrphaned).toHaveBeenCalledOnce();
  });

  it('never fires when there is no supervisor to outlive', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    exitWhenOrphaned({
      ancestors: [],
      livePids: () => new Set<number>(),
      onOrphaned,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('stops watching when cancelled', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    const live = new Set([50162]);
    const stop = exitWhenOrphaned({
      ancestors: [50162],
      livePids: () => live,
      onOrphaned,
      intervalMs: 1000,
    });

    stop();
    live.delete(50162);
    vi.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});
