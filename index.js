import { generatePrediction, readContext, generateRewrite, readRewriteContext } from './prediction.js';

export const inject = ['connection', 'llm', 'sessions', 'agents'];
const ROUTE = '/api/local-composer-predictions/next';
const DEADLINE_MS = 12000;
const FRESHNESS_MS = 15 * 60 * 1000;

function generateWithinDeadline(llm, context, controller, generate = generatePrediction) {
  const { signal } = controller;
  if (signal.aborted) return Promise.resolve(null);
  const { promise: cancelled, resolve } = Promise.withResolvers();
  const onAbort = () => resolve(null);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);

  // Release waiters even if the provider has not reacted to the abort signal.
  return Promise.race([cancelled, generate(llm, context, signal)])
    .catch(() => null)
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
    latest.set(session.id, { session, event, context: undefined, auto: undefined, autoValue: undefined, manual: undefined, active: undefined });
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
        const result = await generateWithinDeadline(ctx.llm, context, controller,
          (llm, value, signal) => generateRewrite(llm, value, body.draft, signal));
        return response(controller.signal.aborted || ctx.sessions.get(id) !== session ? null : result);
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
      const response = (suggestion = null, retryTurn = null) => Response.json({ suggestion, retryTurn }, {
        headers: { 'cache-control': 'no-store' },
      });
      const entry = latest.get(id);
      if (entry === undefined || request.signal.aborted) return response();
      if (Date.now() - entry.event.time > FRESHNESS_MS) {
        clear(id);
        return response();
      }
      const start = () => {
        const controller = new AbortController();
        entry.active = controller;
        return generateWithinDeadline(ctx.llm, entry.context, controller);
      };
      let result;
      if (params.has('retry')) {
        if (params.get('retry') !== String(entry.event.seq) || entry.autoValue !== null || !entry.context) return response();
        result = entry.manual ??= start();
      } else {
        if (entry.manual !== undefined) {
          result = entry.manual;
        } else {
          if (entry.auto === undefined) {
            entry.context = readContext(entry.session, entry.event);
            entry.auto = entry.context === null ? Promise.resolve(null) : start();
            entry.auto = entry.auto.then(value => { entry.autoValue = value; return value; });
          }
          result = entry.auto;
        }
      }
      const suggestion = await result ?? null;
      if (latest.get(id) !== entry || request.signal.aborted) return response();
      if (Date.now() - entry.event.time > FRESHNESS_MS) {
        clear(id);
        return response();
      }
      const retryTurn = suggestion === null && entry.context && entry.autoValue === null && entry.manual === undefined
        ? entry.event.seq : null;
      return response(suggestion, retryTurn);
    },
  });
}
