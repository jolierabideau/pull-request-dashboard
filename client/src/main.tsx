import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const style = document.createElement('style');
style.textContent = `
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #faf9f7; color: #1c1b19; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; } h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #6b6862; margin-top: 28px; }
  .banner { background: #fdf3d7; border: 1px solid #e8d9a0; padding: 8px 12px; border-radius: 6px; }
  .cards { list-style: none; padding: 0; display: grid; gap: 10px; }
  .card { background: #fff; border: 1px solid #e6e3dd; border-radius: 8px; padding: 12px 14px; }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .card-head a { color: inherit; text-decoration: none; font-weight: 600; flex: 1; }
  .card-head a:hover { text-decoration: underline; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .age { color: #8a867f; font-variant-numeric: tabular-nums; }
  .receipts, .asks { margin: 8px 0 0; padding-left: 18px; color: #6b6862; font-size: 13px; }
  .asks { color: #1c1b19; }
  button { margin-top: 10px; font: inherit; padding: 5px 10px; border-radius: 6px;
           border: 1px solid #d4d0c8; background: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #171614; color: #ece9e3; }
    .card { background: #201f1c; border-color: #35332e; }
    .receipts { color: #9b968d; }
    button { background: #201f1c; color: inherit; border-color: #35332e; }
  }
`;
document.head.append(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
