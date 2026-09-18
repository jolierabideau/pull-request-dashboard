import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeAddressInUse,
  exitWhenOrphaned,
  identityKey,
  parseListenerPid,
  parseProcessTable,
  supervisorsOf,
  type ProcessIdentity,
} from '../src/server/lifecycle.js';

// `lsof -nP -iTCP:5174 -sTCP:LISTEN -F p`.
const LSOF = 'p50210\n';

// `ps -A -o pid=,ppid=,lstart=,comm=` for the orphaned run: run-p (50161) is
// already gone, so npm (50162) has been reparented to 1 while the API (50210)
// lives on under it.
const PS = [
  '    1     0 Thu Sep 18 07:59:02 2026 /sbin/launchd',
  '  892     1 Thu Sep 18 08:14:40 2026 /bin/zsh',
  '50162     1 Thu Sep 18 09:12:31 2026 /usr/local/bin/node',
  '50210 50162 Thu Sep 18 09:12:33 2026 /usr/local/bin/node',
].join('\n');

const API = { name: 'API', command: 'npm run dev' };

const NPM: ProcessIdentity = { pid: 50162, startedAt: 'Thu Sep 18 09:12:31 2026' };
const RUN_P: ProcessIdentity = { pid: 50161, startedAt: 'Thu Sep 18 09:12:29 2026' };

describe('parseListenerPid', () => {
  it('reads the pid of the process holding the port', () => {
    expect(parseListenerPid(LSOF)).toBe(50210);
  });

  it('ignores the other field lines lsof may emit', () => {
    expect(parseListenerPid('p50210\nf20\nn127.0.0.1:5174\n')).toBe(50210);
  });

  it('returns undefined when nothing is listening', () => {
    expect(parseListenerPid('')).toBeUndefined();
  });
});

describe('describeAddressInUse', () => {
  it('names the port, the holder, and the command that frees it', () => {
    const message = describeAddressInUse(
      5174,
      { pid: 50210, command: 'node --import tsx/esm src/server/index.ts' },
      API,
    );
    expect(message).toContain('5174');
    expect(message).toContain('50210');
    expect(message).toContain('node --import tsx/esm src/server/index.ts');
    expect(message).toContain('kill 50210');
  });

  it('still points somewhere useful when the holder cannot be identified', () => {
    const message = describeAddressInUse(5174, undefined, API);
    expect(message).toContain('5174');
    expect(message).toContain('lsof');
    expect(message).toContain('PORT=5175 npm run dev');
  });

  it('leaves out the PORT suggestion for a server PORT does not move', () => {
    const message = describeAddressInUse(5173, undefined, { name: 'web server' });
    expect(message).toContain('web server');
    expect(message).toContain('lsof');
    expect(message).not.toContain('PORT=');
  });

  it('describes whichever server did not start', () => {
    const message = describeAddressInUse(5174, undefined, {
      name: 'demo board',
      command: 'npm run demo',
    });
    expect(message).toContain('demo board');
    expect(message).toContain('npm run demo');
    expect(message).not.toContain('npm run dev\n');
  });
});

describe('parseProcessTable', () => {
  it('maps each pid to its parent', () => {
    expect(parseProcessTable(PS).get(50210)?.ppid).toBe(50162);
  });

  it('keeps the start time whole, spaces and all', () => {
    expect(parseProcessTable(PS).get(50210)?.startedAt).toBe('Thu Sep 18 09:12:33 2026');
  });

  it('keeps the command that follows it', () => {
    expect(parseProcessTable(PS).get(892)?.command).toBe('/bin/zsh');
  });
});

describe('supervisorsOf', () => {
  // The chain `npm run dev` actually builds: npm, run-p and npm again, each
  // reached through the `sh -c` npm inserts, under an interactive login shell.
  const DEV_RUN = parseProcessTable(
    [
      '  400     1 Thu Sep 18 08:14:38 2026 /Applications/Ghostty.app/Contents/MacOS/ghostty',
      '  892   400 Thu Sep 18 08:14:40 2026 -zsh',
      '50100   892 Thu Sep 18 09:12:27 2026 npm run dev',
      '50101 50100 Thu Sep 18 09:12:28 2026 /bin/sh',
      '50161 50101 Thu Sep 18 09:12:29 2026 node',
      '50162 50161 Thu Sep 18 09:12:31 2026 npm run dev:api',
      '50163 50162 Thu Sep 18 09:12:32 2026 /bin/sh',
      '50210 50163 Thu Sep 18 09:12:33 2026 node',
    ].join('\n'),
  );

  it('lists every launcher that could strand us, sh wrappers included', () => {
    expect(supervisorsOf(50210, DEV_RUN).map((s) => s.pid)).toEqual([
      50163, 50162, 50161, 50101, 50100,
    ]);
  });

  it('keeps the start time that pins each of them to one process', () => {
    expect(supervisorsOf(50210, DEV_RUN)[1]).toEqual({
      pid: 50162,
      startedAt: 'Thu Sep 18 09:12:31 2026',
    });
  });

  it('stops short of the terminal that happens to be above them', () => {
    expect(supervisorsOf(50210, DEV_RUN).map((s) => s.pid)).not.toContain(400);
  });

  it('trims the shell off the top: its exiting is not our business', () => {
    // `npm run dev:api &` from a setup script that then finishes should not
    // read as "the supervisor died".
    const table = parseProcessTable(
      [
        '  892     1 Thu Sep 18 08:14:40 2026 /bin/bash',
        '50162   892 Thu Sep 18 09:12:31 2026 npm run dev:api',
        '50163 50162 Thu Sep 18 09:12:32 2026 /bin/sh',
        '50210 50163 Thu Sep 18 09:12:33 2026 node',
      ].join('\n'),
    );
    expect(supervisorsOf(50210, table).map((s) => s.pid)).toEqual([50163, 50162]);
  });

  it('watches nothing when a bare shell is all there is above us', () => {
    const table = parseProcessTable(
      [
        '  892     1 Thu Sep 18 08:14:40 2026 -zsh',
        '50210   892 Thu Sep 18 09:12:33 2026 node',
      ].join('\n'),
    );
    expect(supervisorsOf(50210, table)).toEqual([]);
  });

  it('stops at init rather than watching pid 1', () => {
    expect(supervisorsOf(50162, parseProcessTable(PS))).toEqual([]);
  });

  it('does not hang on a cycle in the table', () => {
    const table = parseProcessTable(
      [
        '   10    20 Thu Sep 18 09:12:31 2026 node',
        '   20    10 Thu Sep 18 09:12:29 2026 node',
      ].join('\n'),
    );
    expect(supervisorsOf(10, table).map((s) => s.pid)).toEqual([20]);
  });
});

describe('exitWhenOrphaned', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits once a watched supervisor dies, even if the direct parent lives', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    // The shape that stranded the API on port 5174: run-p dies, npm does not,
    // so nothing in the process itself notices.
    const live = new Set([identityKey(NPM), identityKey(RUN_P)]);
    exitWhenOrphaned({
      supervisors: [NPM, RUN_P],
      liveProcesses: () => live,
      onOrphaned,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(onOrphaned).not.toHaveBeenCalled();

    live.delete(identityKey(RUN_P));
    vi.advanceTimersByTime(1000);
    expect(onOrphaned).toHaveBeenCalledOnce();
  });

  it('is not fooled by another process inheriting a dead supervisor pid', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    // run-p is gone; the pid has been reused for something started later.
    const live = new Set([
      identityKey(NPM),
      identityKey({ pid: RUN_P.pid, startedAt: 'Thu Sep 18 11:40:02 2026' }),
    ]);
    exitWhenOrphaned({
      supervisors: [NPM, RUN_P],
      liveProcesses: () => live,
      onOrphaned,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    expect(onOrphaned).toHaveBeenCalledOnce();
  });

  it('waits rather than shutting down when the process table cannot be read', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    exitWhenOrphaned({
      supervisors: [NPM],
      liveProcesses: () => undefined,
      onOrphaned,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('never fires when there is no supervisor to outlive', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    exitWhenOrphaned({
      supervisors: [],
      liveProcesses: () => new Set<string>(),
      onOrphaned,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('stops watching when cancelled', () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    const live = new Set([identityKey(NPM)]);
    const stop = exitWhenOrphaned({
      supervisors: [NPM],
      liveProcesses: () => live,
      onOrphaned,
      intervalMs: 1000,
    });

    stop();
    live.clear();
    vi.advanceTimersByTime(10_000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});
