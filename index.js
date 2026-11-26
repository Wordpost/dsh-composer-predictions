import { generatePrediction, readContext, generateRewrite, readRewriteContext } from './prediction.js';

export const inject = ['connection', 'llm', 'sessions', 'agents'];
const ROUTE = '/api/local-composer-predictions/next';
const DEADLINE_MS = 12000;
const FRESHNESS_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 4; // One automatic attempt and up to three manual attempts after errors.

function generateWithinDeadline(controller, generate) {
  const { signal } = controller;
  if (signal.aborted) return Promise.resolve({ reason: 'cancelled' });
  const { promise: cancelled, resolve } = Promise.withResolvers();
  let timedOut = false;
  const onAbort = () => resolve({ reason: timedOut ? 'timeout' : 'cancelled' });
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS);

  // Release waiters even if the provider has not reacted to the abort signal.
  return Promise.race([cancelled, generate(signal)])
    .catch(failure => ({ reason: failure?.status === 429 ? 'rateLimited' : 'modelError' }))
    .finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
}

export function apply(ctx) {
  const latest = new Map();
  const rewrites = new Map();
  let disposed = false;

  function clear(id) {
    const entry = latest.get(id);
    if (entry === undefined) return;
    latest.delete(id);
    entry.active?.abort();
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') rewrites.get(session.id)?.abort();
    if (event.type === 'turn/start' || event.type === 'turn/end') clear(session.id);
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed'
      || session.header.origin === 'subagent' || !session.isOwnSeq(event.seq)) return;
    latest.set(session.id, { session, event, context: undefined, attempt: undefined, active: undefined });
  });
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return;
    clear(agent.id);
    rewrites.get(agent.id)?.abort();
  });
  ctx.on('session/disposed', (session) => { clear(session.id); rewrites.get(session.id)?.abort(); });
  ctx.effect(() => () => {
    disposed = true;
    for (const id of latest.keys()) clear(id);
    for (const controller of rewrites.values()) controller.abort();
  });

  ctx.connection.fetch.register({
    path: '/api/local-composer-predictions/rewrite', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const response = (rewrite = null, status = 200, reason) => Response.json(
        reason ? { rewrite, reason } : { rewrite }, {
          status, headers: { 'cache-control': 'no-store' },
        });
      const id = new URL(request.url).searchParams.get('session');
      let body;
      try { body = await request.json(); } catch { return response(null, 400); }
      if (!id || !body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.draft !== 'string' ||
          !body.draft.trim() || body.draft.length > 2000 || /^\s*\//u.test(body.draft)) return response(null, 400);
      const session = ctx.sessions.get(id);
      if (disposed || request.signal.aborted || !session || session.header?.origin === 'subagent'
          || ctx.agents.turnBoundaryOf(session).openTurnStartSeq !== null) return response(null, 409, 'unavailable');
      if (rewrites.has(id)) return response(null, 409, 'busy');
      const agent = ctx.agents.get(id);
      const context = readRewriteContext(session, agent?.session === session ? agent.model.current() : undefined);
      if (!context) return response(null, 409, 'unavailable');
      const controller = new AbortController();
      rewrites.set(id, controller);
      const onAbort = () => controller.abort();
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) controller.abort();
      try {
        const result = await generateWithinDeadline(controller,
          async signal => ({ rewrite: await generateRewrite(ctx.llm, context, body.draft, signal) }));
        return response(controller.signal.aborted || ctx.sessions.get(id) !== session ? null : result.rewrite ?? null);
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        if (rewrites.get(id) === controller) rewrites.delete(id);
      }
    },
  });

  ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const params = new URL(request.url).searchParams;
      const id = params.get('session');
      const response = ({ suggestion = null, reason } = {}, retry = null) => Response.json({
        suggestion, retry, ...(reason === undefined ? {} : { reason }),
      }, {
        headers: { 'cache-control': 'no-store' },
      });
      const entry = latest.get(id);
      if (entry === undefined || request.signal.aborted) return response();
      if (Date.now() - entry.event.time > FRESHNESS_MS) {
        clear(id);
        return response();
      }
      const retryKey = attempt => `${entry.event.seq}:${attempt}`;
      const canRetry = attempt => attempt.result && !attempt.result.suggestion && attempt.number < MAX_ATTEMPTS
        && (attempt.number === 1 || attempt.result.reason !== undefined);
      const start = number => {
        const controller = new AbortController();
        entry.active = controller;
        const attempt = { number, result: undefined, pending: undefined };
        attempt.pending = generateWithinDeadline(controller, signal => generatePrediction(ctx.llm, entry.context, signal))
          .then(result => {
            if (entry.active === controller) entry.active = undefined;
            return attempt.result = result;
          });
        entry.attempt = attempt;
      };
      const retry = params.get('retry');
      if (retry !== null) {
        const previous = entry.attempt;
        if (previous && retry === retryKey(previous.number) && canRetry(previous)) start(previous.number + 1);
        else if (!previous || previous.number === 1 || retry !== retryKey(previous.number - 1)) return response();
        // Resending the same key joins or retrieves its attempt without starting another model call.
      } else if (!entry.attempt) {
        if (entry.context === undefined) entry.context = readContext(entry.session, entry.event);
        if (!entry.context) return response();
        start(1);
      }
      const attempt = entry.attempt;
      const result = await attempt.pending;
      if (latest.get(id) !== entry || request.signal.aborted) return response();
      if (Date.now() - entry.event.time > FRESHNESS_MS) {
        clear(id);
        return response();
      }
      if (entry.attempt !== attempt) return response();
      return response(result, canRetry(attempt) ? retryKey(attempt.number) : null);
    },
  });
}
