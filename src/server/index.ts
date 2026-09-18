import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { notificationsSupported } from '../notify/osascript.js';
import { openStore } from '../store/db.js';
import {
  describeAddressInUse,
  exitWhenOrphaned,
  findPortHolder,
  livePids,
  ownAncestors,
} from './lifecycle.js';
import { createPoller } from './poller.js';
import { registerRoutes } from './routes.js';

const config = loadConfig(process.env.PRD_CONFIG ?? 'config.json');
const store = openStore(process.env.PRD_DB ?? 'pr-dashboard.db');
const poller = createPoller(config, store);

console.log(`Tracking ${config.me} on ${config.owner}/${config.name} (${config.repoPath})`);
if (!notificationsSupported()) {
  console.log('Desktop notifications are macOS-only; the board still works.');
}

const app = Fastify({ logger: { level: 'warn' } });
registerRoutes(app, poller, store);

poller.start();

// `run-p` cannot always stop us on its way out, and a surviving API keeps the
// port against the next `npm run dev`. Stop ourselves instead.
exitWhenOrphaned({
  ancestors: ownAncestors(),
  livePids,
  onOrphaned: () => {
    console.log('Whatever started this server is gone; shutting down.');
    process.exit(0);
  },
});

const port = Number(process.env.PORT ?? 5174);
try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  console.error(describeAddressInUse(port, findPortHolder(port)));
  process.exit(1);
}
console.log(`PR dashboard API on http://127.0.0.1:${port}`);
