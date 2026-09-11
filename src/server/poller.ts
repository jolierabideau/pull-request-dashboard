import { classify } from '../rules/classify.js';
import { checkDot } from '../rules/checks.js';
import { resolveEscalation } from '../claude/escalate.js';
import { fetchOpenPrs } from '../github/client.js';
import { readBranches } from '../git/branches.js';
import { NOTIFY_BUCKETS, notify } from '../notify/osascript.js';
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
}

export interface BranchItem {
  name: string;
  bucket: Extract<Bucket, 'unsubmitted-branch' | 'dead-branch'>;
}

export interface Board {
  items: BoardItem[];
  branches: BranchItem[];
  yourCourtCount: number;
  fetchedAt: string;
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
      const prBranches = new Set(prs.map((p) => p.title));
      const branches = readBranches(cfg.repoPath, prBranches);
      const next = buildBoard(prs, branches, store, cfg, new Date());

      await attachVerdicts(next, prs, store);
      if (superseded()) return;
      sendNotifications(next, store);
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
    if (verdict.court === 'me' && item.bucket === 'ready-to-merge') {
      item.bucket = 'needs-your-response';
    }
  }
  board.items.sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket));
  board.yourCourtCount = board.items.filter((i) => YOUR_COURT.has(i.bucket)).length;
}

function sendNotifications(board: Board, store: Store): void {
  const now = new Date();
  for (const item of board.items) {
    if (!NOTIFY_BUCKETS.has(item.bucket)) continue;
    if (!store.shouldNotify(item.number, item.bucket, now)) continue;
    notify(`PR #${item.number}`, `${item.bucket}: ${item.title}`, item.url);
    store.recordNotified(item.number, item.bucket, now);
  }
}
