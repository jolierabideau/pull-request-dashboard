import type { Classification, Config, PrInput, ReviewInput } from '../types.js';
import { lastActivityOf } from './activity.js';
import { parseFooter } from './footer.js';

type Reviewing = Extract<
  Classification['bucket'], 'review-needs-you' | 'review-waiting-on-author' | 'review-approved'
>;

/**
 * Sorts someone else's PR, which `cfg.me` has reviewed or commented on, by whose
 * turn it is. Pure: no I/O, no clock. Rules run in order and the first match
 * wins; each pushes a plain-English receipt.
 */
export function classifyReviewing(pr: PrInput, cfg: Config): Classification {
  const receipts: string[] = pr.isDraft ? ['draft'] : [];
  const { author } = pr;
  const me = cfg.me;

  const mine = lastActivityOf(pr, me, { commits: false, threads: true });
  const theirs = lastActivityOf(pr, author, { commits: true, threads: true });

  // 1. A Reviewable footer is a snapshot: it decides only while nothing by the
  // user or the author postdates the review that carries it.
  const footerReview = newestFooterReview(pr);
  if (footerReview !== null) {
    const { review, waitingOn } = footerReview;
    const stale = (mine !== null && mine.at > review.submittedAt)
      || (theirs !== null && theirs.at > review.submittedAt);
    if (!stale) {
      if (waitingOn.includes(me)) {
        receipts.push('Reviewable is waiting on you');
        return done('review-needs-you', receipts, review.submittedAt);
      }
      receipts.push(`Reviewable is waiting on ${waitingOn.join(' and ')}`);
      return done('review-waiting-on-author', receipts, review.submittedAt);
    }
  }

  // 2. A re-request is GitHub saying the user's review is wanted again.
  if (pr.requestedReviewers.includes(me)) {
    receipts.push('your review was re-requested');
    return done('review-needs-you', receipts, null);
  }

  // 3. Reviewable approvals survive pushes, so only a comment from the author
  // pulls an approval back.
  const myReview = latestSubmittedReview(pr, me);
  if (myReview?.state === 'APPROVED') {
    const authorComment = lastActivityOf(pr, author, { commits: false, threads: true });
    if (authorComment === null || authorComment.at <= myReview.submittedAt) {
      receipts.push(`you approved; nothing new from ${author} since`);
      return done('review-approved', receipts, myReview.submittedAt);
    }
  }

  // 4. Whoever acted last has handed the ball to the other.
  if (theirs !== null && (mine === null || theirs.at > mine.at)) {
    const verb = theirs.what === 'pushed' ? 'pushed' : 'replied';
    receipts.push(
      mine === null
        ? `${author} ${verb}; you have not acted yet`
        : `${author} ${verb} after your last review`,
    );
    return done('review-needs-you', receipts, theirs.at);
  }
  const verb = mine?.what === 'commented' ? 'commented' : 'reviewed';
  receipts.push(`you ${verb} after ${author}'s last activity`);
  return done('review-waiting-on-author', receipts, mine?.at ?? null);
}

/** The newest submitted review, by anyone, that carries a Reviewable footer. */
function newestFooterReview(
  pr: PrInput,
): { review: ReviewInput; waitingOn: string[] } | null {
  const newest = [...pr.reviews]
    .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
    .filter((r) => parseFooter(r.bodyText) !== null)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .at(-1);
  if (newest === undefined) return null;
  const waitingOn = parseFooter(newest.bodyText)?.waitingOn ?? [];
  return waitingOn.length > 0 ? { review: newest, waitingOn } : null;
}

function latestSubmittedReview(pr: PrInput, login: string): ReviewInput | null {
  return [...pr.reviews]
    .filter((r) => r.author === login)
    .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED')
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    .at(-1) ?? null;
}

function done(bucket: Reviewing, receipts: string[], displayTime: string | null): Classification {
  return {
    bucket, receipts, displayTime, escalate: null, escalateReviewId: null, verdict: null,
  };
}
