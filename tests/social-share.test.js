import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jpeg from 'jpeg-js';
import { renderShareImage, photoDataUri } from '../social/images.js';
import { politicalLabel } from '../social/publications.js';
import { defaultTexts, finalText } from '../social/routes.js';
import { createComments } from '../comments.js';
import { createLocalCommentStore } from '../comment-store.js';
import { createEditorial } from '../editorial.js';
import { createCompliance, TERMS_VERSION } from '../compliance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const size = bytes => { const image = jpeg.decode(Buffer.from(bytes), { useTArray: true }); return [image.width, image.height]; };

test('Imaginile generate: Open Graph 1200×630 și Story 1080×1920, cu fotografie WebP', async () => {
  const photo = await photoDataUri(await fs.readFile(path.join(root, 'public', 'assets', 'lenauheim-centru-v1.webp')), { baseDir: root });
  assert.match(photo, /^data:image\/jpeg;base64,/);
  const card = { kind: 'Ședința Consiliului Local', title: 'Taxa de salubritate rămâne la nivelul actual', meta: '24.09.2026', photo };
  assert.deepEqual(size(await renderShareImage(card, 'og', { baseDir: root })), [1200, 630]);
  assert.deepEqual(size(await renderShareImage({ ...card, photo: null, political: politicalLabel({ electoral: true, candidate: 'Ana', payer: 'Ana' }) }, 'story', { baseDir: root })), [1080, 1920]);
  assert.equal(await photoDataUri(Buffer.from('nu este o imagine')), null);
});

test('Textele pe rețele: Instagram și TikTok fără linkuri, marcajul politic nu poate fi scos', () => {
  const publication = { title: 'Campanie pentru cartiere curate', summary: 'Rezumat.', political: politicalLabel({ electoral: false, candidate: 'Ana', payer: 'Partidul X' }) };
  assert.equal(publication.political, 'Material politic · Ana · Plătit de Partidul X');
  const texts = defaultTexts(publication);
  assert.match(texts.instagram, /Link în bio/);
  assert.match(texts.facebook, /Plătit de Partidul X/);
  const instagram = finalText('instagram', 'Vezi https://vocealenauheim.ro/x acum', publication);
  assert.doesNotMatch(instagram, /https?:\/\//);
  assert.match(instagram, /Material politic · Ana · Plătit de Partidul X$/, 'marcajul se adaugă dacă a fost șters');
  assert.equal(finalText('facebook', 'Text', { title: 'x', political: '' }), 'Text');
  assert.equal(finalText('tiktok', 'x'.repeat(5000), { political: '' }).length, 2200);
});

test('Distribuire: imagini publice, bara de distribuire, panou Super Admin cu confirmare și jurnal', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'social-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-only-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
  process.env.OAUTH_ENCRYPTION_KEY = 'test-only-oauth-key-0123456789-abcdefghijklmnop';
  // Fonturile, motorul WASM și imaginile publice vin din proiect.
  await fs.symlink(path.join(root, 'assets-social'), path.join(dir, 'assets-social'), 'junction');
  await fs.symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  await fs.mkdir(path.join(dir, 'data'));
  await fs.mkdir(path.join(dir, 'public', 'assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'public', 'style.css'), path.join(dir, 'public', 'style.css'));
  await fs.copyFile(path.join(root, 'public', 'assets', 'lenauheim-centru-v1.webp'), path.join(dir, 'public', 'assets', 'lenauheim-centru-v1.webp'));
  const { encryptSecret } = await import('../social.js');
  const password = 'test-only-password-123456789';
  const hash = bcrypt.hashSync(password, 4);
  const candidate = { id: 2, role: 'candidate', activ: true, status_cont: 'activ', email: 'ana@example.test', password_hash: hash,
    nume_candidat: 'Ana Marinescu', subdomeniu: 'ana', functie_candidatura: 'Consilier local', zona: 'Lenauheim', judet: 'Timiș',
    tip_candidat: 'independent', entitate_responsabila: 'Ana Marinescu', finantator_materiale: 'Ana Marinescu', scrutin: 'Alegeri',
    cod_mandatar_financiar: 'M-1', tip_contract: 'gratuit', numar_contract: 'C-1', data_contract: '2026-01-01', confirmare_mandatar: true,
    terms_version: TERMS_VERSION, terms_accepted_at: '2026-01-01T00:00:00Z', editorial_responsibility_accepted_at: '2026-01-01T00:00:00Z',
    module: { site: true, statistici: true, social: true }, vizibil_in_portal: true, created_at: '2026-01-01T00:00:00Z' };
  await fs.writeFile(path.join(dir, 'data', 'db.json'), JSON.stringify({
    users: [{ id: 1, role: 'admin', activ: true, email: 'admin@example.test', password_hash: hash,
      social_connections: { meta: { selected_page_id: 'p1', pages: [{ id: 'p1', name: 'Vocea Lenauheim', facebook_url: 'https://www.facebook.com/p1',
        access_token_enc: encryptSecret('page-token'), instagram_id: 'ig1', instagram_username: 'vocealenauheim' }] }, tiktok: null } }, candidate],
    articole: [{ id: 1, user_id: 2, titlu: 'Parcul din centru', continut: 'Text articol.', tip: 'idee', categorie: 'Proiecte', status: 'publicat', data_publicare: '2026-01-01T12:00:00Z' }],
    portal_posts: [
      { id: 1, tip: 'stire', status: 'publicat', slug: 'bugetul-pe-2026', titlu: 'Consiliul a aprobat bugetul pe 2026', rezumat: 'Rezumat buget.', continut: 'Text.', categorie: 'Administrație', imagine_url: '/assets/lenauheim-centru-v1.webp', data_publicare: '2026-10-01T10:00:00Z' },
      { id: 2, tip: 'campanie', candidate_id: 2, status: 'publicat', slug: 'cartiere-curate', titlu: 'Campanie pentru cartiere curate', rezumat: 'Ana prezintă proiectul.', continut: 'Text.', categorie: 'Campanie', finantator: 'Ana — campanie', transparenta: { finantat_de: 'Ana — campanie' }, data_publicare: '2026-10-02T10:00:00Z' },
      { id: 3, tip: 'stire', status: 'ciorna', slug: 'ciorna', titlu: 'Ciornă', rezumat: '', continut: 'x', categorie: 'Administrație' },
    ],
    nextUserId: 3, nextArticolId: 2, nextPortalPostId: 4,
  }));
  const clock = Date.parse('2026-10-06T08:00:00Z');
  const now = () => clock;
  const local = name => createLocalCommentStore(path.join(dir, name));
  const { createApp } = await import('../app.js');
  const { createVoceaStore, memoryBackend } = await import('../vocea/store.js');
  const voceaStore = createVoceaStore(memoryBackend({ schema: 1, dosare: [{ id: '1234-30-2026', numar: '1234/30/2026', titlu: 'Primul proces cu Primăria', obiect: 'Anulare act.', stadiu: 'Fond', liveMode: 'auto', featured: true, termene: [{ id: 't1', at: '2026-10-08T06:00:00.000Z' }], updates: [] }],
    anunturi: [{ id: 'a1', tip: 'primarie', titlu: 'Întrerupere apă', text: 'Joi, între 8 și 14.', status: 'publicat', publicatLa: '2026-10-01T00:00:00Z' }], sedinte: [], settings: {}, limite: {} }));
  const app = await createApp({
    now, voceaStore, auth: null,
    comments: createComments({ store: local('comments'), now }),
    editorial: createEditorial({ store: local('editorial'), env: {}, now, fetcher: async () => { throw new Error('fără rețea'); } }),
    compliance: createCompliance({ store: local('compliance'), now, secret: process.env.SESSION_SECRET }),
  });
  app.set('views', path.join(root, 'views'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  // Graph API simulat: nicio cerere reală către Meta.
  const realFetch = globalThis.fetch;
  const graphCalls = [];
  let failInstagram = false;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith('https://graph.facebook.com/')) return realFetch(url, options);
    graphCalls.push({ url: target, body: String(options.body || '') });
    const reply = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (target.includes('/p1/feed')) return reply({ id: 'p1_555' });
    if (target.includes('/ig1/media_publish')) return reply({ id: 'm777' });
    if (target.includes('/ig1/media')) return failInstagram ? new Response(JSON.stringify({ error: { message: 'Imaginea nu a putut fi descărcată.' } }), { status: 400 }) : reply({ id: 'c1' });
    if (target.includes('/m777?')) return reply({ permalink: 'https://www.instagram.com/p/abc/' });
    return reply({});
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const cookies = new Map();
    return async (url, form) => {
      const response = await realFetch(base + url, {
        redirect: 'manual', method: form ? 'POST' : 'GET',
        headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(form ? { body: new URLSearchParams(form) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) { const [k, ...v] = cookie.split(';')[0].split('='); cookies.set(k, v.join('=')); }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8') };
    };
  };
  const guest = client();
  const admin = client();

  // Paginile publice au imaginea OG generată, bara de distribuire și imaginea pentru Story.
  const post = await guest('/actualitate/bugetul-pe-2026');
  const ogMatch = post.text.match(/property="og:image" content="([^"]+\/imagini\/og\/stire\/bugetul-pe-2026\.jpg\?v=\w+)"/);
  assert.ok(ogMatch, 'og:image generat');
  assert.ok(post.text.indexOf(ogMatch[1]) < post.text.indexOf('property="og:image" content="' + base + '/assets/'), 'imaginea generată e prima');
  assert.match(post.text, /class="share-bar/);
  assert.match(post.text, /Copiază link/);
  assert.match(post.text, /class="share-btn share-btn--native native-share"[^>]*hidden/);
  assert.match(post.text, /Descarcă imaginea pentru Story\/TikTok/);
  assert.equal((post.text.match(/class="share-panel"/g) || []).length, 0, 'fără a doua bară de distribuire');
  const og = await guest(new URL(ogMatch[1]).pathname + new URL(ogMatch[1]).search);
  assert.equal(og.status, 200);
  assert.equal(og.headers.get('content-type'), 'image/jpeg');
  assert.match(og.headers.get('netlify-cdn-cache-control'), /immutable/);
  assert.deepEqual(size(og.buffer), [1200, 630]);
  const story = await guest('/imagini/story/stire/bugetul-pe-2026.jpg?descarca=1');
  assert.deepEqual(size(story.buffer), [1080, 1920]);
  assert.match(story.headers.get('content-disposition'), /^attachment; filename="vocea-lenauheim-story-stire-bugetul-pe-2026.jpg"/);
  assert.equal((await guest('/imagini/og/stire/ciorna.jpg')).status, 404, 'ciornele nu au imagini publice');
  assert.equal((await guest('/imagini/og/necunoscut/x.jpg')).status, 404);
  for (const [url, type] of [['/dosare/1234-30-2026', 'dosar'], ['/anunturi/a1', 'anunt']]) {
    const page = await guest(url);
    assert.match(page.text, new RegExp(`/imagini/og/${type}/`), url);
    assert.match(page.text, /class="share-bar/, url);
  }
  const article = await guest('/site/ana/articol/1');
  assert.match(article.text, /\/imagini\/og\/articol\/1\.jpg/);
  assert.match(article.text, /Imagine pentru Story\/TikTok/);
  assert.equal((await guest('/imagini/og/articol/1.jpg')).status, 200);

  // Super Admin: panoul, previzualizarea și confirmarea manuală.
  assert.equal((await guest('/admin/distribuie')).status, 403);
  await admin('/login', { email: 'admin@example.test', parola: password });
  const hub = await admin('/admin/distribuie');
  assert.equal(hub.status, 200);
  assert.match(hub.text, /Campanie pentru cartiere curate/);
  const token = hub.text.match(/name="csrf_token" value="([^"]+)"/)[1];
  const panel = await admin('/admin/distribuie/stire/cartiere-curate');
  assert.match(panel.text, /Conținut politic/);
  assert.match(panel.text, /Material politic · Ana Marinescu · Plătit de Ana — campanie|Material de propagandă electorală · Ana Marinescu · Plătit de Ana — campanie/);
  assert.match(panel.text, /name="retea_tiktok" value="da" disabled/, 'TikTok neconectat');
  assert.match(panel.text, /Link în bio/);
  const noNetwork = await admin('/admin/distribuie/stire/cartiere-curate/confirma', { csrf_token: token, text_facebook: 'x' });
  assert.equal(noNetwork.status, 400);
  const choices = { csrf_token: token, retea_facebook: 'da', retea_instagram: 'da', text_facebook: 'Despre cartiere curate', text_instagram: 'Detalii https://exemplu.ro aici', text_tiktok: '' };
  const confirm = await admin('/admin/distribuie/stire/cartiere-curate/confirma', choices);
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /Confirmă postarea/);
  assert.equal(graphCalls.length, 0, 'previzualizarea nu postează nimic');
  assert.match((await admin('/admin/distribuie/stire/cartiere-curate/posteaza', choices)).headers.get('location'), /eroare=/, 'fără confirmare explicită');
  assert.equal(graphCalls.length, 0);
  const posted = await admin('/admin/distribuie/stire/cartiere-curate/posteaza', { ...choices, confirmare: 'da' });
  assert.equal(posted.status, 303);
  assert.match(decodeURIComponent(posted.headers.get('location')), /mesaj=Trimis pe: Facebook \(Pagina\), Instagram/);
  const feed = graphCalls.find(call => call.url.includes('/p1/feed'));
  assert.match(decodeURIComponent(feed.body.replace(/\+/g, ' ')), /Plătit de Ana — campanie/, 'marcajul politic pe Facebook');
  assert.match(decodeURIComponent(feed.body), /link=http:\/\/127\.0\.0\.1:\d+\/actualitate\/cartiere-curate\?utm_source=facebook/);
  const media = graphCalls.find(call => call.url.includes('/ig1/media') && !call.url.includes('publish'));
  const mediaBody = new URLSearchParams(media.body);
  assert.doesNotMatch(mediaBody.get('caption'), /https?:\/\//, 'Instagram fără link în text');
  assert.match(mediaBody.get('image_url'), /\/imagini\/og\/stire\/cartiere-curate\.jpg/);
  const log = (await voceaStore.read()).social_log;
  assert.deepEqual(log.map(entry => [entry.network, entry.status, entry.url]).sort(), [
    ['facebook', 'publicat', 'https://www.facebook.com/p1_555'],
    ['instagram', 'publicat', 'https://www.instagram.com/p/abc/'],
  ]);

  // O eroare a rețelei ajunge în jurnal, cu mesajul primit.
  failInstagram = true;
  const failed = await admin('/admin/distribuie/anunt/a1/posteaza', { csrf_token: token, retea_instagram: 'da', text_instagram: 'Anunț', confirmare: 'da' });
  assert.match(decodeURIComponent(failed.headers.get('location')), /eroare=Eșuat: Instagram/);
  const errorEntry = (await voceaStore.read()).social_log.find(entry => entry.status === 'eroare');
  assert.equal(errorEntry.error, 'Imaginea nu a putut fi descărcată.');
  assert.match((await admin('/admin/distribuie')).text, /Imaginea nu a putut fi descărcată/);
  assert.match((await admin('/admin/social')).text, /Conectează paginile oficiale/);
});
