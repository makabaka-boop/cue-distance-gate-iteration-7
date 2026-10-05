import Fastify, { type FastifyInstance } from 'fastify';
import { boundedCueDistance } from './distance.js';
import { PerformanceStore } from './performance.js';
import { ApiError, parseCompareBody, parsePerformanceCommand } from './validation.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Two 50_000-element int32 arrays serialise to roughly 1.2 MB of JSON.
    bodyLimit: 16 * 1024 * 1024,
  });

  const performances = new PerformanceStore();

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.statusCode)
        .send({
          error: {
            code: err.code,
            message: err.message,
            ...(err.reason ? { reason: err.reason } : {}),
          },
        });
    }
    const statusCode =
      typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (statusCode === 413) {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
      });
    }
    if (statusCode === 400) {
      // Fastify body-parser failures (malformed JSON, empty body, ...).
      return reply.code(400).send({
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
      });
    }
    app.log.error(err);
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post('/api/distance', async (req, reply) => {
    const { a, b, k } = parseCompareBody(req.body);
    const result = boundedCueDistance(a, b, k);
    const lengths = { a: a.length, b: b.length };
    if (result.status === 'ok') {
      return reply.send({ status: 'ok', distance: result.distance, k, lengths });
    }
    return reply.send({ status: 'exceeded', k, lengths });
  });

  // --- independent performance session console ---------------------------

  app.post('/api/performances/commands', async (req) => {
    const command = parsePerformanceCommand(req.body);
    // dispatch() enqueues onto the per-session serial adjudication chain;
    // the returned snapshot is the committed post-decision state.
    const session = await performances.dispatch(command);
    return { status: 'ok', performance: session };
  });

  app.get<{ Params: { id: string } }>('/api/performances/:id', async (req) => {
    return { status: 'ok', performance: performances.get(req.params.id) };
  });

  return app;
}
