import express from 'express';
import ejs from 'ejs';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import path from 'path';
import { db, initDB, slugify, generateazaParola, nextUserId, nextArticolId } from './db.js';
import { requireRole } from './middleware/auth.js';
import { articleInput, profileInput, filterArticles, isPublished, publicationDate, localDateTime, displayDate, ValidationError } from './publication.js';
import { createComments, COMMENT_STATUS } from './comments.js';
import { createEditorial, editorialImageUrl, internalImageId } from './editorial.js';
import { attachEditorialRoutes } from './editorial-routes.js';
import { LEGAL_PAGES } from './legal-pages.js';
import {
  TERMS_VERSION,
  REPORT_STATUS,
  candidateComplianceMissing,
  createCompliance,
  legalProfileInput,
  platformInfo,
  publicTransparency,
  transparencySnapshot,
} from './compliance.js';
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
const ACCEPTANCE_FIELDS = [
  'functie_candidatura', 'zona', 'judet', 'partid', 'tip_candidat', 'entitate_responsabila',
  'finantator_materiale', 'scrutin', 'cod_mandatar_financiar', 'tip_contract', 'numar_contract',
  'data_contract', 'valoare_contract', 'moneda_contract', 'campanie_start', 'campanie_end',
  'confirmare_mandatar',
];

function acceptanceChanged(before, after) {
  return ACCEPTANCE_FIELDS.some(field => String(before[field] ?? '') !== String(after[field] ?? ''));
}

function invalidateAcceptance(user) {
  user.terms_version = '';
  user.terms_accepted_at = null;
  user.editorial_responsibility_accepted_at = null;
}

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

export async function createApp({
  comments = createComments(),
  now = () => Date.now(),
  editorial = createEditorial({ now }),
  compliance = createCompliance({ now }),
} = {}) {
  await initDB();
  const platform = platformInfo();

  const app = express();
  // Inregistram motorul explicit (in loc sa lasam Express sa faca un require
  // dinamic dupa numele "ejs") - altfel esbuild nu detecteaza dependenta la bundling
  // pe Netlify si arunca "Cannot find module 'ejs'" la runtime.
  app.engine('ejs', ejs.renderFile);
  app.set('view engine', 'ejs');
  app.set('views', path.join(baseDir, 'views'));
  app.locals.isPublished = article => isPublished(article, now());
  app.locals.publicationDate = publicationDate;
  app.locals.displayDate = displayDate;
  app.locals.publicTransparency = publicTransparency;
  app.locals.platform = platform;
  app.locals.termsVersion = TERMS_VERSION;
  app.use(express.static(path.join(baseDir, 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use('/dashboard/media', express.json({ limit: '4300kb' }));
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

  const safely = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  function requireActiveAccount(req, res, next) {
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user?.activ || user.role !== req.session.rol || (user.role === 'candidate' && user.status_cont !== 'activ')) {
      return res.status(403).send('Contul nu este activ.');
    }
    next();
  }
  function requestIp(req) {
    return (process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME)
      ? req.get('x-nf-client-connection-ip') || req.socket.remoteAddress || 'unknown'
      : req.socket.remoteAddress || 'unknown';
  }
  function publicArticle(req) {
    const user = db.data.users.find(u => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u));
    const articol = user && db.data.articole.find(a => a.id === Number(req.params.id)
      && a.user_id === user.id && isPublished(a, now()));
    return { user, articol };
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

  app.get('/legal/:page', (req, res) => {
    const page = LEGAL_PAGES[req.params.page];
    if (!page) return res.status(404).send('Pagina nu există.');
    res.render('legal-page', { page });
  });

  app.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const parola = String(req.body.parola || '');
    const user = db.data.users.find((u) => u.email.toLowerCase() === email);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return res.render('login', { eroare: 'Cont blocat temporar după prea multe încercări. Încearcă din nou peste 15 minute.' });
    }
    const contPermis = user?.role === 'admin'
      ? user.activ
      : user?.role === 'candidate' && ['in_asteptare', 'activ'].includes(user.status_cont);
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
    if (user.status_cont === 'in_asteptare') return res.redirect('/activare');
    return res.redirect('/dashboard');
  });

  app.post('/logout', requireCsrf, (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  /* ----------------------- ACTIVAREA CANDIDATULUI ----------------------- */

  app.get('/activare', requireRole('candidate'), (req, res) => {
    const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
    if (!user || ['suspendat', 'expirat'].includes(user.status_cont)) return res.status(403).send('Contul nu poate fi activat.');
    res.render('candidate-activation', {
      user,
      lipsuri: candidateComplianceMissing(user, platform),
      mesaj: req.query.mesaj || '',
      eroare: req.query.eroare || '',
    });
  });

  app.post('/activare', requireRole('candidate'), requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
    if (!user || ['suspendat', 'expirat'].includes(user.status_cont)) throw new ValidationError('Contul nu poate fi activat.', 403);
    if (req.body.accepta_termeni !== 'on' || req.body.accepta_responsabilitate !== 'on') {
      throw new ValidationError('Trebuie să accepți termenii și responsabilitatea editorială.');
    }
    const temporary = { ...user, terms_version: TERMS_VERSION, terms_accepted_at: 'pending', editorial_responsibility_accepted_at: 'pending' };
    const otherMissing = candidateComplianceMissing(temporary, platform);
    if (otherMissing.length) throw new ValidationError(`Activarea nu poate continua. Lipsesc: ${otherMissing.join(', ')}.`);
    const acceptance = await compliance.acceptTerms({ candidateId: user.id, ip: requestIp(req) });
    user.terms_version = acceptance.terms_version;
    user.terms_accepted_at = acceptance.accepted_at;
    user.editorial_responsibility_accepted_at = acceptance.editorial_responsibility_accepted_at;
    await db.write();
    await compliance.audit({ actorId: user.id, actorRole: 'candidate', action: 'terms_accepted',
      targetType: 'candidate', targetId: user.id, details: { terms_version: TERMS_VERSION } });
    if (user.status_cont === 'activ') return res.redirect('/dashboard?activare=confirmata');
    res.redirect('/activare?mesaj=Datele%20au%20fost%20confirmate.%20Super%20Adminul%20poate%20activa%20acum%20contul.');
  }));

  // Niciun instrument editorial nu este disponibil unui cont aflat în așteptare.
  app.use('/dashboard', requireRole('candidate'), requireActiveAccount);

  /* -------------------------------- ADMIN -------------------------------- */

  app.get('/admin', requireRole('admin'), requireActiveAccount, (req, res) => {
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
      topArticole: db.data.articole.filter(a => isPublished(a, now()))
        .map(a => ({ ...a, candidat: candidati.find(c => c.id === a.user_id) }))
        .filter(a => a.candidat && poatePublicaSite(a.candidat))
        .sort((a, b) => (b.vizualizari || 0) - (a.vizualizari || 0)).slice(0, 10),
      mesaj: req.query.mesaj || null,
      eroare: req.query.eroare || null,
      platform,
      complianceMissing: Object.fromEntries(candidati.map(candidate =>
        [candidate.id, candidateComplianceMissing(candidate, platform)])),
    });
  });

  app.post('/admin/candidati', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
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
    const legal = legalProfileInput(req.body);
    const candidate = {
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
      ...legal,
      terms_version: '',
      terms_accepted_at: null,
      editorial_responsibility_accepted_at: null,
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
    };
    db.data.users.push(candidate);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_created',
      targetType: 'candidate', targetId: candidate.id, details: { contract_type: legal.tip_contract, contract_number: legal.numar_contract } });
    res.status(201).render('candidate-created', { candidate, parola });
  }));

  app.post('/admin/securitate', requireRole('admin'), requireActiveAccount, requireCsrf, async (req, res) => {
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

  app.post('/admin/candidati/:id/status', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((u) => u.id === Number(req.params.id));
    const status = String(req.body.status_cont || '');
    if (user?.role === 'candidate' && STATUS_CONT.has(status)) {
      if (status === 'activ') {
        const missing = candidateComplianceMissing(user, platform);
        if (missing.length) {
          return res.redirect(`/admin?eroare=${encodeURIComponent(`Contul nu poate fi activat. Lipsesc: ${missing.join(', ')}.`)}`);
        }
      }
      const previous = user.status_cont;
      user.status_cont = status;
      user.activ = status === 'activ';
      user.activated_at = status === 'activ' ? new Date().toISOString() : user.activated_at || null;
      await db.write();
      await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_status_changed',
        targetType: 'candidate', targetId: user.id, details: { previous, status } });
    }
    res.redirect('/admin');
  }));

  app.post('/admin/candidati/:id/configurare', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((u) => u.id === Number(req.params.id));
    if (user?.role === 'candidate') {
      const before = Object.fromEntries(ACCEPTANCE_FIELDS.map(field => [field, user[field]]));
      user.functie_candidatura = String(req.body.functie_candidatura || '').trim();
      user.zona = String(req.body.zona || '').trim();
      user.judet = String(req.body.judet || '').trim();
      user.partid = String(req.body.partid || '').trim();
      Object.assign(user, legalProfileInput(req.body));
      const requiresNewAcceptance = acceptanceChanged(before, user);
      if (requiresNewAcceptance) invalidateAcceptance(user);
      user.module = {
        site: req.body.modul_site === 'on',
        statistici: req.body.modul_statistici === 'on',
        social: req.body.modul_social === 'on',
      };
      await db.write();
      await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_configuration_changed',
        targetType: 'candidate', targetId: user.id, details: { contract_type: user.tip_contract,
          contract_number: user.numar_contract, acceptance_invalidated: requiresNewAcceptance } });
    }
    res.redirect('/admin');
  }));

  /* ------------------------------ CANDIDAT ------------------------------- */

  app.get('/admin/comentarii', requireRole('admin'), requireActiveAccount, safely(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'in_asteptare';
    if (!COMMENT_STATUS.has(status)) throw new ValidationError('Filtru de moderare invalid.');
    const all = await comments.list();
    const total = all.filter(c => c.status === status).length;
    const pages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.pagina, 10) || 1));
    const lista = all.filter(c => c.status === status).slice((page - 1) * 25, page * 25).map(c => {
      const candidat = db.data.users.find(u => u.id === c.user_id);
      const articol = db.data.articole.find(a => a.id === c.articol_id && a.user_id === c.user_id);
      return { ...c, candidat, articol, publicLink: poatePublicaSite(candidat) && articol && isPublished(articol, now()) };
    });
    res.render('admin-comments', { lista, status, page, pages, total,
      counts: Object.fromEntries([...COMMENT_STATUS].map(s => [s, all.filter(c => c.status === s).length])) });
  }));

  app.post('/admin/comentarii/:candidateId/:articleId/:id', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const candidateId = Number(req.params.candidateId);
    const articleId = Number(req.params.articleId);
    if (![candidateId, articleId].every(id => Number.isSafeInteger(id) && id > 0)) throw new ValidationError('Identificator invalid.');
    await comments.moderate({ candidateId, articleId, id: req.params.id, status: req.body.status,
      adminId: req.session.userId, version: req.body.version });
    res.redirect(303, '/admin/comentarii');
  }));

  app.get('/admin/sesizari', requireRole('admin'), requireActiveAccount, safely(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'noua';
    if (!REPORT_STATUS.has(status)) throw new ValidationError('Filtru de sesizări invalid.');
    const all = await compliance.listReports();
    const filtered = all.filter(report => report.status === status);
    const pages = Math.max(1, Math.ceil(filtered.length / 25));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.pagina, 10) || 1));
    const lista = filtered.slice((page - 1) * 25, page * 25).map(report => ({
      ...report,
      candidat: db.data.users.find(candidate => candidate.id === report.user_id),
      articol: db.data.articole.find(article => article.id === report.articol_id && article.user_id === report.user_id),
    }));
    res.render('admin-reports', { lista, status, page, pages, total: filtered.length,
      counts: Object.fromEntries([...REPORT_STATUS].map(value => [value, all.filter(report => report.status === value).length])) });
  }));

  app.post('/admin/sesizari/:candidateId/:articleId/:id', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const candidateId = Number(req.params.candidateId);
    const articleId = Number(req.params.articleId);
    if (![candidateId, articleId].every(id => Number.isSafeInteger(id) && id > 0)) throw new ValidationError('Identificator invalid.');
    const article = db.data.articole.find(item => item.id === articleId && item.user_id === candidateId);
    if (!article) throw new ValidationError('Articolul sesizat nu mai există în lista activă.', 404);
    const action = String(req.body.action || 'none');
    const event = await compliance.resolveReport({ candidateId, articleId, id: req.params.id,
      status: req.body.status, note: req.body.note, action, adminId: req.session.userId, version: req.body.version });
    if (action === 'suspend') {
      article.moderation_status = 'suspendat';
      article.moderation_reason = event.note;
      article.moderated_at = event.created_at;
      article.moderated_by = req.session.userId;
      await db.write();
    } else if (action === 'restore') {
      article.moderation_status = 'normal';
      article.moderation_reason = '';
      article.moderated_at = event.created_at;
      article.moderated_by = req.session.userId;
      await db.write();
    }
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: `report_${event.status}`,
      targetType: 'article', targetId: articleId, details: { report_id: req.params.id, moderation_action: action } });
    res.redirect(303, `/admin/sesizari?status=${encodeURIComponent(event.status)}`);
  }));

  app.get('/admin/jurnal', requireRole('admin'), requireActiveAccount, safely(async (req, res) => {
    const events = await compliance.listAudit(100);
    res.render('admin-audit', { events });
  }));

  app.get('/dashboard', requireRole('candidate'), (req, res) => {
    const articole = db.data.articole
      .filter((a) => a.user_id === req.session.userId)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const totalCitiri = articole.reduce((total, articol) => total + (articol.vizualizari || 0), 0);
    const topArticole = [...articole]
      .filter((articol) => isPublished(articol, now()))
      .sort((a, b) => (b.vizualizari || 0) - (a.vizualizari || 0))
      .slice(0, 5);
    res.render('candidate-dashboard', { articole, user, totalCitiri, topArticole,
      lipsuriJuridice: candidateComplianceMissing(user, platform) });
  });

  app.get('/dashboard/social', requireRole('candidate'), (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    if (!user?.module?.social) return res.redirect('/dashboard');
    const articole = db.data.articole
      .filter((a) => a.user_id === user.id && isPublished(a, now()))
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

  app.get('/oauth/meta/callback', requireRole('candidate'), requireActiveAccount, async (req, res) => {
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

  app.get('/oauth/tiktok/callback', requireRole('candidate'), requireActiveAccount, async (req, res) => {
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
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId && isPublished(a, now())
    );
    const platforma = String(req.body.platforma || '').toLowerCase();
    if (!user?.module?.social || !articol || !['facebook', 'instagram', 'tiktok'].includes(platforma)) {
      return res.redirect('/dashboard/social?eroare=Articolul%20sau%20reteaua%20selectata%20nu%20este%20valida.');
    }
    const articolUrl = `${publicBaseUrl(req)}/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}?utm_source=${platforma}`;
    const textScurt = String(articol.continut || '').replace(/\s+/g, ' ').trim().slice(0, 450);
    try {
      const imaginePublica = internalImageId(articol.imagine_url)
        ? new URL(articol.imagine_url, publicBaseUrl(req)).toString() : articol.imagine_url;
      let rezultat;
      if (platforma === 'facebook' || platforma === 'instagram') {
        const meta = user.social_connections?.meta;
        const page = meta?.pages?.find((item) => item.id === meta.selected_page_id);
        if (!page) throw new Error('Conecteaza Meta si selecteaza o Pagina inainte de publicare.');
        rezultat = platforma === 'facebook'
          ? await publishFacebook(page, `${articol.titlu}\n\n${textScurt}`, articolUrl)
          : await publishInstagram(page, `${articol.titlu}\n\n${textScurt}\n\n${articolUrl}`, imaginePublica);
      } else {
        const connection = user.social_connections?.tiktok;
        if (!connection) throw new Error('Conecteaza contul TikTok inainte de publicare.');
        rezultat = await publishTikTokPhoto(connection, articol.titlu, `${textScurt}\n\n${articolUrl}`, imaginePublica);
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

  app.post('/dashboard/profil', requireRole('candidate'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    if (!user) return res.redirect('/login');
    const before = Object.fromEntries(ACCEPTANCE_FIELDS.map(field => [field, user[field]]));
    Object.assign(user, profileInput(req.body));
    const requiresNewAcceptance = acceptanceChanged(before, user);
    if (requiresNewAcceptance) invalidateAcceptance(user);
    if (user.module?.social) {
      user.facebook_url = urlSigur(req.body.facebook_url);
      user.instagram_url = urlSigur(req.body.instagram_url);
      user.tiktok_url = urlSigur(req.body.tiktok_url);
      user.youtube_url = urlSigur(req.body.youtube_url);
    }
    await db.write();
    await compliance.audit({ actorId: user.id, actorRole: 'candidate', action: 'candidate_profile_changed',
      targetType: 'candidate', targetId: user.id, details: { acceptance_invalidated: requiresNewAcceptance } });
    res.redirect(requiresNewAcceptance ? '/activare?mesaj=Datele%20publice%20s-au%20schimbat.%20Confirm%C4%83%20din%20nou%20termenii.' : '/dashboard?profil=salvat');
  }));

  app.get('/dashboard/articol/nou', requireRole('candidate'), (req, res) => {
    res.render('articol-form', { articol: null, eroare: '', dataProgramata: '', confirmareResponsabilitate: false });
  });

  app.get('/dashboard/articol/:id/edit', requireRole('candidate'), (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    res.render('articol-form', { articol, eroare: '', dataProgramata: localDateTime(articol.data_programata), confirmareResponsabilitate: false });
  });

  async function validateArticle(req, res, previous) {
    try {
      const fields = articleInput(req.body, previous, now());
      const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
      if (previous?.moderation_status === 'suspendat' && ['publicat', 'programat'].includes(fields.status)) {
        throw new ValidationError('Articolul este suspendat de Super Admin și nu poate fi republicat până la soluționarea sesizării.');
      }
      if (['publicat', 'programat'].includes(fields.status)) {
        const missing = candidateComplianceMissing(user, platform);
        if (missing.length) throw new ValidationError(`Publicarea este blocată. Lipsesc: ${missing.join(', ')}.`);
        if (req.body.confirmare_responsabilitate !== 'on') {
          throw new ValidationError('Confirmă responsabilitatea editorială și exactitatea datelor de transparență.');
        }
        fields.transparenta = transparencySnapshot(user, new Date(now()).toISOString());
      }
      fields.imagine_url = editorialImageUrl(req.body.imagine_url);
      const imageId = internalImageId(fields.imagine_url);
      if (imageId) {
        const image = await editorial.media(imageId);
        if (!image || image.userId !== req.session.userId) throw new ValidationError('Imaginea nu aparține contului tău sau nu mai este disponibilă.');
        fields.imagine_generata_ai = image.generated || fields.imagine_generata_ai;
      }
      return fields;
    }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const form = Object.fromEntries(['titlu', 'continut', 'tip', 'categorie', 'imagine_url', 'rezumat', 'imagine_alt', 'imagine_legenda', 'imagine_credit'].map(key =>
        [key, typeof req.body[key] === 'string' ? req.body[key] : '']));
      res.status(400).render('articol-form', { articol: { ...form, id: previous?.id, generat_de_ai: req.body.generat_de_ai === 'true', imagine_generata_ai: req.body.imagine_generata_ai === 'true' },
        eroare: error.message, dataProgramata: typeof req.body.data_programata === 'string' ? req.body.data_programata : '',
        confirmareResponsabilitate: req.body.confirmare_responsabilitate === 'on' });
      return null;
    }
  }

  app.post('/dashboard/articol', requireRole('candidate'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const fields = await validateArticle(req, res, null);
    if (!fields) return;
    const article = {
      id: nextArticolId(),
      user_id: req.session.userId,
      ...fields,
      vizualizari: 0,
      distribuiri_sociale: [],
      moderation_status: 'normal',
    };
    db.data.articole.push(article);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'candidate', action: 'article_created',
      targetType: 'article', targetId: article.id, details: { status: article.status, title: article.titlu.slice(0, 200) } });
    res.redirect('/dashboard');
  }));

  app.post('/dashboard/articol/:id', requireRole('candidate'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    const fields = await validateArticle(req, res, articol);
    if (!fields) return;
    Object.assign(articol, fields);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'candidate', action: 'article_updated',
      targetType: 'article', targetId: articol.id, details: { status: articol.status, title: articol.titlu.slice(0, 200) } });
    res.redirect('/dashboard');
  }));

  app.post('/dashboard/articol/:id/sterge', requireRole('candidate'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const articol = db.data.articole.find(a => a.id === Number(req.params.id) && a.user_id === req.session.userId);
    if (articol?.moderation_status === 'suspendat') {
      throw new ValidationError('Un articol suspendat nu poate fi șters până la soluționarea sesizării.', 409);
    }
    db.data.articole = db.data.articole.filter(
      (a) => !(a.id === Number(req.params.id) && a.user_id === req.session.userId)
    );
    await db.write();
    if (articol) await compliance.audit({ actorId: req.session.userId, actorRole: 'candidate', action: 'article_deleted',
      targetType: 'article', targetId: articol.id, details: { status: articol.status, title: articol.titlu.slice(0, 200) } });
    res.redirect('/dashboard');
  }));

  attachEditorialRoutes(app, { db, editorial, requireRole, requireActiveAccount, requireCsrf, now });

  /* --------------------------- SITE PUBLIC (ziar) -------------------------- */

  app.get('/site/:subdomeniu', safely(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const user = db.data.users.find(
      (u) => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u)
    );
    if (!user) return res.status(404).send('Pagina nu exista.');
    const toate = db.data.articole
      .filter((a) => a.user_id === user.id && isPublished(a, now()))
      .sort((a, b) => new Date(publicationDate(b)) - new Date(publicationDate(a)));
    const { cautaText, categorieSelectata, filtrate } = filterArticles(toate, req.query);
    const candidatura = filtrate.find((a) => a.tip === 'candidatura');
    const fluxIdei = filtrate.filter((a) => a.id !== candidatura?.id);
    const categorii = filtrate.reduce((grupuri, articol) => {
      const categorie = articol.categorie || 'Actualitate';
      grupuri[categorie] ||= [];
      grupuri[categorie].push(articol);
      return grupuri;
    }, Object.create(null));
    if (user.module?.statistici) {
      user.statistici.vizite_site += 1;
      const sursa = sursaVizitei(req);
      user.statistici.surse[sursa] = (user.statistici.surse[sursa] || 0) + 1;
      await db.write();
    }
    res.render('site-public', { user, candidatura, fluxIdei, categorii, cautaText, categorieSelectata,
      categoriiToate: [...new Set(toate.map(a => a.categorie || 'Actualitate'))].sort(),
      rezultatTotal: filtrate.length });
  }));

  app.get('/site/:subdomeniu/contact', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const user = db.data.users.find(u => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u));
    if (!user) return res.status(404).send('Pagina nu există.');
    res.render('site-contact', { user });
  });

  app.get('/site/:subdomeniu/transparenta', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const user = db.data.users.find(candidate => candidate.subdomeniu === req.params.subdomeniu && poatePublicaSite(candidate));
    if (!user) return res.status(404).send('Pagina nu există.');
    const articleId = Number(req.query.articol);
    const articol = Number.isSafeInteger(articleId) && articleId > 0
      ? db.data.articole.find(item => item.id === articleId && item.user_id === user.id && isPublished(item, now()))
      : null;
    res.render('site-transparency', { user, articol, transparenta: publicTransparency(user, articol) });
  });

  app.get('/site/:subdomeniu/articol/:id/raporteaza', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const { user, articol } = publicArticle(req);
    if (!articol) return res.status(404).send('Articolul nu există sau nu este publicat.');
    const reportId = /^[a-f0-9-]{36}$/.test(String(req.query.sesizare || '')) ? String(req.query.sesizare) : '';
    res.render('report-form', { user, articol, eroare: '', values: {}, trimis: req.query.trimis === 'da', reportId });
  });

  app.post('/site/:subdomeniu/articol/:id/raporteaza', requireCsrf, safely(async (req, res) => {
    const { user, articol } = publicArticle(req);
    if (!articol) return res.status(404).send('Articolul nu există sau nu este publicat.');
    try {
      const report = await compliance.submitReport({ candidate: user, article: articol, body: req.body, ip: requestIp(req) });
      return res.redirect(303, `/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}/raporteaza?trimis=da&sesizare=${encodeURIComponent(report.id)}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      if (error.status === 429) res.set('Retry-After', '60');
      return res.status(error.status).render('report-form', { user, articol, eroare: error.message,
        values: Object.fromEntries(['motiv', 'descriere', 'nume', 'email'].map(key =>
          [key, typeof req.body[key] === 'string' ? req.body[key] : ''])), trimis: false, reportId: '' });
    }
  }));

  async function renderPublicArticle(req, res, { error = '', values = {}, status = 200, count = false } = {}) {
    res.set('Cache-Control', 'private, no-store');
    const { user, articol } = publicArticle(req);
    if (!articol) return res.status(404).send('Articolul nu exista sau nu e publicat.');
    let comentarii = [];
    let commentsAvailable = true;
    try { comentarii = (await comments.list(user.id, articol.id)).filter(c => c.status === 'aprobat'); }
    catch (commentError) {
      commentsAvailable = false;
      console.error('Citirea comentariilor a eșuat:', commentError.name);
    }
    if (count && user.module?.statistici) {
      articol.vizualizari = (articol.vizualizari || 0) + 1;
      await db.write();
    }
    const bazaPublica = process.env.URL || `${req.protocol}://${req.get('host')}`;
    const articolUrl = new URL(`/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}`, bazaPublica).toString();
    res.status(status).render('site-articol', { user, articol, articolUrl, transparenta: publicTransparency(user, articol), comentarii, commentsAvailable, commentError: error,
      commentValues: values, commentSent: req.query.comentariu === 'trimis' });
  }

  app.get('/site/:subdomeniu/articol/:id', safely((req, res) => renderPublicArticle(req, res, { count: true })));

  app.post('/site/:subdomeniu/articol/:id/comentarii', requireCsrf, safely(async (req, res) => {
    const { user, articol } = publicArticle(req);
    if (!articol) return res.status(404).send('Articolul nu există sau nu e publicat.');
    try {
      await comments.submit({ candidateId: user.id, articleId: articol.id, body: req.body,
        // Nu avem încredere în X-Forwarded-For trimis direct de client.
        ip: requestIp(req) });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      if (error.status === 429) res.set('Retry-After', '60');
      return renderPublicArticle(req, res, { error: error.message, status: error.status,
        values: { nume: typeof req.body.nume === 'string' ? req.body.nume : '', text: typeof req.body.text === 'string' ? req.body.text : '' } });
    }
    res.redirect(303, `/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}?comentariu=trimis#comentarii`);
  }));

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

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (req.path === '/dashboard/media' && error.type === 'entity.too.large') {
      return res.status(413).json({ eroare: 'Imagine prea mare. Încarcă un fișier de maximum 3 MB după redimensionare.' });
    }
    if (error instanceof ValidationError) return res.status(error.status).send(error.message);
    // Nu expunem stack-uri, secrete sau datele trimise de vizitatori.
    console.error('Cerere nereușită:', error.name);
    res.status(503).send('Datele nu pot fi accesate momentan. Reîncarcă pagina și încearcă din nou.');
  });
  return app;
}
