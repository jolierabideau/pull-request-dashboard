export type ReviewState =
  | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface Footer {
  /** 'all' when every file is reviewed, else the partial counts. */
  files: 'all' | { reviewed: number; total: number };
  /** 'resolved' when no discussions are open, else the open count. */
  discussions: 'resolved' | { unresolved: number };
  /** Logins named in "(waiting on ...)". Empty when the clause is absent. */
  waitingOn: string[];
  /** True only for the literal "complete!" form. */
  complete: boolean;
}

export interface ReviewInput {
  id: string;
  author: string;
  state: ReviewState;
  submittedAt: string;
  bodyText: string;
  lastEditedAt: string | null;
}

export interface CommentInput { author: string; createdAt: string }

export interface CommitInput {
  oid: string;
  committedDate: string;
  authorLogin: string | null;
  authorEmail: string | null;
  messageHeadline: string;
  parentCount: number;
}

export interface ThreadInput {
  isResolved: boolean;
  lastCommentAuthor: string;
  lastCommentAt: string;
}

export interface CheckContext {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PrInput {
  /** The `owner/name` the PR lives in. Together with `number` it identifies the PR. */
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  reviews: ReviewInput[];
  comments: CommentInput[];
  commits: CommitInput[];
  threads: ThreadInput[];
  checks: CheckContext[];
}

export interface BranchInput {
  name: string;
  upstreamGone: boolean;
  aheadOfMain: number;
  prNumber: number | null;
}

export interface LocalState { discordPostedAt: string | null }

export type Bucket =
  | 'blocked-mechanically'
  | 'needs-your-response'
  | 'ready-to-merge'
  | 'waiting-on-reviewer'
  | 'asked-no-looks'
  | 'not-asked'
  | 'draft'
  | 'unsubmitted-branch'
  | 'dead-branch';

export type EscalationReason =
  | 'commented-no-footer'
  | 'approved-with-blocking-language';

export interface ClaudeVerdict {
  court: 'me' | 'reviewer';
  blockingCount: number;
  asks: string[];
  confidence: 'high' | 'low';
}

export interface Classification {
  bucket: Bucket;
  receipts: string[];
  displayTime: string | null;
  escalate: EscalationReason | null;
  /** Which review the escalation is about. Non-null exactly when escalate is. */
  escalateReviewId: string | null;
  verdict: ClaudeVerdict | null;
}

export type Scope = 'repo' | 'org';

export interface Config {
  /** The home repo's local clone; the branch list reads it. */
  repoPath: string;
  /** Owner of the home repo; also the org searched when `scope` is 'org'. */
  owner: string;
  name: string;
  /** 'repo' tracks only owner/name; 'org' tracks every repo of `owner`. Defaults to 'repo'. */
  scope?: Scope;
  me: string;
  botLogins: string[];
  pollIntervalMs: number;
  staleAfterHours: number;
}
