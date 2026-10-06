import { createHmac } from 'node:crypto';
import { dosarView, sortDosare, caseTag, liveJson, upcomingTermen, nextTermen, featuredDosar } from './dosare.js';
import { termenIcs } from './ics.js';
import { formatDateTime, bucharestDayKey } from './time.js';
import {
  AD_TYPES, READER_AD_TYPES, READER_LIMIT_PER_DAY, ADS_PAGE_SIZE,
  activeAds, importantAd, adView, adTypeName, validAdType, isActive, readAdForm, newAdId, phoneDigits,
} from './anunturi.js';
import { PORTAL_SITE_NAME } from '../seo.js';
import { claimPhotos, photoOwner } from './poze-routes.js';

// Prima pagină și paginile de dosar: date calculate o singură dată pentru șabloane.
export function homeProcese(data, now) {
  const featured = featuredDosar(data);
  return {
    hero: featured ? dosarView(featured, now) : null,
    cases: sortDosare(data.dosare, now).map(d => ({ dosar: d, tag: caseTag(d, now) })),
  };
}

export function registerVoceaPublic(app, ctx) {
  const { voceaStore, now, safely, setPublicCdnCache, ensureCsrfToken, requireCsrf, pageSeo, baseUrl, clientIp } = ctx;
  const findDosar = (data, id) => data.dosare.find(d => d.id === id);

  app.get('/dosare', safely(async (req, res) => {
    const t = now();
    const data = await voceaStore.read();
    setPublicCdnCache(res, { maxAge: 20, stale: 60 });
    res.render('vocea-dosare', {
      section: 'procese',
      cases: sortDosare(data.dosare, t).map(d => ({ dosar: d, tag: caseTag(d, t), view: dosarView(d, t) })),
      seo: pageSeo(req, { path: '/dosare', title: `Toate dosarele cu Primăria — ${PORTAL_SITE_NAME}`,
        description: 'Procesele în care este parte Primăria Lenauheim: termene, stadiu și actualizări din sala de judecată.' }),
    });
  }));

  app.get('/dosare/:id', safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const dosar = findDosar(data, req.params.id);
    if (!dosar) return next();
    const t = now();
    const view = dosarView(dosar, t);
    setPublicCdnCache(res, { maxAge: 20, stale: 60 });
    res.render('vocea-dosar', {
      section: 'procese', view, nowMs: t, nextId: nextTermen(dosar, t)?.id,
      terms: [...dosar.termene].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
      seo: pageSeo(req, {
        path: `/dosare/${encodeURIComponent(dosar.id)}`,
        title: `${dosar.titlu}${dosar.numar ? ` — dosar ${dosar.numar}` : ''} — ${PORTAL_SITE_NAME}`,
        description: `${view.termenLabel.toLowerCase()}. ${dosar.obiect || ''} Stadiu: ${dosar.stadiu || '—'}.`,
      }),
    });
  }));

  app.get('/dosare/:id/termen.ics', safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const dosar = findDosar(data, req.params.id);
    const t = now();
    const termen = dosar && (upcomingTermen(dosar, t) || nextTermen(dosar, t));
    if (!termen) return next();
    const url = `${baseUrl(req)}/dosare/${encodeURIComponent(dosar.id)}`;
    setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="termen-${dosar.id}.ics"`);
    res.send(termenIcs({
      uid: `${dosar.id}-${termen.id}@vocealenauheim.ro`,
      start: termen.at,
      summary: `Termen: ${dosar.titlu}${dosar.numar ? ` (dosar ${dosar.numar})` : ''}`,
      location: [dosar.instanta, termen.sala, termen.complet].filter(Boolean).join(', '),
      description: `${dosar.obiect || ''}\n${formatDateTime(termen.at)}\nUrmărește live: ${url}`.trim(),
      url,
      now: t,
    }));
  }));

  app.get('/api/dosare/:id/live', safely(async (req, res) => {
    const data = await voceaStore.read();
    const dosar = findDosar(data, req.params.id);
    if (!dosar) return res.status(404).json({ error: 'Dosarul nu există.' });
    // Fluxul se citește la 30 s; CDN-ul ține răspunsul 10 s, ca un vârf de cititori să nu încarce funcția.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.set('Netlify-CDN-Cache-Control', 'public, durable, max-age=10, stale-while-revalidate=10');
    res.json(liveJson(dosar, now()));
  }));

  app.get('/alerte', safely(async (req, res) => {
    const data = await voceaStore.read();
    const featured = featuredDosar(data);
    setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    res.render('vocea-alerte', {
      section: 'alerte', featured, termen: featured && upcomingTermen(featured, now()),
      whatsappUrl: data.settings.whatsappUrl || '',
      seo: pageSeo(req, { path: '/alerte', title: `Alerte pentru termene — ${PORTAL_SITE_NAME}`,
        description: 'Află primul când începe un termen în procesele cu Primăria Lenauheim: WhatsApp și calendar.' }),
    });
  }));

  /* -------------------------------- anunțuri -------------------------------- */

  app.get('/anunturi', safely(async (req, res) => {
    const t = now();
    const data = await voceaStore.read();
    const tip = validAdType(req.query.tip) ? req.query.tip : null;
    const all = activeAds(data, t, tip);
    const pages = Math.max(1, Math.ceil(all.length / ADS_PAGE_SIZE));
    const page = Math.min(Math.max(1, Number.parseInt(req.query.pagina, 10) || 1), pages);
    const query = (n) => {
      const params = new URLSearchParams();
      if (tip) params.set('tip', tip);
      if (n > 1) params.set('pagina', String(n));
      return params.size ? `/anunturi?${params}` : '/anunturi';
    };
    const important = importantAd(data, t);
    setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    res.render('vocea-anunturi', {
      section: 'anunturi', types: AD_TYPES, tip, page, pages, query,
      important: important && adView(important),
      ads: all.slice((page - 1) * ADS_PAGE_SIZE, page * ADS_PAGE_SIZE).map(adView),
      seo: pageSeo(req, {
        path: query(page),
        title: `${tip ? `Anunțuri: ${adTypeName(tip)}` : 'Anunțuri — avizierul comunei'}${page > 1 ? ` — pagina ${page}` : ''} — ${PORTAL_SITE_NAME}`,
        description: 'Avizierul comunei Lenauheim: anunțuri de la Primărie, decese, mica publicitate și locuri de muncă din Lenauheim, Bulgăruș și Grabaț.',
      }),
    });
  }));

  // Formularul are pagină proprie (cu sesiune și CSRF), ca lista să rămână în cache-ul CDN.
  app.get('/anunturi/publica', (req, res) => {
    ensureCsrfToken(req, res);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.render('vocea-anunt-publica', {
      section: 'anunturi', types: AD_TYPES.filter(type => READER_AD_TYPES.includes(type.slug)),
      values: { tip: 'mica-publicitate' }, error: null, sent: req.query.trimis === '1', pending: [],
      seo: pageSeo(req, { path: '/anunturi/publica', title: `Publică un anunț — ${PORTAL_SITE_NAME}`,
        description: 'Trimite un anunț de mica publicitate, deces sau loc de muncă. Redacția îl verifică înainte de publicare.', noindex: true }),
    });
  });

  app.post('/anunturi/publica', requireCsrf, safely(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const render = async (status, values, error) => {
      // Pozele deja încărcate rămân în formular când anunțul trebuie corectat.
      const ids = [].concat(req.body.poze || []).map(String);
      const owner = photoOwner(req);
      const uploads = (await voceaStore.read()).poze_incarcate || [];
      const pending = ids.map(id => uploads.find(item => item.id === id && item.owner === owner && item.mic)).filter(Boolean);
      return res.status(status).render('vocea-anunt-publica', {
      section: 'anunturi', types: AD_TYPES.filter(type => READER_AD_TYPES.includes(type.slug)), values, error, sent: false, pending,
      seo: pageSeo(req, { path: '/anunturi/publica', title: `Publică un anunț — ${PORTAL_SITE_NAME}`,
        description: 'Trimite un anunț spre verificare.', noindex: true }),
      });
    };
    // Câmpul ascuns e completat doar de roboți: răspundem ca și cum ar fi reușit.
    if (String(req.body.website || '').trim()) return res.redirect(303, '/anunturi/publica?trimis=1');
    const { values, error } = readAdForm(req.body, { reader: true });
    if (error) return render(400, values, error);
    if (req.body.acord !== 'da') return render(400, values, 'Confirmă că anunțul e corect și că ești de acord cu publicarea lui.');
    const t = now();
    const day = bucharestDayKey(t);
    const who = createHmac('sha256', process.env.SESSION_SECRET || 'local').update(`anunt:${clientIp(req)}`).digest('hex').slice(0, 24);
    const limited = await voceaStore.update((data) => {
      // Contorul zilnic păstrează doar o amprentă a adresei IP, ștearsă a doua zi.
      for (const key of Object.keys(data.limite)) if (!key.startsWith(`${day}:`)) delete data.limite[key];
      const key = `${day}:${who}`;
      if ((data.limite[key] || 0) >= READER_LIMIT_PER_DAY) return true;
      data.limite[key] = (data.limite[key] || 0) + 1;
      data.anunturi.push({
        id: newAdId(), ...values, status: 'in_asteptare', sursa: 'cititor',
        // Pozele încărcate de această sesiune trec prin moderare împreună cu anunțul.
        poze: claimPhotos(data, req.body.poze, photoOwner(req)),
        createdAt: new Date(t).toISOString(), publicatLa: null, expiraLa: null,
      });
      return false;
    });
    if (limited) return render(429, values, `Poți trimite cel mult ${READER_LIMIT_PER_DAY} anunțuri pe zi. Încearcă mâine.`);
    res.redirect(303, '/anunturi/publica?trimis=1');
  }));

  app.get('/anunturi/:id', safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const found = data.anunturi.find(a => a.id === req.params.id && isActive(a, now()) && validAdType(a.tip));
    if (!found) return next();
    const ad = adView(found);
    setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    res.render('vocea-anunt', {
      section: 'anunturi', ad,
      seo: pageSeo(req, { path: ad.url, title: `${ad.titlu} — ${ad.typeName} — ${PORTAL_SITE_NAME}`,
        description: ad.summary || ad.titlu, noindex: ad.tip === 'decese' }),
    });
  }));

  // Telefonul nu apare în HTML (ca să nu fie cules de roboți); se cere la apăsarea butonului.
  app.get('/api/anunturi/:id/telefon', safely(async (req, res) => {
    const data = await voceaStore.read();
    const ad = data.anunturi.find(a => a.id === req.params.id && isActive(a, now()) && validAdType(a.tip));
    const tel = ad && phoneDigits(ad.telefon);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!tel || tel.length < 6) return res.status(404).json({ error: 'Anunțul nu are telefon.' });
    res.json({ telefon: ad.telefon, tel });
  }));
}
