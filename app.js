import express from 'express';
import ejs from 'ejs';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'path';
import { db, initDB, slugify, generateazaParola, nextUserId, nextArticolId, nextPortalPostId } from './db.js';
import { StateConflictError } from './state-conflict.js';
import { requireRole } from './middleware/auth.js';
import { articleInput, profileInput, filterArticles, isPublished, publicationDate, localDateTime, displayDate, textField, ValidationError } from './publication.js';
import { raportareInput, moderareRaportareInput, statisticiPublice, totalPublic, purjeazaRaportariExpirate, limitaRaportariDepasita,
  descriereDispozitiv, LOCALITATI, RETENTION_DAYS, MAX_RAPORTARI_PER_IP } from './cost-reports.js';
import { createComments, COMMENT_STATUS } from './comments.js';
import { createEditorial, editorialImageUrl, internalImageId } from './editorial.js';
import { attachEditorialRoutes } from './editorial-routes.js';
import { createAuthUserWithPassword, deleteAuthUser, signInWithPassword, updateAuthPassword, updateAuthEmail } from './supabase-auth.js';
import { LEGAL_PAGES } from './legal-pages.js';
import { isPortalPublished, portalPostInput, portalPublicationDate } from './portal.js';
import { mailConfigured, sendMail } from './mail.js';
import { PORTAL_SITE_NAME, portalPageSeo, portalArticleSeo, seoDate, jsonLd } from './seo.js';
import {
  TERMS_VERSION,
  REPORT_STATUS,
  candidateComplianceMissing,
  createCompliance,
  legalProfileInput,
  isElectoralMode,
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
  fetchTikTokProfile,
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
const STATUS_DASHBOARD = new Set(['ciorna', 'programat', 'publicat', 'suspendat']);
const SECTIUNI_EDITORIALE = Object.freeze([
  { slug: 'actualitate', categorie: 'Actualitate', titlu: 'Actualitate', descriere: 'Știri, reacții și informații recente din campanie.' },
  { slug: 'program', categorie: 'Program', titlu: 'Program', descriere: 'Prioritățile și angajamentele candidatului.' },
  { slug: 'proiecte', categorie: 'Proiecte', titlu: 'Proiecte', descriere: 'Proiecte concrete pentru comunitate, fiecare cu pagina sa.' },
  { slug: 'evenimente', categorie: 'Evenimente', titlu: 'Evenimente', descriere: 'Întâlniri publice, dezbateri și acțiuni de campanie.' },
]);
const PORTAL_SECTIONS = Object.freeze({
  stiri: { titlu: 'Știri locale', descriere: 'Noutăți verificate din Bulgăruș, Lenauheim și Grabaț.', categorii: [] },
  administratie: { titlu: 'Administrație', descriere: 'Decizii publice, proiecte și informații despre administrația locală.', categorii: ['Administrație', 'Primărie'] },
  comunitate: { titlu: 'Comunitate', descriere: 'Oameni, inițiative și subiecte importante pentru comună.', categorii: ['Comunitate'] },
  educatie: { titlu: 'Educație', descriere: 'Școli, copii și oportunități educaționale locale.', categorii: ['Educație'] },
  economie: { titlu: 'Economie', descriere: 'Afaceri locale, locuri de muncă și dezvoltare.', categorii: ['Economie'] },
  evenimente: { titlu: 'Evenimente', descriere: 'Calendarul activităților și întâlnirilor din comunitate.', categorii: ['Evenimente'] },
});
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

function vizibilInPortal(user) {
  return poatePublicaSite(user) && user.vizibil_in_portal !== false;
}

function pollInput(body) {
  const question = textField(body.intrebare, 'Întrebarea sondajului', 180, true);
  const options = String(body.optiuni || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 6) throw new ValidationError('Adaugă între 2 și 6 opțiuni, fiecare pe un rând.');
  if (new Set(options.map(value => value.toLowerCase())).size !== options.length) throw new ValidationError('Opțiunile sondajului trebuie să fie diferite.');
  return { question, options: options.map((text, index) => ({ id: index + 1, text, votes: 0 })) };
}

function reactionFingerprint(req, type, id) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new ValidationError('Reacțiile necesită configurarea securizată a sesiunii.', 503);
  return createHmac('sha256', secret).update(`reaction:${type}:${id}:${req.session.csrfToken}`).digest('hex');
}

function applyReaction(item, fingerprint, choice) {
  if (!['like', 'dislike'].includes(choice)) throw new ValidationError('Reacția selectată nu este validă.');
  item.reactii ||= { like: 0, dislike: 0, voters: {} };
  item.reactii.voters ||= {};
  const previous = item.reactii.voters[fingerprint];
  if (previous === choice) return;
  if (previous) item.reactii[previous] = Math.max(0, Number(item.reactii[previous] || 0) - 1);
  item.reactii[choice] = Number(item.reactii[choice] || 0) + 1;
  item.reactii.voters[fingerprint] = choice;
}

function productionAuth() {
  if (!process.env.SUPABASE_SECRET_KEY) return null;
  return {
    signIn: signInWithPassword,
    createUser: createAuthUserWithPassword,
    deleteUser: deleteAuthUser,
    updatePassword: updateAuthPassword,
    updateEmail: updateAuthEmail,
  };
}

export async function createApp({
  comments = createComments(),
  now = () => Date.now(),
  editorial = createEditorial({ now }),
  compliance = createCompliance({ now }),
  auth = productionAuth(),
} = {}) {
  const sessionSecret = String(process.env.SESSION_SECRET || '').trim();
  const isNetlify = Boolean(
    process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
  );
  if (isNetlify && !sessionSecret) {
    throw new Error('SESSION_SECRET este obligatorie in productie');
  }
  await initDB();
  const platform = platformInfo();
  const isLenauheimCivicPortal = platform.operatorId.includes('44420154');
  const portalEditorialResponsible = process.env.PLATFORM_EDITORIAL_RESPONSIBLE
    || (isLenauheimCivicPortal ? 'Droc Cristian Dan' : platform.operatorName);
  const portalTechnicalProvider = isLenauheimCivicPortal ? 'CristianWeb' : platform.operatorName;
  const electoralMode = isElectoralMode(now());
  const ownerPolls = (role, ownerId = null) => db.data.polls
    .filter(poll => poll.owner_role === role && poll.owner_id === ownerId)
    .sort((a, b) => b.id - a.id);
  const activePoll = (role, ownerId = null) => ownerPolls(role, ownerId).find(poll => poll.active) || null;

  const app = express();
  // Inregistram motorul explicit (in loc sa lasam Express sa faca un require
  // dinamic dupa numele "ejs") - altfel esbuild nu detecteaza dependenta la bundling
  // pe Netlify si arunca "Cannot find module 'ejs'" la runtime.
  app.engine('ejs', ejs.renderFile);
  app.set('view engine', 'ejs');
  app.set('views', path.join(baseDir, 'views'));
  app.set('view cache', isNetlify || process.env.NODE_ENV === 'production');
  // Versiune comprimată a aceleiași fotografii; URL-ul salvat în profil rămâne editabil.
  const originalPortrait = '/candidate-assets/daniel-ganea-20260911.png';
  const optimizedPortrait = '/candidate-assets/daniel-ganea-20260911-v1.webp';
  const optimizedImages = new Map([
    [originalPortrait, optimizedPortrait],
    [`https://vocealenauheim.ro${originalPortrait}`, optimizedPortrait],
    [`https://www.vocealenauheim.ro${originalPortrait}`, optimizedPortrait],
  ]);
  app.locals.publicImageUrl = url => optimizedImages.get(url) || url;
  // O adresă nouă la fiecare modificare CSS evită copiile vechi din cache.
  // public/** este inclus atât în fișierele statice, cât și în funcția Netlify.
  const stylesheetVersion = createHash('sha256')
    .update(await readFile(path.join(baseDir, 'public', 'style.css')))
    .digest('hex').slice(0, 12);
  app.locals.stylesheetUrl = `/style.css?v=${stylesheetVersion}`;
  app.locals.isPublished = article => isPublished(article, now());
  app.locals.publicationDate = publicationDate;
  app.locals.portalPublicationDate = portalPublicationDate;
  app.locals.jsonLd = jsonLd;
  app.locals.displayDate = displayDate;
  app.locals.publicTransparency = publicTransparency;
  app.locals.platform = platform;
  app.locals.portalEditorialResponsible = portalEditorialResponsible;
  app.locals.isLenauheimCivicPortal = isLenauheimCivicPortal;
  app.locals.termsVersion = TERMS_VERSION;
  app.locals.electoralMode = electoralMode;
  app.use(express.static(path.join(baseDir, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
    },
  }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/dashboard/media', express.json({ limit: '4300kb' }));
  app.use('/admin/portal/media', express.json({ limit: '4300kb' }));
  app.use(express.json());

  // Sesiune stocata in cookie semnat (fara memorie pe server) - functioneaza
  // identic local si pe functii serverless (Netlify).
  app.use(
    cookieSession({
      name: 'sesiune',
      // Fallback permis exclusiv pentru development/test; productia este validata la pornire.
      keys: [sessionSecret || 'secret-local-doar-pentru-development'],
      maxAge: 1000 * 60 * 60 * 8, // 8 ore
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
  );

  app.use((req, res, next) => {
    res.locals.userId = req.session.userId || null;
    res.locals.rol = req.session.rol || null;
    res.locals.numeCandidat = req.session.numeCandidat || null;
    res.locals.csrfToken = req.session.csrfToken || '';
    res.locals.pageUrl = `${publicBaseUrl(req)}${req.originalUrl}`;
    if (/^\/(?:admin|dashboard|activare|login|logout|parola-uitata|reseteaza-parola|oauth)(?:\/|$)/i.test(req.path)
      || /^\/raportare\/(?:apa|salubritate)\/?$/i.test(req.path)
      || /^\/site\/[^/]+\/articol\/[^/]+\/raporteaza\/?$/i.test(req.path)) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.set('Cache-Control', 'private, no-store');
      res.set('Netlify-CDN-Cache-Control', 'no-store');
    }
    next();
  });

  function ensureCsrfToken(req, res) {
    req.session.csrfToken ||= randomState();
    res.locals.csrfToken = req.session.csrfToken;
    return req.session.csrfToken;
  }

  function setPublicCdnCache(res, { maxAge = 60, stale = 300 } = {}) {
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.set('Netlify-CDN-Cache-Control', `public, durable, max-age=${maxAge}, stale-while-revalidate=${stale}`);
  }

  app.use((req, res, next) => {
    if (req.method === 'GET' && /^(\/admin|\/dashboard|\/activare)(\/|$)/.test(req.path)) {
      ensureCsrfToken(req, res);
    }
    next();
  });

  function requireCsrf(req, res, next) {
    if (!req.body?.csrf_token || req.body.csrf_token !== req.session.csrfToken) {
      return res.status(403).send('Cererea a expirat sau nu este valida. Reincarca pagina si incearca din nou.');
    }
    next();
  }

  const safely = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  app.use(safely(async (req, res, next) => {
    // După o scriere respinsă recitim datele înaintea verificării drepturilor
    // sau a unei noi modificări. Netlify recitește și între invocări.
    if (db.requiresReload) await initDB();
    next();
  }));
  async function saveVisitStatistics() {
    // O eroare a contorului nu trebuie să blocheze citirea sau linkul social.
    // Așteptăm scrierea și în Lambda; salvările de conținut rămân obligatorii.
    try { await db.write(); }
    catch (error) { console.error('Salvarea statisticilor a eșuat:', error.name); }
  }
  function requireActiveAccount(req, res, next) {
    const user = db.data.users.find(u => u.id === req.session.userId);
    if (!user?.activ || user.role !== req.session.rol || (user.role === 'candidate' && user.status_cont !== 'activ')) {
      return res.status(403).send('Contul nu este activ.');
    }
    next();
  }

  function requestIp(req) {
    return (process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY)
      ? req.get('x-nf-client-connection-ip') || req.socket.remoteAddress || 'unknown'
      : req.socket.remoteAddress || 'unknown';
  }
  function publicArticle(req) {
    const user = db.data.users.find(u => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u));
    const articol = user && db.data.articole.find(a => a.id === Number(req.params.id)
      && a.user_id === user.id && isPublished(a, now()));
    return { user, articol };
  }

  function publicCandidate(subdomeniu) {
    return db.data.users.find(user => user.subdomeniu === subdomeniu && poatePublicaSite(user));
  }

  function publicCandidateArticles(user) {
    return db.data.articole
      .filter(article => article.user_id === user.id && isPublished(article, now()))
      .sort((a, b) => new Date(publicationDate(b)) - new Date(publicationDate(a)));
  }

  function sectionSlugForCategory(category) {
    return SECTIUNI_EDITORIALE.find(section => section.categorie === category)?.slug || '';
  }

  function portalCandidate(post) {
    return post?.candidate_id
      ? db.data.users.find(user => user.id === post.candidate_id && vizibilInPortal(user))
      : null;
  }

  function portalPostIsPublic(post) {
    return isPortalPublished(post) && (post.tip !== 'campanie' || portalCandidate(post));
  }

  function uniquePortalSlug(title, currentId = null) {
    const base = slugify(title) || `material-${currentId || db.data.nextPortalPostId}`;
    let value = base;
    let index = 2;
    while (db.data.portal_posts.some(post => post.slug === value && post.id !== currentId)) {
      value = `${base}-${index++}`;
    }
    return value;
  }

  /* ---------------------------- AUTENTIFICARE ---------------------------- */

  app.get('/', (req, res) => {
    const candidatiPublici = db.data.users
      .filter(vizibilInPortal)
      .slice(0, 6);
    const portalPosts = db.data.portal_posts
      .filter(portalPostIsPublic)
      .sort((a, b) => Number(b.principal) - Number(a.principal)
        || new Date(portalPublicationDate(b)) - new Date(portalPublicationDate(a)));
    const withCandidate = post => ({ ...post, candidat: portalCandidate(post) });
    const mainPost = portalPosts[0] || null;
    const portalOwner = db.data.users.find(user => user.role === 'admin');
    const sondaj = activePoll('admin');
    if (sondaj) {
      ensureCsrfToken(req, res);
      res.set('Cache-Control', 'private, no-store');
    } else {
      setPublicCdnCache(res);
    }
    res.render('landing', {
      seo: portalPageSeo(publicBaseUrl(req)),
      candidatiPublici,
      principal: mainPost ? withCandidate(mainPost) : null,
      stiri: portalPosts.filter(post => post.tip === 'stire' && post.id !== mainPost?.id).slice(0, 6).map(withCandidate),
      campanii: portalPosts.filter(post => post.tip === 'campanie' && post.id !== mainPost?.id).slice(0, 6).map(withCandidate),
      sondaj,
      portalOwner,
    });
  });

  function escapeXml(text) {
    return String(text ?? '').replace(/[<>&'"]/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c]));
  }

  app.get('/robots.txt', (req, res) => {
    res.set('Content-Type', 'text/plain').set('Cache-Control', 'public, max-age=3600').send(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /dashboard\n\nSitemap: ${publicBaseUrl(req)}/sitemap.xml\n`
    );
  });

  app.get('/sitemap.xml', (req, res) => {
    const baza = publicBaseUrl(req);
    const candidati = db.data.users.filter(vizibilInPortal);
    const urlIntrari = ['/', '/candidati', ...Object.keys(PORTAL_SECTIONS).map(slug => `/sectiune/${slug}`),
      '/statistici/apa', '/statistici/salubritate'].map(route => ({ url: `${baza}${route}` }));
    for (const post of db.data.portal_posts.filter(portalPostIsPublic)) {
      urlIntrari.push({ url: `${baza}/actualitate/${encodeURIComponent(post.slug)}`,
        lastmod: seoDate(post.updated_at || portalPublicationDate(post)) });
    }
    for (const candidat of candidati) {
      const bazaCandidat = `${baza}/site/${encodeURIComponent(candidat.subdomeniu)}`;
      urlIntrari.push(...[bazaCandidat, `${bazaCandidat}/despre`, `${bazaCandidat}/contact`].map(url => ({ url })));
      for (const articol of publicCandidateArticles(candidat)) {
        urlIntrari.push({ url: `${bazaCandidat}/articol/${articol.id}`,
          lastmod: seoDate(articol.updated_at || publicationDate(articol)) });
      }
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urlIntrari.map(({ url, lastmod }) => `  <url><loc>${escapeXml(url)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('\n')
    }\n</urlset>`;
    res.set('Content-Type', 'application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
  });

  app.get('/site/:subdomeniu/rss.xml', (req, res) => {
    const user = publicCandidate(req.params.subdomeniu);
    if (!user) return res.status(404).send('Pagina nu exista.');
    const baza = publicBaseUrl(req);
    const bazaCandidat = `${baza}/site/${encodeURIComponent(user.subdomeniu)}`;
    const articole = publicCandidateArticles(user).slice(0, 30);
    const itemsXml = articole.map((articol) => `  <item>
    <title>${escapeXml(articol.titlu)}</title>
    <link>${escapeXml(`${bazaCandidat}/articol/${articol.id}`)}</link>
    <guid isPermaLink="true">${escapeXml(`${bazaCandidat}/articol/${articol.id}`)}</guid>
    <pubDate>${new Date(publicationDate(articol)).toUTCString()}</pubDate>
    <description>${escapeXml(articol.continut.slice(0, 400))}</description>
  </item>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n  <title>${
      escapeXml(user.nume_candidat)
    }</title>\n  <link>${escapeXml(bazaCandidat)}</link>\n  <description>${
      escapeXml(user.mesaj_scurt || user.slogan || user.nume_candidat)
    }</description>\n  <language>ro-ro</language>\n${itemsXml}\n</channel></rss>`;
    res.set('Content-Type', 'application/rss+xml').set('Cache-Control', 'public, max-age=900').send(xml);
  });

  app.get('/candidati', (req, res) => {
    const all = db.data.users.filter(vizibilInPortal).sort((a, b) => String(a.nume_candidat).localeCompare(String(b.nume_candidat), 'ro'));
    const judet = textField(req.query.judet, 'Județ', 100).toLowerCase();
    const functie = textField(req.query.functie, 'Funcție', 100).toLowerCase();
    const cauta = textField(req.query.cauta, 'Căutare', 120).toLowerCase();
    const filtered = all.filter(candidate => (!judet || String(candidate.judet).toLowerCase() === judet)
      && (!functie || String(candidate.functie_candidatura).toLowerCase().includes(functie))
      && (!cauta || `${candidate.nume_candidat} ${candidate.zona} ${candidate.partid}`.toLowerCase().includes(cauta)));
    const pages = Math.max(1, Math.ceil(filtered.length / 12));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.pagina, 10) || 1));
    setPublicCdnCache(res);
    const canonicalQuery = new URLSearchParams();
    for (const [key, value] of [['cauta', cauta], ['judet', judet], ['functie', functie]]) {
      if (value) canonicalQuery.set(key, value);
    }
    if (page > 1) canonicalQuery.set('pagina', String(page));
    const hasFilters = Boolean(cauta || judet || functie);
    if (hasFilters) res.set('X-Robots-Tag', 'noindex, follow');
    res.render('candidate-showcase', { candidati: filtered.slice((page - 1) * 12, page * 12), total: filtered.length, page, pages,
      seo: portalPageSeo(publicBaseUrl(req), { path: `/candidati${canonicalQuery.size ? `?${canonicalQuery}` : ''}`,
        title: `Candidați și publicații locale${page > 1 ? ` — pagina ${page}` : ''} — ${PORTAL_SITE_NAME}`,
        description: 'Descoperă candidații activi, proiectele și publicațiile lor. Filtrează după nume, județ sau funcție.', noindex: hasFilters }),
      judet: req.query.judet || '', functie: req.query.functie || '', cauta: req.query.cauta || '',
      judete: [...new Set(all.map(candidate => candidate.judet).filter(Boolean))].sort() });
  });

  app.get('/sectiune/:slug', (req, res) => {
    const section = PORTAL_SECTIONS[req.params.slug];
    if (!section) return res.status(404).send('Secțiunea nu există.');
    const posts = db.data.portal_posts.filter(post => portalPostIsPublic(post)
      && (req.params.slug === 'stiri' ? post.tip === 'stire' : section.categorii.includes(post.categorie)))
      .sort((a, b) => new Date(portalPublicationDate(b)) - new Date(portalPublicationDate(a)));
    setPublicCdnCache(res);
    res.render('portal-section-public', { section, posts,
      seo: portalPageSeo(publicBaseUrl(req), { path: `/sectiune/${req.params.slug}`,
        title: `${section.titlu} — ${PORTAL_SITE_NAME}`,
        description: `${section.descriere} Bulgăruș, Lenauheim și Grabaț, județul Timiș.` }) });
  });

  app.post('/sondaje/:id/vot', requireCsrf, safely(async (req, res) => {
    const poll = db.data.polls.find(item => item.id === Number(req.params.id) && item.active);
    if (!poll) throw new ValidationError('Sondajul nu mai este activ.', 404);
    const option = poll.options.find(item => item.id === Number(req.body.optiune));
    if (!option) throw new ValidationError('Alege una dintre opțiunile sondajului.');
    const pollSecret = process.env.SESSION_SECRET;
    if (!pollSecret || pollSecret.length < 32) throw new ValidationError('Sondajele necesită SESSION_SECRET configurat securizat.', 503);
    const fingerprint = createHmac('sha256', pollSecret)
      .update(`poll:${poll.id}:${req.session.csrfToken}`).digest('hex');
    poll.voters ||= [];
    if (poll.voters.includes(fingerprint)) throw new ValidationError('Ai votat deja în acest sondaj.', 409);
    poll.voters.push(fingerprint);
    option.votes += 1;
    await db.write();
    const candidate = poll.owner_role === 'candidate' && db.data.users.find(user => user.id === poll.owner_id);
    res.redirect(303, candidate ? `/site/${candidate.subdomeniu}?sondaj=votat#sondaj` : '/?sondaj=votat#sondaj');
  }));

  app.get('/actualitate/:slug', safely(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    ensureCsrfToken(req, res);
    const post = db.data.portal_posts.find(item => item.slug === req.params.slug && portalPostIsPublic(item));
    if (!post) return res.status(404).send('Materialul nu există.');
    post.vizualizari = (post.vizualizari || 0) + 1;
    await saveVisitStatistics();
    res.render('portal-post', { post, candidat: portalCandidate(post), postUrl: `${publicBaseUrl(req)}/actualitate/${encodeURIComponent(post.slug)}`,
      seo: portalArticleSeo(publicBaseUrl(req), post) });
  }));

  app.post('/actualitate/:slug/reactie', requireCsrf, safely(async (req, res) => {
    const post = db.data.portal_posts.find(item => item.slug === req.params.slug && portalPostIsPublic(item));
    if (!post) throw new ValidationError('Materialul nu există.', 404);
    applyReaction(post, reactionFingerprint(req, 'portal', post.id), String(req.body.reactie || ''));
    await db.write();
    res.redirect(303, `/actualitate/${post.slug}#reactii`);
  }));

  app.get('/login', (req, res) => {
    res.render('login', { eroare: null, mesaj: req.query.mesaj || null });
  });

  app.get('/parola-uitata', (req, res) => {
    ensureCsrfToken(req, res);
    res.render('parola-uitata', { trimis: false });
  });

  app.post('/parola-uitata', safely(async (req, res) => {
    if (!req.body?.csrf_token || req.body.csrf_token !== req.session.csrfToken) {
      throw new ValidationError('Cererea a expirat. Reîncarcă pagina și încearcă din nou.', 403);
    }
    const acumMs = Date.now();
    if (req.session.ultimaCerereResetare && acumMs - req.session.ultimaCerereResetare < 60000) {
      throw new ValidationError('Ai cerut deja o resetare recent. Mai așteaptă un minut.', 429);
    }
    req.session.ultimaCerereResetare = acumMs;
    const email = String(req.body.email || '').trim().toLowerCase();
    const admin = db.data.users.find((u) => u.role === 'admin' && u.email.toLowerCase() === email);
    if (admin && mailConfigured()) {
      const tokenBrut = randomBytes(32).toString('hex');
      admin.reset_token_hash = createHash('sha256').update(tokenBrut).digest('hex');
      admin.reset_token_expires = new Date(acumMs + 60 * 60 * 1000).toISOString();
      await db.write();
      const link = `${publicBaseUrl(req)}/reseteaza-parola?token=${tokenBrut}&email=${encodeURIComponent(admin.email)}`;
      await sendMail({
        to: admin.email,
        subject: 'Resetare parolă - Super Admin',
        text: `Ai cerut resetarea parolei. Link valabil o oră: ${link}\n\nDacă nu ai cerut tu asta, ignoră acest email.`,
        html: `<p>Ai cerut resetarea parolei contului de Super Admin.</p><p><a href="${link}">Setează o parolă nouă</a> (link valabil o oră).</p><p>Dacă nu ai cerut tu asta, ignoră acest email.</p>`,
      }).catch(() => {});
    }
    res.render('parola-uitata', { trimis: true });
  }));

  app.get('/reseteaza-parola', (req, res) => {
    ensureCsrfToken(req, res);
    const email = String(req.query.email || '').trim().toLowerCase();
    const token = String(req.query.token || '');
    const admin = db.data.users.find((u) => u.role === 'admin' && u.email.toLowerCase() === email);
    const valid = Boolean(admin?.reset_token_hash && admin.reset_token_expires && new Date(admin.reset_token_expires) > new Date());
    res.render('reseteaza-parola', { email, token, valid });
  });

  app.post('/reseteaza-parola', safely(async (req, res) => {
    if (!req.body?.csrf_token || req.body.csrf_token !== req.session.csrfToken) {
      throw new ValidationError('Cererea a expirat. Reîncarcă pagina și încearcă din nou.', 403);
    }
    const email = String(req.body.email || '').trim().toLowerCase();
    const token = String(req.body.token || '');
    const admin = db.data.users.find((u) => u.role === 'admin' && u.email.toLowerCase() === email);
    const tokenValid = admin?.reset_token_hash && token
      && admin.reset_token_hash.length === createHash('sha256').update(token).digest('hex').length
      && timingSafeEqual(Buffer.from(admin.reset_token_hash), Buffer.from(createHash('sha256').update(token).digest('hex')));
    const neexpirat = admin?.reset_token_expires && new Date(admin.reset_token_expires) > new Date();
    if (!admin || !tokenValid || !neexpirat) {
      return res.render('reseteaza-parola', { email, token, valid: false });
    }
    const parolaNoua = String(req.body.parola_noua || '');
    if (parolaNoua.length < 12 || parolaNoua !== String(req.body.confirma_parola || '')) {
      throw new ValidationError('Parola nouă trebuie să aibă minimum 12 caractere și să fie confirmată.');
    }
    if (auth && admin.auth_user_id) await auth.updatePassword(admin.auth_user_id, parolaNoua);
    admin.password_hash = bcrypt.hashSync(parolaNoua, 12);
    admin.password_changed_at = new Date().toISOString();
    admin.reset_token_hash = null;
    admin.reset_token_expires = null;
    admin.login_attempts = 0;
    admin.locked_until = null;
    await db.write();
    await compliance.audit({ actorId: admin.id, actorRole: 'admin', action: 'admin_password_reset_via_email',
      targetType: 'admin', targetId: admin.id, details: {} });
    res.redirect('/login?mesaj=Parola%20a%20fost%20resetata.%20Te%20poti%20autentifica.');
  }));

  app.get('/legal/:page', (req, res) => {
    const page = LEGAL_PAGES[req.params.page];
    if (!page) return res.status(404).send('Pagina nu există.');
    setPublicCdnCache(res, { maxAge: 3600, stale: 86400 });
    res.render('legal-page', { page, seo: portalPageSeo(publicBaseUrl(req), {
      path: `/legal/${req.params.page}`, title: `${page.title} — ${PORTAL_SITE_NAME}`, description: page.intro,
    }) });
  });

  app.get('/raportare/:tip(apa|salubritate)', (req, res) => {
    ensureCsrfToken(req, res);
    res.set('Cache-Control', 'private, no-store');
    res.render('raportare-costuri', { tip: req.params.tip, localitati: LOCALITATI, eroare: null, trimis: false });
  });

  app.post('/raportare/:tip(apa|salubritate)', safely(async (req, res) => {
    if (!req.body?.csrf_token || req.body.csrf_token !== req.session.csrfToken) {
      throw new ValidationError('Cererea a expirat. Reîncarcă pagina și încearcă din nou.', 403);
    }
    const acumMs = Date.now();
    if (req.session.ultimaRaportareCosturi && acumMs - req.session.ultimaRaportareCosturi < 30000) {
      throw new ValidationError('Ai trimis deja o raportare recent. Mai așteaptă puțin.', 429);
    }
    const ipHash = createHmac('sha256', sessionSecret || 'secret-local-doar-pentru-development')
      .update(`raportare-costuri-ip-v1:${requestIp(req)}`).digest('hex');
    const auAnonimizat = purjeazaRaportariExpirate(db, acumMs);
    if (limitaRaportariDepasita(db.data.raportari_costuri, req.params.tip, ipHash, acumMs)) {
      if (auAnonimizat) await db.write();
      throw new ValidationError(`Ai trimis deja numărul maxim de ${MAX_RAPORTARI_PER_IP} raportări pentru acest serviciu în ultimele ${RETENTION_DAYS} de zile.`, 429);
    }
    let fields;
    try {
      fields = raportareInput(req.body, req.params.tip);
    } catch (error) {
      if (error instanceof ValidationError) {
        return res.status(error.status).render('raportare-costuri', {
          tip: req.params.tip, localitati: LOCALITATI, eroare: error.message, trimis: false,
        });
      }
      throw error;
    }
    fields.created_at = new Date(acumMs).toISOString();
    fields.ip_hash = ipHash;
    if (req.body.acord_dispozitiv === 'on' || req.body.acord_dispozitiv === true) {
      fields.dispozitiv = descriereDispozitiv(req.get('user-agent'));
      fields.dispozitiv_acord_at = fields.created_at;
    } else {
      fields.dispozitiv = '';
      fields.dispozitiv_acord_at = null;
    }
    fields.id = db.data.nextRaportareId++;
    db.data.raportari_costuri.push(fields);
    await db.write();
    req.session.ultimaRaportareCosturi = acumMs;
    res.render('raportare-costuri', { tip: req.params.tip, localitati: LOCALITATI, eroare: null, trimis: true });
  }));

  app.get('/statistici/:tip(apa|salubritate)', safely(async (req, res) => {
    const auPurjat = purjeazaRaportariExpirate(db, Date.now());
    if (auPurjat) await db.write();
    // Statisticile se schimba la fiecare raportare si trebuie sa afiseze
    // inclusiv primul raspuns imediat, fara o versiune veche din CDN.
    res.set('Cache-Control', 'no-store');
    res.set('Netlify-CDN-Cache-Control', 'no-store');
    res.render('statistici-costuri', {
      seo: portalPageSeo(publicBaseUrl(req), { path: `/statistici/${req.params.tip}`,
        title: `Cât plătim pentru ${req.params.tip === 'apa' ? 'apă' : 'salubritate'}? — ${PORTAL_SITE_NAME}`,
        description: `Compară costurile pentru ${req.params.tip === 'apa' ? 'apă' : 'salubritate'} declarate voluntar în Bulgăruș, Lenauheim și Grabaț. Rezultate publicate pe intervale, fără nume.` }),
      tip: req.params.tip,
      grupuri: statisticiPublice(db.data.raportari_costuri, req.params.tip, db.data.raportari_costuri_arhiva),
      total: totalPublic(db.data.raportari_costuri, req.params.tip, db.data.raportari_costuri_arhiva),
    });
  }));

  app.get('/admin/raportari-costuri', requireRole('admin'), requireActiveAccount, safely(async (req, res) => {
    const auPurjat = purjeazaRaportariExpirate(db, Date.now());
    if (auPurjat) await db.write();
    const tip = ['apa', 'salubritate'].includes(req.query.tip) ? req.query.tip : 'apa';
    const lista = db.data.raportari_costuri
      .filter((r) => r.tip === tip)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.render('admin-raportari-costuri', {
      tip, lista, retentionDays: RETENTION_DAYS, localitati: LOCALITATI,
      mesaj: req.query.mesaj || '', eroare: req.query.eroare || '',
    });
  }));

  app.post('/admin/raportari-costuri/:id(\\d+)/modifica', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const raportare = db.data.raportari_costuri.find((r) => r.id === Number(req.params.id));
    if (!raportare) return res.redirect('/admin/raportari-costuri?eroare=Raportarea%20nu%20mai%20exista.');
    const inainte = { localitate: raportare.localitate, perioada: raportare.perioada, suma: raportare.suma };
    const fields = moderareRaportareInput(req.body, raportare.tip);
    Object.assign(raportare, fields);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'cost_report_updated',
      targetType: 'cost_report', targetId: raportare.id, details: { inainte, dupa: fields } });
    res.redirect(`/admin/raportari-costuri?tip=${raportare.tip}&mesaj=Raportarea%20a%20fost%20corectata.`);
  }));

  app.post('/admin/raportari-costuri/:id(\\d+)/sterge', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const raportare = db.data.raportari_costuri.find((r) => r.id === Number(req.params.id));
    if (!raportare) return res.redirect('/admin/raportari-costuri?eroare=Raportarea%20nu%20mai%20exista.');
    db.data.raportari_costuri = db.data.raportari_costuri.filter((r) => r.id !== raportare.id);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'cost_report_deleted',
      targetType: 'cost_report', targetId: raportare.id,
      details: { tip: raportare.tip, localitate: raportare.localitate, perioada: raportare.perioada, suma: raportare.suma } });
    res.redirect(`/admin/raportari-costuri?tip=${raportare.tip}&mesaj=Raportarea%20a%20fost%20stearsa.`);
  }));

  app.post('/login', safely(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const parola = String(req.body.parola || '');
    const user = db.data.users.find((u) => u.email.toLowerCase() === email);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return res.render('login', { eroare: 'Cont blocat temporar după prea multe încercări. Încearcă din nou peste 15 minute.', mesaj: null });
    }
    const contPermis = user?.role === 'admin'
      ? user.activ
      : user?.role === 'candidate' && ['in_asteptare', 'activ'].includes(user.status_cont);
    let parolaValida = false;
    if (user && contPermis) {
      if (auth && user.auth_user_id) {
        try {
          const result = await auth.signIn(email, parola);
          parolaValida = result?.user?.id === user.auth_user_id;
        } catch {
          parolaValida = false;
        }
      } else if (!auth) {
        parolaValida = bcrypt.compareSync(parola, user.password_hash);
      }
    }
    if (!user || !contPermis || !parolaValida) {
      if (user) {
        user.login_attempts = (user.login_attempts || 0) + 1;
        if (user.login_attempts >= 5) {
          user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          user.login_attempts = 0;
        }
        await db.write();
      }
      return res.render('login', { eroare: 'Email sau parola incorecte.', mesaj: null });
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
  }));

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
      sondaje: ownerPolls('admin'),
      user: db.data.users.find((u) => u.id === req.session.userId && u.role === 'admin'),
    });
  });

  app.post('/admin/sondaje', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const fields = pollInput(req.body);
    db.data.polls.forEach(poll => { if (poll.owner_role === 'admin') poll.active = false; });
    db.data.polls.push({ id: db.data.nextPollId++, owner_role: 'admin', owner_id: null, ...fields,
      active: true, show_results: req.body.rezultate_publice === 'on', voters: [], created_at: new Date().toISOString() });
    await db.write();
    res.redirect('/admin?mesaj=Sondajul%20paginii%20principale%20a%20fost%20publicat.');
  }));

  const portalCandidates = () => db.data.users
    .filter(user => user.role === 'candidate')
    .sort((a, b) => String(a.nume_candidat || '').localeCompare(String(b.nume_candidat || ''), 'ro'));

  function renderPortalForm(res, { post = null, eroare = '', status = 200 } = {}) {
    return res.status(status).render('admin-portal-form', {
      post,
      eroare,
      candidati: portalCandidates(),
      categoriiPortal: [...Object.values(PORTAL_SECTIONS).flatMap(sectiune => sectiune.categorii).filter(Boolean), 'Campanie'],
    });
  }

  async function validatePortalPost(req, res, previous = null) {
    try {
      const fields = portalPostInput(req.body, previous, now());
      const candidate = fields.candidate_id
        ? db.data.users.find(user => user.id === fields.candidate_id && user.role === 'candidate')
        : null;
      if (fields.tip === 'campanie' && !candidate) throw new ValidationError('Candidatul selectat nu există.');
      if (fields.status === 'publicat' && !platform.complete) {
        throw new ValidationError('Publicarea este blocată până la configurarea completă a datelor juridice ale operatorului.');
      }
      if (fields.status === 'publicat' && fields.tip === 'campanie') {
        if (!poatePublicaSite(candidate)) throw new ValidationError('Campania poate fi publicată numai pentru un candidat activ cu site public.');
        if (!vizibilInPortal(candidate)) throw new ValidationError('Candidatul este ascuns din Vocea Locală. Activează afișarea în portal înainte de publicarea unui material asociat.');
        const missing = candidateComplianceMissing(candidate, platform);
        if (missing.length) throw new ValidationError(`Publicarea campaniei este blocată. Lipsesc: ${missing.join(', ')}.`);
      }
      const imageId = internalImageId(fields.imagine_url);
      if (imageId) {
        const image = await editorial.media(imageId);
        if (!image || image.userId !== req.session.userId) {
          throw new ValidationError('Imaginea nu aparține contului Super Admin sau nu mai este disponibilă.');
        }
        fields.imagine_generata_ai = image.generated || fields.imagine_generata_ai;
      }
      const recordedAt = new Date(now()).toISOString();
      fields.transparenta = fields.tip === 'campanie'
        ? { ...transparencySnapshot(candidate, recordedAt), finantat_de: fields.finantator }
        : {
          material: 'stire_platforma',
          publicat_de: platform.name,
          responsabil_editorial: portalEditorialResponsible,
          finantat_de: isLenauheimCivicPortal ? 'Inițiativă civică personală' : platform.operatorName,
          furnizor_tehnic: portalTechnicalProvider,
          serviciu_tehnic: isLenauheimCivicPortal
            ? 'Livrat gratuit persoanei fizice Droc Cristian Dan' : '',
          recorded_at: recordedAt,
        };
      return fields;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const form = Object.fromEntries([
        'titlu', 'rezumat', 'continut', 'tip', 'categorie', 'finantator', 'imagine_url',
        'imagine_alt', 'imagine_legenda', 'imagine_credit',
      ].map(key => [key, typeof req.body[key] === 'string' ? req.body[key] : '']));
      form.id = previous?.id;
      form.slug = previous?.slug;
      form.candidate_id = Number(req.body.candidate_id) || null;
      form.status = typeof req.body.status === 'string' ? req.body.status : 'ciorna';
      form.principal = req.body.principal === 'on';
      form.generat_de_ai = req.body.generat_de_ai === 'true';
      form.imagine_generata_ai = req.body.imagine_generata_ai === 'true';
      renderPortalForm(res, { post: form, eroare: error.message, status: error.status || 400 });
      return null;
    }
  }

  app.get('/admin/portal', requireRole('admin'), requireActiveAccount, (req, res) => {
    const posts = db.data.portal_posts
      .map(post => ({ ...post, candidat: portalCandidates().find(candidate => candidate.id === post.candidate_id) }))
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    res.render('admin-portal', {
      posts,
      sumar: {
        total: posts.length,
        publicate: posts.filter(post => post.status === 'publicat').length,
        ciorne: posts.filter(post => post.status === 'ciorna').length,
        citiri: posts.reduce((total, post) => total + (post.vizualizari || 0), 0),
      },
      mesaj: req.query.mesaj || '',
    });
  });

  app.get('/admin/portal/nou', requireRole('admin'), requireActiveAccount, (req, res) => {
    renderPortalForm(res);
  });

  app.get('/admin/portal/:id(\\d+)/edit', requireRole('admin'), requireActiveAccount, (req, res) => {
    const post = db.data.portal_posts.find(item => item.id === Number(req.params.id));
    if (!post) return res.redirect('/admin/portal');
    renderPortalForm(res, { post });
  });

  app.post('/admin/portal', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const fields = await validatePortalPost(req, res);
    if (!fields) return;
    const id = nextPortalPostId();
    const post = {
      id,
      slug: uniquePortalSlug(fields.titlu, id),
      ...fields,
      vizualizari: 0,
      created_at: new Date(now()).toISOString(),
    };
    if (post.principal && post.status === 'publicat') db.data.portal_posts.forEach(item => { item.principal = false; });
    db.data.portal_posts.push(post);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'portal_post_created',
      targetType: 'portal_post', targetId: post.id, details: { type: post.tip, status: post.status, title: post.titlu } });
    res.redirect('/admin/portal?mesaj=Materialul%20a%20fost%20salvat.');
  }));

  app.post('/admin/portal/:id(\\d+)', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const post = db.data.portal_posts.find(item => item.id === Number(req.params.id));
    if (!post) return res.redirect('/admin/portal');
    const fields = await validatePortalPost(req, res, post);
    if (!fields) return;
    if (fields.principal && fields.status === 'publicat') {
      db.data.portal_posts.forEach(item => { item.principal = item.id === post.id; });
    }
    Object.assign(post, fields);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'portal_post_updated',
      targetType: 'portal_post', targetId: post.id, details: { type: post.tip, status: post.status, title: post.titlu } });
    res.redirect('/admin/portal?mesaj=Materialul%20a%20fost%20actualizat.');
  }));

  app.post('/admin/portal/:id(\\d+)/sterge', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const post = db.data.portal_posts.find(item => item.id === Number(req.params.id));
    if (!post) return res.redirect('/admin/portal');
    db.data.portal_posts = db.data.portal_posts.filter(item => item.id !== post.id);
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'portal_post_deleted',
      targetType: 'portal_post', targetId: post.id, details: { type: post.tip, title: post.titlu } });
    res.redirect('/admin/portal?mesaj=Materialul%20a%20fost%20sters.');
  }));

  const adminJson = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const known = error instanceof ValidationError;
      res.status(known ? error.status : 503).json({
        eroare: known ? error.message : 'Operațiunea nu a putut fi salvată. Nu a fost publicat nimic.',
      });
    }
  };

  app.get('/admin/portal/ai/config', requireRole('admin'), requireActiveAccount, (req, res) => res.json(editorial.config()));
  app.post('/admin/portal/genereaza-ai', requireRole('admin'), requireActiveAccount, requireCsrf,
    adminJson(async (req, res) => res.status(202).json(await editorial.start(req.session.userId, req.body))));
  app.post('/admin/portal/ai/:id/status', requireRole('admin'), requireActiveAccount, requireCsrf,
    adminJson(async (req, res) => res.json(await editorial.status(req.session.userId, req.params.id))));
  app.post('/admin/portal/media', requireRole('admin'), requireActiveAccount, requireCsrf, adminJson(async (req, res) => {
    if (req.body.acord_imagine !== true) throw new ValidationError('Confirmă dreptul de utilizare a imaginii.');
    res.status(201).json(await editorial.upload(req.session.userId, req.body.base64));
  }));

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
    const legal = legalProfileInput(req.body, electoralMode);
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
      vizibil_in_portal: false,
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
    let authUser;
    if (auth) {
      authUser = await auth.createUser(candidate, parola);
      candidate.auth_user_id = authUser.id;
    }
    db.data.users.push(candidate);
    try {
      await db.write();
    } catch (error) {
      db.data.users = db.data.users.filter(user => user.id !== candidate.id);
      if (authUser) await auth.deleteUser(authUser.id).catch(() => {});
      throw error;
    }
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_created',
      targetType: 'candidate', targetId: candidate.id, details: { contract_type: legal.tip_contract, contract_number: legal.numar_contract } });
    res.status(201).render('candidate-created', { candidate, parola });
  }));

  app.post('/admin/securitate', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const admin = db.data.users.find((u) => u.id === req.session.userId && u.role === 'admin');
    const parolaActuala = String(req.body.parola_actuala || '');
    const parolaNoua = String(req.body.parola_noua || '');
    let parolaActualaValida = false;
    if (admin) {
      if (auth && admin.auth_user_id) {
        try {
          const result = await auth.signIn(admin.email, parolaActuala);
          parolaActualaValida = result?.user?.id === admin.auth_user_id;
        } catch {
          parolaActualaValida = false;
        }
      } else if (!auth) {
        parolaActualaValida = bcrypt.compareSync(parolaActuala, admin.password_hash);
      }
    }
    if (!admin || !parolaActualaValida) {
      return res.redirect('/admin?eroare=Parola%20actuala%20nu%20este%20corecta.');
    }
    if (parolaNoua.length < 12 || parolaNoua !== String(req.body.confirma_parola || '')) {
      return res.redirect('/admin?eroare=Parola%20noua%20trebuie%20sa%20aiba%20minimum%2012%20caractere%20si%20sa%20fie%20confirmata.');
    }
    if (auth) await auth.updatePassword(admin.auth_user_id, parolaNoua);
    admin.password_hash = bcrypt.hashSync(parolaNoua, 12);
    admin.password_changed_at = new Date().toISOString();
    await db.write();
    res.redirect('/admin?mesaj=Parola%20Super%20Adminului%20a%20fost%20schimbata.');
  }));

  app.post('/admin/email', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const admin = db.data.users.find((u) => u.id === req.session.userId && u.role === 'admin');
    if (!admin) return res.redirect('/admin?eroare=Cont%20invalid.');
    const parolaActuala = String(req.body.parola_actuala || '');
    let parolaActualaValida = false;
    if (auth && admin.auth_user_id) {
      try {
        const result = await auth.signIn(admin.email, parolaActuala);
        parolaActualaValida = result?.user?.id === admin.auth_user_id;
      } catch {
        parolaActualaValida = false;
      }
    } else if (!auth) {
      parolaActualaValida = bcrypt.compareSync(parolaActuala, admin.password_hash);
    }
    if (!parolaActualaValida) {
      return res.redirect('/admin?eroare=Parola%20actuala%20nu%20este%20corecta.');
    }
    const emailNou = String(req.body.email_nou || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNou)) {
      return res.redirect('/admin?eroare=Adresa%20de%20email%20nu%20este%20valida.');
    }
    if (db.data.users.some((u) => u.id !== admin.id && u.email.toLowerCase() === emailNou)) {
      return res.redirect('/admin?eroare=Acest%20email%20este%20deja%20folosit.');
    }
    if (auth && admin.auth_user_id) await auth.updateEmail(admin.auth_user_id, emailNou);
    admin.email = emailNou;
    await db.write();
    await compliance.audit({ actorId: admin.id, actorRole: 'admin', action: 'admin_email_changed',
      targetType: 'admin', targetId: admin.id, details: {} });
    res.redirect('/admin?mesaj=Emailul%20de%20logare%20a%20fost%20schimbat.');
  }));

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

  app.post('/admin/candidati/:id/vizibilitate', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const candidate = db.data.users.find(user => user.id === Number(req.params.id) && user.role === 'candidate');
    if (!candidate) throw new ValidationError('Candidatul nu există.', 404);
    if (!['da', 'nu'].includes(req.body.vizibil_in_portal)) throw new ValidationError('Alege dacă afișezi candidatul în portal.');
    const visible = req.body.vizibil_in_portal === 'da';
    if (visible && !poatePublicaSite(candidate)) {
      throw new ValidationError('Activează contul și modulul site înainte de afișarea în portal.');
    }
    const previous = candidate.vizibil_in_portal !== false;
    candidate.vizibil_in_portal = visible;
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_portal_visibility_changed',
      targetType: 'candidate', targetId: candidate.id, details: { previous, visible } });
    const message = visible ? 'Candidatul este afișat în Vocea Locală.' : 'Candidatul este ascuns din Vocea Locală. Accesul la dashboard rămâne neschimbat.';
    res.redirect(303, `/admin?mesaj=${encodeURIComponent(message)}`);
  }));

  app.post('/admin/candidati/:id/parola', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const candidate = db.data.users.find(user => user.id === Number(req.params.id) && user.role === 'candidate');
    if (!candidate) return res.redirect('/admin?eroare=Contul%20candidatului%20nu%20exista.');
    const password = String(req.body.parola_noua || '');
    if (password.length < 12 || password !== String(req.body.confirma_parola || '')) {
      return res.redirect('/admin?eroare=Parola%20noua%20trebuie%20sa%20aiba%20minimum%2012%20caractere%20si%20sa%20fie%20confirmata.');
    }
    if (auth) await auth.updatePassword(candidate.auth_user_id, password);
    candidate.password_hash = bcrypt.hashSync(password, 12);
    candidate.password_changed_at = new Date().toISOString();
    candidate.login_attempts = 0;
    candidate.locked_until = null;
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_password_changed',
      targetType: 'candidate', targetId: candidate.id });
    res.redirect('/admin?mesaj=Parola%20candidatului%20a%20fost%20schimbata.');
  }));

  app.post('/admin/candidati/:id/recuperare-parola', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const candidate = db.data.users.find(user => user.id === Number(req.params.id) && user.role === 'candidate');
    if (!candidate) return res.redirect('/admin?eroare=Contul%20candidatului%20nu%20exista.');
    const password = generateazaParola();
    if (auth) await auth.updatePassword(candidate.auth_user_id, password);
    candidate.password_hash = bcrypt.hashSync(password, 12);
    candidate.password_changed_at = new Date().toISOString();
    candidate.login_attempts = 0;
    candidate.locked_until = null;
    await db.write();
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_password_recovered',
      targetType: 'candidate', targetId: candidate.id });
    res.status(200).render('candidate-password-reset', { candidate, parola: password });
  }));

  app.post('/admin/candidati/:id/sterge', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const candidate = db.data.users.find(user => user.id === Number(req.params.id) && user.role === 'candidate');
    if (!candidate) return res.redirect('/admin?eroare=Contul%20candidatului%20nu%20exista.');
    if (String(req.body.confirma_email || '').trim().toLowerCase() !== candidate.email.toLowerCase()) {
      return res.redirect('/admin?eroare=Pentru%20stergere%20scrie%20exact%20emailul%20candidatului.');
    }
    const previous = structuredClone(db.data);
    db.data.users = db.data.users.filter(user => user.id !== candidate.id);
    db.data.articole = db.data.articole.filter(article => article.user_id !== candidate.id);
    db.data.portal_posts = db.data.portal_posts.filter(post => post.candidate_id !== candidate.id);
    db.data.polls = db.data.polls.filter(poll => poll.owner_role !== 'candidate' || poll.owner_id !== candidate.id);
    await db.write();
    try {
      if (auth && candidate.auth_user_id) await auth.deleteUser(candidate.auth_user_id);
    } catch (error) {
      db.data = previous;
      await db.write();
      throw error;
    }
    await Promise.allSettled([
      comments.purgeCandidate?.(candidate.id),
      compliance.purgeCandidate?.(candidate.id),
      editorial.purgeUser?.(candidate.id),
    ]);
    await compliance.audit({ actorId: req.session.userId, actorRole: 'admin', action: 'candidate_deleted',
      targetType: 'candidate', targetId: candidate.id, details: { auth_deleted: Boolean(candidate.auth_user_id) } });
    res.redirect('/admin?mesaj=Contul%20candidatului%20si%20materialele%20sale%20au%20fost%20sterse.');
  }));

  app.post('/admin/candidati/:id/configurare', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((u) => u.id === Number(req.params.id));
    if (user?.role === 'candidate') {
      const before = Object.fromEntries(ACCEPTANCE_FIELDS.map(field => [field, user[field]]));
      user.functie_candidatura = String(req.body.functie_candidatura || '').trim();
      user.zona = String(req.body.zona || '').trim();
      user.judet = String(req.body.judet || '').trim();
      user.partid = String(req.body.partid || '').trim();
      Object.assign(user, legalProfileInput({ ...user, ...req.body }, electoralMode));
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

  app.get('/dashboard/comentarii', requireRole('candidate'), requireActiveAccount, safely(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'in_asteptare';
    if (!COMMENT_STATUS.has(status)) throw new ValidationError('Filtru de moderare invalid.');
    const all = (await comments.list()).filter(c => c.user_id === req.session.userId);
    const total = all.filter(c => c.status === status).length;
    const pages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.pagina, 10) || 1));
    const lista = all.filter(c => c.status === status).slice((page - 1) * 25, page * 25).map(c => {
      const articol = db.data.articole.find(a => a.id === c.articol_id && a.user_id === req.session.userId);
      return { ...c, articol };
    });
    res.render('candidate-comments', { lista, status, page, pages, total,
      counts: Object.fromEntries([...COMMENT_STATUS].map(s => [s, all.filter(c => c.status === s).length])) });
  }));

  app.post('/dashboard/comentarii/:articleId/:id', requireRole('candidate'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const articleId = Number(req.params.articleId);
    if (!Number.isSafeInteger(articleId) || articleId <= 0) throw new ValidationError('Identificator invalid.');
    const articolPropriu = db.data.articole.find(a => a.id === articleId && a.user_id === req.session.userId);
    if (!articolPropriu) throw new ValidationError('Acest articol nu iti apartine.', 403);
    await comments.moderate({ candidateId: req.session.userId, articleId, id: req.params.id, status: req.body.status,
      adminId: req.session.userId, version: req.body.version });
    res.redirect(303, '/dashboard/comentarii');
  }));

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
    const toateArticolele = db.data.articole
      .filter((a) => a.user_id === req.session.userId)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const categoriiDashboard = [...new Set(toateArticolele.map(article => article.categorie || 'Actualitate'))].sort();
    const categorieFiltru = categoriiDashboard.includes(req.query.categorie) ? req.query.categorie : '';
    const statusFiltru = STATUS_DASHBOARD.has(req.query.status) ? req.query.status : '';
    const statusArticol = article => article.moderation_status === 'suspendat'
      ? 'suspendat' : (isPublished(article, now()) ? 'publicat' : article.status);
    const articole = toateArticolele.filter(article =>
      (!categorieFiltru || article.categorie === categorieFiltru)
      && (!statusFiltru || statusArticol(article) === statusFiltru));
    const totalCitiri = toateArticolele.reduce((total, articol) => total + (articol.vizualizari || 0), 0);
    const topArticole = [...toateArticolele]
      .filter((articol) => isPublished(articol, now()))
      .sort((a, b) => (b.vizualizari || 0) - (a.vizualizari || 0))
      .slice(0, 5);
    const sectiuniEditoriale = SECTIUNI_EDITORIALE.map(section => ({
      ...section,
      total: toateArticolele.filter(article => article.categorie === section.categorie).length,
      publicate: toateArticolele.filter(article => article.categorie === section.categorie && isPublished(article, now())).length,
    }));
    res.render('candidate-dashboard', { articole, user, totalCitiri, topArticole, sectiuniEditoriale,
      categoriiDashboard, categorieFiltru, statusFiltru, rezultatTotal: articole.length,
      totalArticole: toateArticolele.length,
      lipsuriJuridice: candidateComplianceMissing(user, platform), sondaje: ownerPolls('candidate', user.id),
      mesaj: req.query.mesaj || '', eroare: req.query.eroare || '' });
  });

  app.post('/dashboard/sondaje', requireRole('candidate'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const fields = pollInput(req.body);
    db.data.polls.forEach(poll => { if (poll.owner_role === 'candidate' && poll.owner_id === req.session.userId) poll.active = false; });
    db.data.polls.push({ id: db.data.nextPollId++, owner_role: 'candidate', owner_id: req.session.userId, ...fields,
      active: true, show_results: req.body.rezultate_publice === 'on', voters: [], created_at: new Date().toISOString() });
    await db.write();
    res.redirect('/dashboard?mesaj=Sondajul%20a%20fost%20publicat.');
  }));

  app.post('/sondaje/:id/stare', requireCsrf, safely(async (req, res) => {
    const poll = db.data.polls.find(item => item.id === Number(req.params.id));
    const sessionCandidate = db.data.users.find(user => user.id === req.session.userId && poatePublicaSite(user));
    const owns = req.session.rol === 'admin' ? poll?.owner_role === 'admin'
      : req.session.rol === 'candidate' && sessionCandidate && poll?.owner_role === 'candidate' && poll.owner_id === req.session.userId;
    if (!owns) return res.status(403).send('Acces interzis.');
    poll.active = req.body.active === 'true';
    if (poll.active) db.data.polls.forEach(item => { if (item.id !== poll.id && item.owner_role === poll.owner_role && item.owner_id === poll.owner_id) item.active = false; });
    await db.write();
    res.redirect(req.session.rol === 'admin' ? '/admin' : '/dashboard');
  }));

  app.get('/admin/social', requireRole('admin'), requireActiveAccount, (req, res) => {
    const user = db.data.users.find((item) => item.id === req.session.userId);
    const posts = db.data.portal_posts.filter(portalPostIsPublic)
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    res.render('admin-social-center', { user, posts, metaEsteConfigurat: metaConfigured(),
      tiktokEsteConfigurat: tiktokConfigured(), mesaj: req.query.mesaj || '', eroare: req.query.eroare || '' });
  });

  app.get('/admin/social/meta/conecteaza', requireRole('admin'), requireActiveAccount, (req, res) => {
    if (!metaConfigured()) return res.redirect('/admin/social?eroare=Integrarea%20Meta%20nu%20este%20inca%20configurata.');
    const state = randomState();
    req.session.oauth = { provider: 'meta-admin', state, expires: Date.now() + 10 * 60 * 1000 };
    const redirectUri = `${publicBaseUrl(req)}/oauth/meta/admin/callback`;
    res.redirect(metaAuthorizeUrl(redirectUri, state));
  });

  app.get('/oauth/meta/admin/callback', requireRole('admin'), requireActiveAccount, async (req, res) => {
    const oauth = req.session.oauth;
    req.session.oauth = null;
    if (!oauth || oauth.provider !== 'meta-admin' || oauth.state !== req.query.state || oauth.expires < Date.now()) return res.redirect('/admin/social?eroare=Sesiunea%20Meta%20a%20expirat.');
    if (req.query.error || !req.query.code) return res.redirect(`/admin/social?eroare=${encodeURIComponent(req.query.error_description || 'Conectarea Meta a fost anulata.')}`);
    try {
      const redirectUri = `${publicBaseUrl(req)}/oauth/meta/admin/callback`;
      const token = await exchangeMetaCode(String(req.query.code), redirectUri);
      const pages = await fetchMetaPages(token.access_token);
      if (!pages.length) throw new Error('Nu am gasit nicio Pagina Facebook administrata de acest cont.');
      const user = db.data.users.find((item) => item.id === req.session.userId);
      user.social_connections ||= { meta: null, tiktok: null };
      user.social_connections.meta = { connected_at: new Date().toISOString(), selected_page_id: pages[0].id, pages };
      user.facebook_url = pages[0].facebook_url;
      user.instagram_url = pages[0].instagram_username ? `https://www.instagram.com/${pages[0].instagram_username}/` : user.instagram_url;
      await db.write();
      res.redirect('/admin/social?mesaj=Pagina%20Meta%20a%20fost%20conectata.');
    } catch (error) { res.redirect(`/admin/social?eroare=${encodeURIComponent(error.message || 'Conectarea Meta a esuat.')}`); }
  });

  app.post('/admin/social/meta/pagina', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((item) => item.id === req.session.userId);
    const meta = user?.social_connections?.meta;
    const page = meta?.pages?.find((item) => item.id === String(req.body.page_id || ''));
    if (!page) return res.redirect('/admin/social?eroare=Pagina%20Meta%20selectata%20nu%20este%20valida.');
    meta.selected_page_id = page.id;
    user.facebook_url = page.facebook_url;
    if (page.instagram_username) user.instagram_url = `https://www.instagram.com/${page.instagram_username}/`;
    await db.write();
    res.redirect('/admin/social?mesaj=Pagina%20principala%20a%20fost%20salvata.');
  }));

  app.post('/admin/social/meta/deconecteaza', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((item) => item.id === req.session.userId);
    if (user?.social_connections) user.social_connections.meta = null;
    await db.write();
    res.redirect('/admin/social?mesaj=Meta%20a%20fost%20deconectat.');
  }));

  app.get('/admin/social/tiktok/conecteaza', requireRole('admin'), requireActiveAccount, (req, res) => {
    if (!tiktokConfigured()) return res.redirect('/admin/social?eroare=Integrarea%20TikTok%20nu%20este%20inca%20configurata.');
    const state = randomState();
    req.session.oauth = { provider: 'tiktok-admin', state, expires: Date.now() + 10 * 60 * 1000 };
    const redirectUri = `${publicBaseUrl(req)}/oauth/tiktok/admin/callback`;
    res.redirect(tiktokAuthorizeUrl(redirectUri, state));
  });

  app.get('/oauth/tiktok/admin/callback', requireRole('admin'), requireActiveAccount, async (req, res) => {
    const oauth = req.session.oauth;
    req.session.oauth = null;
    if (!oauth || oauth.provider !== 'tiktok-admin' || oauth.state !== req.query.state || oauth.expires < Date.now()) return res.redirect('/admin/social?eroare=Sesiunea%20TikTok%20a%20expirat.');
    if (req.query.error || !req.query.code) return res.redirect(`/admin/social?eroare=${encodeURIComponent(req.query.error_description || 'Conectarea TikTok a fost anulata.')}`);
    try {
      const redirectUri = `${publicBaseUrl(req)}/oauth/tiktok/admin/callback`;
      const token = await exchangeTikTokCode(String(req.query.code), redirectUri);
      const profile = await fetchTikTokProfile(token.access_token);
      const user = db.data.users.find((item) => item.id === req.session.userId);
      user.social_connections ||= { meta: null, tiktok: null };
      user.social_connections.tiktok = { open_id: token.open_id, display_name: profile.display_name || '',
        profile_url: profile.profile_deep_link || '', scope: token.scope,
        access_token_enc: encryptSecret(token.access_token), refresh_token_enc: encryptSecret(token.refresh_token),
        expires_at: new Date(Date.now() + Number(token.expires_in || 86400) * 1000).toISOString(),
        refresh_expires_at: new Date(Date.now() + Number(token.refresh_expires_in || 31536000) * 1000).toISOString(), connected_at: new Date().toISOString() };
      if (profile.profile_deep_link) user.tiktok_url = profile.profile_deep_link;
      await db.write();
      res.redirect('/admin/social?mesaj=TikTok%20a%20fost%20conectat.');
    } catch (error) { res.redirect(`/admin/social?eroare=${encodeURIComponent(error.message || 'Conectarea TikTok a esuat.')}`); }
  });

  app.post('/admin/social/tiktok/deconecteaza', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((item) => item.id === req.session.userId);
    if (user?.social_connections) user.social_connections.tiktok = null;
    await db.write();
    res.redirect('/admin/social?mesaj=TikTok%20a%20fost%20deconectat.');
  }));

  app.post('/admin/social/publica/:id', requireRole('admin'), requireActiveAccount, requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((item) => item.id === req.session.userId);
    const post = db.data.portal_posts.find((item) => item.id === Number(req.params.id) && portalPostIsPublic(item));
    const platforma = String(req.body.platforma || '').toLowerCase();
    if (!post || !['facebook', 'instagram', 'tiktok'].includes(platforma)) return res.redirect('/admin/social?eroare=Materialul%20sau%20reteaua%20nu%20este%20valida.');
    const postUrl = `${publicBaseUrl(req)}/actualitate/${encodeURIComponent(post.slug)}?utm_source=${platforma}`;
    const textScurt = String(post.rezumat || post.continut || '').replace(/\s+/g, ' ').trim().slice(0, 450);
    try {
      const imaginePublica = internalImageId(post.imagine_url) ? new URL(post.imagine_url, publicBaseUrl(req)).toString() : post.imagine_url;
      let rezultat;
      if (platforma === 'facebook' || platforma === 'instagram') {
        const meta = user.social_connections?.meta;
        const page = meta?.pages?.find((item) => item.id === meta.selected_page_id);
        if (!page) throw new Error('Conecteaza Meta si selecteaza o Pagina.');
        rezultat = platforma === 'facebook' ? await publishFacebook(page, `${post.titlu}\n\n${textScurt}`, postUrl)
          : await publishInstagram(page, `${post.titlu}\n\n${textScurt}\n\n${postUrl}`, imaginePublica);
      } else {
        const connection = user.social_connections?.tiktok;
        if (!connection) throw new Error('Conecteaza contul TikTok.');
        rezultat = await publishTikTokPhoto(connection, post.titlu, `${textScurt}\n\n${postUrl}`, imaginePublica);
      }
      post.distribuiri_sociale ||= [];
      post.distribuiri_sociale.push({ platforma, data: new Date().toISOString(), id_extern: rezultat.id || rezultat.data?.publish_id || '', status: 'trimis' });
      await db.write();
      res.redirect(`/admin/social?mesaj=${encodeURIComponent(`Materialul a fost trimis catre ${platforma}.`)}`);
    } catch (error) { res.redirect(`/admin/social?eroare=${encodeURIComponent(`${platforma}: ${error.message || 'publicarea a esuat.'}`)}`); }
  }));

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
      user.facebook_url = pages[0].facebook_url;
      user.instagram_url = pages[0].instagram_username ? `https://www.instagram.com/${pages[0].instagram_username}/` : user.instagram_url;
      await db.write();
      res.redirect('/dashboard/social?mesaj=Meta%20a%20fost%20conectat.%20Alege%20Pagina%20pe%20care%20vrei%20sa%20publici.');
    } catch (error) {
      res.redirect(`/dashboard/social?eroare=${encodeURIComponent(error.message || 'Conectarea Meta a esuat.')}`);
    }
  });

  app.post('/dashboard/social/meta/pagina', requireRole('candidate'), requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    const meta = user?.social_connections?.meta;
    const pageId = String(req.body.page_id || '');
    if (meta?.pages?.some((page) => page.id === pageId)) {
      meta.selected_page_id = pageId;
      const page = meta.pages.find((item) => item.id === pageId);
      user.facebook_url = page.facebook_url;
      if (page.instagram_username) user.instagram_url = `https://www.instagram.com/${page.instagram_username}/`;
      await db.write();
      return res.redirect('/dashboard/social?mesaj=Pagina%20Meta%20a%20fost%20selectata.');
    }
    res.redirect('/dashboard/social?eroare=Pagina%20Meta%20selectata%20nu%20este%20valida.');
  }));

  app.post('/dashboard/social/meta/deconecteaza', requireRole('candidate'), requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find((u) => u.id === req.session.userId);
    if (user?.social_connections) user.social_connections.meta = null;
    await db.write();
    res.redirect('/dashboard/social?mesaj=Meta%20a%20fost%20deconectat%20din%20platforma.');
  }));

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
      const profile = await fetchTikTokProfile(token.access_token);
      const user = db.data.users.find((u) => u.id === req.session.userId);
      user.social_connections ||= { meta: null, tiktok: null };
      user.social_connections.tiktok = {
        open_id: token.open_id,
        display_name: profile.display_name || '',
        profile_url: profile.profile_deep_link || '',
        scope: token.scope,
        access_token_enc: encryptSecret(token.access_token),
        refresh_token_enc: encryptSecret(token.refresh_token),
        expires_at: new Date(Date.now() + Number(token.expires_in || 86400) * 1000).toISOString(),
        refresh_expires_at: new Date(Date.now() + Number(token.refresh_expires_in || 31536000) * 1000).toISOString(),
        connected_at: new Date().toISOString(),
      };
      if (profile.profile_deep_link) user.tiktok_url = profile.profile_deep_link;
      await db.write();
      res.redirect('/dashboard/social?mesaj=Contul%20TikTok%20a%20fost%20conectat.');
    } catch (error) {
      res.redirect(`/dashboard/social?eroare=${encodeURIComponent(error.message || 'Conectarea TikTok a esuat.')}`);
    }
  });

  app.post('/dashboard/social/tiktok/deconecteaza', requireRole('candidate'), requireCsrf, safely(async (req, res) => {
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
  }));

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
    const photos = {};
    for (const field of ['fotografie_profil_url', 'fotografie_coperta_url']) {
      photos[field] = editorialImageUrl(req.body[field]);
      const imageId = internalImageId(photos[field]);
      if (imageId) {
        const image = await editorial.media(imageId);
        if (!image || image.userId !== user.id) throw new ValidationError('Folosește o fotografie încărcată în contul tău.');
      }
    }
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
    Object.assign(user, photos);
    await db.write();
    await compliance.audit({ actorId: user.id, actorRole: 'candidate', action: 'candidate_profile_changed',
      targetType: 'candidate', targetId: user.id, details: { acceptance_invalidated: requiresNewAcceptance } });
    res.redirect(requiresNewAcceptance ? '/activare?mesaj=Datele%20publice%20s-au%20schimbat.%20Confirm%C4%83%20din%20nou%20termenii.' : '/dashboard?profil=salvat');
  }));

  app.get('/dashboard/articol/nou', requireRole('candidate'), (req, res) => {
    const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
    const section = SECTIUNI_EDITORIALE.find(item => item.categorie === req.query.categorie);
    const categorie = section?.categorie || 'Actualitate';
    const tip = categorie === 'Program' ? 'candidatura' : (categorie === 'Evenimente' ? 'anunt' : 'idee');
    res.render('articol-form', { user, legalReady: candidateComplianceMissing(user, platform).length === 0, articol: { titlu: '', continut: '', categorie, tip }, eroare: '', dataProgramata: '', confirmareResponsabilitate: false });
  });

  app.get('/dashboard/articol/:id/edit', requireRole('candidate'), (req, res) => {
    const articol = db.data.articole.find(
      (a) => a.id === Number(req.params.id) && a.user_id === req.session.userId
    );
    if (!articol) return res.redirect('/dashboard');
    const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
    res.render('articol-form', { user, legalReady: candidateComplianceMissing(user, platform).length === 0, articol, eroare: '', dataProgramata: localDateTime(articol.data_programata), confirmareResponsabilitate: false });
  });

  app.get('/dashboard/articol/:id/preview', requireRole('candidate'), requireActiveAccount, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
    const articol = db.data.articole.find(item => item.id === Number(req.params.id) && item.user_id === user?.id);
    if (!user?.module?.site || !articol) return res.status(404).send('Materialul nu există.');
    const articolUrl = `${req.protocol}://${req.get('host')}/dashboard/articol/${articol.id}/preview`;
    res.render('site-articol', {
      user, articol, articolUrl, transparenta: publicTransparency(user, articol), activeSection: sectionSlugForCategory(articol.categorie),
      comentarii: [], commentsAvailable: true, commentError: '', commentValues: {}, commentSent: false, preview: true,
    });
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
      const user = db.data.users.find(candidate => candidate.id === req.session.userId && candidate.role === 'candidate');
      res.status(400).render('articol-form', { user, legalReady: candidateComplianceMissing(user, platform).length === 0, articol: { ...form, id: previous?.id, generat_de_ai: req.body.generat_de_ai === 'true', imagine_generata_ai: req.body.imagine_generata_ai === 'true' },
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

  attachEditorialRoutes(app, {
    db, editorial, requireRole, requireActiveAccount, requireCsrf, now,
    isPortalPostPublished: portalPostIsPublic,
  });

  /* --------------------------- SITE PUBLIC (ziar) -------------------------- */

  app.get('/site/:subdomeniu', safely(async (req, res) => {
    const user = db.data.users.find(
      (u) => u.subdomeniu === req.params.subdomeniu && poatePublicaSite(u)
    );
    if (!user) return res.status(404).send('Pagina nu exista.');
    const toate = publicCandidateArticles(user);
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
      await saveVisitStatistics();
    }
    const sondaj = activePoll('candidate', user.id);
    if (sondaj) {
      ensureCsrfToken(req, res);
      res.set('Cache-Control', 'private, no-store');
    } else {
      setPublicCdnCache(res);
    }
    res.render('site-public', { user, candidatura, fluxIdei, categorii, cautaText, categorieSelectata, activeSection: 'acasa', sondaj,
      categoriiToate: [...new Set(toate.map(a => a.categorie || 'Actualitate'))].sort(),
      rezultatTotal: filtrate.length });
  }));

  for (const section of SECTIUNI_EDITORIALE) {
    app.get(`/site/:subdomeniu/${section.slug}`, (req, res) => {
      const user = publicCandidate(req.params.subdomeniu);
      if (!user) return res.status(404).send('Pagina nu există.');
      const articole = publicCandidateArticles(user)
        .filter(article => article.categorie === section.categorie);
      setPublicCdnCache(res);
      res.render('site-section', { user, section, articole, activeSection: section.slug });
    });
  }

  app.get('/site/:subdomeniu/despre', (req, res) => {
    const user = publicCandidate(req.params.subdomeniu);
    if (!user) return res.status(404).send('Pagina nu există.');
    setPublicCdnCache(res);
    res.render('site-about', { user, activeSection: 'despre' });
  });

  app.get('/site/:subdomeniu/contact', (req, res) => {
    const user = publicCandidate(req.params.subdomeniu);
    if (!user) return res.status(404).send('Pagina nu există.');
    setPublicCdnCache(res);
    res.render('site-contact', { user, activeSection: 'contact' });
  });

  app.get('/site/:subdomeniu/transparenta', (req, res) => {
    const user = publicCandidate(req.params.subdomeniu);
    if (!user) return res.status(404).send('Pagina nu există.');
    const articleId = Number(req.query.articol);
    const articol = Number.isSafeInteger(articleId) && articleId > 0
      ? db.data.articole.find(item => item.id === articleId && item.user_id === user.id && isPublished(item, now()))
      : null;
    setPublicCdnCache(res);
    res.render('site-transparency', { user, articol, transparenta: publicTransparency(user, articol), activeSection: 'transparenta' });
  });

  app.get('/site/:subdomeniu/articol/:id/raporteaza', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    ensureCsrfToken(req, res);
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

  async function renderPublicArticle(req, res, { error = '', values = {}, status = 200, count = false, expectedCategory = '' } = {}) {
    res.set('Cache-Control', 'private, no-store');
    ensureCsrfToken(req, res);
    const { user, articol } = publicArticle(req);
    if (!articol || (expectedCategory && articol.categorie !== expectedCategory)) {
      return res.status(404).send('Articolul nu exista sau nu e publicat.');
    }
    let comentarii = [];
    let commentsAvailable = true;
    await Promise.all([
      (async () => {
        try { comentarii = (await comments.list(user.id, articol.id)).filter(c => c.status === 'aprobat'); }
        catch (commentError) {
          commentsAvailable = false;
          console.error('Citirea comentariilor a eșuat:', commentError.name);
        }
      })(),
      (async () => {
        if (count && user.module?.statistici) {
          articol.vizualizari = (articol.vizualizari || 0) + 1;
          await saveVisitStatistics();
        }
      })(),
    ]);
    const bazaPublica = process.env.URL || `${req.protocol}://${req.get('host')}`;
    const articolUrl = new URL(`/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}`, bazaPublica).toString();
    res.status(status).render('site-articol', { user, articol, articolUrl, transparenta: publicTransparency(user, articol), comentarii, commentsAvailable, commentError: error,
      activeSection: sectionSlugForCategory(articol.categorie),
      commentValues: values, commentSent: req.query.comentariu === 'trimis', preview: false });
  }

  app.get('/site/:subdomeniu/articol/:id', safely((req, res) => renderPublicArticle(req, res, { count: true })));
  app.get('/site/:subdomeniu/proiect/:id', safely((req, res) => renderPublicArticle(req, res, { count: true, expectedCategory: 'Proiecte' })));

  app.post('/site/:subdomeniu/articol/:id/reactie', requireCsrf, safely(async (req, res) => {
    const user = db.data.users.find(item => item.subdomeniu === req.params.subdomeniu && poatePublicaSite(item));
    const articol = user && db.data.articole.find(item => item.id === Number(req.params.id)
      && item.user_id === user.id && isPublished(item, now()) && item.moderation_status !== 'suspendat');
    if (!articol) throw new ValidationError('Articolul nu există.', 404);
    applyReaction(articol, reactionFingerprint(req, 'candidate', articol.id), String(req.body.reactie || ''));
    await db.write();
    res.redirect(303, `/site/${encodeURIComponent(user.subdomeniu)}/articol/${articol.id}#reactii`);
  }));

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

  app.get('/site/:subdomeniu/social/:platforma', safely(async (req, res) => {
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
      await saveVisitStatistics();
    }
    res.redirect(destinatie);
  }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof StateConflictError) {
      res.set('Cache-Control', 'private, no-store');
      res.set('Netlify-CDN-Cache-Control', 'no-store');
      if (req.is('application/json')) return res.status(409).json({ eroare: error.message });
      return res.status(409).send(error.message);
    }
    if (['/dashboard/media', '/admin/portal/media'].includes(req.path) && error.type === 'entity.too.large') {
      return res.status(413).json({ eroare: 'Imagine prea mare. Încarcă un fișier de maximum 3 MB după redimensionare.' });
    }
    if (error instanceof ValidationError) return res.status(error.status).send(error.message);
    // Nu expunem stack-uri, secrete sau datele trimise de vizitatori.
    console.error('Cerere nereușită:', error.name);
    res.status(503).send('Datele nu pot fi accesate momentan. Reîncarcă pagina și încearcă din nou.');
  });
  return app;
}
