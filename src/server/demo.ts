/**
 * A board built from the captured fixtures in tests/fixtures/, served without
 * touching GitHub, `gh`, a local clone, Claude, or your notification state.
 *
 * It exists so a teammate can see what the dashboard looks like before wiring
 * up a config of their own, and so the README screenshot is reproducible.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import {
  describeAddressInUse,
  exitWhenOrphaned,
  findPortHolder,
  livePids,
  ownAncestors,
} from './lifecycle.js';
import { buildBoard, type Board } from './poller.js';
import { openStore, type Store } from '../store/db.js';
import type { BranchInput, Config, PrInput } from '../types.js';

/** The PRs captured by scripts/capture-fixtures.ts. */
const FIXTURES = [2717, 2720, 2664, 2742, 2795, 2796, 2687, 2635, 2180];

/**
 * The config the fixtures were captured against. `repoPath` is never read:
 * demo mode supplies its own branches rather than shelling into a clone.
 */
export const DEMO_CONFIG: Config = {
  repoPath: '/nonexistent',
  owner: 'paranext',
  name: 'paranext-core',
  me: 'jolierabideau',
  botLogins: ['devin-ai-integration'],
  pollIntervalMs: 180_000,
  staleAfterHours: 48,
};

/**
 * Pinned so the board — and therefore the screenshot — is identical on every
 * run. The fixtures were captured around this moment, so relative ages read
 * sensibly against it. The client reads its ages off `fetchedAt` rather than
 * the wall clock, so the card ages stay pinned to this moment too.
 */
export const DEMO_NOW = new Date('2026-09-11T12:00:00Z');

const DEMO_BRANCHES: BranchInput[] = [
  { name: 'feature/paratext-sync', upstreamGone: false, aheadOfMain: 3, prNumber: null },
  { name: 'fix/menu-crash', upstreamGone: true, aheadOfMain: 1, prNumber: null },
];

const loadFixture = (n: number): PrInput =>
  JSON.parse(
    readFileSync(new URL(`../../tests/fixtures/pr-${n}.json`, import.meta.url), 'utf8'),
  ) as PrInput;

/**
 * Builds the demo board. Pass a `store` to keep the Discord state between
 * builds; without one, an in-memory store is opened and closed per call.
 * Either way demo mode never reads or writes the real notification and
 * Discord state in pr-dashboard.db.
 */
export function buildDemoBoard(store?: Store): Board {
  const scratch = store ?? openStore(':memory:');
  try {
    return buildBoard(FIXTURES.map(loadFixture), DEMO_BRANCHES, scratch, DEMO_CONFIG, DEMO_NOW);
  } finally {
    if (store === undefined) scratch.close();
  }
}

export async function serveDemo(port: number): Promise<void> {
  // Held open for the life of the process so that clicking "Posted to
  // Discord" actually moves the card, as it does on the real board.
  const store = openStore(':memory:');
  let board = buildDemoBoard(store);

  const app = Fastify({ logger: false });
  app.get('/api/board', async (_request, reply) => reply.send(board));

  app.post<{ Params: { number: string }; Body: { posted: boolean } }>(
    '/api/pr/:number/discord',
    async (request, reply) => {
      const number = Number(request.params.number);
      if (!Number.isInteger(number)) {
        return reply.code(400).send({ error: 'bad PR number' });
      }
      // Stamped with the pinned clock, not the wall clock, so the receipt
      // ("posted to Discord Nh ago") stays reproducible.
      store.setDiscordPostedAt(
        number,
        request.body?.posted === false ? null : DEMO_NOW.toISOString(),
      );
      board = buildDemoBoard(store);
      return reply.send({ ok: true });
    },
  );

  await app.listen({ port, host: '127.0.0.1' });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // `npm run demo` runs under `run-p` exactly as `npm run dev` does, so it can
  // be stranded holding the port the same way. See ./lifecycle.ts.
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
    await serveDemo(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    console.error(describeAddressInUse(port, findPortHolder(port)));
    process.exit(1);
  }
  console.log(`Demo board (${FIXTURES.length} captured PRs) on http://127.0.0.1:${port}`);
  console.log('No GitHub access, no notifications, no writes to your database.');
}
