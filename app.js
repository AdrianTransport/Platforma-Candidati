import express from 'express';
import ejs from 'ejs';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import path from 'path';
import { db, initDB, slugify, generateazaParola, nextUserId, nextArticolId } from './db.js';
import { requireRole } from './middleware/auth.js';
import {
  decryptSecret,
  encryptSecret,
  exchangeMetaCode,
  exchangeTikTokCode,
  fetchMetaPages,
  metaAuthorizeUrl,
  metaConfigured,
  publicBaseUrl,
  publishFacebook,
  publishInstagram,
  publishTikTokPhoto,
  randomState,
  tiktokAuthorizeUrl,
  tiktokConfigured,
} from './social.js';

// Folosim process.cwd() in loc de fileURLToPath(import.meta.url): dupa ce Netlify
// impacheteaza functia cu esbuild, import.meta.url poate deveni undefined si arunca
// eroare la pornire. process.cwd() functioneaza identic local si pe Netlify, atata
// timp cat "views" si "public" sunt incluse in pachetul functiei (vezi netlify.toml).
const baseDir = process.cwd();

const STATUS_CONT = new Set(['in_asteptare', 'activ', 'suspendat', 'expirat']);
const RETELE_SOCIALE = new Set(['facebook', 'instagram', 'tiktok', 'youtube']);

function urlSigur(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function sursaVizitei(req) {
  const declarata = String(req.query.utm_source || '').toLowerCase();
  if (['facebook', 'instagram', 'tiktok'].includes(declarata)) return declarata;
  const referer = String(req.get('referer') || '').toLowerCase();
  if (referer.includes('facebook.') || referer.includes('fb.com')) return 'facebook';
  if (referer.includes('instagram.')) return 'instagram';
  if (referer.includes('tiktok.')) return 'tiktok';
  if (!referer) return 'direct';
  return 'altele';
}

function poatePublicaSite(user) {
  return user?.role === 'candidate' && user.activ && user.status_cont === 'activ' && user.module?.site;
}

export async function createApp() {
  await initDB();

  const app = express();
  // Inregistram motorul explicit (in loc sa lasam Express sa faca un require
  // dinamic dupa numele "ejs") - altfel esbuild nu detecteaza dependenta la bundling
  // pe Netlify si arunca "Cannot find module 'ejs'" la runtime.
  app.engine('ejs', ejs.renderFile);
  app.set('view engine', 'ejs');
  app.set('views', path.join(baseDir, 'views'));
  app.use(express.static(path.join(baseDir, 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Sesiune stocata in cookie semnat (fara memorie pe server) - functioneaza
  // identic local si pe functii serverless (Netlify).
  app.use(
    cookieSession({
      name: 'sesiune',
      keys: [process.env.SESSION_SECRET || 'schimba-acest-secret-in-productie'],
      maxAge: 1000 * 60 * 60 * 8, // 8 ore
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
  );

  app.use((req, res, next) => {
    req.session.csrfToken ||= randomState();
    res.locals.userId = req.session.userId || null;
    res.locals.rol = req.session.rol || null;
    res.locals.numeCandidat = req.session.numeCandidat || null;
    res.locals.csrfToken = req.session.csrfToken;
    next();
  });

  function requireCsrf(req, res, next) {
    if (!req.body?.csrf_token || req.body.csrf_token !== req.session.csrfToken) {
      return res.status(403).send('Cererea a expirat sau nu este valida. Reincarca pagina si incearca din nou.');
    }
    next();
  }

  /* ---------------------------- AUTENTIFICARE ---------------------------- */

  app.get('/', (req, res) => {
    const candidatiPublici = db.data.users
      .filter(poatePublicaSite)
      .slice(0, 6);
    res.render('landing', { candidatiPublici });
  });

  app.get('/login', (req, res) => {
    res.render('login', { eroare: null });
  });

  app.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const parola = String(req.body.parola || '');
    const user = db.data.users.find((u) => u.email.toLowerCase() === email);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return res.render('login', { eroare: 'Cont blocat temporar după prea multe încercări. Încearcă din nou peste 15 minute.' });
    }
    const contPermis = user?.activ && (user.role === 'admin' || user.status_cont === 'activ');
    if (!user || !contPermis || !bcrypt.compareSync(parola, user.password_hash)) {
      if (user) {
        user.login_attempts = (user.login_attempts || 0) + 1;
        if (user.login_attempts >= 5) {
          user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          user.login_attempts = 0;
        }
        await db.write();
      }
      return res.render('login', { eroare: 'Email sau parola incorecte.' });
    }
    user.login_attempts = 0;
    user.locked_until = null;
    user.last_login_at = new Date().toISOString();
    await db.write();
    req.session.userId = user.id;
    req.session.rol = user.role;
    req.session.numeCandidat = user.nume_candidat;
    if (user.role === 'admin') return res.redirect('/admin');
    return res.redirect('/dashboard');
  });

  app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  /* -------------------------------- ADMIN -------------------------------- */

  app.get('/admin', requireRole('admin'), (req, res) => {
    const candidati = db.data.users
      .filter((u) => u.role === 'candidate')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const sumar = {
      total: candidati.length,
      activi: candidati.filter((c) => c.status_cont === 'activ').length,
      asteptare: candidati.filter((c) => c.status_cont === 'in_asteptare').length,
      suspendati: candidati.filter((c) => c.status_cont === 'suspendat').length,
    };
    res.render('admin-dashboard', {
      candidati,
      sumar,
      parolaNoua: req.query.parolaNoua || null,
      emailNou: req.query.emailNou || null,
      mesaj: req.query.mesaj || null,
      eroare: req.query.eroare || null,
    });
  });

  app.post('/admin/candidati', requireRole('admin'), async (req, res) => {
    const { nume_candidat, email, zona, judet, functie_candidatura, partid } = req.body;
    const emailNormalizat = String(email || '').trim().toLowerCase();
    if (!nume_candidat || !emailNormalizat) return res.redirect('/admin');
    if (db.data.users.some((u) => u.email.toLowerCase() === emailNormalizat)) {
      return res.redirect('/admin?eroare=Adresa%20de%20email%20este%20deja%20folosita.');
    }
    let subdomeniu = slugify(nume_candidat);
    let contor = 1;
    while (db.data.users.some((u) => u.subdomeniu === subdomeniu)) {
      subdomeniu = `${slugify(nume_candidat)}-${contor++}`;
    }
    const parola = generateazaParola();
    db.data.users.push({
      id: nextUserId(),
      email: emailNormalizat,
      password_hash: bcrypt.hashSync(parola, 10),
      role: 'candidate',
      nume_candidat,
      zona: zona || '',
      judet: judet || '',
      functie_candidatura: functie_candidatura || '',
      partid: partid || '',
      subdomeniu,
      mesaj_scurt: '',
      slogan: '',
      descriere: '',
      domeniu_custom: null,
      facebook_url: '',
      instagram_url: '',
      tiktok_url: '',
      youtube_url: '',
      social_connections: { meta: null, tiktok: null },
      status_cont: 'in_asteptare',
      activ: false,
      module: { site: true, statistici: true, social: true },
      statistici: {
        vizite_site: 0,
        surse: { direct: 0, facebook: 0, instagram: 0, tiktok: 0, altele: 0 },
        clickuri_sociale: { facebook: 0, instagram: 0, tiktok: 0, youtube: 0 },
      },
      login_attempts: 0,
      locked_until: null,
      last_login_at: null,
      created_at: new Date().toISOString(),
    });
    await db.write();
    res.redirect(`/admin?parolaNoua=${encodeURIComponent(parola)}&emailNou=${encodeURIComponent(emailNormalizat)}`);
  });

  app.post('/admin/securitate', requireRole('admin'), async (req, res) => {
    const admin = db.data.users.find((u) => u.id === req.session.userId && u.role === 'admin');
    const parolaActuala = String(req.body.parola_actuala || '');
    const parolaNoua = String(req.body.parola_noua || '');
    if (!admin || !bcrypt.compareSync(parolaActuala, admin.password_hash)) {
      return res.redirect('/admin?eroare=Parola%20actuala%20nu%20este%20corecta.');
    }
    if (parolaNoua.length < 12 || parolaNoua !== String(req.body.confirma_parola || '')) {
      return res.redirect('/admin?eroare=Parola%20noua%20trebuie%20sa%20aiba%20minimum%2012%20caractere%20si%20sa%20fie%20confirmata.');
    }
    admin.password_hash = bcrypt.hashSync(parolaNoua, 12);
    admin.password_changed_at = new Date().toISOString();
    await db.write();
    res.redirect('/admin?mesaj=Parola%20Super%20Adminului%20a%20fost%20schimbata.');
  });

  app.post('/admin/candidati/:id/status', requireRole('admin'), async (req, res) => {
    const user = db.data.users.find((u) => u.id === Number(req.params.id));
    const status = String(req.body.status_cont || '');
    if (user?.role === 'candidate' && STATUS_CONT.has(status)) {
      user.status_cont = status;
      user.activ = status === 'activ';
      user.activated_at = status === 'activ' ? new Date().toISOString() : user.activated_at || null;
      await db.write();
    }
    res.redirect('/admin');
  });

  app.post('/admin/candidati/:id/configurare', requireRole('admin'), async (req, res) => {
    const user = db.data.users.find((u) => u.id === Number(req.params.id));
    if (user?.role === 'candidate') {
      user.functie_candidatura = String(req.body.functie_candidatura || '').trim();
      user.zona = String(req.body.zona || '').trim();
      user.judet = String(req.body.judet || '').trim();
      user.partid = String(req.body.partid || '').trim();
      user.module = {
        site: req.body.modul_site === 'on',
        statistici: req.body.modul_statistici === 'on',
        social: req.body.modul_social === 'on',
      };
      await db.write();
    }
    res.redirect('/admin');
  });

  /* ------------------------------ CANDIDAT ------------------------------- */

  app.get('/dashboard', requireRole('candidate'), (req, res) => {
    const articole = db.data.articole
      .filter((a) => a.user_id === req.session.userId)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const totalCitiri = articole.reduce((total, articol) => total + (articol.vizualizari || 0), 0);
    const topArticole = [...articole]
      .filter((articol) => articol.status === 'publicat')
      .sort((a, b) => (b.vizualizari || 0) - (a.vizualizari || 0))
      .slice(0, 5);
    res.render('candidate-dashboard', { articole, user, totalCitiri, topArticole });
  });

  app.get('/dashboard/social', requireRole('candidate'), (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    if (!user?.module?.social) return res.redirect('/dashboard');
    const articole = db.data.articole
      .filter((a) => a.user_id === user.id && a.status === 'publicat')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    res.render('social-center', {
      user,
      articole,
      metaEsteConfigurat: metaConfigured(),
      tiktokEsteConfigurat: tiktokConfigured(),
      mesaj: req.query.mesaj || '',
      eroare: req.query.eroare || '',
    });
  });

  app.get('/dashboard/social/meta/conecteaza', requireRole('candidate'), (req, res) => {
    if (!metaConfigured()) {
      return res.redirect('/dashboard/social?eroare=Integrarea%20Meta%20nu%20este%20inca%20configurata%20de%20administrator.');
    }
    const state = randomState();
    req.session.oauth = { provider: 'meta', state, expires: Date.now() + 10 * 60 * 1000 };
    const redirectUri = `${publicBaseUrl(req)}/oauth/meta/callback`;
    res.redirect(metaAuthorizeUrl(redirectUri, state));
  });

  app.get('/oauth/meta/callback', requireRole('candidate'), async (req, res) => {
    const oauth = req.session.oauth;
    req.session.oauth = null;
    if (!oauth || oauth.provider !== 'meta' || oauth.state !== req.query.state || oauth.expires < Date.now()) {
      return res.redirect('/dashboard/social?eroare=Sesiunea%20de%20conectare%20Meta%20a%20expirat%20sau%20nu%20este%20valida.');
    }
    if (req.query.error || !req.query.code) {
      return res.redirect(`/dashboard/social?eroare=${encodeURIComponent(req.query.error_description || 'Conectarea Meta a fost anulata.')}`);
    }
    try {
      const redirectUri = `${publicBaseUrl(req)}/oauth/meta/callback`;
      const token = await exchangeMetaCode(String(req.query.code), redirectUri);
      const pages = await fetchMetaPages(token.access_token);
      if (!pages.length) throw new Error('Nu am gasit nicio Pagina Facebook pe care o poti administra.');
      const user = db.data.users.find((u) => u.id === req.session.userId);
      user.social_connections ||= { meta: null, tiktok: null };
      user.social_connections.meta = {
        connected_at: new Date().toISOString(),
        selected_page_id: pages[0].id,
        pages,
      };
      await db.write();
      res.redirect('/dashboard/social?mesaj=Meta%20a%20fost%20conectat.%20Alege%20Pagina%20pe%20care%20vrei%20sa%20publici.');
    } catch (error) {
      res.redirect(`/dashboard/social?eroare=${encodeURIComponent(error.message || 'Conectarea Meta a esuat.')}`);
    }
  });

  app.post('/dashboard/social/meta/pagina', requireRole('candidate'), requireCsrf, async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const meta = user?.social_connections?.meta;
    const pageId = String(req.body.page_id || '');
    if (meta?.pages?.some((page) => page.id === pageId)) {
      meta.selected_page_id = pageId;
      await db.write();
      return res.redirect('/dashboard/social?mesaj=Pagina%20Meta%20a%20fost%20selectata.');
    }
    res.redirect('/dashboard/social?eroare=Pagina%20Meta%20selectata%20nu%20este%20valida.');
  });

  app.post('/dashboard/social/meta/deconecteaza', requireRole('candidate'), requireCsrf, async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    if (user?.social_connections) user.social_connections.meta = null;
    await db.write();
    res.redirect('/dashboard/social?mesaj=Meta%20a%20fost%20deconectat%20din%20platforma.');
  });

  app.get('/dashboard/social/tiktok/conecteaza', requireRole('candidate'), (req, res) => {
    if (!tiktokConfigured()) {
      return res.redirect('/dashboard/social?eroare=Integrarea%20TikTok%20nu%20este%20inca%20configurata%20de%20administrator.');
    }
    const state = randomState();
    req.session.oauth = { provider: 'tiktok', state, expires: Date.now() + 10 * 60 * 1000 };
    const redirectUri = `${publicBaseUrl(req)}/oauth/tiktok/callback`;
    res.redirect(tiktokAuthorizeUrl(redirectUri, state));
  });

  app.get('/oauth/tiktok/callback', requireRole('candidate'), async (req, res) => {
    const oauth = req.session.oauth;
    req.session.oauth = null;
    if (!oauth || oauth.provider !== 'tiktok' || oauth.state !== req.query.state || oauth.expires < Date.now()) {
      return res.redirect('/dashboard/social?eroare=Sesiunea%20de%20conectare%20TikTok%20a%20expirat%20sau%20nu%20este%20valida.');
    }
    if (req.query.error || !req.query.code) {
      return res.redirect(`/dashboard/social?eroare=${encodeURIComponent(req.query.error_description || 'Conectarea TikTok a fost anulata.')}`);
    }
    try {
      const redirectUri = `${publicBaseUrl(req)}/oauth/tiktok/callback`;
      const token = await exchangeTikTokCode(String(req.query.code), redirectUri);
      const user = db.data.users.find((u) => u.id === req.session.userId);
      user.social_connections ||= { meta: null, tiktok: null };
      user.social_connections.tiktok = {
        open_id: token.open_id,
        scope: token.scope,
        access_token_enc: encryptSecret(token.access_token),
        refresh_token_enc: encryptSecret(token.refresh_token),
        expires_at: new Date(Date.now() + Number(token.expires_in || 86400) * 1000).toISOString(),
        refresh_expires_at: new Date(Date.now() + Number(token.refresh_expires_in || 31536000) * 1000).toISOString(),
        connected_at: new Date().toISOString(),
      };
      await db.write();
      res.redirect('/dashboard/social?mesaj=Contul%20TikTok%20a%20fost%20conectat.');
    } catch (error) {
      res.redirect(`/dashboard/social?eroare=${encodeURIComponent(error.message || 'Conectarea TikTok a esuat.')}`);
    }
  });

  app.post('/dashboard/social/tiktok/deconecteaza', requireRole('candidate'), requireCsrf, async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const connection = user?.social_connections?.tiktok;
    if (connection && tiktokConfigured()) {
      try {
        const body = new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          token: decryptSecret(connection.access_token_enc),
        });
        await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
      } catch {
        // Stergerea conexiunii locale ramane prioritara chiar daca furnizorul nu raspunde.
      }
    }
    if (user?.social_connections) user.social_connections.tiktok = null;
    await db.write();
    res.redirect('/dashboard/social?mesaj=TikTok%20a%20fost%20deconectat%20din%20platforma.');
  });

  app.post('/dashboard/social/publica/:id', requireRole('candidate'), requireCsrf, async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId && a.status === 'publicat'
    );
    const platforma = String(req.body.platforma || '').toLowerCase();
    if (!user?.module?.social || !articol || !['facebook', 'instagram', 'tiktok'].includes(platforma)) {
      return res.redirect('/dashboard/social?eroare=Articolul%20sau%20reteaua%20selectata%20nu%20este%20valida.');
    }
    const articolUrl = `${publicBaseUrl(req)}/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}?utm_source=${platforma}`;
    const textScurt = String(articol.continut || '').replace(/\s+/g, ' ').trim().slice(0, 450);
    try {
      let rezultat;
      if (platforma === 'facebook' || platforma === 'instagram') {
        const meta = user.social_connections?.meta;
        const page = meta?.pages?.find((item) => item.id === meta.selected_page_id);
        if (!page) throw new Error('Conecteaza Meta si selecteaza o Pagina inainte de publicare.');
        rezultat = platforma === 'facebook'
          ? await publishFacebook(page, `${articol.titlu}\n\n${textScurt}`, articolUrl)
          : await publishInstagram(page, `${articol.titlu}\n\n${textScurt}\n\n${articolUrl}`, articol.imagine_url);
      } else {
        const connection = user.social_connections?.tiktok;
        if (!connection) throw new Error('Conecteaza contul TikTok inainte de publicare.');
        rezultat = await publishTikTokPhoto(connection, articol.titlu, `${textScurt}\n\n${articolUrl}`, articol.imagine_url);
      }
      articol.distribuiri_sociale ||= [];
      articol.distribuiri_sociale.push({
        platforma,
        data: new Date().toISOString(),
        id_extern: rezultat.id || rezultat.data?.publish_id || '',
        status: 'trimis',
      });
      await db.write();
      res.redirect(`/dashboard/social?mesaj=${encodeURIComponent(`Articolul a fost trimis cu succes catre ${platforma}.`)}`);
    } catch (error) {
      res.redirect(`/dashboard/social?eroare=${encodeURIComponent(`${platforma}: ${error.message || 'publicarea a esuat.'}`)}`);
    }
  });

  app.post('/dashboard/profil', requireRole('candidate'), async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    if (!user) return res.redirect('/login');
    user.slogan = String(req.body.slogan || '').trim().slice(0, 140);
    user.mesaj_scurt = String(req.body.mesaj_scurt || '').trim().slice(0, 240);
    user.descriere = String(req.body.descriere || '').trim().slice(0, 2000);
    user.facebook_url = urlSigur(req.body.facebook_url);
    user.instagram_url = urlSigur(req.body.instagram_url);
    user.tiktok_url = urlSigur(req.body.tiktok_url);
    user.youtube_url = urlSigur(req.body.youtube_url);
    await db.write();
    res.redirect('/dashboard?profil=salvat');
  });

  app.get('/dashboard/articol/nou', requireRole('candidate'), (req, res) => {
    res.render('articol-form', { articol: null });
  });

  app.get('/dashboard/articol/:id/edit', requireRole('candidate'), (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    res.render('articol-form', { articol });
  });

  app.post('/dashboard/articol', requireRole('candidate'), async (req, res) => {
    const { titlu, continut, tip, categorie, generat_de_ai, status } = req.body;
    const acum = new Date().toISOString();
    db.data.articole.push({
      id: nextArticolId(),
      user_id: req.session.userId,
      tip: tip || 'idee',
      titlu,
      continut,
      categorie: categorie || 'Actualitate',
      status: status === 'publicat' ? 'publicat' : 'ciorna',
      generat_de_ai: generat_de_ai === 'true',
      imagine_url: urlSigur(req.body.imagine_url),
      vizualizari: 0,
      distribuiri_sociale: [],
      data_publicare: acum,
      updated_at: acum,
    });
    await db.write();
    res.redirect('/dashboard');
  });

  app.post('/dashboard/articol/:id', requireRole('candidate'), async (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    const { titlu, continut, tip, categorie, generat_de_ai, status } = req.body;
    articol.titlu = titlu;
    articol.continut = continut;
    articol.tip = tip || articol.tip;
    articol.categorie = categorie || articol.categorie;
    articol.generat_de_ai = generat_de_ai === 'true';
    articol.imagine_url = urlSigur(req.body.imagine_url);
    const eraDejaPublicat = articol.status === 'publicat';
    articol.status = status === 'publicat' ? 'publicat' : 'ciorna';
    if (!eraDejaPublicat && articol.status === 'publicat') {
      articol.data_publicare = new Date().toISOString();
    }
    articol.updated_at = new Date().toISOString();
    await db.write();
    res.redirect('/dashboard');
  });

  app.post('/dashboard/articol/:id/sterge', requireRole('candidate'), async (req, res) => {
    db.data.articole = db.data.articole.filter(
      (a) => !(a.id === Number(req.params.id) && a.user_id === req.session.userId)
    );
    await db.write();
    res.redirect('/dashboard');
  });

  app.post('/dashboard/genereaza-ai', requireRole('candidate'), async (req, res) => {
    const { idee, ton } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        eroare: 'Nu este configurata ANTHROPIC_API_KEY. Vezi README.md pentru instructiuni.',
      });
    }
    try {
      const raspuns = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 700,
          messages: [
            {
              role: 'user',
              content: `Esti asistentul de comunicare al unui candidat local la alegeri din Romania. Scrie un articol scurt (120-180 de cuvinte), in limba romana, ton ${ton || 'direct si apropiat'}, plecand de la aceasta idee data de candidat: "${idee}".
Reguli stricte:
- Nu inventa cifre, date sau promisiuni concrete pe care candidatul nu le-a mentionat.
- Nu ataca alti candidati sau partide.
- Nu folosi limbaj de campanie negativa sau afirmatii neverificabile.
- Scrie la persoana intai, ca si cum candidatul insusi ar vorbi.
Raspunde DOAR cu doua linii:
Titlu: <titlul articolului>
Text: <continutul articolului>`,
            },
          ],
        }),
      });
      if (!raspuns.ok) {
        const detalii = await raspuns.text();
        return res.status(502).json({ eroare: 'Eroare de la API-ul Claude.', detalii });
      }
      const data = await raspuns.json();
      const text = data.content?.find((b) => b.type === 'text')?.text || '';
      const potrivireTitlu = text.match(/Titlu:\s*(.+)/i);
      const potrivireText = text.match(/Text:\s*([\s\S]+)/i);
      res.json({
        titlu: potrivireTitlu ? potrivireTitlu[1].trim() : 'Titlu generat de AI',
        continut: potrivireText ? potrivireText[1].trim() : text.trim(),
      });
    } catch (err) {
      res.status(500).json({ eroare: 'Nu am putut contacta API-ul Claude.', detalii: String(err) });
    }
  });

  /* --------------------------- SITE PUBLIC (ziar) -------------------------- */

  app.get('/site/:subdomeniu', async (req, res) => {
    const user = db.data.users.find(
      (u) => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u)
    );
    if (!user) return res.status(404).send('Pagina nu exista.');
    const toate = db.data.articole
      .filter((a) => a.user_id === user.id && a.status === 'publicat')
      .sort((a, b) => new Date(b.data_publicare) - new Date(a.data_publicare));
    const candidatura = toate.find((a) => a.tip === 'candidatura');
    const fluxIdei = toate.filter((a) => a.tip !== 'candidatura');
    const categorii = fluxIdei.reduce((grupuri, articol) => {
      const categorie = articol.categorie || 'Actualitate';
      grupuri[categorie] ||= [];
      grupuri[categorie].push(articol);
      return grupuri;
    }, {});
    if (user.module?.statistici) {
      user.statistici.vizite_site += 1;
      const sursa = sursaVizitei(req);
      user.statistici.surse[sursa] = (user.statistici.surse[sursa] || 0) + 1;
      await db.write();
    }
    res.render('site-public', { user, candidatura, fluxIdei, categorii });
  });

  app.get('/site/:subdomeniu/articol/:id', async (req, res) => {
    const user = db.data.users.find((u) => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u));
    if (!user) return res.status(404).send('Pagina nu exista.');
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === user.id && a.status === 'publicat'
    );
    if (!articol) return res.status(404).send('Articolul nu exista sau nu e publicat.');
    if (user.module?.statistici) {
      articol.vizualizari = (articol.vizualizari || 0) + 1;
      await db.write();
    }
    const bazaPublica = process.env.URL || `${req.protocol}://${req.get('host')}`;
    const articolUrl = new URL(req.originalUrl, bazaPublica).toString();
    res.render('site-articol', { user, articol, articolUrl });
  });

  app.get('/site/:subdomeniu/social/:platforma', async (req, res) => {
    const user = db.data.users.find((u) => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u));
    const platforma = String(req.params.platforma || '').toLowerCase();
    if (!user || !user.module?.social || !RETELE_SOCIALE.has(platforma)) {
      return res.redirect(`/site/${encodeURIComponent(req.params.subdomeniu)}`);
    }
    const destinatie = urlSigur(user[`${platforma}_url`]);
    if (!destinatie) return res.redirect(`/site/${encodeURIComponent(user.subdomeniu)}`);
    if (user.module?.statistici) {
      user.statistici.clickuri_sociale[platforma] =
        (user.statistici.clickuri_sociale[platforma] || 0) + 1;
      await db.write();
    }
    res.redirect(destinatie);
  });

  return app;
}
