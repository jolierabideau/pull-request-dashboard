import type {
  Classification, Config, EscalationReason, Footer, LocalState, PrInput, ReviewInput,
} from '../types.js';
import { parseFooter } from './footer.js';
import { isHumanReviewer, lastMyActivity, lastReviewerActivity } from './activity.js';
import { conflictState, hasFailingCheck } from './checks.js';

export type Court = 'me' | 'reviewer' | 'nobody' | 'unknown';

const BLOCKING_LANGUAGE = /\b(blocker|blocking|must fix|needs change)\b/i;

export function classify(
  pr: PrInput,
  local: LocalState,
  cfg: Config,
  now: Date,
): Classification {
  const receipts: string[] = [];

  const reviewer = lastReviewerActivity(pr, cfg);
  const mine = lastMyActivity(pr, cfg);
  const newestHumanReview = latestHumanReview(pr, cfg);

  // Drafts stay quiet unless somebody has actually reviewed them.
  const draftAndUntouched = pr.isDraft && reviewer === null;
  if (draftAndUntouched) {
    receipts.push('draft with no reviewer activity');
    return done('draft', receipts, null, null);
  }

  if (!pr.isDraft) {
    const conflict = conflictState(pr);
    if (conflict === 'conflicting') {
      receipts.push('branch has merge conflicts');
      return done('blocked-mechanically', receipts, null, null);
    }
    if (conflict === 'unknown') receipts.push('conflict status unknown');
    if (hasFailingCheck(pr.checks)) {
      receipts.push('a required check is failing on the current head');
      return done('blocked-mechanically', receipts, null, null);
    }
  }
  if (pr.mergeStateStatus === 'BLOCKED') {
    receipts.push('blocked by branch protection');
  }

  const escalate = escalationFor(newestHumanReview, receipts);

  // An explicit approval outranks the footer's unresolved count: Reviewable
  // counts its own summary thread, and such approvals merge within minutes
  // (#2720 in 2, #2712 in 6).
  if (newestHumanReview?.state === 'APPROVED' && !hasActivityAfter(pr, cfg, newestHumanReview)) {
    receipts.push(`approved by ${newestHumanReview.author}`);
    return done('ready-to-merge', receipts, newestHumanReview.submittedAt, escalate);
  }

  const court = determineCourt(pr, cfg, receipts);

  if (court === 'me') {
    return done('needs-your-response', receipts, reviewer?.at ?? null, escalate);
  }
  if (court === 'reviewer') {
    return done('waiting-on-reviewer', receipts, mine?.at ?? null, escalate);
  }
  if (court === 'nobody') {
    return done('ready-to-merge', receipts, reviewer?.at ?? null, escalate);
  }

  // No review has ever happened.
  if (local.discordPostedAt !== null) {
    const hours = (now.getTime() - Date.parse(local.discordPostedAt)) / 3_600_000;
    receipts.push(`posted to Discord ${Math.floor(hours)}h ago, no reviewer activity`);
    if (hours > cfg.staleAfterHours) receipts.push('stale — consider re-pinging');
    return done('asked-no-looks', receipts, local.discordPostedAt, escalate);
  }
  if (pr.isDraft) return done('draft', receipts, null, escalate);
  receipts.push('not yet posted for review');
  return done('not-asked', receipts, null, escalate);
}

/**
 * The footer is the primary court signal, taken from the newest review by
 * anyone — the user replies through Reviewable too (#2635). A footer is a
 * snapshot: if anything happened after its review, it is stale and the
 * timestamp comparison decides instead.
 */
export function determineCourt(
  pr: PrInput,
  cfg: Config,
  receipts: string[] = [],
): Court {
  const newestReview = [...pr.reviews]
    .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .at(-1);

  const footer = newestReview ? parseFooter(newestReview.bodyText) : null;

  if (newestReview && footer && !hasActivityAfter(pr, cfg, newestReview)) {
    receipts.push(footerReceipt(newestReview, footer));
    if (footer.waitingOn.includes(cfg.me)) return 'me';
    if (footer.waitingOn.length > 0) return 'reviewer';
    if (footer.discussions === 'resolved' && footer.files === 'all') return 'nobody';
    return 'reviewer';
  }

  const reviewer = lastReviewerActivity(pr, cfg);
  const mine = lastMyActivity(pr, cfg);
  if (reviewer === null) return 'unknown';

  if (mine !== null && mine.at > reviewer.at) {
    receipts.push(`you ${mine.what} after ${reviewer.who}'s last activity`);
    return 'reviewer';
  }
  receipts.push(`${reviewer.who} acted after your last activity`);
  return 'me';
}

function footerReceipt(review: ReviewInput, footer: Footer): string {
  const who = footer.waitingOn.length > 0
    ? `waiting on ${footer.waitingOn.join(' and ')}`
    : 'nobody waiting';
  const open = footer.discussions === 'resolved'
    ? 'all discussions resolved'
    : `${footer.discussions.unresolved} unresolved`;
  return `footer on ${review.author}'s review: ${open}, ${who}`;
}

/** True when any qualifying activity postdates the given review. */
function hasActivityAfter(pr: PrInput, cfg: Config, review: ReviewInput): boolean {
  const reviewer = lastReviewerActivity(pr, cfg);
  const mine = lastMyActivity(pr, cfg);
  const at = review.submittedAt;
  return (reviewer !== null && reviewer.at > at) || (mine !== null && mine.at > at);
}

function latestHumanReview(pr: PrInput, cfg: Config): ReviewInput | null {
  return [...pr.reviews]
    .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
    .filter((r) => isHumanReviewer(r.author, cfg))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .at(-1) ?? null;
}

export interface Escalation {
  reason: EscalationReason;
  reviewId: string;
}

function escalationFor(
  review: ReviewInput | null,
  receipts: string[],
): Escalation | null {
  if (review === null) return null;
  if (review.state === 'APPROVED' && BLOCKING_LANGUAGE.test(review.bodyText)) {
    receipts.push('approval mentions a blocker — checking');
    return { reason: 'approved-with-blocking-language', reviewId: review.id };
  }
  if (review.state === 'COMMENTED' && parseFooter(review.bodyText) === null) {
    receipts.push('commented review with no footer — checking');
    return { reason: 'commented-no-footer', reviewId: review.id };
  }
  return null;
}

function done(
  bucket: Classification['bucket'],
  receipts: string[],
  displayTime: string | null,
  escalation: Escalation | null,
): Classification {
  return {
    bucket,
    receipts,
    displayTime,
    escalate: escalation?.reason ?? null,
    escalateReviewId: escalation?.reviewId ?? null,
    verdict: null,
  };
}
