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

/** Buckets rendered expanded by default; the rest collapse to one line. */
export const EXPANDED: Set<Bucket> = new Set([
  'blocked-mechanically', 'needs-your-response', 'ready-to-merge',
]);
