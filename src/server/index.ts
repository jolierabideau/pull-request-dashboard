import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { notificationsSupported } from '../notify/osascript.js';
import { openStore } from '../store/db.js';
import {
  describeAddressInUse,
  exitWhenOrphaned,
  findPortHolder,
  liveProcesses,
  ownSupervisors,
  printSync,
} from './lifecycle.js';
import { createPoller } from './poller.js';
import { registerRoutes } from './routes.js';

const API_LABEL = { name: 'API', command: 'npm run dev' };

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
  supervisors: ownSupervisors(),
  liveProcesses,
  onOrphaned: () => {
    printSync('stdout', 'Whatever started this server is gone; shutting down.');
    process.exit(0);
  },
});

const port = Number(process.env.PORT ?? 5174);
try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  printSync('stderr', describeAddressInUse(port, findPortHolder(port), API_LABEL));
  process.exit(1);
}
console.log(`PR dashboard API on http://127.0.0.1:${port}`);
