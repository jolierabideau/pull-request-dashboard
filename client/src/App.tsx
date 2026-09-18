import { useCallback, useEffect, useState } from 'react';
import { fetchBoard, type Board } from './api';
import { BUCKET_LABEL, BUCKET_ORDER, EXPANDED, type Bucket } from './buckets';
import { Card } from './Card';

const formatFetchedAt = (iso: string | null): string => {
  if (iso === null) return 'an unknown time';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await fetchBoard());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const n = board?.yourCourtCount ?? 0;
    const base = n > 0 ? `(${n}) PR Dashboard` : 'PR Dashboard';
    document.title = failed ? `⚠ ${base}` : base;
  }, [board?.yourCourtCount, failed]);

  if (board === null) return <main><p>{failed ? 'API unreachable.' : 'Loading…'}</p></main>;

  // Cards age against the moment the board was built, so their ages agree with
  // the verdicts computed at that moment. Only the pre-first-poll shell has no
  // `fetchedAt`, and it has no cards to age.
  const asOf = board.fetchedAt === null ? Date.now() : Date.parse(board.fetchedAt);

  return (
    <main>
      <h1>{board.yourCourtCount} in your court</h1>

      {failed && (
        <p className="banner">
          Cannot reach the dashboard API — showing last-known data from{' '}
          {formatFetchedAt(board.fetchedAt)}. Will keep retrying every 30s.
        </p>
      )}

      {board.stale && (
        <p className="banner">
          Showing the last good data{board.error === null ? '' : ` — ${board.error}`}
        </p>
      )}

      {BUCKET_ORDER.map((bucket: Bucket) => {
        const items = board.items.filter((i) => i.bucket === bucket);
        if (items.length === 0) return null;
        return (
          <section key={bucket}>
            <h2>{BUCKET_LABEL[bucket]} ({items.length})</h2>
            {EXPANDED.has(bucket) ? (
              <ul className="cards">
                {items.map((item) => (
                  <Card
                    key={item.number}
                    item={item}
                    now={asOf}
                    onChange={() => void load()}
                  />
                ))}
              </ul>
            ) : (
              <details>
                <summary>{items.length} hidden</summary>
                <ul className="cards">
                  {items.map((item) => (
                    <Card
                      key={item.number}
                      item={item}
                      now={asOf}
                      onChange={() => void load()}
                    />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}

      {board.branches.length > 0 && (
        <details>
          <summary>Local branches ({board.branches.length})</summary>
          {/*
            A plain list of local branches, not a claim about unsubmitted work:
            we do not fetch headRefName, so we cannot tell which branches have
            PRs. The only distinction we can honestly draw is a gone upstream.
          */}
          <ul>
            {board.branches.map((b) => (
              <li key={b.name}>
                {b.name}
                {b.bucket === 'dead-branch' && ' — upstream gone'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
