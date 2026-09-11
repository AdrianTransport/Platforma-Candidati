import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  const { readData, writeData } = await import('../store.js?local-test');
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
  await writeData(state);
  assert.deepEqual(await readData(), state);
  assert.deepEqual(await fs.readdir('data'), ['db.json']);
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
  const { readData, writeData, configureBlobsCredentials } = await import('../store.js?blobs-test');
  await assert.rejects(readData());
  let stored = { revision: 1 };
  let expectedToken = 'test-token-1';
  let requests = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    requests++;
    if (url.hostname === 'api.netlify.com') {
      assert.equal(options.headers.authorization, `Bearer ${expectedToken}`);
      assert.match(url.pathname, /\/blobs\/test-site\/site:campanie-db\/db$/);
      return Response.json({ url: 'https://signed.example.test/state' });
    }
    assert.equal(url.hostname, 'signed.example.test');
    if (options.method.toUpperCase() === 'PUT') {
      stored = JSON.parse(options.body);
      return new Response(null, { status: 200 });
    }
    return Response.json(stored);
  };
  configureBlobsCredentials({ siteID: 'test-site', token: expectedToken });
  assert.deepEqual(await readData(), { revision: 1 });
  stored = { revision: 2 };
  expectedToken = 'test-token-2';
  configureBlobsCredentials({ siteID: 'test-site', token: expectedToken });
  assert.deepEqual(await readData(), { revision: 2 });
  await writeData({ revision: 3 });
  assert.deepEqual(stored, { revision: 3 });
  assert.equal(requests, 6);
});
