import type { FastifyInstance } from 'fastify';
import type { Poller } from './poller.js';
import type { Store } from '../store/db.js';

export function registerRoutes(
  app: FastifyInstance, poller: Poller, store: Store,
): void {
  app.get('/api/board', async (_request, reply) => {
    const board = poller.snapshot();
    if (board === null) {
      return reply.send({
        items: [], branches: [], yourCourtCount: 0,
        fetchedAt: null, stale: true, error: 'no data yet — retrying',
      });
    }
    return reply.send(board);
  });

  app.post<{ Params: { number: string }; Body: { posted: boolean } }>(
    '/api/pr/:number/discord',
    async (request, reply) => {
      const number = Number(request.params.number);
      if (!Number.isInteger(number)) {
        return reply.code(400).send({ error: 'bad PR number' });
      }
      store.setDiscordPostedAt(
        number,
        request.body?.posted === false ? null : new Date().toISOString(),
      );
      await poller.refresh();
      return reply.send({ ok: true });
    },
  );
}
