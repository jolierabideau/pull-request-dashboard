import type { FastifyInstance } from 'fastify';
import type { Poller } from './poller.js';
import type { Store } from '../store/db.js';
import { prKey } from '../pr-key.js';

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export function registerRoutes(
  app: FastifyInstance, poller: Poller, store: Store,
): void {
  app.get('/api/board', async (_request, reply) => {
    const board = poller.snapshot();
    if (board === null) {
      return reply.send({
        items: [], reviewing: [], branches: [],
        yourCourtCount: 0, myCourtCount: 0, reviewCourtCount: 0,
        fetchedAt: null, stale: true, error: 'no data yet — retrying',
        notifications: [], epoch: '',
      });
    }
    return reply.send(board);
  });

  app.post<{ Params: { owner: string; name: string; number: string }; Body: { posted: boolean } }>(
    '/api/pr/:owner/:name/:number/discord',
    async (request, reply) => {
      const { owner, name } = request.params;
      const number = Number(request.params.number);
      if (!Number.isInteger(number)) {
        return reply.code(400).send({ error: 'bad PR number' });
      }
      if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(name)) {
        return reply.code(400).send({ error: 'bad repo' });
      }
      store.setDiscordPostedAt(
        prKey(`${owner}/${name}`, number),
        request.body?.posted === false ? null : new Date().toISOString(),
      );
      await poller.refresh();
      return reply.send({ ok: true });
    },
  );
}
