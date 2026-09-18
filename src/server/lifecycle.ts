/**
 * Keeps a dev server from outliving whatever started it, and turns the port
 * collision an outlived server causes into a message you can act on.
 *
 * The failure this exists for: `npm run dev` runs the API and the web server
 * under `run-p`. When `run-p` dies abruptly, it never gets to stop its
 * children, and `npm run dev:api` does not stop its own child either — so the
 * API keeps running, keeps port 5174, and the next `npm run dev` dies on an
 * unhandled EADDRINUSE stack trace that names no culprit.
 *
 * Note that watching `process.ppid` is not enough. In that collapse the API's
 * direct parent (`npm run dev:api`) stayed alive; it was the grandparent
 * `run-p` that vanished. So the whole supervisor chain is watched — but only
 * the supervisor chain, and only as identities rather than bare pids. See
 * `supervisorsOf` and `ProcessIdentity` for why each of those matters.
 */
import { execFileSync } from 'node:child_process';
import { writeSync } from 'node:fs';

export interface PortHolder {
  pid: number;
  command: string;
}

/**
 * A pid alone is not an identity: pids get reused, and on macOS's small pid
 * space that happens soon enough that a dead `run-p`'s number can be handed to
 * something unrelated — after which a pid-only check would see the supervisor
 * as alive forever and the API would be stranded exactly as before, silently.
 * The start time pins the number to one process.
 */
export interface ProcessIdentity {
  pid: number;
  /** `ps -o lstart=`, e.g. `Thu Sep 18 09:12:33 2026`. */
  startedAt: string;
}

export interface ProcessInfo extends ProcessIdentity {
  ppid: number;
  command: string;
}

export interface OrphanWatch {
  /** The chain of supervisors above this process; see `supervisorsOf`. */
  supervisors: ProcessIdentity[];
  /** Identity keys of everything running now, or undefined if unreadable. */
  liveProcesses: () => Set<string> | undefined;
  onOrphaned: () => void;
  intervalMs?: number;
}

/** What to describe a server as when its port is taken. */
export interface ServerLabel {
  /** Fills "so the ___ did not start". */
  name: string;
  /**
   * How the user started it, for the "run somewhere else" suggestion. Left out
   * where there is no such suggestion to make: the web server's port comes
   * from the Vite config, not from `PORT`.
   */
  command?: string;
}

/** Comparable form of a `ProcessIdentity`, for set membership. */
export function identityKey({ pid, startedAt }: ProcessIdentity): string {
  return `${pid}@${startedAt}`;
}

/**
 * Pulls the pid out of `lsof -nP -iTCP:<port> -sTCP:LISTEN -F p` output.
 *
 * The `-F p` form is what makes this reliable: lsof's default table truncates
 * COMMAND to nine characters without removing the spaces inside it, so a
 * holder named `Google Chrome Helper` shifts every column right and the pid
 * reads as `Ch`. The field form emits one `p<pid>` line and nothing else.
 */
export function parseListenerPid(lsofOutput: string): number | undefined {
  for (const line of lsofOutput.split('\n')) {
    if (!line.startsWith('p')) continue;
    const pid = Number(line.slice(1).trim());
    if (Number.isInteger(pid)) return pid;
  }
  return undefined;
}

/** Arguments that produce the table `parseProcessTable` reads. */
const PS_TABLE_ARGS = ['-A', '-o', 'pid=,ppid=,lstart=,comm='];

/**
 * Reads `ps -A -o pid=,ppid=,lstart=,comm=`. `lstart` is always five
 * whitespace-separated tokens (`Thu Sep 18 09:12:33 2026`), so the columns
 * stay unambiguous even though it contains spaces and `comm` may too.
 */
export function parseProcessTable(psOutput: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of psOutput.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    table.set(pid, {
      pid,
      ppid,
      startedAt: fields.slice(2, 7).join(' '),
      command: fields.slice(7).join(' '),
    });
  }
  return table;
}

/**
 * The launchers worth watching — `run-p` and the npm wrappers, all of which
 * run as node — and the shells that appear between them, since npm reaches
 * what it runs through `sh -c`.
 */
const LAUNCHER_COMMANDS = new Set(['node', 'npm', 'npx', 'run-p', 'run-s', 'npm-run-all']);
const SHELL_COMMANDS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish']);

/**
 * The program name out of a `ps -o comm=` field, which is a process title
 * rather than a path: npm rewrites its own to the whole command line ("npm
 * exec node --import …"), and a login shell arrives as "-zsh".
 */
function commandName({ command }: ProcessInfo): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return (first.split('/').pop() ?? first).replace(/^-/, '');
}

function isLauncher(info: ProcessInfo): boolean {
  return LAUNCHER_COMMANDS.has(commandName(info));
}

function isShell(info: ProcessInfo): boolean {
  return SHELL_COMMANDS.has(commandName(info));
}

/**
 * The launcher chain above `pid`, nearest first: the npm/`run-p` processes
 * that would strand this server if they died, and the `sh -c` wrappers between
 * them. Stops at the first ancestor that is neither, and short of init, which
 * outlives everything.
 *
 * Stopping there is the point. The full ancestry runs on through the shell,
 * tmux, sshd and the terminal app, and any of those can exit for a perfectly
 * ordinary reason — `npm run dev:api &` from a setup script that then
 * finishes, or a CI step that backgrounds the API — which would shut this
 * server down seconds later with a message implying something went wrong.
 *
 * Which is also why the chain is trimmed back to the topmost launcher: the
 * shell that ran `npm run dev` is an ancestor like any other, and its exiting
 * says nothing about whether we have been stranded.
 */
export function supervisorsOf(pid: number, table: Map<number, ProcessInfo>): ProcessIdentity[] {
  const chain: ProcessInfo[] = [];
  const seen = new Set([pid]);
  let current = table.get(pid)?.ppid;
  while (current !== undefined && current > 1 && !seen.has(current)) {
    const info = table.get(current);
    if (info === undefined || !(isLauncher(info) || isShell(info))) break;
    chain.push(info);
    seen.add(current);
    current = info.ppid;
  }
  while (chain.length > 0 && !isLauncher(chain[chain.length - 1]!)) chain.pop();
  return chain.map(({ pid: ancestor, startedAt }) => ({ pid: ancestor, startedAt }));
}

/** The process table, or undefined when `ps` could not be read. */
function readProcessTable(): Map<number, ProcessInfo> | undefined {
  try {
    return parseProcessTable(execFileSync('ps', PS_TABLE_ARGS, { encoding: 'utf8' }));
  } catch {
    // No `ps`, or it failed transiently (EAGAIN under fork pressure, EMFILE, a
    // signal). Either way this says nothing about who is alive, so it must not
    // be reported as an empty table — see `exitWhenOrphaned`.
    return undefined;
  }
}

/** What is running right now, as `exitWhenOrphaned` polls it. */
export function liveProcesses(): Set<string> | undefined {
  const table = readProcessTable();
  return table && new Set([...table.values()].map(identityKey));
}

/** The supervisor chain above this process, for `exitWhenOrphaned`. */
export function ownSupervisors(): ProcessIdentity[] {
  const table = readProcessTable();
  return table === undefined ? [] : supervisorsOf(process.pid, table);
}

/**
 * Calls `onOrphaned` once any watched supervisor disappears. Returns a
 * function that stops watching.
 */
export function exitWhenOrphaned({
  supervisors,
  liveProcesses: readLive,
  onOrphaned,
  intervalMs = 5_000,
}: OrphanWatch): () => void {
  // Started with no supervisor to outlive (launched detached, or by init):
  // there is nothing whose death would mean this process is stranded.
  if (supervisors.length === 0) return () => {};

  const timer = setInterval(() => {
    const live = readLive();
    // Could not read the process table. That is not evidence of anything, and
    // treating it as "they are all gone" would kill a healthy dev server on a
    // single hiccup — so wait for a reading that means something.
    if (live === undefined) return;
    if (supervisors.every((supervisor) => live.has(identityKey(supervisor)))) return;
    clearInterval(timer);
    onOrphaned();
  }, intervalMs);
  // Never a reason on its own to keep the process alive.
  timer.unref?.();

  return () => clearInterval(timer);
}

/**
 * Prints a line that has to survive the `process.exit` right behind it.
 *
 * Under `run-p` stdout and stderr are pipes rather than ttys, so node writes
 * them asynchronously and `process.exit` drops whatever is still queued — and
 * the messages here exist precisely to be read on the way out.
 */
export function printSync(stream: 'stdout' | 'stderr', text: string): void {
  try {
    writeSync(process[stream].fd, `${text}\n`);
  } catch {
    // Non-blocking pipe that would not take it, or a closed fd. Better a
    // possibly-truncated message than none.
    (stream === 'stderr' ? console.error : console.log)(text);
  }
}

/** Who holds `port`, for the message below. */
export function findPortHolder(port: number): PortHolder | undefined {
  try {
    const pid = parseListenerPid(
      execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p'], {
        encoding: 'utf8',
      }),
    );
    if (pid === undefined) return undefined;
    // `-F p` gives the pid and nothing else; ps gives the whole command line,
    // which is what makes a stale dev server recognisable as one.
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return { pid, command };
  } catch {
    return undefined;
  }
}

/** What to print instead of an unhandled EADDRINUSE stack trace. */
export function describeAddressInUse(
  port: number,
  holder: PortHolder | undefined,
  { name, command }: ServerLabel,
): string {
  if (holder === undefined) {
    return [
      `Port ${port} is already in use, so the ${name} did not start.`,
      'Nothing identifiable is holding it. To look yourself:',
      `  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      ...(command === undefined ? [] : [`Or run somewhere else: PORT=${port + 1} ${command}`]),
    ].join('\n');
  }
  return [
    `Port ${port} is already in use, so the ${name} did not start.`,
    `Held by pid ${holder.pid}: ${holder.command}`,
    'That is usually an earlier dev server that outlived its terminal. Stop it with:',
    `  kill ${holder.pid}`,
  ].join('\n');
}
