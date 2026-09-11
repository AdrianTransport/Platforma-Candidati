import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';

test('Stocare locală: numai un fișier absent inițializează o bază nouă', async t => {
  const cwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-store-'));
  const keys = ['NETLIFY', 'LAMBDA_TASK_ROOT', 'AWS_LAMBDA_FUNCTION_NAME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => { delete process.env[key]; });
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { readData, readDataSnapshot, writeData } = await import('../store.js?local-test');
  assert.deepEqual((await readData()).users, []);
  await fs.mkdir('data');
  await fs.writeFile('data/db.json', '{broken');
  await assert.rejects(readData(), SyntaxError);
  assert.equal(await fs.readFile('data/db.json', 'utf8'), '{broken');
  await fs.rm('data/db.json');
  await fs.mkdir('data/db.json');
  await assert.rejects(readData());
  await fs.rmdir('data/db.json');
  const state = { users: [{ id: 1, nume_candidat: 'Ștefan — Țimiș' }] };
  await assert.rejects(writeData(state), /versiunea/);
  await writeData(state, null);
  assert.deepEqual(await readData(), state);
  const old = await readDataSnapshot();
  const fresh = { ...state, nextUserId: 2 };
  await writeData(fresh, old.version);
  await assert.rejects(writeData(state, old.version), { code: 'STATE_CONFLICT', status: 409 });
  await assert.rejects(writeData(state, null), { code: 'STATE_CONFLICT' });
  assert.deepEqual(await readData(), fresh);
  assert.deepEqual(await fs.readdir('data'), ['db.json']);
});

test('Două procese: conflictul nu suprascrie datele; recitirea păstrează ambele raportări și ID-uri unice', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-race-'));
  const env = { ...process.env };
  for (const key of ['NETLIFY', 'LAMBDA_TASK_ROOT', 'AWS_LAMBDA_FUNCTION_NAME', 'NODE_TEST_CONTEXT']) delete env[key];
  const worker = path.join(dir, 'writer.mjs');
  await fs.writeFile(worker, `
    import { readDataSnapshot, writeData } from ${JSON.stringify(new URL('../store.js', import.meta.url).href)};
    let snapshot = await readDataSnapshot();
    process.on('message', async ({ name, reload }) => {
      try {
        if (reload) snapshot = await readDataSnapshot();
        snapshot.data.raportari_costuri.push({ id: snapshot.data.nextRaportareId++, name });
        await writeData(snapshot.data, snapshot.version);
        process.send({ saved: true });
      } catch (error) { process.send({ saved: false, code: error.code }); }
    });
    process.send({ ready: true });
  `);
  const children = [1, 2].map(() => fork(worker, { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('exit', resolve);
      child.kill();
    })));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const ready = await Promise.all(children.map(child => once(child, 'message')));
  assert.ok(ready.every(([message]) => message.ready));
  const pending = children.map(child => once(child, 'message'));
  children.forEach((child, index) => child.send({ name: `raportare-${index}` }));
  const results = (await Promise.all(pending)).map(([message]) => message);
  assert.equal(results.filter(result => result.saved).length, 1);
  const rejected = results.findIndex(result => !result.saved);
  assert.equal(results[rejected].code, 'STATE_CONFLICT');
  const retry = once(children[rejected], 'message');
  children[rejected].send({ name: `raportare-${rejected}`, reload: true });
  assert.equal((await retry)[0].saved, true);
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'data/db.json'), 'utf8'));
  assert.deepEqual(stored.raportari_costuri.map(row => row.name).sort(), ['raportare-0', 'raportare-1']);
  assert.deepEqual(stored.raportari_costuri.map(row => row.id).sort(), [1, 2]);
  assert.equal(stored.nextRaportareId, 3);
});

test('Blobs: fără fallback local la eroare; credențiale și date proaspete la fiecare invocare', async t => {
  const keys = ['NETLIFY', 'SUPABASE_SECRET_KEY', 'DATA_BACKEND', 'NETLIFY_BLOBS_CONTEXT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.NETLIFY = 'true';
  process.env.DATA_BACKEND = 'blobs';
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { readData, readDataSnapshot, writeData, configureBlobsCredentials } = await import('../store.js?blobs-test');
  await assert.rejects(readData());
  let stored = { revision: 1 };
  let etag = 'v1';
  let sequence = 1;
  let expectedToken = 'test-token-1';
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.netlify.com') {
      assert.equal(options.headers.authorization, `Bearer ${expectedToken}`);
      assert.match(url.pathname, /\/blobs\/test-site\/site:campanie-db\/db$/);
      return Response.json({ url: 'https://signed.example.test/state' });
    }
    assert.equal(url.hostname, 'signed.example.test');
    if (options.method.toUpperCase() === 'PUT') {
      const headers = new Headers(options.headers);
      assert.ok(headers.has('if-match') || headers.has('if-none-match'), 'Nicio scriere necondiționată');
      if (headers.get('if-match') !== etag && !(headers.get('if-none-match') === '*' && stored === null)) {
        return new Response(null, { status: 412 });
      }
      stored = JSON.parse(options.body);
      etag = `v${++sequence}`;
      return new Response(null, { status: 200, headers: { etag } });
    }
    return stored === null ? new Response(null, { status: 404 }) : Response.json(stored, { headers: { etag } });
  };
  configureBlobsCredentials({ siteID: 'test-site', token: expectedToken });
  assert.deepEqual(await readData(), { revision: 1 });
  stored = { revision: 2 };
  etag = 'v2'; sequence = 2;
  expectedToken = 'test-token-2';
  configureBlobsCredentials({ siteID: 'test-site', token: expectedToken });
  assert.deepEqual(await readData(), { revision: 2 });
  const first = await readDataSnapshot();
  const second = await readDataSnapshot();
  const writes = await Promise.allSettled([
    writeData({ revision: 3 }, first.version), writeData({ revision: 4 }, second.version),
  ]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.code, 'STATE_CONFLICT');
  assert.deepEqual(stored, { revision: 3 });
  await assert.rejects(writeData({}, ''), /versiunea/);
  await assert.rejects(writeData({}, null), { code: 'STATE_CONFLICT' });
  stored = null; etag = null;
  const missing = await readDataSnapshot();
  assert.equal(missing.version, null);
  assert.deepEqual(missing.data.users, []);
  await assert.rejects(writeData({}, first.version), { code: 'STATE_CONFLICT' });
  const creations = await Promise.allSettled([writeData({ revision: 1 }, null), writeData({ revision: 2 }, null)]);
  assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(creations.find(result => result.status === 'rejected').reason.code, 'STATE_CONFLICT');
});
