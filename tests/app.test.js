import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { createComments } from '../comments.js';
import { createLocalCommentStore } from '../comment-store.js';
import { createEditorial } from '../editorial.js';
import { createCompliance, TERMS_VERSION } from '../compliance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const csrf = html => html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
test('Flux HTTP complet într-o instalare izolată, fără API-uri sau date de producție', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-app-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-only-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
  process.env.PLATFORM_OPERATOR_NAME = 'Operator Test SRL';
  process.env.PLATFORM_OPERATOR_ID = 'RO12345678';
  process.env.PLATFORM_LEGAL_EMAIL = 'juridic@example.test';
  process.env.PLATFORM_LEGAL_ADDRESS = 'Strada Test 1, Timișoara';
  // Datele fixture nu sunt conturi de producție.
  const password = 'test-only-password-123456789';
  const hash = bcrypt.hashSync(password, 4);
  await fs.mkdir(path.join(dir, 'data'));
  const candidate = (id, name) => ({ id, role: 'candidate', activ: true, status_cont: 'activ',
    email: `${name}@example.test`, password_hash: hash, nume_candidat: name, subdomeniu: name,
    functie_candidatura: 'Consilier local', zona: 'Timișoara', judet: 'Timiș', partid: 'Independent',
    tip_candidat: 'independent', entitate_responsabila: name, finantator_materiale: name,
    scrutin: 'Alegeri locale de test', cod_mandatar_financiar: `MANDAT-${id}`, tip_contract: 'platit',
    numar_contract: `TEST-${id}`, data_contract: '2026-01-01', valoare_contract: 1000, moneda_contract: 'RON',
    confirmare_mandatar: true, terms_version: TERMS_VERSION, terms_accepted_at: '2026-01-01T00:00:00Z',
    editorial_responsibility_accepted_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' });
  await fs.writeFile(path.join(dir, 'data', 'db.json'), JSON.stringify({
    users: [{ id: 1, role: 'admin', activ: true, email: 'admin@example.test', password_hash: hash, auth_user_id: 'auth-1' },
      { ...candidate(2, 'ana'), auth_user_id: 'auth-2' }, { ...candidate(3, 'bogdan'), auth_user_id: 'auth-3' }],
    articole: [{ id: 1, user_id: 2, titlu: 'Școala publică', continut: 'Informații pentru Timișoara', tip: 'idee', categorie: 'Proiecte', status: 'publicat', data_publicare: '2026-01-01T12:00:00Z' },
      { id: 2, user_id: 3, titlu: 'Alt candidat', continut: 'Text privat candidat B', tip: 'idee', categorie: 'Program', status: 'publicat', data_publicare: '2026-01-01T12:00:00Z' },
      { id: 3, user_id: 2, titlu: 'Ciorna secretă', continut: 'Niciodată public înainte de aprobare', tip: 'idee', categorie: 'Secrete', status: 'ciorna' }],
    nextUserId: 4, nextArticolId: 4,
  }));
  let clock = Date.parse('2026-07-10T08:00:00Z');
  const comments = createComments({ store: createLocalCommentStore(path.join(dir, 'comments')), now: () => clock });
  const editorial = createEditorial({ store: createLocalCommentStore(path.join(dir, 'editorial')), env: {},
    fetcher: async () => { throw new Error('AI network must not be called'); }, now: () => clock });
  const compliance = createCompliance({ store: createLocalCommentStore(path.join(dir, 'compliance')),
    now: () => clock, secret: process.env.SESSION_SECRET });
  const authAccounts = new Map([
    ['admin@example.test', { id: 'auth-1', password }],
    ['ana@example.test', { id: 'auth-2', password }],
    ['bogdan@example.test', { id: 'auth-3', password }],
  ]);
  const auth = {
    async signIn(email, supplied) {
      const account = authAccounts.get(email);
      if (!account || account.password !== supplied) throw new Error('Invalid credentials');
      return { user: { id: account.id } };
    },
    async createUser(user, supplied) {
      const account = { id: `auth-${user.id}`, password: supplied };
      authAccounts.set(user.email, account);
      return account;
    },
    async updatePassword(id, supplied) {
      const entry = [...authAccounts.entries()].find(([, account]) => account.id === id);
      if (!entry) throw new Error('User not found');
      entry[1].password = supplied;
    },
    async deleteUser(id) {
      const entry = [...authAccounts.entries()].find(([, account]) => account.id === id);
      if (entry) authAccounts.delete(entry[0]);
    },
  };
  const { createApp } = await import('../app.js');
  const { db } = await import('../db.js');
  const app = await createApp({ comments, editorial, compliance, auth, now: () => clock });
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
  function browser() {
    const cookies = new Map();
    return async (url, body, json = false) => {
      const response = await fetch(base + url, {
        redirect: 'manual', method: body ? 'POST' : 'GET',
        headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' } : {}) },
        ...(body ? { body: json ? JSON.stringify(body) : new URLSearchParams(body) } : {}),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [key, ...value] = cookie.split(';')[0].split('=');
        cookies.set(key, value.join('='));
      }
      return { status: response.status, headers: response.headers, html: await response.text() };
    };
  }
  const guest = browser();
  const cand = browser();
  const admin = browser();
  const articleBody = { titlu: 'Articol programat', continut: 'Eveniment pentru comunitate', tip: 'idee', categorie: 'Evenimente', status: 'programat', data_programata: '2026-07-10T12:30', confirmare_responsabilitate: 'on' };
  let candidateToken;
  let guestToken;
  let adminToken;
  let comment;

  await t.test('Paginile existente și autentificarea sunt păstrate', async () => {
    assert.equal((await guest('/')).status, 200);
    assert.equal((await guest('/login')).status, 200);
    assert.equal((await guest('/admin/comentarii')).status, 403);
    assert.equal((await cand('/login', { email: 'ana@example.test', parola: password })).headers.get('location'), '/dashboard');
    const dashboard = await cand('/dashboard');
    assert.equal(dashboard.status, 200);
    candidateToken = csrf(dashboard.html);
    assert.ok(candidateToken);
    assert.equal((await cand('/dashboard/social')).status, 200);
    assert.equal((await cand('/admin/comentarii')).status, 403);
  });
  await t.test('SEO public: robots, sitemap, RSS și Open Graph', async () => {
    const robots = await guest('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /text\/plain/);
    assert.match(robots.html, /Disallow: \/admin/);
    assert.match(robots.html, new RegExp(`Sitemap: ${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/sitemap\\.xml`));

    const sitemap = await guest('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /application\/xml/);
    assert.match(sitemap.html, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(sitemap.html, /\/site\/ana\/articol\/1<\/loc>/);
    assert.doesNotMatch(sitemap.html, /\/site\/ana\/articol\/3<\/loc>/);

    const rss = await guest('/site/ana/rss.xml');
    assert.equal(rss.status, 200);
    assert.match(rss.headers.get('content-type'), /application\/rss\+xml/);
    assert.match(rss.html, /<title>Școala publică<\/title>/);
    assert.doesNotMatch(rss.html, /Ciorna secretă|Alt candidat/);

    const candidatePage = await guest('/site/ana');
    assert.match(candidatePage.html, /property="og:type" content="website"/);
    assert.match(candidatePage.html, /property="og:url" content="http:\/\/127\.0\.0\.1:/);
    assert.match(candidatePage.html, /type="application\/rss\+xml"/);

    const articlePage = await guest('/site/ana/articol/1');
    assert.match(articlePage.html, /property="og:type" content="article"/);
    assert.match(articlePage.html, /property="og:title" content="Școala publică"/);
    assert.match((await guest('/site/ana/despre')).html, /property="og:type" content="profile"/);
    assert.match((await guest('/site/ana/contact')).html, /property="og:title" content="Contact — ana"/);
  });
  await t.test('Rubricile au pagini proprii, iar proiectele sunt multiple, clicabile și administrate din dashboard', async () => {
    const dashboard = await cand('/dashboard');
    assert.match(dashboard.html, /Administrează fiecare pagină din meniu/);
    assert.match(dashboard.html, /href="\/candidate-ui\.css"/);
    assert.match(dashboard.html, /class="candidate-sidebar"/);
    assert.match(dashboard.html, /class="candidate-profile-editor candidate-panel"/);
    assert.match(dashboard.html, /Identitate publică/);
    assert.match(dashboard.html, /Candidatură și zonă/);
    assert.match(dashboard.html, /Gestionează conexiunile API/);
    assert.match(dashboard.html, /data-label="Acțiuni"/);
    for (const section of ['actualitate', 'program', 'proiecte', 'evenimente']) {
      assert.ok(dashboard.html.includes(`/dashboard/articol/nou?categorie=${section[0].toUpperCase()}${section.slice(1)}`));
      assert.ok(dashboard.html.includes(`/site/ana/${section}`));
      assert.equal((await guest(`/site/ana/${section}`)).status, 200);
    }

    const form = await cand('/dashboard/articol/nou?categorie=Proiecte');
    assert.equal(form.status, 200);
    assert.match(form.html, /<h1>Proiect nou<\/h1>/);
    assert.match(form.html, /value="Proiecte" selected/);
    assert.match(form.html, /Text și imagini cu OpenAI/);
    assert.match(form.html, /id="fisier-imagine"/);
    assert.match(form.html, /Generează material complet/);
    assert.match(form.html, /Generează doar ilustrația/);
    assert.match(form.html, /data-editor-context="candidate"/);
    assert.match(form.html, /data-editor-step="1"/);
    assert.match(form.html, /data-editor-step="4"/);
    assert.match(form.html, /Verifică și asumă materialul/);

    const secondProject = { id: 90, user_id: 2, titlu: 'Parcul cartierului', rezumat: 'Un al doilea proiect public.', continut: 'Detaliile proiectului.', tip: 'idee', categorie: 'Proiecte', status: 'publicat', imagine_url: 'https://example.test/parc.jpg', imagine_alt: 'Plan ilustrat al parcului', data_publicare: '2026-01-02T12:00:00Z', vizualizari: 0 };
    db.data.articole.push(secondProject);
    try {
      const projects = await guest('/site/ana/proiecte');
      assert.equal(projects.status, 200);
      assert.match(projects.html, /2 materiale publicate/);
      assert.match(projects.html, /Școala publică/);
      assert.match(projects.html, /Parcul cartierului/);
      assert.match(projects.html, /src="https:\/\/example\.test\/parc\.jpg"/);
      assert.match(projects.html, /href="\/site\/ana\/proiect\/1"/);
      assert.match(projects.html, /href="\/site\/ana\/proiect\/90"/);
      assert.ok(!projects.html.includes('Alt candidat'));
      assert.ok(!projects.html.includes('Ciorna secretă'));
      const reads = db.data.articole.find(article => article.id === 1).vizualizari || 0;
      const detail = await guest('/site/ana/proiect/1');
      assert.equal(detail.status, 200);
      assert.match(detail.html, /Școala publică/);
      assert.equal(db.data.articole.find(article => article.id === 1).vizualizari, reads + 1);
      assert.equal((await guest('/site/ana/proiect/3')).status, 404);
      assert.equal((await guest('/site/bogdan/proiect/2')).status, 404);
    } finally {
      db.data.articole = db.data.articole.filter(article => article.id !== secondProject.id);
    }

    const about = await guest('/site/ana/despre');
    assert.equal(about.status, 200);
    assert.match(about.html, /Despre candidat/);
    assert.match(about.html, /Consilier local/);
    assert.match((await guest('/site/ana')).html, /href="\/site\/ana\/proiecte"/);
  });
  await t.test('Previzualizarea este privată, nu numără citiri, iar filtrele dashboardului sunt exacte', async () => {
    const draft = db.data.articole.find(article => article.id === 3);
    const publicArticle = db.data.articole.find(article => article.id === 1);
    const draftReads = draft.vizualizari || 0;
    const publicReads = publicArticle.vizualizari || 0;

    assert.equal((await guest('/dashboard/articol/3/preview')).status, 403);
    assert.equal((await cand('/dashboard/articol/2/preview')).status, 404);
    assert.equal((await guest('/site/ana/articol/3')).status, 404);

    const preview = await cand('/dashboard/articol/3/preview');
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.match(preview.html, /Previzualizare privată/);
    assert.match(preview.html, /Ciorna secretă/);
    assert.match(preview.html, /Numai tu poți vedea această pagină/);
    assert.match(preview.html, /Continuă editarea/);
    assert.ok(!preview.html.includes('class="comment-form"'));
    assert.ok(!preview.html.includes('sharer.php'));
    assert.ok(!preview.html.includes('Raportează materialul'));
    assert.equal(draft.vizualizari || 0, draftReads);

    const publishedPreview = await cand('/dashboard/articol/1/preview');
    assert.equal(publishedPreview.status, 200);
    assert.equal(publicArticle.vizualizari || 0, publicReads);

    const projects = await cand('/dashboard?categorie=Proiecte');
    assert.match(projects.html, /1 din 2 materiale/);
    assert.match(projects.html, /Școala publică/);
    assert.ok(!projects.html.includes('Ciorna secretă'));
    assert.match(projects.html, /href="\/site\/ana\/proiect\/1"/);
    assert.match(projects.html, /href="\/dashboard\/articol\/1\/preview"/);

    const drafts = await cand('/dashboard?status=ciorna');
    const draftRows = drafts.html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
    assert.match(draftRows, /Ciorna secretă/);
    assert.ok(!draftRows.includes('Școala publică'));
    assert.ok(!draftRows.includes('/site/ana/articol/3'));
    assert.match(draftRows, /href="\/dashboard\/articol\/3\/preview"/);

    const published = await cand('/dashboard?status=publicat');
    const publishedRows = published.html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
    assert.match(publishedRows, /Școala publică/);
    assert.ok(!publishedRows.includes('Ciorna secretă'));
    const invalid = await cand('/dashboard?categorie=%3Cscript%3E&status=necunoscut');
    assert.match(invalid.html, /Școala publică/);
    assert.match(invalid.html, /Ciorna secretă/);
    assert.ok(!invalid.html.includes('&lt;script&gt;'));
  });
  await t.test('Modul civic, transparența și paginile juridice sunt publice', async () => {
    const listing = await guest('/site/ana');
    assert.match(listing.html, /Vocea[\s\S]*Candidatului/);
    assert.ok(!listing.html.includes('<strong>JURNAL</strong>'));
    assert.match(listing.html, /PUBLICAȚIE CIVICĂ/);
    assert.match(listing.html, /Publicație civică independentă/);
    assert.ok(!listing.html.includes('Cod mandatar financiar'));
    assert.match(listing.html, /Vezi transparența completă/);
    const article = await guest('/site/ana/articol/1');
    assert.match(article.html, /responsabil editorial/);
    assert.match(article.html, /Raportează materialul/);
    const transparency = await guest('/site/ana/transparenta?articol=1');
    assert.equal(transparency.status, 200);
    assert.match(transparency.html, /Material civic \/ informare publică/);
    assert.ok(!transparency.html.includes('Referință contractuală'));
    assert.match(transparency.html, /CristianWeb/);
    assert.doesNotMatch(transparency.html, /Operator Test SRL/);
    assert.doesNotMatch(transparency.html, /RO12345678/);
    const legalTerms = await guest('/legal/termeni');
    assert.match(legalTerms.html, /Droc Cristian Dan/);
    assert.doesNotMatch(legalTerms.html, /Operator Test SRL|RO12345678/);
    assert.equal((await guest('/legal/inexistent')).status, 404);
  });
  await t.test('Profil și contact opțional, fără expunerea adresei de login', async () => {
    let contact = await guest('/site/ana/contact');
    assert.match(contact.html, /nu a publicat încă date de contact/);
    assert.ok(!contact.html.includes('ana@example.test'));
    const body = { csrf_token: candidateToken, functie_candidatura: 'Consilier local', zona: 'Timișoara', judet: 'Timiș', email_contact: 'public@example.test', telefon_contact: '+40 722 123 456', role: 'admin' };
    assert.equal((await cand('/dashboard/profil', { ...body, csrf_token: 'wrong' })).status, 403);
    assert.equal((await cand('/dashboard/profil', { ...body, email_contact: 'invalid' })).status, 400);
    assert.equal(db.data.users.find(u => u.id === 2).email_contact, undefined);
    assert.equal((await cand('/dashboard/profil', body)).status, 302);
    assert.equal(db.data.users.find(u => u.id === 2).role, 'candidate');
    contact = await guest('/site/ana/contact');
    assert.match(contact.html, /mailto:public@example.test/);
    assert.match(contact.html, /tel:\+40722123456/);
    assert.match(contact.html, /Consilier local/);
  });
  await t.test('Programare: ascuns înainte de termen, inclusiv URL direct și căutare', async () => {
    const form = await cand('/dashboard/articol/nou');
    assert.equal(form.status, 200);
    assert.match(form.html, /Europe\/Bucharest/);
    assert.equal((await cand('/dashboard/articol', articleBody)).status, 403);
    const invalid = await cand('/dashboard/articol', { ...articleBody, csrf_token: candidateToken, data_programata: '2026-07-01T12:00' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.html, /trebuie să fie în viitor/);
    assert.match(invalid.html, /action="\/dashboard\/articol"/);
    assert.ok(!invalid.html.includes('/articol/undefined'));
    assert.equal((await cand('/dashboard/articol', { ...articleBody, csrf_token: candidateToken })).status, 302);
    assert.equal(db.data.articole.find(a => a.id === 4).data_programata, '2026-07-10T09:30:00.000Z');
    assert.equal((await guest('/site/ana/articol/4')).status, 404);
    assert.equal((await guest('/site/ana/articol/3')).status, 404);
    assert.equal((await guest('/site/ana/articol/2')).status, 404);
    const listing = await guest('/site/ana');
    assert.ok(!listing.html.includes('Articol programat'));
    assert.ok(!listing.html.includes('Secrete'));
    assert.ok(!listing.html.includes('Ciorna secretă'));
    assert.equal(listing.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.match(listing.headers.get('netlify-cdn-cache-control'), /durable, max-age=60/);
    assert.match((await guest('/site/ana?cauta=programat')).html, /Niciun articol găsit/);
    assert.match((await cand('/dashboard/articol/4/edit')).html, /value="2026-07-10T12:30"/);
  });
  await t.test('La termen: site, URL, căutare, dashboard și centru social coerente', async () => {
    clock = Date.parse('2026-07-10T09:30:00Z');
    const listing = await guest('/site/ana');
    assert.match(listing.html, /Articol programat/);
    assert.ok(!listing.html.includes('1970'));
    assert.equal((await guest('/site/ana/articol/4')).status, 200);
    assert.match((await guest('/site/ana?cauta=scoala&categorie=Proiecte')).html, /Școala publică/);
    assert.match((await guest('/site/ana?cauta=scoala&categorie=Program')).html, /Niciun articol găsit/);
    assert.equal((await guest('/site/ana?cauta[x]=a')).status, 400);
    assert.match((await cand('/dashboard/social')).html, /Articol programat/);
    assert.match((await cand('/dashboard')).html, /Publicat/);
    assert.equal(db.data.articole.find(a => a.id === 4).status, 'programat');
  });
  await t.test('Comentarii: CSRF, honeypot, validare, pending, ratelimit', async () => {
    const page = await guest('/site/ana/articol/1');
    guestToken = csrf(page.html);
    assert.ok(guestToken);
    assert.match(page.html, /Părerea comunității/);
    assert.match(page.html, /WhatsApp/);
    assert.equal((await guest('/site/ana/articol/1/reactie', { csrf_token: guestToken, reactie: 'like' })).status, 303);
    assert.equal(db.data.articole.find(item => item.id === 1).reactii.like, 1);
    assert.equal((await guest('/site/ana/articol/1/reactie', { csrf_token: guestToken, reactie: 'dislike' })).status, 303);
    assert.equal(db.data.articole.find(item => item.id === 1).reactii.like, 0);
    assert.equal(db.data.articole.find(item => item.id === 1).reactii.dislike, 1);
    const body = { nume: '<script>autor</script>', text: '<script>alert("test")</script>', acord_publicare: 'on', csrf_token: guestToken };
    const url = '/site/ana/articol/1/comentarii';
    assert.equal((await guest(url, { ...body, csrf_token: 'wrong' })).status, 403);
    assert.equal((await guest(url, { ...body, website: 'spam' })).status, 400);
    assert.equal((await guest('/site/ana/articol/3/comentarii', body)).status, 404);
    const submitted = await guest(url, body);
    assert.equal(submitted.status, 303);
    assert.match(submitted.headers.get('location'), /comentariu=trimis/);
    const pending = await guest('/site/ana/articol/1');
    assert.ok(!pending.html.includes('alert('));
    assert.equal((await guest(url, body)).status, 429);
    comment = (await comments.list(2, 1))[0];
    assert.equal(comment.status, 'in_asteptare');
  });
  await t.test('Super Admin: aprobare, XSS escapate, audit, respingere și ștergere', async () => {
    assert.equal((await admin('/login', { email: 'admin@example.test', parola: password })).status, 302);
    const adminDashboard = await admin('/admin');
    assert.match(adminDashboard.html, /Cele mai citite articole/);
    assert.match(adminDashboard.html, /href="\/admin\/social"/);
    const page = await admin('/admin/comentarii');
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes('<script>autor'));
    assert.match(page.html, /&lt;script&gt;autor/);
    adminToken = csrf(page.html);
    const adminSocial = await admin('/admin/social');
    assert.equal(adminSocial.status, 200);
    assert.match(adminSocial.html, /Conectează paginile oficiale/);
    assert.equal((await cand('/admin/social')).status, 403);
    const url = `/admin/comentarii/2/1/${comment.id}`;
    assert.equal((await cand(url, { csrf_token: candidateToken, status: 'aprobat', version: 'initial' })).status, 403);
    assert.equal((await admin(url, { status: 'aprobat', version: 'initial' })).status, 403);
    assert.equal((await admin(url, { csrf_token: adminToken, status: 'aprobat', version: 'initial' })).status, 303);
    let publicPage = await guest('/site/ana/articol/1');
    assert.match(publicPage.html, /&lt;script&gt;alert/);
    assert.ok(!publicPage.html.includes('<script>alert'));
    assert.equal((await admin(url, { csrf_token: adminToken, status: 'respins', version: 'initial' })).status, 409);
    let current = (await comments.list(2, 1))[0];
    clock += 1000;
    assert.equal((await admin(url, { csrf_token: adminToken, status: 'respins', version: current.version })).status, 303);
    assert.ok(!(await guest('/site/ana/articol/1')).html.includes('alert('));
    current = (await comments.list(2, 1))[0];
    clock += 1000;
    assert.equal((await admin(url, { csrf_token: adminToken, status: 'sters', version: current.version })).status, 303);
    assert.match((await admin('/admin/comentarii?status=sters')).html, /Istoric moderare \(3\)/);
  });
  await t.test('Sondaje separate pentru portal și candidat, vot unic și vitrină filtrabilă', async () => {
    const portalPoll = await admin('/admin/sondaje', { csrf_token: adminToken,
      intrebare: 'Care este prioritatea comunității?', optiuni: 'Drumuri\nȘcoli\nCurățenie', rezultate_publice: 'on' });
    assert.equal(portalPoll.status, 302);
    const home = await guest('/');
    assert.match(home.html, /Care este prioritatea comunității/);
    const homeToken = csrf(home.html);
    const portalPollId = db.data.polls.find(poll => poll.owner_role === 'admin').id;
    assert.equal((await guest(`/sondaje/${portalPollId}/vot`, { csrf_token: homeToken, optiune: '1' })).status, 303);
    assert.equal((await guest(`/sondaje/${portalPollId}/vot`, { csrf_token: homeToken, optiune: '2' })).status, 409);

    const candidatePoll = await cand('/dashboard/sondaje', { csrf_token: candidateToken,
      intrebare: 'Ce proiect este prioritar în cartier?', optiuni: 'Parc\nIluminat', rezultate_publice: 'on' });
    assert.equal(candidatePoll.status, 302);
    const candidateSite = await guest('/site/ana');
    assert.match(candidateSite.html, /Ce proiect este prioritar în cartier/);
    const directory = await guest('/candidati?judet=Timiș&functie=Consilier');
    assert.equal(directory.status, 200);
    assert.match(directory.html, /Toți candidații activi/);
    assert.match(directory.html, /ana/);
    assert.ok(!(await guest('/candidati?judet=Cluj')).html.includes('Deschide publicația →'));
  });
  await t.test('Site principal: numai Super Admin publică știri și campanii cu imagini și citiri', async () => {
    assert.equal((await cand('/admin/portal')).status, 403);
    const center = await admin('/admin/portal');
    assert.equal(center.status, 200);
    assert.match(center.html, /Centrul editorial/);
    assert.match(center.html, /Nu există încă știri sau campanii/);
    const form = await admin('/admin/portal/nou');
    assert.equal(form.status, 200);
    assert.match(form.html, /Text și imagini cu OpenAI/);
    assert.equal((await admin('/admin/portal', { titlu: 'Fără CSRF' })).status, 403);

    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
    const uploaded = await admin('/admin/portal/media', { csrf_token: adminToken, base64: png, acord_imagine: true }, true);
    assert.equal(uploaded.status, 201);
    const imageUrl = JSON.parse(uploaded.html).imagine_url;
    assert.equal((await guest(imageUrl)).status, 404);

    const campaign = {
      csrf_token: adminToken, tip: 'campanie', candidate_id: '2', titlu: 'Campanie pentru cartiere curate',
      rezumat: 'Ana prezintă proiectele propuse pentru comunitate.', continut: 'Primul paragraf.\n## Proiecte\n<script>nu se execută</script>',
      categorie: 'Campanie locală', finantator: 'Ana — campanie electorală', imagine_url: imageUrl,
      imagine_alt: 'Candidat discutând cu locuitorii', imagine_credit: 'Arhiva candidatului', principal: 'on',
      confirmare_responsabilitate: 'on', status: 'publicat',
    };
    const created = await admin('/admin/portal', campaign);
    assert.equal(created.status, 302);
    assert.match(created.headers.get('location'), /^\/admin\/portal/);
    const post = db.data.portal_posts[0];
    assert.equal(post.slug, 'campanie-pentru-cartiere-curate');
    assert.equal(post.transparenta.responsabil_editorial, 'ana');
    assert.equal(post.transparenta.finantat_de, 'Ana — campanie electorală');
    assert.equal((await guest(imageUrl)).status, 200);

    const home = await guest('/');
    assert.match(home.html, /Vocea Locală/);
    assert.match(home.html, /Bulgăruș · Lenauheim · Grabaț/);
    assert.match(home.html, /portal-community-photo/);
    assert.doesNotMatch(home.html, /openstreetmap\.org\/export\/embed/);
    assert.match(home.html, /Campanie pentru cartiere curate/);
    assert.match(home.html, /Campanie candidat/);
    assert.match(home.html, /href="\/sectiune\/administratie"/);
    const detail = await guest(`/actualitate/${post.slug}`);
    assert.equal(detail.status, 200);
    assert.match(detail.html, /Ana — campanie electorală/);
    assert.match(detail.html, /Vezi publicația candidatului/);
    assert.match(detail.html, /<h2>Proiecte<\/h2>/);
    assert.ok(!detail.html.includes('<script>nu se execută'));
    assert.equal(post.vizualizari, 1);

    const drafted = await admin(`/admin/portal/${post.id}`, { ...campaign, status: 'ciorna', confirmare_responsabilitate: '' });
    assert.equal(drafted.status, 302);
    assert.equal((await guest(`/actualitate/${post.slug}`)).status, 404);
    assert.ok(!(await guest('/')).html.includes('Campanie pentru cartiere curate'));

    const news = await admin('/admin/portal', {
      csrf_token: adminToken, tip: 'stire', titlu: 'Noutăți din platformă', rezumat: 'O informare publicată de operator.',
      continut: 'Conținut editorial verificat.', categorie: 'Actualitate', imagine_url: '',
      confirmare_responsabilitate: 'on', status: 'publicat',
    });
    assert.equal(news.status, 302);
    const newsPost = db.data.portal_posts.find(item => item.tip === 'stire');
    assert.equal(newsPost.transparenta.responsabil_editorial, 'Operator Test SRL');
    const newsSection = await guest('/sectiune/stiri');
    assert.equal(newsSection.status, 200);
    assert.match(newsSection.html, /Noutăți din platformă/);
    assert.equal((await guest('/sectiune/necunoscuta')).status, 404);
    const newsDetail = await guest(`/actualitate/${newsPost.slug}`);
    const reactionToken = csrf(newsDetail.html);
    assert.equal((await guest(`/actualitate/${newsPost.slug}/reactie`, { csrf_token: reactionToken, reactie: 'like' })).status, 303);
    assert.equal(newsPost.reactii.like, 1);
    assert.match((await guest(`/actualitate/${newsPost.slug}`)).html, /Știre publicată și asumată editorial de/);
    const invalidImage = await admin(`/admin/portal/${newsPost.id}`, {
      csrf_token: adminToken, ...newsPost, imagine_url: 'javascript:alert(1)', status: 'publicat', confirmare_responsabilitate: 'on',
    });
    assert.equal(invalidImage.status, 400);
    assert.match(invalidImage.html, /Adresa imaginii trebuie să fie HTTP\/HTTPS/);
    assert.deepEqual(JSON.parse((await admin('/admin/portal/ai/config')).html), { text: false, image: false });
  });
  await t.test('Activare civică fără date electorale, apoi actualizare și reacceptare', async () => {
    const created = await admin('/admin/candidati', {
      csrf_token: adminToken, nume_candidat: 'Candidat Nou', email: 'nou@example.test',
      functie_candidatura: 'Primar', zona: 'Lugoj', judet: 'Timiș', partid: 'Independent',
      tip_candidat: 'independent', entitate_responsabila: 'Candidat Nou',
      modul_site: 'on', modul_statistici: 'on', modul_social: 'on',
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('location'), null);
    assert.ok(!created.html.includes('parolaNoua='));
    const temporaryPassword = created.html.match(/class="credential-value">([^<]+)</)?.[1];
    assert.equal(temporaryPassword?.length, 16);
    const pending = browser();
    const login = await pending('/login', { email: 'nou@example.test', parola: temporaryPassword });
    assert.equal(login.headers.get('location'), '/activare');
    const activation = await pending('/activare');
    assert.match(activation.html, /Activare profil civic/);
    assert.ok(!activation.html.includes('Cod mandatar financiar'));
    const activationToken = csrf(activation.html);
    assert.ok(activationToken);
    assert.equal((await pending('/dashboard')).status, 403);
    assert.equal((await pending('/activare', { accepta_termeni: 'on', accepta_responsabilitate: 'on' })).status, 403);
    const accepted = await pending('/activare', { csrf_token: activationToken, accepta_termeni: 'on', accepta_responsabilitate: 'on' });
    assert.equal(accepted.status, 302);
    const newCandidate = db.data.users.find(user => user.email === 'nou@example.test');
    assert.equal(newCandidate.terms_version, TERMS_VERSION);
    assert.equal(newCandidate.status_cont, 'in_asteptare');
    assert.equal(newCandidate.activ, false);
    const activated = await admin(`/admin/candidati/${newCandidate.id}/status`, { csrf_token: adminToken, status_cont: 'activ' });
    assert.equal(activated.status, 302);
    assert.equal(newCandidate.activ, true);
    let newDashboard = await pending('/dashboard');
    assert.equal(newDashboard.status, 200);
    const changed = await admin(`/admin/candidati/${newCandidate.id}/configurare`, {
      csrf_token: adminToken, functie_candidatura: 'Primar', zona: 'Lugoj', judet: 'Timiș', partid: 'Independent',
      tip_candidat: 'independent', scrutin: 'Alegeri locale de test', entitate_responsabila: 'Candidat Nou',
      finantator_materiale: 'Candidat Nou — campanie', cod_mandatar_financiar: 'MANDAT-NOU', tip_contract: 'platit',
      numar_contract: 'CONTRACT-NOU', data_contract: '2026-07-01', valoare_contract: '2500', moneda_contract: 'RON',
      confirmare_mandatar: 'on', modul_site: 'on', modul_statistici: 'on', modul_social: 'on',
    });
    assert.equal(changed.status, 302);
    assert.equal(newCandidate.terms_version, '');
    const newCandidateToken = csrf(newDashboard.html);
    const blockedPublication = await pending('/dashboard/articol', { ...articleBody, status: 'publicat', csrf_token: newCandidateToken });
    assert.equal(blockedPublication.status, 400);
    assert.match(blockedPublication.html, /Publicarea este blocată/);
    const repeatActivation = await pending('/activare');
    const repeatToken = csrf(repeatActivation.html);
    const repeated = await pending('/activare', { csrf_token: repeatToken, accepta_termeni: 'on', accepta_responsabilitate: 'on' });
    assert.equal(repeated.headers.get('location'), '/dashboard?activare=confirmata');
    assert.equal(newCandidate.terms_version, TERMS_VERSION);
  });
  await t.test('Super Admin schimbă, recuperează și șterge sincronizat contul candidatului', async () => {
    const candidate = db.data.users.find(user => user.email === 'nou@example.test');
    const changedPassword = 'Parola-Noua-Sigura-2026!';
    const invalid = await admin(`/admin/candidati/${candidate.id}/parola`, {
      csrf_token: adminToken, parola_noua: changedPassword, confirma_parola: 'alta-parola',
    });
    assert.match(invalid.headers.get('location'), /eroare=/);
    const changed = await admin(`/admin/candidati/${candidate.id}/parola`, {
      csrf_token: adminToken, parola_noua: changedPassword, confirma_parola: changedPassword,
    });
    assert.match(changed.headers.get('location'), /mesaj=/);
    assert.equal((await browser()('/login', { email: candidate.email, parola: changedPassword })).status, 302);

    const recovered = await admin(`/admin/candidati/${candidate.id}/recuperare-parola`, { csrf_token: adminToken });
    assert.equal(recovered.status, 200);
    const temporaryPassword = recovered.html.match(/class="credential-value">([^<]+)</)?.[1];
    assert.equal(temporaryPassword?.length, 16);
    assert.equal((await browser()('/login', { email: candidate.email, parola: temporaryPassword })).status, 302);

    db.data.articole.push({ id: 999, user_id: candidate.id, titlu: 'Material de șters', continut: 'Test', status: 'ciorna' });
    await db.write();
    const rejected = await admin(`/admin/candidati/${candidate.id}/sterge`, { csrf_token: adminToken, confirma_email: 'gresit@example.test' });
    assert.match(rejected.headers.get('location'), /eroare=/);
    assert.ok(db.data.users.some(user => user.id === candidate.id));
    const deleted = await admin(`/admin/candidati/${candidate.id}/sterge`, { csrf_token: adminToken, confirma_email: candidate.email });
    assert.match(deleted.headers.get('location'), /mesaj=/);
    assert.ok(!db.data.users.some(user => user.id === candidate.id));
    assert.ok(!db.data.articole.some(article => article.user_id === candidate.id));
    assert.ok(!authAccounts.has(candidate.email));
  });
  await t.test('Sesizare: dovadă, suspendare, protecție la concurență, restabilire și jurnal', async () => {
    const reportUrl = '/site/ana/articol/1/raporteaza';
    const reportPage = await guest(reportUrl);
    const reportToken = csrf(reportPage.html);
    const body = { csrf_token: reportToken, motiv: 'electoral', descriere: 'Acest material trebuie verificat deoarece datele de finanțare par neclare.',
      nume: 'Cititor Test', email: 'cititor@example.test', acord_contact: 'on', buna_credinta: 'on' };
    assert.equal((await guest(reportUrl, { ...body, csrf_token: 'invalid' })).status, 403);
    const submitted = await guest(reportUrl, body);
    assert.equal(submitted.status, 303);
    assert.match(submitted.headers.get('location'), /sesizare=[a-f0-9-]{36}/);
    let report = (await compliance.listReports())[0];
    assert.equal(report.status, 'noua');
    assert.equal(report.evidence.titlu, db.data.articole.find(article => article.id === 1).titlu);
    const confirmation = await guest(submitted.headers.get('location'));
    assert.match(confirmation.html, new RegExp(report.id));
    const moderation = await admin('/admin/sesizari');
    assert.match(moderation.html, /Cititor Test/);
    assert.equal((await cand(`/admin/sesizari/2/1/${report.id}`, { csrf_token: candidateToken, status: 'continut_suspendat', action: 'suspend', note: 'Verificare juridică necesară.', version: report.version })).status, 403);
    assert.equal((await admin(`/admin/sesizari/2/1/${report.id}`, { csrf_token: adminToken, status: 'in_analiza', action: 'suspend', note: 'Stare incompatibilă.', version: report.version })).status, 400);
    assert.equal((await admin(`/admin/sesizari/2/1/${report.id}`, { csrf_token: adminToken, status: 'continut_suspendat', action: 'suspend', note: 'Verificare juridică necesară.', version: report.version })).status, 303);
    assert.equal((await guest('/site/ana/articol/1')).status, 404);
    assert.equal((await cand('/dashboard/articol/1/sterge', { csrf_token: candidateToken })).status, 409);
    assert.equal((await cand('/dashboard/articol/1', { ...articleBody, status: 'publicat', csrf_token: candidateToken })).status, 400);
    report = (await compliance.listReports())[0];
    assert.equal((await admin(`/admin/sesizari/2/1/${report.id}`, { csrf_token: adminToken, status: 'inchisa', action: 'restore', note: 'Verificarea s-a încheiat; materialul poate reveni.', version: report.version })).status, 303);
    assert.equal((await guest('/site/ana/articol/1')).status, 200);
    const journal = await admin('/admin/jurnal');
    assert.equal(journal.status, 200);
    assert.match(journal.html, /Conținut suspendat/);
    assert.match(journal.html, /Sesizare închisă/);
    assert.ok(!journal.html.includes('cititor@example.test'));
  });
  await t.test('O cădere a stocării comentariilor nu ascunde articolul sau pretinde succes', async () => {
    const list = comments.list;
    const submit = comments.submit;
    try {
      comments.list = async () => { throw new Error('simulated storage failure'); };
      comments.submit = async () => { throw new Error('simulated storage failure'); };
      const page = await guest('/site/ana/articol/1');
      assert.equal(page.status, 200);
      assert.match(page.html, /Școala publică/);
      assert.match(page.html, /Comentariile sunt temporar indisponibile/);
      assert.ok(!page.html.includes('class="comment-form"'));
      const submission = await guest('/site/ana/articol/1/comentarii', { csrf_token: guestToken, nume: 'Test', text: 'Nu se salvează', acord_publicare: 'on' });
      assert.equal(submission.status, 503);
      assert.equal(submission.headers.get('location'), null);
      assert.ok(!submission.html.includes('simulated storage failure'));
    } finally { comments.list = list; comments.submit = submit; }
  });
  await t.test('Editor foto: CSRF, acord, proprietar, ciornă privată, persistență și retragere', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
    const uploadBody = { base64: png, acord_imagine: true, csrf_token: candidateToken };
    assert.equal((await guest('/dashboard/media', uploadBody, true)).status, 403);
    assert.equal((await cand('/dashboard/media', { ...uploadBody, csrf_token: 'wrong' }, true)).status, 403);
    assert.equal((await cand('/dashboard/media', { ...uploadBody, acord_imagine: false }, true)).status, 400);
    assert.equal((await cand('/dashboard/media', { ...uploadBody, base64: Buffer.from('<svg/>').toString('base64') }, true)).status, 400);
    const uploaded = await cand('/dashboard/media', uploadBody, true);
    assert.equal(uploaded.status, 201);
    const imageUrl = JSON.parse(uploaded.html).imagine_url;
    assert.equal((await guest(imageUrl)).status, 404);
    const own = await cand(imageUrl);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    const foreign = await editorial.upload(3, png);
    const fields = { ...articleBody, csrf_token: candidateToken, status: 'ciorna', imagine_url: imageUrl,
      rezumat: 'Un rezumat editorial.', imagine_alt: 'Imagine descrisă', imagine_legenda: '<script>legendă</script>', imagine_credit: 'Autor test', continut: 'Introducere\n## Subtitlu\n<script>nu se execută</script>' };
    assert.equal((await cand('/dashboard/articol/1', { ...fields, imagine_url: foreign.imagine_url })).status, 400);
    assert.equal((await cand('/dashboard/articol/1', fields)).status, 302);
    assert.equal((await guest(imageUrl)).status, 404);
    assert.equal((await cand('/dashboard/articol/1', { ...fields, status: 'publicat' })).status, 302);
    assert.equal((await guest(imageUrl)).status, 200);
    const article = await guest('/site/ana/articol/1');
    assert.match(article.html, /Un rezumat editorial/);
    assert.match(article.html, /<h2>Subtitlu<\/h2>/);
    assert.match(article.html, /&lt;script&gt;legendă/);
    assert.ok(!article.html.includes('<script>nu se execută'));
    assert.match(article.html, /newspaper.css/);
    const listing = await guest('/site/ana');
    assert.match(listing.html, /class="front-page"/);
    assert.ok(listing.html.includes(`src="${imageUrl}"`));
    assert.match((await cand('/dashboard/articol/1/edit')).html, /Un rezumat editorial/);
    assert.equal((await cand('/dashboard/articol/1', { ...fields, imagine_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await cand('/dashboard/articol/1', fields)).status, 302);
    assert.equal((await guest(imageUrl)).status, 404);
    assert.equal((await cand('/dashboard/articol/1', { ...fields, status: 'publicat' })).status, 302);
    const generatedId = '00000000-0000-4000-8000-000000000042';
    await createLocalCommentStore(path.join(dir, 'editorial')).set(`media/${generatedId}`, { userId: 2, mime: 'image/png', base64: png, generated: true });
    assert.equal((await cand('/dashboard/articol/1', { ...fields, status: 'publicat', imagine_url: `/media/${generatedId}`, imagine_generata_ai: 'false' })).status, 302);
    assert.equal(db.data.articole.find(a => a.id === 1).imagine_generata_ai, true);
    assert.match((await guest('/site/ana/articol/1')).html, /Ilustrație generată cu AI; nu este o fotografie documentară/);
    for (let i = 0; i < 5; i++) db.data.articole.push({ id: 100 + i, user_id: 2, titlu: `Material ${i}`, continut: 'Conținut de test', categorie: 'Comunitate', status: 'publicat', tip: 'idee', imagine_url: imageUrl, data_publicare: '2026-01-01T00:00:00Z' });
    const complete = await guest('/site/ana');
    assert.match(complete.html, /class="photo-grid"/);
    assert.match(complete.html, /class="front-sidebar"/);
    // Șase articole au imagine; articolul programat din fixture nu are fotografie.
    assert.equal((complete.html.match(/class="news-photo"/g) || []).length, 6);
    assert.match(complete.html, /Articol fără fotografie/);
    db.data.articole = db.data.articole.filter(a => a.id < 100);
    assert.equal((await cand('/dashboard/articol/1', { ...fields, status: 'publicat' })).status, 302);
  });
  await t.test('Handlerul Netlify real păstrează octeții imaginii în răspunsul Lambda', async () => {
    const article = db.data.articole.find(a => a.id === 1);
    const id = article.imagine_url.split('/').pop();
    const image = await editorial.media(id);
    await db.write();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === 'api.netlify.com') {
        assert.equal(options.method.toUpperCase(), 'GET');
        return Response.json({ url: 'https://signed-blobs.example.test/editorial-image' });
      }
      if (url.hostname === 'signed-blobs.example.test') return Response.json(image);
      throw new Error(`Cerere externă neașteptată: ${url.hostname}`);
    };
    try {
      const { handler } = await import('../netlify/functions/api.js');
      const response = await handler({ httpMethod: 'GET', path: article.imagine_url, body: null,
        headers: { host: 'example.test', 'x-nf-site-id': 'test-only-site', 'x-nf-deploy-id': 'test-only-deploy' },
        blobs: Buffer.from(JSON.stringify({ url: 'https://blobs.example.test', token: 'fake-token' })).toString('base64'),
        requestContext: { identity: { sourceIp: '127.0.0.1' } } }, {});
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.isBase64Encoded, true);
      assert.deepEqual(Buffer.from(response.body, 'base64'), Buffer.from(image.base64, 'base64'));
    } finally { globalThis.fetch = originalFetch; }
  });
  await t.test('OpenAI: oprit implicit, protejat prin cont activ și CSRF, fără apeluri externe', async () => {
    const config = await cand('/dashboard/ai/config');
    assert.deepEqual(JSON.parse(config.html), { text: false, image: false });
    assert.equal((await guest('/dashboard/ai/config')).status, 403);
    assert.equal((await cand('/dashboard/genereaza-ai', {})).status, 403);
    const result = await cand('/dashboard/genereaza-ai', { csrf_token: candidateToken, tip: 'text' }, true);
    assert.equal(result.status, 503);
    assert.match(result.html, /nu este activată/);
    assert.equal((await cand('/dashboard/ai/00000000-0000-4000-8000-000000000000/status', { csrf_token: candidateToken }, true)).status, 404);
    const user = db.data.users.find(u => u.id === 2);
    user.activ = false;
    assert.equal((await cand('/dashboard/ai/config')).status, 403);
    assert.equal((await cand('/dashboard/media', { csrf_token: candidateToken }, true)).status, 403);
    user.activ = true;
  });
  await t.test('Izolare între candidați, retragerea articolului și cont suspendat', async () => {
    const before = db.data.articole.find(a => a.id === 2).titlu;
    await cand('/dashboard/articol/2', { ...articleBody, status: 'publicat', csrf_token: candidateToken });
    assert.equal(db.data.articole.find(a => a.id === 2).titlu, before);
    assert.equal((await cand('/dashboard/articol/4/sterge', {})).status, 403);
    await cand('/dashboard/articol/4', { ...articleBody, status: 'ciorna', csrf_token: candidateToken });
    assert.equal((await guest('/site/ana/articol/4')).status, 404);
    const user = db.data.users.find(u => u.id === 2);
    user.activ = false; user.status_cont = 'suspendat';
    assert.equal((await guest('/site/ana')).status, 404);
    assert.equal((await guest('/site/ana/contact')).status, 404);
    assert.equal((await guest('/site/ana/articol/1')).status, 404);
    assert.equal((await cand('/dashboard/articol', { ...articleBody, csrf_token: candidateToken })).status, 403);
    const adminUser = db.data.users.find(u => u.id === 1);
    adminUser.activ = false;
    assert.equal((await admin('/admin/comentarii')).status, 403);
  });
});
