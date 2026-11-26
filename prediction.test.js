import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';
import { apply } from './index.js';
import { parsePrediction, readContext } from './prediction.js';

const text = text => ({ type: 'text', text });
const end = (seq, turn, reason = 'completed') => ({ seq, time: Date.now(), type: 'turn/end', data: { turn, reason: { kind: reason } } });
const message = (seq, role, content, turn = 2) => {
  const data = { content, source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'test', model: 'small' } };
  return { seq, type: `${role}/message`, surfaceOp: 'append', data: role === 'user' ? data : { turn, message: data } };
};
const fixture = () => {
  const rows = [message(1, 'user', [text('Объясни тесты'), { type: 'file' }]),
    message(4, 'assistant', [{ type: 'reasoning', text: 'ignore' }, text('На выбор A и B')]), end(6, 2)];
  return { rows, session: { id: 'test', header: {}, surface: { nodes: [1, 4] }, eventAt: seq => rows.find(x => x.seq === seq), isOwnSeq: () => true } };
};

function host(llm) {
  const handlers = new Map();
  let route;
  let dispose;
  apply({ llm, on: (event, listener) => handlers.set(event, listener), effect: register => { dispose = register(); },
    connection: { fetch: { register: value => { route = value; } } } });
  const raw = async (id = 'test', retry) => {
    const params = new URLSearchParams({ session: id });
    if (retry !== undefined) params.set('retry', retry);
    const response = await route.fetch(new Request(`http://localhost${route.path}?${params}`, { method: 'POST' }));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  const call = async (id = 'test') => (await raw(id)).suggestion;
  return { call, raw, dispose: () => dispose(), fire: (event, ...args) => handlers.get(event)(...args) };
}

function model(generate) {
  return { prepareCall: async (route, signal, select) => {
    const config = { ...route, ...select({}, { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }) };
    assert.equal(config.reasoningEffort, 'low');
    return { config, stream: options => generate(options, signal) };
  } };
}

const finish = { type: 'finish', reason: { kind: 'stop' } };

test('local bundle exports, localized metadata and vector asset exist', async () => {
  const fromHere = path => new URL(path, import.meta.url);
  const manifest = JSON.parse(await readFile(fromHere('package.json'), 'utf8'));
  for (const path of [manifest.exports['.'], manifest.exports['./client'], manifest.dsh.bundle.patch]) await access(fromHere(path));
  const icon = await readFile(fromHere(manifest.exports['./icon']), 'utf8');
  assert.match(icon, /^<svg[\s\S]+<\/svg>\s*$/u);
  for (const locale of ['en', 'ru', 'zh']) {
    const { meta } = JSON.parse(await readFile(fromHere(`locale/${locale}.json`), 'utf8'));
    assert.ok(meta.title && meta.description);
  }
});

test('uses recent visible human and assistant text only, after a final answer of that turn', () => {
  const { session, rows } = fixture();
  const context = readContext(session, rows[2]);
  assert.deepEqual(context, { route: { provider: 'test', model: 'small' },
    transcript: [{ role: 'user', text: 'Объясни тесты' }, { role: 'assistant', text: 'На выбор A и B' }] });
  assert.equal(readContext(session, end(10, 3)), null);
  rows[1].data.message.content.push({ type: 'tool-call' });
  assert.equal(readContext(session, rows[2]), null);
});

test('long tool-heavy turns retain the human prompt even after surface compaction', () => {
  const rows = new Map();
  rows.set(1, { seq: 1, type: 'turn/start' });
  rows.set(2, message(2, 'user', [text('Предложи два варианта')], 2));
  for (let seq = 3; seq < 360; seq++) {
    rows.set(seq, seq % 2 === 0
      ? message(seq, 'assistant', [text('Проверяю источник'), { type: 'tool-call' }], 2)
      : { seq, type: 'tool/result', surfaceOp: 'append' });
  }
  rows.set(360, message(360, 'assistant', [text('Есть два варианта: А и Б. Какой разобрать?')], 2));
  const settled = end(361, 2);
  rows.set(362, message(362, 'user', [text('Не брать из следующего хода')], 3));
  const context = readContext({ surface: { nodes: [360, 362] }, eventAt: seq => rows.get(seq) }, settled);
  assert.deepEqual(context.transcript, [
    { role: 'user', text: 'Предложи два варианта' },
    { role: 'assistant', text: 'Есть два варианта: А и Б. Какой разобрать?' },
  ]);
});

test('long runs with many text updates reserve one slot for the human prompt', () => {
  const rows = new Map([[0, message(0, 'user', [text('Продолжай')])]]);
  for (let seq = 1; seq <= 9; seq++) rows.set(seq, message(seq, 'assistant', [text(`Обновление ${seq}`)]));
  const context = readContext({ eventAt: seq => rows.get(seq) }, end(10, 2));
  assert.equal(context.transcript.length, 6);
  assert.deepEqual(context.transcript[0], { role: 'user', text: 'Продолжай' });
  assert.deepEqual(context.transcript.at(-1), { role: 'assistant', text: 'Обновление 9' });
});

test('rejects absent, malformed, too long, multiline and command suggestions', () => {
  for (const output of ['{', '{"suggestion":null}', '{"suggestion":"/goal test"}', '{"suggestion":"Строка\\nвторая"}',
    '{"suggestion":"https://example.org"}', JSON.stringify({ suggestion: 'a'.repeat(181) })]) {
    assert.deepEqual(parsePrediction(output), output === '{"suggestion":null}'
      ? { suggestion: null } : { reason: 'invalidResponse' });
  }
  assert.deepEqual(parsePrediction('{"suggestion":"  Покажи второй вариант.  "}'), { suggestion: 'Покажи второй вариант.' });
});

test('settled turns generate one tool-free request and leave other sessions untouched', async () => {
  const { session, rows } = fixture();
  let calls = 0;
  const h = host(model(async function* (options) {
    calls++;
    assert.deepEqual(options.tools, []);
    assert.equal(options.model, 'small');
    assert.equal(options.messages[0].content[0].text.includes('ignore'), false);
    yield { type: 'text-delta', text: '{"suggestion":"Покажи второй вариант"}' };
    yield finish;
  }));
  h.fire('session/event', session, rows[2]);
  assert.equal(await h.call('other'), null);
  assert.deepEqual(await Promise.all([h.call(), h.call()]), ['Покажи второй вариант', 'Покажи второй вариант']);
  assert.deepEqual(await h.raw('test', '6:1'), { suggestion: null, retry: null });
  assert.equal(calls, 1);
  h.fire('session/event', session, end(9, 3, 'aborted'));
  assert.equal(await h.call(), null);
});

test('a newer turn aborts and releases waiters before an unresponsive provider settles', { timeout: 2000 }, async () => {
  const { session, rows } = fixture();
  const { promise: started, resolve: start } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const h = host(model(async function* (_options, signal) {
    start(signal);
    await released;
    yield { type: 'text-delta', text: '{"suggestion":"Старая реплика"}' };
    yield finish;
  }));
  h.fire('session/event', session, rows[2]);
  const result = h.call();
  try {
    const signal = await started;
    h.fire('session/event', session, { type: 'turn/start' });
    assert.equal(signal.aborted, true);
    assert.equal(await result, null);
    assert.equal(await h.call(), null);
  } finally {
    release();
  }
});

test('a hung provider cannot delay the shared result past the deadline or publish a late suggestion', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, rows } = fixture();
  const { promise: started, resolve: start } = Promise.withResolvers();
  const { promise: released, resolve: release } = Promise.withResolvers();
  const { promise: settled, resolve: settle } = Promise.withResolvers();
  let calls = 0;
  const h = host(model(async function* (_options, signal) {
    calls++;
    start(signal);
    try {
      await released;
      yield { type: 'text-delta', text: '{"suggestion":"Запоздалая реплика"}' };
      yield finish;
    } finally {
      settle();
    }
  }));
  h.fire('session/event', session, rows[2]);
  const results = Promise.all([h.call(), h.call()]);
  try {
    const signal = await started;
    t.mock.timers.tick(11999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await results, [null, null]);
    release();
    await settled;
    assert.equal(await h.call(), null);
    assert.equal(calls, 1);
  } finally {
    release();
  }
});

test('missing context never exposes a retry or calls the model', async () => {
  const { session, rows } = fixture();
  rows[1].data.message.content.push({ type: 'tool-call' });
  let calls = 0;
  const h = host(model(async function* () { calls++; }));
  h.fire('session/event', session, rows[2]);
  assert.deepEqual(await h.raw(), { suggestion: null, retry: null });
  assert.deepEqual(await h.raw('test', '6:1'), { suggestion: null, retry: null });
  assert.equal(calls, 0);
});

test('manual retry joins concurrent requests and is cached for auto, including null', async () => {
  for (const output of ['Покажи другой вариант', null]) {
    const { session, rows } = fixture();
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    let calls = 0;
    const h = host(model(async function* () {
      calls++;
      if (calls === 2) { started.resolve(); await gate.promise; }
      yield { type: 'text-delta', text: JSON.stringify({ suggestion: calls === 1 ? null : output }) };
      yield finish;
    }));
    h.fire('session/event', session, rows[2]);
    assert.deepEqual(await h.raw('test', '6:1'), { suggestion: null, retry: null });
    assert.equal(calls, 0);
    assert.deepEqual(await h.raw(), { suggestion: null, retry: '6:1' });
    assert.deepEqual(await h.raw('test', '06:1'), { suggestion: null, retry: null });
    const first = h.raw('test', '6:1');
    await started.promise;
    const second = h.raw('test', '6:1');
    const remount = h.raw();
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second, remount]), Array(3).fill({ suggestion: output, retry: null }));
    assert.deepEqual(await h.raw('test', '6:1'), { suggestion: output, retry: null });
    assert.equal(calls, 2);
  }
});

test('pending auto blocks manual; timeout leaves the retry available', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, rows } = fixture();
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let calls = 0;
  const h = host(model(async function* (_options, signal) {
    calls++;
    if (calls === 1) { started.resolve(signal); await gate.promise; }
    yield { type: 'text-delta', text: '{"suggestion":"Ручной результат"}' };
    yield finish;
  }));
  h.fire('session/event', session, rows[2]);
  const auto = h.raw();
  const signal = await started.promise;
  assert.deepEqual(await h.raw('test', '6:1'), { suggestion: null, retry: null });
  assert.equal(calls, 1);
  t.mock.timers.tick(12000);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await auto, { suggestion: null, retry: '6:1', reason: 'timeout' });
  assert.deepEqual(await h.raw('test', '6:1'), { suggestion: 'Ручной результат', retry: null });
  assert.equal(calls, 2);
  gate.resolve();
});

test('manual pending is cancelled and never published on turn start, inbox, or disposal', async () => {
  for (const clear of ['turn', 'inbox', 'dispose', 'plugin']) {
    const { session, rows } = fixture();
    const started = Promise.withResolvers();
    const gate = Promise.withResolvers();
    let calls = 0;
    const h = host(model(async function* (_options, signal) {
      calls++;
      if (calls === 2) { started.resolve(signal); await gate.promise; }
      yield { type: 'text-delta', text: JSON.stringify({ suggestion: calls === 1 ? null : 'Устаревший результат' }) };
      yield finish;
    }));
    h.fire('session/event', session, rows[2]);
    await h.raw();
    const pending = h.raw('test', '6:1');
    const signal = await started.promise;
    if (clear === 'turn') h.fire('session/event', session, { type: 'turn/start' });
    if (clear === 'inbox') h.fire('agent/inbox/inserted', { agent: { id: session.id }, message: { source: { kind: 'user' } } });
    if (clear === 'dispose') h.fire('session/disposed', session);
    if (clear === 'plugin') h.dispose();
    assert.equal(signal.aborted, true);
    assert.deepEqual(await pending, { suggestion: null, retry: null });
    assert.deepEqual(await h.raw(), { suggestion: null, retry: null });
    gate.resolve();
  }
});

test('a sent user message retires the completed turn’s cached suggestion before the next turn starts', async () => {
  const { session, rows } = fixture();
  let calls = 0;
  const h = host(model(async function* () {
    calls++;
    yield { type: 'text-delta', text: '{"suggestion":"Покажи второй вариант"}' };
    yield finish;
  }));
  h.fire('session/event', session, rows[2]);
  assert.equal(await h.call(), 'Покажи второй вариант');
  h.fire('agent/inbox/inserted', { agent: { id: session.id }, message: { source: { kind: 'user' } } });
  assert.equal(await h.call(), null);
  assert.equal(calls, 1);
});

test('failures allow manual recovery, with safe reasons and no automatic repeat', async () => {
  const { session, rows } = fixture();
  let calls = 0;
  const h = host(model(async function* () {
    calls++;
    if (calls === 1) throw new Error('private error');
    if (calls === 2) {
      yield { type: 'finish', reason: { kind: 'error', failure: { status: 429, code: 'RATE_LIMIT', message: 'private error' } } };
      return;
    }
    yield { type: 'text-delta', text: '{"suggestion":"Покажи пример"}' };
    yield finish;
  }));
  h.fire('session/event', session, rows[2]);
  const auto = { suggestion: null, retry: '6:1', reason: 'modelError' };
  assert.deepEqual(await h.raw(), auto);
  assert.deepEqual(await h.raw(), auto);
  assert.equal(calls, 1);
  const limited = { suggestion: null, retry: '6:2', reason: 'rateLimited' };
  assert.deepEqual(await h.raw('test', '6:1'), limited);
  assert.deepEqual(await h.raw('test', '6:1'), limited);
  assert.deepEqual(await h.raw(), limited);
  assert.equal(calls, 2);
  assert.deepEqual(await h.raw('test', '6:2'), { suggestion: 'Покажи пример', retry: null });
  assert.deepEqual(await h.raw('test', '6:3'), { suggestion: null, retry: null });
  assert.equal(calls, 3);
});

test('invalid output has a retryable reason and attempts are capped per reply', async () => {
  const { session, rows } = fixture();
  let calls = 0;
  const h = host(model(async function* () {
    calls++;
    yield { type: 'text-delta', text: 'invalid' };
    yield finish;
  }));
  h.fire('session/event', session, rows[2]);
  assert.deepEqual(await h.raw(), { suggestion: null, retry: '6:1', reason: 'invalidResponse' });
  assert.deepEqual(await h.raw('test', '6:1'), { suggestion: null, retry: '6:2', reason: 'invalidResponse' });
  assert.deepEqual(await h.raw('test', '6:2'), { suggestion: null, retry: '6:3', reason: 'invalidResponse' });
  const expired = { suggestion: null, retry: null, reason: 'invalidResponse' };
  assert.deepEqual(await h.raw('test', '6:3'), expired);
  assert.deepEqual(await h.raw('test', '6:3'), expired);
  assert.deepEqual(await h.raw('test', '6:4'), { suggestion: null, retry: null });
  assert.equal(calls, 4);
});
