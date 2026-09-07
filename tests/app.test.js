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
    users: [{ id: 1, role: 'admin', activ: true, email: 'admin@example.test', password_hash: hash }, candidate(2, 'ana'), candidate(3, 'bogdan')],
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
  const { createApp } = await import('../app.js');
  const { db } = await import('../db.js');
  const app = await createApp({ comments, editorial, compliance, now: () => clock });
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
  await t.test('Etichetele electorale, transparența și paginile juridice sunt publice', async () => {
    const listing = await guest('/site/ana');
    assert.match(listing.html, /Material electoral · publicitate politică/);
    assert.match(listing.html, /Finanțat de ana/);
    assert.match(listing.html, /Vezi transparența completă/);
    const article = await guest('/site/ana/articol/1');
    assert.match(article.html, /responsabil editorial/);
    assert.match(article.html, /Raportează materialul/);
    const transparency = await guest('/site/ana/transparenta?articol=1');
    assert.equal(transparency.status, 200);
    assert.match(transparency.html, /Operator Test SRL/);
    assert.match(transparency.html, /TEST-2/);
    assert.match((await guest('/legal/termeni')).html, /Operator Test SRL/);
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
    assert.match(listing.headers.get('cache-control'), /no-store/);
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
    assert.match((await admin('/admin')).html, /Cele mai citite articole/);
    const page = await admin('/admin/comentarii');
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes('<script>autor'));
    assert.match(page.html, /&lt;script&gt;autor/);
    adminToken = csrf(page.html);
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
  await t.test('Activare contractuală: cont în așteptare, acceptare și activare de Super Admin', async () => {
    const created = await admin('/admin/candidati', {
      csrf_token: adminToken, nume_candidat: 'Candidat Nou', email: 'nou@example.test',
      functie_candidatura: 'Primar', zona: 'Lugoj', judet: 'Timiș', partid: 'Independent',
      tip_candidat: 'independent', scrutin: 'Alegeri locale de test', entitate_responsabila: 'Candidat Nou',
      finantator_materiale: 'Candidat Nou', cod_mandatar_financiar: 'MANDAT-NOU', tip_contract: 'platit',
      numar_contract: 'CONTRACT-NOU', data_contract: '2026-07-01', valoare_contract: '2500', moneda_contract: 'RON',
      confirmare_mandatar: 'on', modul_site: 'on', modul_statistici: 'on', modul_social: 'on',
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
    await createLocalCommentStore(path.join(dir, 'data', 'editorial')).set(`media/${id}`, image);
    await db.write();
    const { handler } = await import('../netlify/functions/api.js');
    const response = await handler({ httpMethod: 'GET', path: article.imagine_url, body: null,
      headers: { host: 'example.test', 'x-nf-site-id': 'test-only-site', 'x-nf-deploy-id': 'test-only-deploy' },
      blobs: Buffer.from(JSON.stringify({ url: 'https://blobs.example.test', token: 'fake-token' })).toString('base64'),
      requestContext: { identity: { sourceIp: '127.0.0.1' } } }, {});
    assert.equal(response.statusCode, 200);
    assert.equal(response.isBase64Encoded, true);
    assert.deepEqual(Buffer.from(response.body, 'base64'), Buffer.from(image.base64, 'base64'));
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
