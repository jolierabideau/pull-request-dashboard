export interface BoardItem {
  /** `owner/name`; with `number` it identifies the PR. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Login of the PR's author. */
  author: string;
  /** 'author' for the user's own PRs, 'reviewer' for other people's. */
  role: 'author' | 'reviewer';
  bucket: string;
  receipts: string[];
  displayTime: string | null;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
  verdict: { asks: string[] } | null;
}

export interface NotificationEvent {
  id: number;
  title: string;
  body: string;
  url: string;
  at: string;
}

export interface Board {
  items: BoardItem[];
  reviewing: BoardItem[];
  branches: { name: string; bucket: string }[];
  yourCourtCount: number;
  myCourtCount: number;
  reviewCourtCount: number;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  notifications: NotificationEvent[];
  epoch: string;
}

export const fetchBoard = async (): Promise<Board> => {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as Board;
};

export const markPostedToDiscord = async (
  repo: string, number: number, posted: boolean,
): Promise<void> => {
  await fetch(`/api/pr/${repo}/${number}/discord`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posted }),
  });
};
