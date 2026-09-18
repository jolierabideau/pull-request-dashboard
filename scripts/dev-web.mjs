// Starts the Vite dev server through its Node API rather than the `vite` CLI binary.
//
// This is deliberate, not incidental. paranext-core's `npm stop` (stop-processes.mjs) walks
// every process on the machine and kills any whose command line contains "vite", scoped only
// by a hardcoded list of excluded paths. Running `node_modules/.bin/vite` put that substring
// in our command line, so stopping a sibling repo also stopped this dashboard: killing the
// web server made run-p exit, which took the API down with it. Launched this way the command
// line is just `node scripts/dev-web.mjs`, which matches none of its search terms.
import { createServer } from 'vite';

const server = await createServer({ configFile: 'client/vite.config.ts' });
await server.listen();
server.printUrls();
