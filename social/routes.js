import { randomUUID } from 'node:crypto';
import { renderShareImage, photoDataUri } from './images.js';
import { TYPES, imageUrl } from './publications.js';
import { publishFacebook, publishInstagram, publishTikTokPhoto, instagramPermalink, metaConfigured, tiktokConfigured } from '../social.js';
import { clean } from '../vocea/util.js';

export const NETWORKS = { facebook: 'Facebook (Pagina)', instagram: 'Instagram (cont profesional)', tiktok: 'TikTok' };
const LIMITS = { facebook: 5000, instagram: 2200, tiktok: 2200 };
const LOG_LIMIT = 500;
const BIO = 'Link în bio · vocealenauheim.ro';

// TikTok publică public prin API doar după auditul aplicației; până atunci postările rămân private („doar eu”).
export const tiktokApproved = () => process.env.TIKTOK_DIRECT_POST_APPROVED === 'true';

export function defaultTexts(publication) {
  const body = [publication.title, publication.summary].filter(Boolean).join('\n\n');
  const political = publication.political ? `\n\n${publication.political}` : '';
  return {
    facebook: `${body}${political}`,
    // Instagram și TikTok nu au linkuri active în text: trimitem la linkul din bio.
    instagram: `${body}${political}\n\n${BIO}`,
    tiktok: `${body}${political}\n\n${BIO}`,
  };
}

// Textul final: fără linkuri pe Instagram, cu marcajul politic adăugat dacă a fost șters.
export function finalText(network, text, publication) {
  let out = clean(text, LIMITS[network]);
  if (network !== 'facebook') out = out.replace(/https?:\/\/\S+/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (publication.political && !out.includes(publication.political)) out = `${out}\n\n${publication.political}`.trim();
  return out.slice(0, LIMITS[network]);
}

export function registerSocial(app, ctx) {
  const { db, voceaStore, publications, safely, adminGuard, requireCsrf, baseUrl, baseDir, isActiveAdmin } = ctx;
  const admin = req => db.data.users.find(user => user.id === req.session.userId && user.role === 'admin');
  const isAdmin = req => req.session?.rol === 'admin' && isActiveAdmin(req);

  /* ---------------------------- imagini publice ---------------------------- */

  app.get('/imagini/:format(og|story)/:type/:id.jpg', safely(async (req, res, next) => {
    if (!Object.hasOwn(TYPES, req.params.type)) return next();
    const preview = isAdmin(req);
    const publication = await publications.find(req.params.type, req.params.id, { includeDrafts: preview });
    if (!publication) return next();
    let bytes;
    try {
      const photo = await photoDataUri(await publications.photoBuffer(publication.photoUrl), { baseDir });
      bytes = await renderShareImage({ ...publication, photo }, req.params.format, { baseDir });
    } catch (error) {
      // O imagine lipsă nu trebuie să strice distribuirea: trimitem imaginea implicită a site-ului.
      console.error('Imaginea de distribuire nu a putut fi generată:', error.name, error.code || '');
      res.set('Cache-Control', 'no-store');
      res.set('X-Share-Image', `fallback ${error.name}${error.code ? ` ${error.code}` : ''}`);
      res.set('X-Share-Debug', encodeURIComponent(String(error.stack || error.message).slice(0, 600)));
      return res.redirect(302, '/img/og-default.jpg');
    }
    const isPublic = Boolean(await publications.find(req.params.type, req.params.id));
    if (isPublic) {
      // Adresa conține versiunea conținutului: imaginea poate sta mult în CDN.
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Netlify-CDN-Cache-Control', 'public, durable, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'private, no-store');
      res.set('Netlify-CDN-Cache-Control', 'no-store');
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('X-Robots-Tag', 'noindex');
    if (req.query.descarca === '1') {
      res.set('Content-Disposition', `attachment; filename="vocea-lenauheim-${req.params.format === 'story' ? 'story' : 'imagine'}-${publication.type}-${String(publication.id).slice(0, 40).replace(/[^\w-]/g, '')}.jpg"`);
    }
    res.send(Buffer.from(bytes));
  }));

  /* ------------------------------- Super Admin ------------------------------- */

  function connections(user) {
    const meta = user?.social_connections?.meta;
    const page = meta?.pages?.find(item => item.id === meta.selected_page_id) || null;
    const tiktok = user?.social_connections?.tiktok || null;
    return {
      page, tiktok,
      facebook: Boolean(page), instagram: Boolean(page?.instagram_id), tiktokConnected: Boolean(tiktok),
      metaConfigured: metaConfigured(), tiktokConfigured: tiktokConfigured(), tiktokApproved: tiktokApproved(),
    };
  }

  const absolute = (req, path) => `${baseUrl(req)}${path}`;
  const withMessage = (url, kind, text) => `${url}${url.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`;
  const panelUrl = (type, id) => `/admin/distribuie/${type}/${encodeURIComponent(id)}`;

  async function readLog(filter) {
    const data = await voceaStore.read();
    return (data.social_log || []).filter(filter || (() => true)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  app.get('/admin/distribuie', ...adminGuard, safely(async (req, res) => {
    const log = await readLog();
    const items = await publications.recent(40);
    res.render('admin-social-distribuie', {
      TYPES, NETWORKS, items, log: log.slice(0, 60), conn: connections(admin(req)),
      shared: Object.fromEntries(items.map(item => [`${item.type}:${item.id}`, log.filter(entry => entry.type === item.type && entry.pubId === item.id && entry.status !== 'eroare').map(entry => entry.network)])),
      mesaj: req.query.mesaj || '', eroare: req.query.eroare || '',
    });
  }));

  async function loadPanel(req) {
    if (!Object.hasOwn(TYPES, req.params.type)) return null;
    const publication = await publications.find(req.params.type, req.params.id);
    if (!publication) return null;
    return {
      publication, conn: connections(admin(req)), TYPES, NETWORKS,
      ogUrl: imageUrl(publication, 'og'), storyUrl: imageUrl(publication, 'story'),
      link: absolute(req, publication.path),
      log: await readLog(entry => entry.type === publication.type && entry.pubId === publication.id),
    };
  }

  app.get('/admin/distribuie/:type/:id', ...adminGuard, safely(async (req, res, next) => {
    const panel = await loadPanel(req);
    if (!panel) return next();
    res.render('admin-social-panou', { ...panel, texts: defaultTexts(panel.publication), selected: [], mesaj: req.query.mesaj || '', eroare: req.query.eroare || '' });
  }));

  function readChoices(req, panel) {
    const selected = Object.keys(NETWORKS).filter(network => req.body[`retea_${network}`] === 'da');
    const texts = Object.fromEntries(Object.keys(NETWORKS).map(network => [network, String(req.body[`text_${network}`] ?? '')]));
    const problems = [];
    if (!selected.length) problems.push('Bifează cel puțin o rețea.');
    if (selected.includes('facebook') && !panel.conn.facebook) problems.push('Conectează mai întâi Pagina de Facebook (Setări → Rețele sociale).');
    if (selected.includes('instagram') && !panel.conn.instagram) problems.push('Pagina selectată nu are un cont Instagram profesional legat.');
    if (selected.includes('tiktok') && !panel.conn.tiktokConnected) problems.push('Conectează mai întâi contul TikTok.');
    for (const network of selected) if (!finalText(network, texts[network], panel.publication)) problems.push(`Textul pentru ${NETWORKS[network]} este gol.`);
    return { selected, texts, problems };
  }

  // „Modifică textele” din pagina de confirmare: panoul se redeschide cu ce era scris.
  app.post('/admin/distribuie/:type/:id', ...adminGuard, requireCsrf, safely(async (req, res, next) => {
    const panel = await loadPanel(req);
    if (!panel) return next();
    const { selected, texts } = readChoices(req, panel);
    res.render('admin-social-panou', { ...panel, texts, selected, mesaj: '', eroare: '' });
  }));

  // Pasul 1: previzualizare și confirmare manuală (nu se postează nimic).
  app.post('/admin/distribuie/:type/:id/confirma', ...adminGuard, requireCsrf, safely(async (req, res, next) => {
    const panel = await loadPanel(req);
    if (!panel) return next();
    const { selected, texts, problems } = readChoices(req, panel);
    if (problems.length) return res.status(400).render('admin-social-panou', { ...panel, texts, selected, mesaj: '', eroare: problems.join(' ') });
    res.render('admin-social-confirma', {
      ...panel, selected, texts,
      finals: Object.fromEntries(selected.map(network => [network, finalText(network, texts[network], panel.publication)])),
    });
  }));

  // Pasul 2: postarea, doar cu confirmarea explicită; fiecare rezultat intră în jurnal.
  app.post('/admin/distribuie/:type/:id/posteaza', ...adminGuard, requireCsrf, safely(async (req, res, next) => {
    const panel = await loadPanel(req);
    if (!panel) return next();
    const back = panelUrl(panel.publication.type, panel.publication.id);
    if (req.body.confirmare !== 'da') return res.redirect(303, withMessage(back, 'eroare', 'Postarea nu a fost confirmată.'));
    const { selected, texts, problems } = readChoices(req, panel);
    if (problems.length) return res.redirect(303, withMessage(back, 'eroare', problems.join(' ')));
    const user = admin(req);
    const { publication } = panel;
    const results = [];
    for (const network of selected) {
      const text = finalText(network, texts[network], publication);
      const entry = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), type: publication.type, pubId: publication.id, title: publication.title, network, text, actor: user?.email || '' };
      try {
        if (network === 'facebook') {
          const result = await publishFacebook(panel.conn.page, text, `${panel.link}?utm_source=facebook`);
          Object.assign(entry, { status: 'publicat', externalId: result.id || '', url: result.id ? `https://www.facebook.com/${result.id}` : '' });
        } else if (network === 'instagram') {
          const result = await publishInstagram(panel.conn.page, text, absolute(req, panel.ogUrl));
          const url = await instagramPermalink(panel.conn.page, result.id).catch(() => '');
          Object.assign(entry, { status: 'publicat', externalId: result.id || '', url });
        } else {
          const title = publication.title.slice(0, 90);
          const result = await publishTikTokPhoto(user.social_connections.tiktok, title, text, absolute(req, panel.storyUrl));
          Object.assign(entry, {
            status: 'trimis', externalId: result.data?.publish_id || '', url: user.social_connections.tiktok.profile_url || '',
            note: tiktokApproved() ? 'TikTok procesează postarea; apare în profil în câteva minute.' : 'Aplicația TikTok nu e încă aprobată: postarea e privată („doar eu”). Fă-o publică din aplicația TikTok sau postează manual imaginea.',
          });
        }
      } catch (error) {
        Object.assign(entry, { status: 'eroare', error: String(error.message || error).slice(0, 500) });
      }
      results.push(entry);
    }
    if (user?.social_connections?.tiktok && selected.includes('tiktok')) await db.write().catch(() => {});
    await voceaStore.update((data) => {
      data.social_log = [...results, ...(data.social_log || [])].slice(0, LOG_LIMIT);
    });
    const failed = results.filter(entry => entry.status === 'eroare');
    const okNetworks = results.filter(entry => entry.status !== 'eroare').map(entry => NETWORKS[entry.network]);
    const message = [okNetworks.length && `Trimis pe: ${okNetworks.join(', ')}.`, failed.length && `Eșuat: ${failed.map(entry => `${NETWORKS[entry.network]} (${entry.error})`).join('; ')}.`].filter(Boolean).join(' ');
    res.redirect(303, withMessage(back, failed.length ? 'eroare' : 'mesaj', message));
  }));
}
