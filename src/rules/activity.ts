import type { CommitInput, Config, PrInput } from '../types.js';

const MERGE_OF_MAIN =
  /^Merge (?:remote-tracking )?branch '(?:origin\/)?main'(?: of \S+)? into /i;

/**
 * A commit counts as the user handing work back only when they wrote it and it
 * is not a bare merge of main. This author merges origin/main constantly — 8 of
 * 12 recent commits on PR #2664 — and such a merge is frequently the head
 * commit, so counting it reports "waiting on reviewer" for PRs nobody touched.
 */
export function isSubstantiveCommit(commit: CommitInput, me: string): boolean {
  if (!authoredByMe(commit, me)) return false;
  return !(commit.parentCount > 1 && MERGE_OF_MAIN.test(commit.messageHeadline));
}

function authoredByMe(commit: CommitInput, me: string): boolean {
  if (commit.authorLogin !== null) return commit.authorLogin === me;
  // 15 older PRs have a null author.user from an unmapped commit email.
  return (commit.authorEmail ?? '').toLowerCase().startsWith(`${me.toLowerCase()}@`);
}

export function isHumanReviewer(login: string, cfg: Config): boolean {
  return login !== cfg.me && !cfg.botLogins.includes(login);
}

type Stamp = { at: string; who: string };

export function lastReviewerActivity(pr: PrInput, cfg: Config): Stamp | null {
  const stamps: Stamp[] = [];

  for (const review of pr.reviews) {
    if (review.state === 'DISMISSED' || review.state === 'PENDING') continue;
    if (!isHumanReviewer(review.author, cfg)) continue;
    stamps.push({ at: review.submittedAt, who: review.author });
  }
  for (const comment of pr.comments) {
    if (!isHumanReviewer(comment.author, cfg)) continue;
    stamps.push({ at: comment.createdAt, who: comment.author });
  }
  for (const thread of pr.threads) {
    if (thread.isResolved) continue;
    if (!isHumanReviewer(thread.lastCommentAuthor, cfg)) continue;
    stamps.push({ at: thread.lastCommentAt, who: thread.lastCommentAuthor });
  }
  return newest(stamps);
}

export function lastMyActivity(
  pr: PrInput,
  cfg: Config,
): { at: string; what: string } | null {
  const stamps: { at: string; who: string; what: string }[] = [];

  for (const commit of pr.commits) {
    if (!isSubstantiveCommit(commit, cfg.me)) continue;
    stamps.push({ at: commit.committedDate, who: cfg.me, what: 'pushed' });
  }
  for (const comment of pr.comments) {
    if (comment.author !== cfg.me) continue;
    stamps.push({ at: comment.createdAt, who: cfg.me, what: 'commented' });
  }
  for (const review of pr.reviews) {
    if (review.author !== cfg.me) continue;
    stamps.push({ at: review.submittedAt, who: cfg.me, what: 'replied in review' });
  }

  const best = newest(stamps) as { at: string; what: string } | null;
  return best;
}

function newest<T extends { at: string }>(stamps: T[]): T | null {
  return stamps.reduce<T | null>(
    (acc, s) => (acc === null || s.at > acc.at ? s : acc),
    null,
  );
}
