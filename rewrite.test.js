import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.js';
import { parseRewrite, readRewriteContext } from './prediction.js';

const text = value => ({ type: 'text', text: value });
const row = (seq, role, content) => ({ seq, type: `${role}/message`, surfaceOp: 'append', data: role === 'user'
  ? { source: { kind: 'user' }, content } : { message: { content } } });
function session(rows = []) {
  const events = new Map(rows.map(row => [row.seq, row]));
  return { id: 'one', seq: rows.length ? rows.at(-1).seq + 1 : 0,
    eventAt: seq => events.get(seq), requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), requestContext: () => undefined };
}
function host(s, stream) {
  const routes = new Map(), handlers = new Map(); let dispose;
  const sessions = new Map([[s.id, s]]);
  const llm = { prepareCall: async (config, signal, select) => ({ config: { ...config, ...select({}, {}) }, stream: opts => stream(opts, signal) }) };
  const agents = new Map(), boundaries = new Map();
  apply({ llm, sessions: { get: id => sessions.get(id) }, on: (name, fn) => handlers.set(name, fn),
    agents: { get: id => agents.get(id), turnBoundaryOf: s => ({ openTurnStartSeq: boundaries.get(s.id) ?? null }) },
    effect: fn => { dispose = fn(); }, connection: { fetch: { register: route => routes.set(route.path, route) } } });
  const route = routes.get('/api/local-composer-predictions/rewrite');
  const call = (body, id = 'one', signal) => route.fetch(new Request(`http://localhost${route.path}?session=${id}`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), signal,
  }));
  return { call, dispose, handlers, sessions, agents, boundaries };
}
const finish = { type: 'finish', reason: { kind: 'stop' } };

test('append context is bounded to two text messages and model is session-owned', () => {
  const s = session([row(0, 'user', [text('old')]), row(1, 'assistant', [text('a'.repeat(900)), { type: 'reasoning', text: 'secret' }]), row(2, 'user', [text('new'), { type: 'file' }])]);
  assert.deepEqual(readRewriteContext(s), { route: { provider: 'p', model: 'm' }, transcript: [
    { role: 'assistant', text: 'a'.repeat(800) }, { role: 'user', text: 'new' },
  ] });
  s.requestHeader = () => undefined;
  assert.equal(readRewriteContext(s), null);
});

test('compaction and deep tool traffic preserve original append order, excluding noise', () => {
  const rows = [row(1, 'user', [text('original question')]), row(2, 'assistant', [text('original answer')])];
  for (let seq = 3; seq < 603; seq++) rows.push({ seq, type: 'tool/result', surfaceOp: 'append' });
  rows.push({ ...row(603, 'user', [text('summary')]), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } });
  rows.push({ ...row(604, 'assistant', [text('replacement')]), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } });
  rows.push({ ...row(605, 'assistant', [text('interrupted')]), data: { interrupted: true, message: { content: [text('interrupted')] } } });
  rows.push(row(606, 'assistant', [text('tool narration'), { type: 'tool-call' }]));
  rows.push(row(607, 'assistant', [{ type: 'reasoning', text: 'hidden' }]));
  rows.push({ ...row(608, 'user', [text('not a human')]), data: { source: { kind: 'tool' }, content: [text('not a human')] } });
  const s = session(rows);
  // Only replacement/noise remain in the model surface; the original chat rows still exist in the log.
  s.surface = { nodes: [603, 604, 605, 606, 607, 608] };
  assert.deepEqual(readRewriteContext(s).transcript, [
    { role: 'user', text: 'original question' }, { role: 'assistant', text: 'original answer' },
  ]);
});

test('rewrite reads at most the recent 4096 events even when the log has no dialogue', () => {
  const last = 100000;
  const reads = [];
  const s = { ...session(), seq: last, eventAt: seq => { reads.push(seq); } };
  assert.deepEqual(readRewriteContext(s).transcript, []);
  assert.equal(reads.length, 4096);
  assert.equal(reads[0], last - 1);
  assert.equal(reads.at(-1), last - 4096);
});

test('validates JSON output including multiline, commands, length and controls', () => {
  assert.equal(parseRewrite(JSON.stringify({ rewrite: 'строка\nещё' })), 'строка\nещё');
  for (const value of ['/command', ' /command', 'x\u0000y', 'x\ufffcy', 'x'.repeat(4001)]) assert.equal(parseRewrite(JSON.stringify({ rewrite: value })), null);
  assert.equal(parseRewrite('{'), null);
});

test('isolated draft-only request sends complete data and no tools', async () => {
  let calls = 0;
  const h = host(session(), async function* (opts) {
    calls++; assert.deepEqual(opts.tools, []); assert.equal(opts.provider, 'p');
    assert.deepEqual(JSON.parse(opts.messages[0].content[0].text), { transcript: [], draft: 'x'.repeat(2000) });
    yield { type: 'text-delta', text: JSON.stringify({ rewrite: 'готово\nещё' }) }; yield finish;
  });
  const response = await h.call({ draft: 'x'.repeat(2000) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { rewrite: 'готово\nещё' }); assert.equal(calls, 1);
  for (const bad of ['{', {}, { draft: 'x'.repeat(2001) }, { draft: '' }, { draft: ' /goal' }, { draft: 'x', model: 'other' }]) {
    const invalid = await h.call(bad);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { rewrite: null });
  }
  const missing = await h.call({ draft: 'x' }, 'other');
  assert.equal(missing.status, 409);
  assert.deepEqual(await missing.json(), { rewrite: null, reason: 'unavailable' });
});

test('the live session model is used even without a request header; open turns are refused', async () => {
  const s = session();
  s.requestHeader = () => undefined;
  let calls = 0;
  const h = host(s, async function* (opts) {
    calls++;
    assert.equal(opts.provider, 'selected');
    assert.equal(opts.model, 'new-model');
    yield { type: 'text-delta', text: '{"rewrite":"Draft improved"}' }; yield finish;
  });
  const noModel = await h.call({ draft: 'draft' });
  assert.equal(noModel.status, 409);
  assert.deepEqual(await noModel.json(), { rewrite: null, reason: 'unavailable' });
  h.agents.set(s.id, { session: s, model: { current: () => ({ provider: 'selected', model: 'new-model' }) } });
  h.boundaries.set(s.id, 0);
  const openTurn = await h.call({ draft: 'draft' });
  assert.equal(openTurn.status, 409);
  assert.deepEqual(await openTurn.json(), { rewrite: null, reason: 'unavailable' });
  h.boundaries.delete(s.id);
  assert.deepEqual(await (await h.call({ draft: 'draft' })).json(), { rewrite: 'Draft improved' });
  assert.equal(calls, 1);
});

test('rewrite times out after 12 seconds without applying a late result', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const h = host(session(), async function* (_opts, signal) {
    started.resolve(signal);
    await release.promise;
    yield { type: 'text-delta', text: '{"rewrite":"Late result"}' }; yield finish;
  });
  const pending = h.call({ draft: 'draft' });
  try {
    const signal = await started.promise;
    t.mock.timers.tick(11999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await (await pending).json(), { rewrite: null });
  } finally {
    release.resolve();
  }
});

test('busy request can be retried after completion without a new turn', async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const h = host(session(), async function* () {
    if (++calls === 1) { started.resolve(); await release.promise; }
    yield { type: 'text-delta', text: '{"rewrite":"improved"}' }; yield finish;
  });
  const first = h.call({ draft: 'draft' });
  await started.promise;
  const busy = await h.call({ draft: 'draft' });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { rewrite: null, reason: 'busy' });
  release.resolve();
  assert.deepEqual(await (await first).json(), { rewrite: 'improved' });
  assert.deepEqual(await (await h.call({ draft: 'draft' })).json(), { rewrite: 'improved' });
  assert.equal(calls, 2);
});

test('concurrent request is refused and cancellation releases even a hung provider', { timeout: 2000 }, async () => {
  for (const mode of ['request', 'dispose', 'session', 'turn', 'inbox']) {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const s = session();
    const h = host(s, async function* (_opts, signal) { started.resolve(signal); await release.promise; yield finish; });
    const ac = new AbortController();
    const pending = h.call({ draft: 'test' }, 'one', ac.signal);
    const signal = await started.promise;
    const busy = await h.call({ draft: 'other' });
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { rewrite: null, reason: 'busy' });
    if (mode === 'request') ac.abort();
    if (mode === 'dispose') h.dispose();
    if (mode === 'session') h.handlers.get('session/disposed')(s);
    if (mode === 'turn') h.handlers.get('session/event')(s, { type: 'turn/start' });
    if (mode === 'inbox') h.handlers.get('agent/inbox/inserted')({ agent: { id: s.id }, message: { source: { kind: 'user' } } });
    assert.equal(signal.aborted, true);
    assert.deepEqual(await (await pending).json(), { rewrite: null });
    release.resolve();
  }
});
