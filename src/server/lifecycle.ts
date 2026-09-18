/**
 * Keeps a dev server from outliving the terminal that started it, and turns the
 * port collision an outlived server causes into a message you can act on.
 *
 * The failure this exists for: `npm run dev` runs the API and the web server
 * under `run-p`. When `run-p` dies abruptly, it never gets to stop its
 * children, and `npm run dev:api` does not stop its own child either — so the
 * API keeps running, keeps port 5174, and the next `npm run dev` dies on an
 * unhandled EADDRINUSE stack trace that names no culprit.
 *
 * Note that watching `process.ppid` is not enough. In that collapse the API's
 * direct parent (`npm run dev:api`) stayed alive; it was the grandparent
 * `run-p` that vanished. So the whole ancestor chain is watched, not the
 * parent alone.
 */
import { execFileSync } from 'node:child_process';

export interface PortHolder {
  pid: number;
  command: string;
}

export interface OrphanWatch {
  /** Pids above this process, nearest first; see `ancestorsOf`. */
  ancestors: number[];
  livePids: () => Set<number>;
  onOrphaned: () => void;
  intervalMs?: number;
}

/** Pulls the pid out of `lsof -nP -iTCP:<port> -sTCP:LISTEN` output. */
export function parseListenerPid(lsofOutput: string): number | undefined {
  const row = lsofOutput.split('\n')[1]?.trim();
  const pid = Number(row?.split(/\s+/)[1]);
  return Number.isInteger(pid) ? pid : undefined;
}

/** Maps pid to parent pid from `ps -A -o pid=,ppid=` output. */
export function parseProcessTable(psOutput: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
}

/**
 * The chain above `pid`, nearest first, stopping short of init: pid 1 outlives
 * everything, so watching it would mean never noticing anything.
 */
export function ancestorsOf(pid: number, parents: Map<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set([pid]);
  let current = parents.get(pid);
  while (current !== undefined && current > 1 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parents.get(current);
  }
  return chain;
}

function readProcessTable(): Map<number, number> {
  try {
    return parseProcessTable(execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }));
  } catch {
    // No `ps`: the server still works, it just will not notice being orphaned.
    return new Map();
  }
}

/** The pids running right now, as `exitWhenOrphaned` polls them. */
export function livePids(): Set<number> {
  return new Set(readProcessTable().keys());
}

/** The chain above this process, ready to hand to `exitWhenOrphaned`. */
export function ownAncestors(): number[] {
  return ancestorsOf(process.pid, readProcessTable());
}

/**
 * Calls `onOrphaned` once any watched ancestor disappears. Returns a function
 * that stops watching.
 */
export function exitWhenOrphaned({
  ancestors,
  livePids: readLive,
  onOrphaned,
  intervalMs = 5_000,
}: OrphanWatch): () => void {
  // Started with no supervisor to outlive (launched detached, or by init):
  // there is nothing whose death would mean this process is stranded.
  if (ancestors.length === 0) return () => {};

  const timer = setInterval(() => {
    const live = readLive();
    if (ancestors.every((pid) => live.has(pid))) return;
    clearInterval(timer);
    onOrphaned();
  }, intervalMs);
  // Never a reason on its own to keep the process alive.
  timer.unref?.();

  return () => clearInterval(timer);
}

/** Who holds `port`, for the message below. */
export function findPortHolder(port: number): PortHolder | undefined {
  try {
    const pid = parseListenerPid(
      execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }),
    );
    if (pid === undefined) return undefined;
    // lsof truncates the command; ps gives the whole line, which is what makes
    // a stale dev server recognisable as one.
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return { pid, command };
  } catch {
    return undefined;
  }
}

/** What to print instead of an unhandled EADDRINUSE stack trace. */
export function describeAddressInUse(port: number, holder: PortHolder | undefined): string {
  if (holder === undefined) {
    return [
      `Port ${port} is already in use, so the API did not start.`,
      'Nothing identifiable is holding it. To look yourself:',
      `  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      `Or run somewhere else: PORT=${port + 1} npm run dev`,
    ].join('\n');
  }
  return [
    `Port ${port} is already in use, so the API did not start.`,
    `Held by pid ${holder.pid}: ${holder.command}`,
    'That is usually an earlier dev server that outlived its terminal. Stop it with:',
    `  kill ${holder.pid}`,
  ].join('\n');
}
