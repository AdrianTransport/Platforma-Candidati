import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseKeyStore, readSupabaseState, useSupabase, writeSupabaseState } from '../supabase-store.js';

test('Adaptorul Supabase păstrează starea și contractul key-value', async () => {
  const previousKey = process.env.SUPABASE_SECRET_KEY;
  const previousBackend = process.env.DATA_BACKEND;
  const previousFetch = globalThis.fetch;
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.DATA_BACKEND = 'supabase';
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('platform_state?id=eq.db')) return new Response(JSON.stringify([{ payload: { users: [1] } }]), { status: 200 });
    if (url.includes('select=payload')) return new Response(JSON.stringify([{ payload: { text: 'ok' } }]), { status: 200 });
    if (url.includes('select=key')) return new Response(JSON.stringify([{ key: 'jobs/1/a' }]), { status: 200 });
    return new Response(options.method === 'POST' ? '' : null, { status: options.method === 'POST' ? 201 : 204 });
  };
  try {
    assert.equal(useSupabase(), true);
    assert.deepEqual(await readSupabaseState(), { users: [1] });
    await writeSupabaseState({ users: [2] });
    const store = createSupabaseKeyStore('editorial');
    assert.deepEqual(await store.get('jobs/1/a'), { text: 'ok' });
    assert.deepEqual(await store.keys('jobs/1/'), ['jobs/1/a']);
    await store.set('jobs/1/b', { text: 'nou' });
    await store.delete('jobs/1/b');
    assert.ok(calls.every(call => call.options.headers.apikey === 'sb_secret_test'));
    assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer sb_secret_test'));
    assert.ok(calls.some(call => call.url.includes('on_conflict=id')));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previousKey;
    if (previousBackend === undefined) delete process.env.DATA_BACKEND; else process.env.DATA_BACKEND = previousBackend;
  }
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
