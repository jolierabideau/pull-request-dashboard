export const BUCKET_ORDER = [
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
  'waiting-on-reviewer', 'asked-no-looks', 'not-asked', 'draft',
] as const;

export type Bucket = (typeof BUCKET_ORDER)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  'blocked-mechanically': 'Blocked on you',
  'needs-your-response': 'Needs your response',
  'ready-to-merge': 'Ready to merge',
  'waiting-on-reviewer': 'Waiting on reviewer',
  'asked-no-looks': 'Asked, nobody has looked',
  'not-asked': 'Not asked yet',
  draft: 'Drafts',
};

export const REVIEW_BUCKET_ORDER = [
  'review-needs-you', 'review-waiting-on-author', 'review-approved', 'review-quiet',
] as const;

export type ReviewBucket = (typeof REVIEW_BUCKET_ORDER)[number];

export const REVIEW_BUCKET_LABEL: Record<ReviewBucket, string> = {
  'review-needs-you': 'Needs your review',
  'review-waiting-on-author': 'Waiting on author',
  'review-approved': 'You approved',
  'review-quiet': 'Gone quiet',
};

/** Buckets rendered expanded by default; the rest collapse to one line. */
export const EXPANDED: Set<string> = new Set<Bucket | ReviewBucket>([
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge', 'review-needs-you',
]);
