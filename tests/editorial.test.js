import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEditorial, editorialImageUrl, imageBytes, internalImageId } from '../editorial.js';
import { readEditorialEnv } from '../netlify/functions/api.js';
import { createLocalCommentStore } from '../comment-store.js';
import { articleInput } from '../publication.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const environment = () => ({ PLATFORM_OPENAI_API_KEY: 'test-only-never-real', AI_GENERATION_ENABLED: 'true',
  AI_TEXT_DAILY_LIMIT: '2', AI_IMAGE_DAILY_LIMIT: '2' });
function memoryStore() {
  const records = new Map();
  return { get: async key => records.get(key) || null, set: async (key, value) => records.set(key, value),
    keys: async prefix => [...records.keys()].filter(key => key.startsWith(prefix)), delete: async key => records.delete(key) };
}
const body = (tip = 'text') => ({ tip, request_id: randomUUID(), idee: 'O explicație generală a unei propuneri, fără cifre inventate.', acord_ai: true });
const textResult = { titlu: 'Titlu verificat', rezumat: 'Rezumat.', continut: 'Introducere.\n## O propunere\nDetalii.', verificari: 'Verifică faptele înainte de publicare.' };

test('Adaptorul Netlify citește configurația editorială prin Netlify.env', () => {
  const expected = environment();
  const requested = [];
  assert.deepEqual(readEditorialEnv((key) => {
    requested.push(key);
    return expected[key];
  }), expected);
  assert.deepEqual(requested, [
    'PLATFORM_OPENAI_API_KEY',
    'AI_GENERATION_ENABLED',
    'AI_TEXT_DAILY_LIMIT',
    'AI_IMAGE_DAILY_LIMIT',
  ]);
});

test('Fără activare explicită, cheie dedicată și limite pozitive, nu se apelează OpenAI', async () => {
  for (const env of [{}, { OPENAI_API_KEY: 'gateway-virtual' }, { ...environment(), AI_GENERATION_ENABLED: 'false' },
    { ...environment(), AI_TEXT_DAILY_LIMIT: '0' }, { ...environment(), PLATFORM_OPENAI_API_KEY: '' }]) {
    let calls = 0;
    const editorial = createEditorial({ store: memoryStore(), env, fetcher: async () => { calls++; throw new Error('network forbidden'); } });
    await assert.rejects(editorial.start(2, body()), error => error.status === 503);
    assert.equal(calls, 0);
  }
});

test('Text OpenAI asincron: schemă, job privat, retry fără regenerare, rezultat validat', async () => {
  const calls = [];
  let polls = 0;
  const editorial = createEditorial({ store: memoryStore(), env: environment(), fetcher: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return Response.json({ id: 'resp_test', status: 'queued' });
    polls++;
    return Response.json(polls === 1 ? { status: 'in_progress' } : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(textResult) }] }] });
  } });
  const input = body();
  const job = await editorial.start(2, input);
  assert.equal(job.status, 'in_lucru');
  assert.ok(!JSON.stringify(job).includes('resp_'));
  assert.deepEqual(await editorial.start(2, input), job);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.background, true);
  assert.equal(payload.store, false);
  assert.equal(payload.model, 'gpt-5');
  assert.equal(payload.text.format.strict, true);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  await assert.rejects(editorial.status(3, job.id), error => error.status === 404);
  assert.equal((await editorial.status(2, job.id)).status, 'in_lucru');
  const result = await editorial.status(2, job.id);
  assert.deepEqual(result, { ...textResult, id: job.id, tip: 'text', status: 'gata' });
  assert.deepEqual(await editorial.status(2, job.id), result);
  assert.equal(calls.length, 3);
});

test('Imagine AI: o singură ilustrație, stocare proprie, etichetă de proveniență', async () => {
  let parameters;
  const editorial = createEditorial({ store: memoryStore(), env: environment(), fetcher: async (url, options) => {
    if (options.method === 'POST') { parameters = JSON.parse(options.body); return Response.json({ id: 'resp_image' }); }
    return Response.json({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: PNG }] });
  } });
  const job = await editorial.start(2, body('image'));
  assert.deepEqual(parameters.tool_choice, { type: 'image_generation' });
  assert.equal(parameters.tools[0].model, 'gpt-image-2');
  assert.equal(parameters.tools[0].quality, 'low');
  assert.equal(parameters.max_tool_calls, 1);
  const result = await editorial.status(2, job.id);
  assert.equal(result.imagine_url, `/media/${job.id}`);
  assert.equal(result.imagine_generata_ai, true);
  const image = await editorial.media(job.id);
  assert.equal(image.userId, 2);
  assert.equal(image.generated, true);
  assert.equal(image.base64, PNG);
});

test('Imagini: respinge SVG/HTML/base64 invalid, limite și adrese periculoase', async () => {
  assert.equal(imageBytes(PNG).mime, 'image/png');
  for (const value of ['', '%%%', Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'), 'A'.repeat(4 * 1024 * 1024 + 4)]) {
    assert.throws(() => imageBytes(value));
  }
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,aaa', '//evil.test/image', '/media/../../secret', 'https://user:password@example.test/a']) {
    assert.throws(() => editorialImageUrl(value));
  }
  const id = randomUUID();
  assert.equal(internalImageId(`/media/${id}`), id);
  assert.equal(editorialImageUrl(`/media/${id}`), `/media/${id}`);
  assert.equal(editorialImageUrl('https://example.test/photo.jpg'), 'https://example.test/photo.jpg');
  assert.equal(editorialImageUrl(''), '');
});

test('Limite persistente per candidat, acord și lipsa retry-ului plătit', async () => {
  let clock = Date.parse('2026-09-07T12:00:00Z'), calls = 0;
  const store = memoryStore(), env = { ...environment(), AI_TEXT_DAILY_LIMIT: '1' };
  const fetcher = async () => { calls++; return Response.json({ id: `resp_${calls}` }); };
  const first = createEditorial({ store, env, fetcher, now: () => clock });
  await assert.rejects(first.start(2, { ...body(), acord_ai: false }), error => error.status === 400);
  assert.equal(calls, 0);
  await first.start(2, body());
  const second = createEditorial({ store, env, fetcher, now: () => clock });
  await assert.rejects(second.start(2, body()), error => error.status === 429);
  await second.start(3, body());
  clock += 86400000;
  await second.start(2, body());
  assert.equal(calls, 3);
});

test('Erori furnizor redactate, refuzuri/incomplete/expirare fără succes fals', async () => {
  let clock = 1000;
  const store = memoryStore();
  const options = { store, env: environment(), now: () => clock };
  const rejected = createEditorial({ ...options, fetcher: async () => new Response('secret key and provider debug', { status: 401 }) });
  await assert.rejects(rejected.start(2, body()), error => error.status === 502 && !error.message.includes('secret key'));
  const response = { status: 'incomplete' };
  const editorial = createEditorial({ ...options, fetcher: async (url, init) => Response.json(init.method === 'POST' ? { id: 'resp_bad' } : response) });
  const job = await editorial.start(3, body());
  await assert.rejects(editorial.status(3, job.id), error => error.status === 422);
  response.status = 'completed'; response.output = [{ type: 'message', content: [{ type: 'refusal', refusal: 'private provider detail' }] }];
  await assert.rejects(editorial.status(3, job.id), error => error.status === 422 && !error.message.includes('private provider detail'));
  response.output = [{ type: 'message', content: [{ type: 'output_text', text: 'invalid JSON' }] }];
  await assert.rejects(editorial.status(3, job.id), error => error.status === 502);
  clock += 9 * 60000;
  await assert.rejects(editorial.status(3, job.id), error => error.status === 410);
});

test('Imaginile persistă la recrearea serviciului local; metadatele articolului sunt validate', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'editorial-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = createEditorial({ store: createLocalCommentStore(directory), env: {} });
  const uploaded = await first.upload(2, PNG);
  const second = createEditorial({ store: createLocalCommentStore(directory), env: {} });
  const restored = await second.media(internalImageId(uploaded.imagine_url));
  assert.equal(restored.base64, PNG);
  assert.equal(restored.generated, false);
  const input = { titlu: 'Titlu', continut: 'Text', status: 'ciorna', rezumat: 'Pe scurt', imagine_alt: 'Arbori', imagine_legenda: 'Descriere', imagine_credit: 'Autor', imagine_generata_ai: 'true' };
  assert.equal(articleInput(input).imagine_generata_ai, true);
  assert.equal(articleInput(input).rezumat, 'Pe scurt');
  assert.throws(() => articleInput({ ...input, imagine_credit: 'A'.repeat(161) }));
  assert.throws(() => articleInput({ ...input, rezumat: ['invalid'] }));
});
