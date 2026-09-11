import { useCallback, useEffect, useState } from 'react';
import { fetchBoard, type Board } from './api';
import { BUCKET_LABEL, BUCKET_ORDER, EXPANDED, type Bucket } from './buckets';
import { Card } from './Card';

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
    document.title = n > 0 ? `(${n}) PR Dashboard` : 'PR Dashboard';
  }, [board?.yourCourtCount]);

  if (board === null) return <main><p>{failed ? 'API unreachable.' : 'Loading…'}</p></main>;

  return (
    <main>
      <h1>{board.yourCourtCount} in your court</h1>

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
                  <Card key={item.number} item={item} onChange={() => void load()} />
                ))}
              </ul>
            ) : (
              <details>
                <summary>{items.length} hidden</summary>
                <ul className="cards">
                  {items.map((item) => (
                    <Card key={item.number} item={item} onChange={() => void load()} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}

      {board.branches.length > 0 && (
        <details>
          <summary>{board.branches.length} local branches</summary>
          <ul>
            {board.branches.map((b) => (
              <li key={b.name}>{b.name} — {b.bucket}</li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
