export interface BoardItem {
  number: number;
  title: string;
  url: string;
  bucket: string;
  receipts: string[];
  displayTime: string | null;
  checkDot: 'fail' | 'pending' | 'pass' | 'none';
  verdict: { asks: string[] } | null;
}

export interface Board {
  items: BoardItem[];
  branches: { name: string; bucket: string }[];
  yourCourtCount: number;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
}

export const fetchBoard = async (): Promise<Board> => {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return (await response.json()) as Board;
};

export const markPostedToDiscord = async (
  number: number, posted: boolean,
): Promise<void> => {
  await fetch(`/api/pr/${number}/discord`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posted }),
  });
};
