import { classify } from '../rules/classify.js';
import { checkDot } from '../rules/checks.js';
import { resolveEscalation } from '../claude/escalate.js';
import { fetchOpenPrs } from '../github/client.js';
import { readBranches } from '../git/branches.js';
import { notifyKey } from '../rules/notify.js';
import { notify } from '../notify/osascript.js';
import type { Store } from '../store/db.js';
import type {
  BranchInput, Bucket, Classification, Config, PrInput,
} from '../types.js';

export interface BoardItem extends Classification {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
  /** Carried so the notify key can be recomputed after a verdict moves a bucket. */
  discordPostedAt: string | null;
}

export interface BranchItem {
  name: string;
  bucket: Extract<Bucket, 'unsubmitted-branch' | 'dead-branch'>;
}

export interface Board {
  items: BoardItem[];
  branches: BranchItem[];
  yourCourtCount: number;
  /** Null only on the board shell served before the first poll lands. */
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
}

const ORDER: Bucket[] = [
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
  'waiting-on-reviewer', 'asked-no-looks', 'not-asked', 'draft',
  'unsubmitted-branch', 'dead-branch',
];

const YOUR_COURT: Set<Bucket> = new Set([
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
]);

export function buildBoard(
  prs: PrInput[],
  branches: BranchInput[],
  store: Store,
  cfg: Config,
  now: Date,
): Board {
  const items: BoardItem[] = prs.map((pr) => {
    const local = { discordPostedAt: store.getDiscordPostedAt(pr.number) };
    const classification = classify(pr, local, cfg, now);
    return {
      ...classification,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      checkDot: checkDot(pr.checks),
      discordPostedAt: local.discordPostedAt,
    };
  });

  items.sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));

  return {
    items,
    branches: branches.map((b) => ({
      name: b.name,
      bucket: b.upstreamGone ? ('dead-branch' as const) : ('unsubmitted-branch' as const),
    })),
    yourCourtCount: items.filter((i) => YOUR_COURT.has(i.bucket)).length,
    fetchedAt: now.toISOString(),
    stale: false,
    error: null,
  };
}

export interface Poller {
  snapshot(): Board | null;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

export function createPoller(cfg: Config, store: Store): Poller {
  let board: Board | null = null;
  let timer: NodeJS.Timeout | null = null;
  let generation = 0;
  let stopped = false;

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    const superseded = () => stopped || mine !== generation;
    const commit = (next: Board): void => {
      // A slower earlier refresh must never overwrite a newer snapshot,
      // and nothing may land after stop().
      if (superseded()) return;
      board = next;
    };

    try {
      const prs = await fetchOpenPrs(cfg);
      // No branch-to-PR correlation is asserted: the GraphQL query does not
      // fetch headRefName, so there is nothing honest to match branches on.
      const branches = readBranches(cfg.repoPath, new Set<string>());
      const next = buildBoard(prs, branches, store, cfg, new Date());

      await attachVerdicts(next, prs, store);
      if (superseded()) return;
      sendNotifications(next, store, cfg);
      commit(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleBoard: Board = board === null
        ? {
            items: [],
            branches: [],
            yourCourtCount: 0,
            fetchedAt: new Date().toISOString(),
            stale: true,
            error: message,
          }
        : { ...board, stale: true, error: message };
      commit(staleBoard);
    }
  };

  return {
    snapshot: () => board,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), cfg.pollIntervalMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    },
    refresh,
  };
}

async function attachVerdicts(
  board: Board, prs: PrInput[], store: Store,
): Promise<void> {
  for (const item of board.items) {
    if (item.escalate === null || item.escalateReviewId === null) continue;
    const pr = prs.find((p) => p.number === item.number);
    // Resolve the exact review classify escalated on, not merely the newest.
    const review = pr?.reviews.find((r) => r.id === item.escalateReviewId);
    if (!review) continue;

    const verdict = await resolveEscalation(review, item.escalate, store);
    if (verdict === null) {
      item.receipts.push('tie-break unavailable — showing the rules-only result');
      continue;
    }
    item.verdict = verdict;
    item.receipts.push(`Claude: ball is in ${verdict.court === 'me' ? 'your' : 'their'} court`);

    // A red build or a conflict is the user's court whatever a review says.
    if (item.bucket === 'blocked-mechanically') continue;

    const from = item.bucket;
    const to: Bucket = verdict.court === 'me' ? 'needs-your-response' : 'waiting-on-reviewer';
    if (from !== to) {
      item.bucket = to;
      item.receipts.push(`Claude's verdict moved this from ${from} to ${to}`);
    }
  }
  board.items.sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));
  board.yourCourtCount = board.items.filter((i) => YOUR_COURT.has(i.bucket)).length;
}

function sendNotifications(board: Board, store: Store, cfg: Config): void {
  const now = new Date();
  for (const item of board.items) {
    const key = notifyKey(item, cfg, now);
    if (store.shouldNotify(item.number, key, now)) {
      notify(`PR #${item.number}`, `${key}: ${item.title}`, item.url);
      store.recordNotified(item.number, key, now);
      continue;
    }
    // Record what we saw even when nothing fired, so leaving and re-entering
    // a notify-worthy key notifies again.
    store.recordObserved(item.number, key);
  }
}
