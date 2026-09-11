import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseKeyStore, readSupabaseSnapshot, readSupabaseState, useSupabase, writeSupabaseState } from '../supabase-store.js';

test('Adaptorul Supabase păstrează starea și contractul key-value', async () => {
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const previousBackend = process.env.DATA_BACKEND;
  const previousFetch = globalThis.fetch;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.DATA_BACKEND = 'supabase';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('platform_state?id=eq.db')) {
      return Response.json(options.method === 'PATCH' ? [{ id: 'db' }] : [{ payload: { users: [1] } }]);
    }
    if (url.includes('select=payload')) return new Response(JSON.stringify([{ payload: { text: 'ok' } }]), { status: 200 });
    if (url.includes('select=key')) return new Response(JSON.stringify([{ key: 'jobs/1/a' }]), { status: 200 });
    return new Response(options.method === 'POST' ? '' : null, { status: options.method === 'POST' ? 201 : 204 });
  };
  try {
    assert.equal(useSupabase(), true);
    assert.deepEqual(await readSupabaseState(), { users: [1] });
    await writeSupabaseState({ users: [2] }, 'legacy');
    const store = createSupabaseKeyStore('editorial');
    assert.deepEqual(await store.get('jobs/1/a'), { text: 'ok' });
    assert.deepEqual(await store.keys('jobs/1/'), ['jobs/1/a']);
    await store.set('jobs/1/b', { text: 'nou' });
    await store.delete('jobs/1/b');
    assert.ok(calls.every(call => call.options.headers.apikey === 'sb_secret_test'));
    assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer sb_secret_test'));
    assert.ok(calls.some(call => call.options.method === 'PATCH' && call.url.includes('_stateRevision=is.null')));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
    if (previousBackend === undefined) delete process.env.DATA_BACKEND; else process.env.DATA_BACKEND = previousBackend;
  }
});

test('Supabase: salvări condiționate, tranziție atomică de la datele vechi și conflicte la creare/ștergere', async t => {
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SUPABASE_SECRET_KEY = 'test-only-key';
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
  });
  let stored = { users: [{ id: 1 }], nextUserId: 2 };
  const revisions = [];
  // Contract HTTP PostgREST simulat; nicio cerere către baza de producție.
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/rest/v1/platform_state');
    assert.equal(options.headers.apikey, 'test-only-key');
    if (options.method === 'GET') return Response.json(stored === null ? [] : [{ payload: stored }]);
    assert.equal(options.headers.Prefer, 'return=representation');
    assert.equal(url.searchParams.has('on_conflict'), false);
    if (options.method === 'POST') {
      assert.equal(url.searchParams.get('select'), 'id');
      if (stored !== null) return Response.json({}, { status: 409 });
    } else {
      assert.equal(options.method, 'PATCH');
      assert.equal(url.searchParams.get('id'), 'eq.db');
      const condition = url.searchParams.get('payload->>_stateRevision');
      assert.ok(condition, 'Filtrul versiunii trebuie trimis în UPDATE');
      if (stored === null || condition !== (stored._stateRevision ? `eq.${stored._stateRevision}` : 'is.null')) {
        return Response.json([]);
      }
    }
    const body = JSON.parse(options.body);
    assert.match(body.payload._stateRevision, /^[a-f0-9-]{36}$/);
    stored = body.payload;
    revisions.push(stored._stateRevision);
    return Response.json([{ id: 'db' }]);
  };
  const old = await readSupabaseSnapshot();
  assert.equal(old.version, 'legacy');
  const createUser = snapshot => {
    snapshot.data.users.push({ id: snapshot.data.nextUserId++ });
    return writeSupabaseState(snapshot.data, snapshot.version);
  };
  const first = await readSupabaseSnapshot();
  const concurrent = await Promise.allSettled([createUser(old), createUser(first)]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'STATE_CONFLICT');
  const retry = await readSupabaseSnapshot();
  assert.equal('_stateRevision' in retry.data, false);
  await createUser(retry);
  assert.deepEqual(stored.users.map(user => user.id), [1, 2, 3]);
  assert.equal(stored.nextUserId, 4);
  assert.notEqual(revisions[0], revisions[1]);
  await assert.rejects(writeSupabaseState({}, ''), /versiunea/);
  await assert.rejects(writeSupabaseState({}), /versiunea/);
  const beforeDeletion = await readSupabaseSnapshot();
  stored = null;
  await assert.rejects(writeSupabaseState(beforeDeletion.data, beforeDeletion.version), { code: 'STATE_CONFLICT' });
  assert.equal(stored, null, 'Scrierea veche nu recreează date șterse');
  assert.deepEqual(await readSupabaseSnapshot(), { data: null, version: null });
  const initializations = await Promise.allSettled([
    writeSupabaseState({ users: [1] }, null), writeSupabaseState({ users: [2] }, null),
  ]);
  assert.equal(initializations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(initializations.find(result => result.status === 'rejected').reason.code, 'STATE_CONFLICT');
});

test('Cheia duplicată păstrează semantica EEXIST', async () => {
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  globalThis.fetch = async () => new Response('{}', { status: 409 });
  try {
    await assert.rejects(createSupabaseKeyStore('comments').set('comments/1', {}), error => error.code === 'EEXIST');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
  }
});
