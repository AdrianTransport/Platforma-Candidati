import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { checkPhoto, detectFormat, MAX_PHOTO_BYTES } from '../vocea/poze.js';
import { purgePhotos, claimPhotos } from '../vocea/poze-routes.js';
import { createComments } from '../comments.js';
import { createLocalCommentStore } from '../comment-store.js';
import { createEditorial } from '../editorial.js';
import { createCompliance } from '../compliance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const jpegFile = await fs.readFile(path.join(root, 'public', 'img', 'og-default.jpg'));
const webpFile = await fs.readFile(path.join(root, 'public', 'assets', 'lenauheim-centru-v1-640.webp'));

// Un segment EXIF cu coordonate GPS, inserat după antetul JPEG.
function withGps(jpeg) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSLatitude=45.85;GPSLongitude=20.80;Telefonul lui Ion')]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

test('Pozele: tipul real, dimensiunile, limita de mărime și eliminarea EXIF/GPS', () => {
  const photo = checkPhoto(withGps(jpegFile));
  assert.equal(photo.format, 'jpeg');
  assert.deepEqual([photo.width, photo.height], [1200, 630]);
  assert.ok(!photo.buffer.includes('GPSLatitude'), 'fără coordonate GPS');
  assert.equal(detectFormat(photo.buffer), 'jpeg');
  const webp = checkPhoto(webpFile);
  assert.deepEqual([webp.format, webp.width, webp.height], ['webp', 640, 400]);
  assert.match(checkPhoto(Buffer.from('<?php echo "nu sunt o poză"; ?>')).error, /nu este o poză/);
  assert.match(checkPhoto(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)])).error, /nu este o poză/);
  assert.match(checkPhoto(Buffer.concat([jpegFile, Buffer.alloc(MAX_PHOTO_BYTES)])).error, /prea mare/);
  assert.match(checkPhoto(jpegFile, { maxSide: 640 }).error, /640 px/, 'miniatura are limita ei');
});

test('Pozele se atașează doar sesiunii care le-a încărcat; cele vechi și ale anunțurilor expirate se șterg', () => {
  const now = Date.parse('2026-10-06T08:00:00Z');
  const data = {
    poze_incarcate: [
      { id: 'a', owner: 'eu', at: new Date(now).toISOString(), width: 10, height: 10, format: 'jpeg', mic: { width: 5, height: 5, format: 'jpeg' } },
      { id: 'b', owner: 'altcineva', at: new Date(now).toISOString(), mic: {} },
      { id: 'c', owner: 'eu', at: new Date(now).toISOString() },
      { id: 'vechi', owner: 'eu', at: new Date(now - 25 * 3600000).toISOString(), mic: {} },
    ],
    anunturi: [{ id: 'x', expiraLa: new Date(now - 1000).toISOString(), poze: [{ id: 'p1' }] }, { id: 'y', expiraLa: null, poze: [{ id: 'p2' }] }],
  };
  assert.deepEqual(claimPhotos(data, ['b', 'c', 'a'], 'eu').map(p => p.id), ['a'], 'doar pozele proprii și complete');
  const removed = purgePhotos(data, now).map(p => p.id).sort();
  assert.deepEqual(removed, ['p1', 'vechi']);
  assert.deepEqual(data.anunturi.map(a => a.poze.length), [0, 1]);
});

test('Anunț cu poze: încărcare, moderare, afișare, ștergerea unei poze și a anunțului', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anunturi-poze-'));
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
  let clock = Date.parse('2026-10-06T08:00:00Z');
  const now = () => clock;
  const local = name => createLocalCommentStore(path.join(dir, name));
  const { createApp } = await import('../app.js');
  const { createVoceaStore, memoryBackend } = await import('../vocea/store.js');
  const { memoryPhotoStore } = await import('../vocea/poze.js');
  const voceaStore = createVoceaStore(memoryBackend());
  const photoStore = memoryPhotoStore();
  const app = await createApp({
    now, voceaStore, photoStore, auth: null,
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
    return async (url, { form, body, headers = {} } = {}) => {
      const response = await fetch(base + url, {
        redirect: 'manual', method: form || body ? 'POST' : 'GET',
        headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        ...(form ? { body: form instanceof URLSearchParams ? form : new URLSearchParams(form) } : body ? { body } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) { const [k, ...v] = cookie.split(';')[0].split('='); cookies.set(k, v.join('=')); }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8') };
    };
  };
  const csrf = html => html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const reader = client();
  const other = client();
  const guest = client();

  const form = await reader('/anunturi/publica');
  assert.match(form.text, /Adaugă poze/);
  assert.match(form.text, /accept="image\/\*" multiple/);
  assert.match(form.text, /Fără poze cu persoane fără acordul lor și fără documente cu date personale\./);
  assert.match(form.text, /src="\/anunt-poze.js" defer/);
  const token = csrf(form.text);
  const upload = (who, body, type = 'image/jpeg', extra = {}) => who('/anunturi/poze', { body, headers: { 'Content-Type': type, 'X-CSRF-Token': token, ...extra } });

  assert.equal((await upload(reader, jpegFile, 'image/jpeg', { 'X-CSRF-Token': 'gresit' })).status, 403);
  assert.equal((await upload(reader, Buffer.from('<script>alert(1)</script>'.repeat(4)), 'image/jpeg')).status, 400, 'tipul real, nu cel declarat');
  assert.equal((await upload(reader, Buffer.concat([jpegFile, Buffer.alloc(MAX_PHOTO_BYTES + 4096)]))).status, 413);
  const ids = [];
  for (const [big, type] of [[withGps(jpegFile), 'image/jpeg'], [webpFile, 'image/webp']]) {
    const result = await upload(reader, big, type);
    assert.equal(result.status, 201, result.text);
    const { id } = JSON.parse(result.text);
    assert.equal((await reader(`/anunturi/poze/${id}/mic`, { body: webpFile, headers: { 'Content-Type': 'image/webp', 'X-CSRF-Token': token } })).status, 201);
    ids.push(id);
  }
  assert.ok(!(await photoStore.get(ids[0])).includes('GPSLatitude'), 'EXIF/GPS eliminat și pe server');
  // Poza altei sesiuni nu poate fi atașată.
  const otherToken = csrf((await other('/anunturi/publica')).text);
  const foreign = JSON.parse((await other('/anunturi/poze', { body: jpegFile, headers: { 'Content-Type': 'image/jpeg', 'X-CSRF-Token': otherToken } })).text).id;
  await other(`/anunturi/poze/${foreign}/mic`, { body: webpFile, headers: { 'Content-Type': 'image/webp', 'X-CSRF-Token': otherToken } });

  // O eroare de validare păstrează pozele în formular.
  const fields = [['csrf_token', token], ['tip', 'mica-publicitate'], ['titlu', 'Vând bicicletă'], ['text', 'Bicicletă de oraș, în stare bună.'], ['acord', 'da']];
  const retry = await reader('/anunturi/publica', { form: new URLSearchParams([...fields, ['telefon', ''], ['poze', ids[1]], ['poze', ids[0]]]) });
  assert.equal(retry.status, 400);
  assert.ok(retry.text.indexOf(`value="${ids[1]}"`) < retry.text.indexOf(`value="${ids[0]}"`), 'ordinea pozelor se păstrează');
  assert.equal((await reader(`/anunturi/poze/${ids[0]}/mic`)).status, 200, 'autorul își vede miniatura');
  assert.equal((await guest(`/anunturi/poze/${ids[0]}/mic`)).status, 404);

  const sent = await reader('/anunturi/publica', { form: new URLSearchParams([...fields, ['telefon', '0722000111'], ['poze', ids[1]], ['poze', ids[0]], ['poze', foreign]]) });
  assert.equal(sent.status, 303);
  const pending = (await voceaStore.read()).anunturi[0];
  assert.deepEqual(pending.poze.map(p => p.id), [ids[1], ids[0]], 'prima aleasă e principala; poza străină e ignorată');
  assert.equal((await guest(`/anunturi/poze/${ids[1]}/mare`)).status, 404, 'invizibile până la aprobare');

  // Super Admin vede pozele la moderare și poate scoate una fără să respingă anunțul.
  const admin = client();
  await admin('/login', { form: { email: 'admin@example.test', parola: password } });
  const list = await admin('/admin/anunturi');
  assert.match(list.text, new RegExp(`/anunturi/poze/${ids[1]}/mic`));
  assert.match(list.text, /2 poze de verificat/);
  const adminToken = csrf(list.text);
  assert.equal((await admin(`/anunturi/poze/${ids[0]}/mare`)).status, 200);
  assert.equal((await admin(`/admin/anunturi/${pending.id}/poze/${ids[0]}/sterge`, { form: { csrf_token: adminToken } })).status, 303);
  assert.equal(await photoStore.get(ids[0]), null);
  assert.equal(await photoStore.get(`${ids[0]}-mic`), null);
  assert.equal((await admin(`/admin/anunturi/${pending.id}`, { form: { csrf_token: adminToken, tip: pending.tip, titlu: pending.titlu, text: pending.text, telefon: pending.telefon } })).status, 303);
  assert.deepEqual((await voceaStore.read()).anunturi[0].poze.map(p => p.id), [ids[1]], 'aprobarea păstrează pozele rămase');

  // Pe site: poza principală pe card, cu dimensiuni fixe și încărcare leneșă; galeria la deschidere.
  const listing = await guest('/anunturi');
  assert.match(listing.text, new RegExp(`<img src="/anunturi/poze/${ids[1]}/mic" alt="" width="\\d+" height="\\d+" loading="lazy"`));
  const detail = await guest(`/anunturi/${pending.id}`);
  assert.match(detail.text, /data-gallery/);
  assert.match(detail.text, /src="\/anunt-galerie.js" defer/);
  const image = await guest(`/anunturi/poze/${ids[1]}/mare`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');

  // La expirare, pozele se șterg; la fel încărcările neatașate mai vechi de o zi.
  clock += 31 * 86400000;
  await admin('/admin/anunturi');
  assert.equal(await photoStore.get(ids[1]), null);
  assert.equal(await photoStore.get(foreign), null);
  assert.deepEqual((await voceaStore.read()).poze_incarcate, []);

  // Ștergerea anunțului șterge și pozele lui.
  const fresh = await reader('/anunturi/publica');
  const t2 = csrf(fresh.text);
  const again = JSON.parse((await reader('/anunturi/poze', { body: jpegFile, headers: { 'Content-Type': 'image/jpeg', 'X-CSRF-Token': t2 } })).text).id;
  await reader(`/anunturi/poze/${again}/mic`, { body: webpFile, headers: { 'Content-Type': 'image/webp', 'X-CSRF-Token': t2 } });
  await reader('/anunturi/publica', { form: new URLSearchParams([['csrf_token', t2], ['tip', 'mica-publicitate'], ['titlu', 'Altă bicicletă'], ['text', 'Încă o bicicletă de vânzare.'], ['telefon', '0722000111'], ['acord', 'da'], ['poze', again]]) });
  const second = (await voceaStore.read()).anunturi.find(a => a.titlu === 'Altă bicicletă');
  assert.equal(second.poze.length, 1);
  await admin(`/admin/anunturi/${second.id}/sterge`, { form: { csrf_token: adminToken } });
  assert.equal(await photoStore.get(again), null);
});
