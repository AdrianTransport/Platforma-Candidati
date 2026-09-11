import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, syncRuntimeEnv } from '../netlify/functions/api.js';

test('Variabilele absente rămân absente după invocări repetate', () => {
  const env = {};
  syncRuntimeEnv(key => env[key], env);
  syncRuntimeEnv(key => env[key], env);
  assert.deepEqual(env, {});
  syncRuntimeEnv(key => ({ SUPABASE_SECRET_KEY: 'test-only-key' })[key], env);
  assert.equal(env.DATA_BACKEND, 'supabase');
  syncRuntimeEnv(key => ({ SUPABASE_SECRET_KEY: 'test-only-key', DATA_BACKEND: 'blobs' })[key], env);
  assert.equal(env.DATA_BACKEND, 'blobs');
  syncRuntimeEnv(() => undefined, env);
  assert.deepEqual(env, {});
});

test('O pornire eșuată poate fi reluată la următoarea cerere', async () => {
  let attempts = 0;
  const handler = createHandler({ prepare() {}, refresh() {}, initialize() {
    if (++attempts === 1) throw new Error('Temporary storage failure');
    return event => event.id;
  } });
  await assert.rejects(handler({ id: 1 }), /Temporary storage failure/);
  assert.equal(await handler({ id: 2 }), 2);
  assert.equal(await handler({ id: 3 }), 3);
  assert.equal(attempts, 2);
});

test('Instanța caldă recitește datele modificate extern fără să reconstruiască aplicația', async () => {
  let stored = 'public';
  let snapshot;
  let initializations = 0;
  const handler = createHandler({ prepare() {}, refresh() { snapshot = stored; }, initialize() {
    initializations++;
    snapshot = stored;
    return () => snapshot;
  } });
  assert.equal(await handler({}), 'public');
  stored = 'hidden';
  assert.equal(await handler({}), 'hidden');
  assert.equal(initializations, 1);
});

test('Citirea eșuată nu servește date vechi și nu blochează următoarea cerere', async () => {
  let unavailable = true;
  let served = 0;
  const handler = createHandler({ prepare() {}, initialize: () => () => ++served, refresh() {
    if (unavailable) throw new Error('Read unavailable');
  } });
  assert.equal(await handler({}), 1);
  await assert.rejects(handler({}), /Read unavailable/);
  assert.equal(served, 1);
  unavailable = false;
  assert.equal(await handler({}), 2);
});

test('Cererile suprapuse nu schimbă contextul comun în timpul unei salvări', async () => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const order = [];
  const handler = createHandler({
    prepare(event) { order.push(`prepare:${event.id}`); },
    refresh() { order.push('refresh'); },
    initialize: () => async event => {
      order.push(`start:${event.id}`);
      if (event.id === 1) { started(); await blocked; }
      order.push(`end:${event.id}`);
    },
  });
  const first = handler({ id: 1 });
  await entered;
  const second = handler({ id: 2 });
  await Promise.resolve();
  assert.deepEqual(order, ['prepare:1', 'start:1']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['prepare:1', 'start:1', 'end:1', 'prepare:2', 'refresh', 'start:2', 'end:2']);
});
