/**
 * A board built from the captured fixtures in tests/fixtures/, served without
 * touching GitHub, `gh`, a local clone, Claude, or your notification state.
 *
 * It exists so a teammate can see what the dashboard looks like before wiring
 * up a config of their own, and so the README screenshot is reproducible.
 */
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { buildBoard, type Board } from './poller.js';
import { openStore } from '../store/db.js';
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
 * sensibly against it.
 */
const DEMO_NOW = new Date('2026-09-11T12:00:00Z');

const DEMO_BRANCHES: BranchInput[] = [
  { name: 'feature/paratext-sync', upstreamGone: false, aheadOfMain: 3, prNumber: null },
  { name: 'fix/menu-crash', upstreamGone: true, aheadOfMain: 1, prNumber: null },
];

const loadFixture = (n: number): PrInput =>
  JSON.parse(
    readFileSync(new URL(`../../tests/fixtures/pr-${n}.json`, import.meta.url), 'utf8'),
  ) as PrInput;

export function buildDemoBoard(): Board {
  // An in-memory store keeps demo mode from reading or writing the real
  // notification and Discord state in pr-dashboard.db.
  const store = openStore(':memory:');
  try {
    return buildBoard(FIXTURES.map(loadFixture), DEMO_BRANCHES, store, DEMO_CONFIG, DEMO_NOW);
  } finally {
    store.close();
  }
}

export async function serveDemo(port: number): Promise<void> {
  const board = buildDemoBoard();
  const app = Fastify({ logger: false });
  app.get('/api/board', async (_request, reply) => reply.send(board));
  // Accepted and discarded: the button should not error in the demo, but
  // there is no real state to move.
  app.post('/api/pr/:number/discord', async (_request, reply) => reply.send({ ok: true }));
  await app.listen({ port, host: '127.0.0.1' });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 5174);
  await serveDemo(port);
  console.log(`Demo board (${FIXTURES.length} captured PRs) on http://127.0.0.1:${port}`);
  console.log('No GitHub access, no notifications, no writes to your database.');
}
