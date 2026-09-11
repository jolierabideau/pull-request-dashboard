import type { BoardItem } from './api';
import { markPostedToDiscord } from './api';

const DOT: Record<BoardItem['checkDot'], string> = {
  fail: '#d64545', pending: '#c98a20', pass: '#3f9142', none: 'transparent',
};

const ago = (iso: string | null): string => {
  if (iso === null) return '';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
};

export function Card({ item, onChange }: {
  item: BoardItem;
  onChange: () => void;
}) {
  const post = async () => {
    await markPostedToDiscord(item.number, true);
    onChange();
  };

  return (
    <li className="card">
      <div className="card-head">
        <span className="dot" style={{ background: DOT[item.checkDot] }} />
        <a href={item.url} target="_blank" rel="noreferrer">
          #{item.number} {item.title}
        </a>
        <span className="age">{ago(item.displayTime)}</span>
      </div>

      <ul className="receipts">
        {item.receipts.map((receipt) => <li key={receipt}>{receipt}</li>)}
      </ul>

      {item.verdict !== null && item.verdict.asks.length > 0 && (
        <ul className="asks">
          {item.verdict.asks.map((ask) => <li key={ask}>{ask}</li>)}
        </ul>
      )}

      {(item.bucket === 'not-asked' || item.bucket === 'draft') && (
        <button type="button" onClick={post}>Posted to Discord</button>
      )}
    </li>
  );
}
