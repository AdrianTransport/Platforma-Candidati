import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { liveState, dosarView, feedEntries, LIVE_WINDOW_MS } from '../vocea/dosare.js';
import { termenIcs } from '../vocea/ics.js';
import { bucharestToDate, termenLabel } from '../vocea/time.js';
import { StateConflictError } from '../state-conflict.js';
import { createComments } from '../comments.js';
import { createLocalCommentStore } from '../comment-store.js';
import { createEditorial } from '../editorial.js';
import { createCompliance } from '../compliance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const TERMEN = '2026-10-08T06:00:00.000Z'; // 08.10.2026, 09:00 ora României
const T = Date.parse(TERMEN);
const dosar = (extra = {}) => ({
  id: '1234-30-2026', numar: '1234/30/2026', instanta: 'Tribunalul Timiș', titlu: 'Primul proces cu Primăria',
  obiect: 'Anulare act administrativ.', stadiu: 'Fond', featured: true, liveMode: 'auto',
  dataInregistrare: '2026-06-01T09:00:00.000Z',
  termene: [{ id: 't1', at: TERMEN, sala: 'Sala 12', complet: 'C4', rezultat: '' }],
  updates: [], createdAt: '2026-06-01T09:00:00.000Z', ...extra,
});

test('Ora României: 08.10.2026 09:00 este 06:00 UTC, iar iarna diferența e de 2 ore', () => {
  assert.equal(bucharestToDate('2026-10-08', '09:00').toISOString(), TERMEN);
  assert.equal(bucharestToDate('2026-12-08', '09:00').toISOString(), '2026-12-08T07:00:00.000Z');
  assert.equal(bucharestToDate('2026-02-31', '09:00'), null);
  assert.equal(termenLabel(TERMEN), 'TERMEN: JOI, 8 OCTOMBRIE 2026 · ORA 09:00');
});

test('Starea: URMĂTORUL TERMEN → LIVE automat la ora termenului → încheiat după 6 ore; manual pornit/oprit', () => {
  assert.equal(liveState(dosar(), T - 1000), 'upcoming');
  assert.equal(liveState(dosar(), T), 'live');
  assert.equal(liveState(dosar(), T + LIVE_WINDOW_MS - 1), 'live');
  assert.equal(liveState(dosar(), T + LIVE_WINDOW_MS), 'ended');
  assert.equal(liveState(dosar({ termene: [] }), T), 'none');
  assert.equal(liveState(dosar({ liveMode: 'on' }), T - 86400000), 'live');
  assert.equal(liveState(dosar({ liveMode: 'off' }), T + 1000), 'ended');
  assert.equal(liveState(dosar({ liveMode: 'off' }), T - 1000), 'upcoming');
  const view = dosarView(dosar(), T - (2 * 86400000 + 3 * 3600000 + 4 * 60000 + 5000));
  assert.deepEqual(view.countdown, { d: '2', h: '03', m: '04', s: '05' });
});

test('Fluxul live: cele mai noi primele, plus înregistrarea dosarului', () => {
  const feed = feedEntries(dosar({ updates: [
    { id: 'a', at: '2026-10-08T06:05:00.000Z', titlu: 'A început ședința', text: '' },
    { id: 'b', at: '2026-10-08T06:40:00.000Z', titlu: 'Pauză', text: '' },
  ] }), T + 3600000);
  assert.deepEqual(feed.map(f => f.id), ['b', 'a', 'inregistrare']);
  assert.equal(feed[0].time, '09:40');
});

test('Fișierul .ics: UTC, CRLF, memento cu o zi și o oră înainte, linii de cel mult 75 de octeți', () => {
  const ics = termenIcs({ uid: 'x@y', start: TERMEN, summary: `Termen: ${'Primul proces cu Primăria, '.repeat(4)}`,
    location: 'Tribunalul Timiș, Sala 12', description: 'a\nb', now: T });
  assert.match(ics, /DTSTART:20261008T060000Z\r\n/);
  assert.match(ics, /TRIGGER:-P1D/);
  assert.match(ics, /TRIGGER:-PT1H/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('Depozitul separat: salvare condiționată, reîncercare la conflict', async () => {
  const { createVoceaStore, memoryBackend } = await import('../vocea/store.js');
  const backend = memoryBackend();
  const store = createVoceaStore(backend);
  await store.update((data) => { data.dosare.push(dosar()); });
  let first = true;
  await store.update(async (data) => {
    if (first) { first = false; await createVoceaStore(backend).update(d => { d.settings.x = 1; }); }
    data.anunturi.push({ id: 'z' });
  });
  const data = await store.read();
  assert.equal(data.settings.x, 1, 'modificarea concurentă nu se pierde');
  assert.equal(data.anunturi.length, 1);
  await assert.rejects(backend.write({}, 'versiune-veche'), StateConflictError);
});

test('Rute publice și Super Admin pentru dosare, LIVE și anunțuri', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocea-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-only-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
  const password = 'test-only-password-123456789';
  await fs.mkdir(path.join(dir, 'data'));
  await fs.mkdir(path.join(dir, 'public'));
  await fs.copyFile(path.join(root, 'public', 'style.css'), path.join(dir, 'public', 'style.css'));
  await fs.writeFile(path.join(dir, 'data', 'db.json'), JSON.stringify({
    users: [{ id: 1, role: 'admin', activ: true, email: 'admin@example.test', password_hash: bcrypt.hashSync(password, 4) }],
    articole: [], portal_posts: [], nextUserId: 2, nextArticolId: 1,
  }));
  let clock = T - (2 * 86400000 + 3 * 3600000);
  const now = () => clock;
  const local = name => createLocalCommentStore(path.join(dir, name));
  // Importat după chdir: store.js fixează calea fișierului local la încărcare.
  const { createApp } = await import('../app.js');
  const { createVoceaStore, memoryBackend } = await import('../vocea/store.js');
  const voceaStore = createVoceaStore(memoryBackend({ schema: 1, dosare: [dosar()], anunturi: [], settings: {}, limite: {} }));
  const app = await createApp({
    now, voceaStore, auth: null,
    comments: createComments({ store: local('comments'), now }),
    editorial: createEditorial({ store: local('editorial'), env: {}, now, fetcher: async () => { throw new Error('fără rețea'); } }),
    compliance: createCompliance({ store: local('compliance'), now, secret: process.env.SESSION_SECRET }),
  });
  app.set('views', path.join(root, 'views'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const cookies = new Map();
    return async (url, body) => {
      const response = await fetch(base + url, {
        redirect: 'manual', method: body ? 'POST' : 'GET',
        headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(body ? { body: new URLSearchParams(body) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [key, ...value] = cookie.split(';')[0].split('=');
        cookies.set(key, value.join('='));
      }
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
  };
  const csrf = html => html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const guest = client();

  const home = await guest('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /URMĂTORUL TERMEN/);
  assert.match(home.text, /data-target="1791439200000"/);
  assert.match(home.text, /TERMEN: JOI, 8 OCTOMBRIE 2026 · ORA 09:00/);
  assert.match(home.text, /href="\/dosare\/1234-30-2026\/termen.ics"/);
  assert.match(home.text, /Toate dosarele cu Primăria/);
  assert.match(home.text, /src="\/live.js" defer/);
  assert.match(home.headers.get('netlify-cdn-cache-control'), /max-age=20/);

  const ics = await guest('/dosare/1234-30-2026/termen.ics');
  assert.equal(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.match(ics.text, /BEGIN:VEVENT/);
  assert.match((await guest('/dosare/1234-30-2026')).text, /Toate termenele/);
  assert.equal((await guest('/dosare/nu-exista')).status, 404);

  const live = await guest('/api/dosare/1234-30-2026/live');
  assert.match(live.headers.get('netlify-cdn-cache-control'), /max-age=10/);
  assert.equal(JSON.parse(live.text).state, 'upcoming');
  clock = T + 60000;
  assert.equal(JSON.parse((await guest('/api/dosare/1234-30-2026/live')).text).state, 'live', 'trece singur pe LIVE');
  clock = T - 3600000;

  // Administrarea cere Super Admin și CSRF.
  assert.equal((await guest('/admin/dosare')).status, 403);
  const admin = client();
  const login = await admin('/login', { email: 'admin@example.test', parola: password });
  assert.equal(login.headers.get('location'), '/admin', login.text.slice(0, 300));
  const page = await admin('/admin/dosare');
  assert.equal(page.status, 200);
  assert.match(page.text, /Dosarul evidențiat pe prima pagină/);
  const token = csrf(page.text);
  assert.equal((await admin('/admin/dosare/1234-30-2026/live', { liveMode: 'on' })).status, 403);
  assert.equal((await admin('/admin/dosare/1234-30-2026/live', { csrf_token: token, liveMode: 'on' })).status, 303);
  assert.equal((await admin('/admin/live', { csrf_token: token, dosar: '1234-30-2026', titlu: 'A început ședința', text: 'Părțile sunt prezente.' })).status, 303);
  const after = JSON.parse((await guest('/api/dosare/1234-30-2026/live')).text);
  assert.equal(after.state, 'live', 'LIVE pornit manual înainte de oră');
  assert.equal(after.updates[0].titlu, 'A început ședința');

  // Termenul se introduce în ora României.
  assert.equal((await admin('/admin/dosare/1234-30-2026', { csrf_token: token, titlu: 'Primul proces cu Primăria', stadiu: 'Fond',
    termenData: '2026-10-15', termenOra: '10:30', featured: 'da', liveMode: 'auto' })).status, 303);
  assert.equal(JSON.parse((await guest('/api/dosare/1234-30-2026/live')).text).termenAt, Date.parse('2026-10-15T07:30:00.000Z'));
  const invalid = await admin('/admin/dosare/1234-30-2026', { csrf_token: token, titlu: 'X', portalUrl: 'https://exemplu.ro/dosar' });
  assert.match(invalid.headers.get('location'), /eroare=/);

  // Anunțuri: cititorul trimite spre verificare, redacția aprobă.
  const form = await guest('/anunturi/publica');
  assert.equal(form.headers.get('x-robots-tag'), 'noindex, nofollow');
  const guestToken = csrf(form.text);
  const ad = { csrf_token: guestToken, tip: 'mica-publicitate', titlu: 'Vând lemne de foc', text: 'Lemne uscate, livrare în comună.', telefon: '0722 000 111', acord: 'da' };
  assert.equal((await guest('/anunturi/publica', { ...ad, csrf_token: 'gresit' })).status, 403);
  assert.equal((await guest('/anunturi/publica', ad)).status, 303);
  assert.doesNotMatch((await guest('/anunturi')).text, /Vând lemne de foc/, 'nepublicat înainte de verificare');
  const pending = (await voceaStore.read()).anunturi[0];
  assert.equal(pending.status, 'in_asteptare');
  assert.equal((await admin(`/admin/anunturi/${pending.id}`, { csrf_token: token, tip: pending.tip, titlu: pending.titlu, text: pending.text, telefon: pending.telefon })).status, 303);
  const list = await guest('/anunturi');
  assert.match(list.text, /Vând lemne de foc/);
  assert.doesNotMatch(list.text, /0722 000 111/, 'telefonul nu apare în HTML');
  assert.equal(JSON.parse((await guest(`/api/anunturi/${pending.id}/telefon`)).text).tel, '0722000111');
  for (let i = 0; i < 3; i += 1) await guest('/anunturi/publica', ad);
  assert.equal((await guest('/anunturi/publica', ad)).status, 429, 'limită pe zi');
  assert.equal((await guest('/anunturi/publica', { ...ad, website: 'spam' })).status, 303);
});
