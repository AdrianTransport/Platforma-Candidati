import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import {
  verifyPdf, formatComment, readMeetingForm, meetingTitle, meetingFullTitle, meetingUrl, meetingState, resultCounts, MAX_PDF_BYTES,
} from '../vocea/sedinte.js';
import { createComments } from '../comments.js';
import { createLocalCommentStore } from '../comment-store.js';
import { createEditorial } from '../editorial.js';
import { createCompliance } from '../compliance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pdf = (text = 'Proces-verbal') => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\n%%EOF\n`, 'latin1');

test('Verificarea PDF: doar PDF-uri reale, fără conținut activ, sub limita de mărime', () => {
  assert.equal(verifyPdf(pdf()), null);
  assert.match(verifyPdf(Buffer.from('<html>nu</html>')), /nu este un PDF/);
  assert.match(verifyPdf(Buffer.from('%PDF-1.4\nfără sfârșit')), /incomplet/);
  assert.match(verifyPdf(Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF')), /scripturi/);
  assert.match(verifyPdf(Buffer.from('%PDF-1.4\n<< /EmbeddedFile 3 0 R >>\n%%EOF')), /scripturi/);
  const hidden = Buffer.concat([Buffer.from('%PDF-1.5\n5 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode >>\nstream\n'),
    zlib.deflateSync(Buffer.from('1 0 << /S /JavaScript >>')), Buffer.from('\nendstream endobj\n%%EOF')]);
  assert.match(verifyPdf(hidden), /scripturi/, 'JavaScript ascuns într-un flux comprimat');
  assert.match(verifyPdf(Buffer.from('%PDF-1.4\ntrailer << /Encrypt 4 0 R >>\n%%EOF')), /parolă/);
  assert.match(verifyPdf(Buffer.concat([pdf(), Buffer.alloc(MAX_PDF_BYTES)])), /depășește/);
});

test('Comentariul redacției: HTML sigur, citate, linkuri doar spre documente sau https', () => {
  const html = formatComment('Text **important** și *cursiv* <script>alert(1)</script>\n\n> „citat”\n\n[PV](/documente/abc-1/pv.pdf) [rău](javascript:alert(1)) [extern](https://portal.just.ro/x)');
  assert.match(html, /<strong>important<\/strong>/);
  assert.match(html, /<em>cursiv<\/em>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<blockquote>„citat”<\/blockquote>/);
  assert.match(html, /<a href="\/documente\/abc-1\/pv.pdf">PV<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /href="https:\/\/portal.just.ro\/x" rel="nofollow noopener" target="_blank"/);
});

test('Formularul ședinței: ora României, puncte, voturi, documente permise', () => {
  const { values, error } = readMeetingForm({
    tip: 'extraordinara', data: '2026-10-22', ora: '14:00', stare: 'programata',
    punct_id: ['', ''], punct_titlu: ['Buget', ''], punct_nota: ['Notă', ''], punct_rezultat: ['adoptat', 'respins'],
    punct_pentru: ['9', ''], punct_contra: ['x', ''], punct_abtineri: ['0', ''], punct_doc: ['doc-1', ''],
  }, new Set(['doc-1']));
  assert.equal(error, undefined);
  assert.equal(values.at, '2026-10-22T11:00:00.000Z');
  assert.equal(values.puncte.length, 1, 'punctele fără titlu se elimină');
  assert.deepEqual([values.puncte[0].pentru, values.puncte[0].contra, values.puncte[0].abtineri, values.puncte[0].docId], [9, null, 0, 'doc-1']);
  assert.match(readMeetingForm({ data: '' }).error, /data/);
  assert.match(readMeetingForm({ data: '2026-10-22', comentariu_text: 'Fără titlu' }).error, /titlu/);
  const meeting = { id: 'abc12345', tip: 'ordinara', at: values.at };
  assert.equal(meetingTitle(meeting), 'Ședința ordinară din octombrie 2026');
  assert.equal(meetingFullTitle(meeting), 'Ședința ordinară a Consiliului Local din octombrie 2026');
  assert.equal(meetingUrl(meeting), '/sedinte/2026-10-22-ordinara-abc12345');
  assert.equal(meetingState({ ...meeting, stare: 'programata' }, Date.parse('2026-10-23T12:00:00Z')), 'incheiata');
  assert.deepEqual(resultCounts({ puncte: [{ rezultat: 'adoptat' }, { rezultat: 'amanat' }, {}] }), { adoptat: 1, respins: 0, amanat: 1, nevotat: 1 });
});

test('Ședințe: ciornă, previzualizare, PDF în Netlify Blobs, publicare, comentariu OPINIE', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sedinte-test-'));
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
  const clock = Date.parse('2026-10-06T08:00:00Z');
  const now = () => clock;
  const local = name => createLocalCommentStore(path.join(dir, name));
  // Importate după chdir: stocările locale își fixează căile la încărcare.
  const { createApp } = await import('../app.js');
  const { createVoceaStore, memoryBackend } = await import('../vocea/store.js');
  const { memoryPdfStore } = await import('../vocea/pdf-store.js');
  const voceaStore = createVoceaStore(memoryBackend());
  const pdfStore = memoryPdfStore();
  const app = await createApp({
    now, voceaStore, pdfStore, auth: null,
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
    return async (url, { body, form, headers = {}, method } = {}) => {
      const response = await fetch(base + url, {
        redirect: 'manual', method: method || (body || form ? 'POST' : 'GET'),
        headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        ...(form ? { body: new URLSearchParams(form) } : body ? { body } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [key, ...value] = cookie.split(';')[0].split('=');
        cookies.set(key, value.join('='));
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8') };
    };
  };
  const csrf = html => html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const guest = client();
  const admin = client();

  assert.equal((await guest('/admin/sedinte')).status, 403);
  assert.equal((await admin('/login', { form: { email: 'admin@example.test', parola: password } })).headers.get('location'), '/admin');
  const list = await admin('/admin/sedinte');
  assert.equal(list.status, 200);
  const token = csrf(list.text);
  assert.equal((await admin('/admin/sedinte', { form: { tip: 'ordinara', data: '2026-09-24' } })).status, 403, 'CSRF');
  const created = await admin('/admin/sedinte', { form: { csrf_token: token, tip: 'ordinara', data: '2026-09-24', ora: '10:00' } });
  assert.equal(created.status, 303);
  const id = created.headers.get('location').split('?')[0].split('/').pop();
  const editor = await admin(`/admin/sedinte/${id}`);
  assert.match(editor.text, /Trage PDF-urile aici/);
  assert.match(editor.text, /APARE CA „OPINIE”/);
  assert.match(editor.text, /src="\/admin-sedinta.js"/);

  // Ciorna nu este publică; Super Admin o vede ca previzualizare, fără indexare.
  const url = '/sedinte/2026-09-24-ordinara-' + id;
  assert.equal((await guest(url)).status, 404);
  const preview = await admin(url);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Previzualizare/);
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');

  // Încărcarea PDF: Super Admin, token CSRF în antet, conținut verificat, limită de mărime.
  const upload = (who, body, headers = {}, name = 'proces-verbal.pdf') => who(`/admin/sedinte/${id}/documente?nume=${encodeURIComponent(name)}`, {
    body, headers: { 'Content-Type': 'application/pdf', 'X-CSRF-Token': token, ...headers },
  });
  assert.equal((await upload(guest, pdf())).status, 403);
  assert.equal((await upload(admin, pdf(), { 'X-CSRF-Token': 'gresit' })).status, 403);
  assert.equal((await upload(admin, Buffer.from('<html>'))).status, 400);
  assert.equal((await upload(admin, Buffer.from('%PDF-1.4\n/JS (x)\n%%EOF'))).status, 400);
  assert.equal((await upload(admin, Buffer.concat([pdf(), Buffer.alloc(MAX_PDF_BYTES + 2048)]))).status, 413);
  assert.equal((await upload(admin, pdf(), { 'Content-Type': 'text/plain' })).status, 415);
  const okUpload = await upload(admin, pdf('PV real'));
  assert.equal(okUpload.status, 201);
  const doc = JSON.parse(okUpload.text);
  assert.equal(doc.tip, 'proces-verbal', 'tipul se deduce din nume');
  assert.ok(await pdfStore.get(doc.id), 'fișierul e în stocarea PDF');
  const docPath = `/documente/${doc.id}/proces-verbal.pdf`;
  assert.equal((await guest(docPath)).status, 404, 'PDF-ul unei ciorne nu e public');

  // Salvare completă și publicare.
  const saved = await admin(`/admin/sedinte/${id}`, { form: new URLSearchParams([
    ['csrf_token', token], ['tip', 'ordinara'], ['data', '2026-09-24'], ['ora', '10:00'], ['stare', 'incheiata'], ['loc', 'Sala de consiliu'],
    ['rezumat', 'Bugetul a fost rectificat.'], [`doc_tip_${doc.id}`, 'proces-verbal'],
    ['punct_id', ''], ['punct_titlu', 'Rectificarea bugetului'], ['punct_nota', 'Banii merg la drumuri.'], ['punct_rezultat', 'adoptat'], ['punct_pentru', '9'], ['punct_contra', '2'], ['punct_abtineri', ''], ['punct_doc', doc.id],
    ['punct_id', ''], ['punct_titlu', 'Taxa de salubritate'], ['punct_nota', ''], ['punct_rezultat', 'respins'], ['punct_pentru', ''], ['punct_contra', '7'], ['punct_abtineri', ''], ['punct_doc', ''],
    ['comentariu_titlu', 'Ce înseamnă pentru comună'], ['comentariu_text', `Punctul de vedere al redacției.\n\n> „Citat din procesul-verbal”\n\n[Procesul-verbal](${docPath}) <img src=x>`],
    ['comentariu_autor', 'Redacția'], ['comentariu_nota', 'da'], ['actiune', 'publica'],
  ]) });
  assert.equal(saved.status, 303);
  assert.match(decodeURIComponent(saved.headers.get('location')), /publicată/);

  const page = await guest(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('netlify-cdn-cache-control'), /public, durable/);
  assert.match(page.text, /Ședința ordinară a Consiliului Local din septembrie 2026/);
  assert.match(page.text, /Comentariul redacției/);
  assert.match(page.text, /OPINIE/);
  assert.match(page.text, /drept la replică/);
  assert.match(page.text, /<blockquote>„Citat din procesul-verbal”<\/blockquote>/);
  assert.match(page.text, /&lt;img src=x&gt;/);
  assert.match(page.text, /Nota redacției:<\/i> Banii merg la drumuri./);
  assert.match(page.text, /Adoptat · 9 pentru/);
  assert.match(page.text, /Respins · 7 contra/);
  assert.match(page.text, /data-pdf-viewer/);
  assert.match(page.text, /<script type="module" src="\/sedinta-pdf.js"><\/script>/);
  assert.match(page.text, new RegExp(`href="${docPath}\\?descarca=1"`));

  const inline = await guest(docPath);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.match(inline.headers.get('content-disposition'), /^inline; filename="proces-verbal.pdf"/);
  assert.ok(inline.buffer.equals(pdf('PV real')), 'aceiași octeți');
  assert.match((await guest(`${docPath}?descarca=1`)).headers.get('content-disposition'), /^attachment/);

  const overview = await guest('/sedinte');
  assert.match(overview.text, /Ședințe încheiate/);
  assert.match(overview.text, /Bugetul a fost rectificat./);
  assert.match(overview.text, /Proces-verbal \(PDF\)/);
  assert.match((await guest('/sedinte?tip=extraordinara')).headers.get('x-robots-tag'), /noindex/);
  assert.match((await guest('/sitemap.xml')).text, new RegExp(`${url}</loc>`));
  assert.equal((await guest('/sedinte/2026-09-24-gresit-' + id)).headers.get('location'), url, 'adresa veche redirecționează');

  const next = await admin('/admin/sedinte', { form: { csrf_token: token, tip: 'extraordinara', data: '2026-10-22', ora: '14:00' } });
  const nextId = next.headers.get('location').split('?')[0].split('/').pop();
  await admin(`/admin/sedinte/${nextId}`, { form: { csrf_token: token, tip: 'extraordinara', data: '2026-10-22', ora: '14:00', stare: 'programata', punct_titlu: 'Concesionarea pășunii', punct_rezultat: 'nevotat', actiune: 'publica' } });
  const upcoming = await guest('/sedinte');
  assert.match(upcoming.text, /URMĂTOAREA ȘEDINȚĂ/);
  assert.match(upcoming.text, /Concesionarea pășunii/);
  const ics = await guest(`/sedinte/2026-10-22-extraordinara-${nextId}/calendar.ics`);
  assert.match(ics.text, /DTSTART:20261022T110000Z/);

  // Documente PDF: lista tuturor fișierelor; ștergerea scoate fișierul din stocare.
  const docs = await admin('/admin/documente');
  assert.match(docs.text, /proces-verbal.pdf/);
  assert.equal((await admin(`/admin/documente/${doc.id}/sterge`, { form: { csrf_token: token } })).status, 303);
  assert.equal(await pdfStore.get(doc.id), null);
  assert.equal((await guest(docPath)).status, 404);

  // Retragerea o face din nou ciornă.
  await admin(`/admin/sedinte/${id}`, { form: { csrf_token: token, data: '2026-09-24', actiune: 'ciorna' } });
  assert.equal((await guest(url)).status, 404);

  // Categoria „Biserică” nu mai există.
  assert.doesNotMatch((await guest('/anunturi')).text, /Biseric/);
  assert.doesNotMatch((await guest('/anunturi/publica')).text, /Biseric/);
  await voceaStore.update((data) => {
    data.anunturi.push({ id: 'vechi', tip: 'biserica', titlu: 'Program slujbe', text: 'x', status: 'publicat', publicatLa: '2026-10-01T00:00:00Z' });
  });
  assert.equal((await guest('/anunturi/vechi')).status, 404);
  assert.match((await guest('/')).text, /href="\/sedinte"/);
});
