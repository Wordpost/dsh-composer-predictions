import { generatePrediction, readContext, readHistoricalContext, generateRewrite, readRewriteContext } from './prediction.js';

export const inject = ['connection', 'llm', 'sessions', 'agents', 'sessionQuery'];
const ROUTE = '/api/local-composer-predictions/next';
const PREDICTION_DEADLINE_MS = 30000;
const REWRITE_DEADLINE_MS = 12000;
const FRESHNESS_MS = 15 * 60 * 1000;
const MAX_MANUAL_ATTEMPTS = 3;
const MAX_DETACHED_ENTRIES = 32;

function generateWithinDeadline(controller, deadlineMs, generate) {
  const { signal } = controller;
  if (signal.aborted) return Promise.resolve({ reason: 'cancelled' });
  const { promise: cancelled, resolve } = Promise.withResolvers();
  let timedOut = false;
  const onAbort = () => resolve({ reason: timedOut ? 'timeout' : 'cancelled' });
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);

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
  const historyChecks = new Map();
  let disposed = false;

  function trimDetachedCache() {
    const settled = [...latest].filter(([, entry]) => !entry.session && !entry.active && !entry.attempt?.waiters);
    for (let i = 0; i < settled.length - MAX_DETACHED_ENTRIES; i++) clear(settled[i][0]);
  }

  // Keep in-flight history reads invalidatable even before they find a source.
  function startHistoryCheck(id, session) {
    const check = { session, controller: new AbortController(), waiters: 0 };
    const { signal } = check.controller;
    check.pending = (async () => {
      const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none', signal });
      try {
        if (signal.aborted || ctx.sessions.get(id) !== session || observation.header.origin === 'subagent'
          || (observation.source === 'live' && observation.cursor !== session?.seq - 1)) return undefined;
        const cached = latest.get(id);
        if (!session && cached?.historical && cached.revision === observation.revision) return cached;
        const history = readHistoricalContext(observation.events);
        if (cached && !session) {
          latest.delete(id);
          cached.active?.abort();
        }
        if (!history) return undefined;
        const entry = { ...history, session, historical: true, revision: observation.revision,
          keySuffix: `:${crypto.randomUUID().replaceAll('-', '')}` };
        latest.set(id, entry);
        if (!session) trimDetachedCache();
        return entry;
      } finally {
        observation[Symbol.dispose]();
      }
    })().finally(() => { if (historyChecks.get(id) === check) historyChecks.delete(id); });
    historyChecks.set(id, check);
    return check;
  }

  function cancelHistoryCheck(id, check) {
    if (historyChecks.get(id) === check) historyChecks.delete(id);
    check.controller.abort();
  }

  async function historicalEntry(id, session, signal) {
    if (signal.aborted) return undefined;
    const previous = historyChecks.get(id);
    if (previous && previous.session !== session) cancelHistoryCheck(id, previous);
    const check = historyChecks.get(id) ?? startHistoryCheck(id, session);
    const { promise: cancelled, resolve } = Promise.withResolvers();
    const lifetime = AbortSignal.any([signal, check.controller.signal]);
    check.waiters++;
    let waiting = true;
    const release = () => {
      if (!waiting) return;
      waiting = false;
      lifetime.removeEventListener('abort', onAbort);
      if (--check.waiters === 0 && historyChecks.get(id) === check) cancelHistoryCheck(id, check);
    };
    const onAbort = () => { release(); resolve(undefined); };
    lifetime.addEventListener('abort', onAbort, { once: true });
    if (lifetime.aborted) onAbort();
    try {
      return await Promise.race([cancelled, check.pending]);
    } finally {
      release();
    }
  }

  function clear(id) {
    const check = historyChecks.get(id);
    if (check) cancelHistoryCheck(id, check);
    const entry = latest.get(id);
    if (entry === undefined) return;
    latest.delete(id);
    entry.active?.abort();
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') rewrites.get(session.id)?.abort();
    const entry = latest.get(session.id);
    if (event.type === 'turn/end' && entry?.session === session && entry.event.seq === event.seq) return;
    if (event.type === 'turn/start' || event.type === 'turn/end') clear(session.id);
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed'
      || session.header.origin === 'subagent' || event.seq < session.firstLiveSeq || !session.isOwnSeq(event.seq)) return;
    latest.set(session.id, { session, event, context: undefined, attempt: undefined, active: undefined });
  });
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return;
    clear(agent.id);
    rewrites.get(agent.id)?.abort();
  });
  ctx.on('session/created', session => clear(session.id));
  ctx.on('session/disposed', (session) => { clear(session.id); rewrites.get(session.id)?.abort(); });
  ctx.effect(() => () => {
    disposed = true;
    for (const id of historyChecks.keys()) clear(id);
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
        const result = await generateWithinDeadline(controller, REWRITE_DEADLINE_MS,
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
      const response = ({ suggestion = null, reason } = {}, retry = null, turn, status = 200) => Response.json({
        suggestion, retry, ...(reason === undefined ? {} : { reason }), ...(turn === undefined ? {} : { turn }),
      }, { status, headers: { 'cache-control': 'no-store' } });
      const mode = params.get('mode');
      const retry = params.get('retry');
      if (!['auto', 'availability', 'manual'].includes(mode)
        || (mode === 'manual' ? !/^\d+:\d+(?::[a-f0-9]{32})?$/u.test(retry ?? '') : retry !== null)) {
        return response(undefined, null, undefined, 400);
      }
      if (!id || disposed || request.signal.aborted) return response();
      const session = ctx.sessions.get(id);
      const agent = ctx.agents.get(id);
      if (session && (session.header.origin === 'subagent'
        || ctx.agents.turnBoundaryOf(session).openTurnStartSeq !== null
        || (agent?.session === session && (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)))) return response();

      let entry = latest.get(id);
      if (entry && entry.session !== session) {
        clear(id);
        entry = undefined;
      }
      if (!entry || !session) {
        // Revalidate detached sessions against the stored revision. An expired
        // key can refresh availability, but cannot replay or start a model call.
        const offered = entry;
        if (retry !== null && !offered) return response(undefined, null, undefined, 409);
        try {
          entry = await historicalEntry(id, session, request.signal);
          if (retry !== null && entry !== offered) return response(undefined, null, undefined, 409);
        } catch (error) {
          if (request.signal.aborted || disposed || error?.code === 'SESSION_QUERY_ABORTED'
            || error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return response();
          return response(undefined, null, undefined, 503);
        }
      }
      if (!entry || latest.get(id) !== entry || request.signal.aborted) return response();
      const manualAvailability = mode === 'availability' || (mode === 'auto'
        && (entry.historical || Date.now() - entry.event.time > FRESHNESS_MS));
      const retryKey = attempt => `${entry.event.seq}:${attempt}${entry.keySuffix ?? ''}`;
      if (retry !== null && entry.keySuffix && !retry.endsWith(entry.keySuffix)) return response(undefined, null, undefined, 409);
      const canRetry = attempt => attempt.result && !attempt.result.suggestion
        && attempt.number < (entry.manualOnly ? MAX_MANUAL_ATTEMPTS : MAX_MANUAL_ATTEMPTS + 1)
        && (attempt.result.reason !== undefined || (!entry.manualOnly && attempt.number === 1));
      const start = number => {
        const controller = new AbortController();
        entry.active = controller;
        const attempt = { number, result: undefined, pending: undefined, waiters: 0 };
        attempt.pending = generateWithinDeadline(controller, PREDICTION_DEADLINE_MS, signal => generatePrediction(ctx.llm, entry.context, signal))
          .then(result => {
            if (entry.active === controller) entry.active = undefined;
            return attempt.result = result;
          });
        entry.attempt = attempt;
      };
      const previous = entry.attempt;
      if (!previous) {
        if (retry !== null && retry !== retryKey(0)) return response();
        if (entry.context === undefined) entry.context = readContext(entry.session, entry.event);
        if (!entry.context) return response();
        if (manualAvailability) return response(undefined, retryKey(0));
        entry.manualOnly = retry !== null;
        start(1);
      } else if (manualAvailability) {
        // A click can retrieve a cached suggestion or join an in-flight attempt.
        if (!previous.result || previous.result.suggestion) return response(undefined, retryKey(previous.number - 1), entry.event.seq);
        return response(previous.result, canRetry(previous) ? retryKey(previous.number) : null);
      } else if (retry !== null) {
        if (retry === retryKey(previous.number) && canRetry(previous)) start(previous.number + 1);
        else if (retry !== retryKey(previous.number - 1)) return response();
        // Resending the same key joins or retrieves its attempt without starting another model call.
      }
      const attempt = entry.attempt;
      attempt.waiters++;
      try {
        const result = await attempt.pending;
        if (latest.get(id) !== entry || request.signal.aborted || entry.attempt !== attempt) return response();
        if (mode === 'auto' && Date.now() - entry.event.time > FRESHNESS_MS && result.suggestion) {
          return response(undefined, retryKey(attempt.number - 1), entry.event.seq);
        }
        return response(result, canRetry(attempt) ? retryKey(attempt.number) : null, result.suggestion ? entry.event.seq : undefined);
      } finally {
        if (--attempt.waiters === 0 && !session) trimDetachedCache();
      }
    },
  });
}
