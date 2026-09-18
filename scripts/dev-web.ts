// Starts the Vite dev server through its Node API rather than the `vite` CLI binary.
//
// This is deliberate, not incidental. paranext-core's `npm stop` (stop-processes.mjs) walks
// every process on the machine and kills any whose command line contains "vite", scoped only
// by a hardcoded list of excluded paths. Running `node_modules/.bin/vite` put that substring
// in our command line, so stopping a sibling repo also stopped this dashboard: killing the
// web server made run-p exit, which took the API down with it. Launched this way the command
// line is just `node --import tsx/esm scripts/dev-web.ts`, which matches none of its search
// terms.
import { createServer } from 'vite';
import {
  describeAddressInUse,
  exitWhenOrphaned,
  findPortHolder,
  liveProcesses,
  ownSupervisors,
  printSync,
} from '../src/server/lifecycle.js';

// The web server can be stranded by a collapsing `run-p` exactly as the API can, and a
// surviving Vite holds port 5173 — which, with `strictPort` set, is where the next run stops
// rather than quietly moving to 5174 and taking the API's port. See src/server/lifecycle.ts.
exitWhenOrphaned({
  supervisors: ownSupervisors(),
  liveProcesses,
  onOrphaned: () => {
    printSync('stdout', 'Whatever started this server is gone; shutting down.');
    process.exit(0);
  },
});

const server = await createServer({ configFile: 'client/vite.config.ts' });
const port = server.config.server.port ?? 5173;
try {
  await server.listen();
} catch (error) {
  // `strictPort` keeps Vite off the API's 5174, at the cost of a bare stack
  // trace — so say who holds the port, as the API does. Vite's error carries
  // no `code`, so the holder is what tells us this is a collision at all.
  const holder = findPortHolder(port);
  if (holder === undefined) throw error;
  printSync('stderr', describeAddressInUse(port, holder, { name: 'web server' }));
  process.exit(1);
}
server.printUrls();
