import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createComments } from '../comments.js';
import { createLocalCommentStore, createBlobCommentStore, createCommentStore } from '../comment-store.js';
import { connectLambda, setEnvironmentContext } from '@netlify/blobs';

const secret = 'test-only-secret-not-for-production-123456789';
const valid = { nume: 'Cititor', text: 'Comentariu de test', acord_publicare: 'on' };
function setup() {
  const data = new Map();
  let clock = Date.parse('2026-07-10T12:00:00Z');
  const store = { get: async k => data.get(k), set: async (k, v) => { data.set(k, structuredClone(v)); },
    keys: async p => [...data.keys()].filter(k => k.startsWith(p)), delete: async k => { data.delete(k); } };
  return { data, store, now: () => clock, advance: ms => { clock += ms; },
    service: createComments({ store, secret, now: () => clock }) };
}
test('Comentarii simultane între instanțe: toate cheile și textele persistă', async () => {
  const s = setup();
  const services = Array.from({ length: 3 }, () => createComments({ store: s.store, secret, now: s.now }));
  await Promise.all(Array.from({ length: 30 }, (_, i) => services[i % 3].submit({ candidateId: 2, articleId: 1, body: { ...valid, text: `Text ${i}` }, ip: `192.0.2.${i}` })));
  const saved = await createComments({ store: s.store, secret, now: s.now }).list(2, 1);
  assert.equal(saved.length, 30);
  assert.equal(new Set(saved.map(c => c.id)).size, 30);
  assert.ok(saved.every(c => c.status === 'in_asteptare'));
  assert.equal((await s.service.list(3, 1)).length, 0);
  assert.ok(!JSON.stringify([...s.data]).includes('192.0.2.'));
});
test('Moderare, audit, versiune învechită, ștergere terminală, acces la alt candidat', async () => {
  const s = setup();
  const c = await s.service.submit({ candidateId: 2, articleId: 1, body: valid, ip: '192.0.2.1' });
  const target = { candidateId: 2, articleId: 1, id: c.id, adminId: 1 };
  await assert.rejects(s.service.moderate({ ...target, candidateId: 3, status: 'aprobat', version: 'initial' }), { status: 404 });
  await s.service.moderate({ ...target, status: 'aprobat', version: 'initial' });
  let current = (await s.service.list())[0];
  assert.equal(current.status, 'aprobat');
  assert.equal(current.history[0].admin_id, 1);
  await assert.rejects(s.service.moderate({ ...target, status: 'respins', version: 'initial' }), { status: 409 });
  s.advance(1000);
  await s.service.moderate({ ...target, status: 'respins', version: current.version });
  current = (await s.service.list())[0];
  assert.equal(current.status, 'respins');
  s.advance(1000);
  await s.service.moderate({ ...target, status: 'sters', version: current.version });
  current = (await s.service.list())[0];
  assert.equal(current.history.length, 3);
  assert.equal(current.text, valid.text);
  await assert.rejects(s.service.moderate({ ...target, status: 'aprobat', version: current.version }), { status: 409 });
});
test('Moderări concurente păstrează întregul audit; ștergerea nu poate fi anulată', async () => {
  const s = setup();
  const c = await s.service.submit({ candidateId: 2, articleId: 1, body: valid, ip: '192.0.2.1' });
  const target = { candidateId: 2, articleId: 1, id: c.id, adminId: 1, version: 'initial' };
  await Promise.all([s.service.moderate({ ...target, status: 'sters' }), s.service.moderate({ ...target, status: 'aprobat' })]);
  const result = (await s.service.list())[0];
  assert.equal(result.history.length, 2);
  assert.equal(result.status, 'sters');
});
test('Honeypot, acord, lungimi, chei și limită anti-spam persistentă', async () => {
  const s = setup();
  const base = { candidateId: 2, articleId: 1, ip: '192.0.2.1' };
  for (const extra of [{ website: 'spam' }, { acord_publicare: '' }, { text: 'a' }, { text: 'a'.repeat(2001) }, { nume: {} }]) {
    await assert.rejects(s.service.submit({ ...base, body: { ...valid, ...extra } }), { status: 400 });
  }
  await s.service.submit({ ...base, body: valid });
  const restarted = createComments({ store: s.store, secret, now: s.now });
  await assert.rejects(restarted.submit({ ...base, body: valid }), { status: 429 });
  for (let i = 1; i < 10; i++) { s.advance(61000); await s.service.submit({ ...base, body: valid }); }
  s.advance(61000);
  await assert.rejects(s.service.submit({ ...base, body: valid }), { status: 429 });
  s.advance(3 * 86400000);
  await s.service.submit({ ...base, body: valid });
  assert.equal((await s.store.keys('rate/')).length, 1);
});
test('Erori de stocare propagate, fără succes fictiv; secret obligatoriu', async () => {
  const s = setup();
  await assert.rejects(createComments({ store: s.store, secret: '' }).submit({ candidateId: 2, articleId: 1, body: valid, ip: 'test' }), { status: 503 });
  s.store.set = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(s.service.submit({ candidateId: 2, articleId: 1, body: valid, ip: 'test' }), /storage unavailable/);
  assert.equal((await s.service.list()).length, 0);
});
test('Adaptor local: persistență după reinițializare și scrieri independente', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comments-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createLocalCommentStore(dir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`comments/2/1/item-${i}`, { i })));
  const restarted = createLocalCommentStore(dir);
  assert.equal((await restarted.keys('comments/2/1/')).length, 20);
  assert.deepEqual(await restarted.get('comments/2/1/item-7'), { i: 7 });
  await assert.rejects(store.set('comments/2/1/item-7', { i: 99 }), { code: 'EEXIST' });
  await assert.rejects(store.get('../secret'), /Cheie invalidă/);
});
test('Adaptor Blobs folosește API v8 și obiecte noi, fără opțiuni strong incompatibile', async () => {
  const calls = [];
  const adapter = createBlobCommentStore({
    get: async (...args) => { calls.push(args); return { text: 'salvat' }; },
    setJSON: async (...args) => { calls.push(args); },
    list: async ({ prefix }) => ({ blobs: [{ key: `${prefix}a` }, { key: `${prefix}b` }] }),
    delete: async () => {},
  });
  await adapter.set('comments/2/1/a', { text: 'salvat' });
  assert.equal((await adapter.get('comments/2/1/a')).text, 'salvat');
  assert.deepEqual(calls[1][1], { type: 'json' });
  assert.deepEqual(await adapter.keys('comments/'), ['comments/a', 'comments/b']);
});

test('SDK Blobs real + connectLambda: producție, preview, paginare, fără rețea externă', async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = ['NETLIFY', 'CONTEXT', 'AWS_REGION'];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const data = new Map();
  let requests = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'blobs.example.test');
    requests++;
    const method = options.method.toUpperCase();
    const key = decodeURIComponent(url.pathname);
    if (method === 'PUT') { data.set(key, JSON.parse(options.body)); return new Response('', { status: 200 }); }
    if (method === 'DELETE') { data.delete(key); return new Response(null, { status: 204 }); }
    if (url.searchParams.has('prefix')) {
      const prefix = url.searchParams.get('prefix');
      const keys = [...data.keys()].filter(k => k.startsWith(`${key}/${prefix}`));
      const cursor = Number(url.searchParams.get('cursor')) || 0;
      return Response.json({ blobs: keys.slice(cursor, cursor + 1).map(k => ({ key: k.slice(key.length + 1), etag: 'fake-etag' })),
        ...(cursor + 1 < keys.length ? { next_cursor: String(cursor + 1) } : {}) });
    }
    return data.has(key) ? Response.json(data.get(key)) : new Response('', { status: 404 });
  };
  try {
    process.env.NETLIFY = 'true';
    process.env.CONTEXT = 'production';
    process.env.AWS_REGION = 'us-east-2';
    connectLambda({ blobs: Buffer.from(JSON.stringify({ url: 'https://blobs.example.test', token: 'fake-token' })).toString('base64'),
      headers: { 'x-nf-site-id': 'fake-site', 'x-nf-deploy-id': 'abcdef123456' } });
    const production = createCommentStore();
    await production.set('comments/2/1/first', { text: 'prima' });
    await production.set('comments/2/1/second', { text: 'a doua' });
    assert.equal((await production.get('comments/2/1/first')).text, 'prima');
    assert.equal((await production.keys('comments/')).length, 2);
    process.env.CONTEXT = 'deploy-preview';
    const preview = createCommentStore();
    assert.equal((await preview.keys('comments/')).length, 0);
    await preview.set('comments/2/1/test', { text: 'doar preview' });
    assert.equal((await production.keys('comments/')).length, 2);
    assert.equal((await preview.keys('comments/')).length, 1);
    assert.ok(requests > 5);
    assert.ok([...data.keys()].some(key => key.includes('deploy:abcdef123456:campanie-comments')));
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) { if (originalEnv[key] == null) delete process.env[key]; else process.env[key] = originalEnv[key]; }
    setEnvironmentContext({});
  }
});
