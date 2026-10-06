import { clean, safeUrl, slugify, uniqueSlug } from './util.js';
import { bucharestToDate, toBucharestInputs } from './time.js';
import { STADII, LIVE_MODES, STATE_LABELS, nextTermen, liveState, sortDosare, featuredDosar, newId } from './dosare.js';
import { ValidationError } from '../publication.js';
import { AD_TYPES, AD_STATUS, READER_AD_DAYS, adTypeName, readAdForm, newAdId } from './anunturi.js';

const JUST_HOSTS = ['just.ro'];
const DAY = 86400000;

// Citește formularul dosarului; întoarce { values, error }.
function readDosarForm(body) {
  const values = {
    numar: clean(body.numar, 60),
    instanta: clean(body.instanta, 120),
    stadiu: STADII.includes(body.stadiu) ? body.stadiu : STADII[0],
    titlu: clean(body.titlu, 140),
    obiect: clean(body.obiect, 600),
    portalUrl: clean(body.portalUrl, 500),
    dataInregistrare: clean(body.dataInregistrare, 10),
    termenData: clean(body.termenData, 10),
    termenOra: clean(body.termenOra, 5),
    sala: clean(body.sala, 60),
    complet: clean(body.complet, 60),
    featured: body.featured === 'da',
    liveMode: Object.hasOwn(LIVE_MODES, body.liveMode) ? body.liveMode : 'auto',
  };
  if (!values.titlu) return { values, error: 'Completează titlul de pe prima pagină.' };
  if (values.portalUrl) {
    const url = safeUrl(values.portalUrl, { hosts: JUST_HOSTS });
    if (!url) return { values, error: 'Linkul trebuie să fie o adresă de pe portal.just.ro.' };
    values.portalUrl = url;
  }
  if (values.dataInregistrare && !bucharestToDate(values.dataInregistrare, '12:00')) {
    return { values, error: 'Data înregistrării nu este validă.' };
  }
  if (values.termenData || values.termenOra) {
    values.termenAt = bucharestToDate(values.termenData, values.termenOra || '09:00')?.toISOString();
    if (!values.termenAt) return { values, error: 'Data sau ora termenului nu este validă.' };
  }
  return { values };
}

function applyDosar(data, dosar, values, now) {
  Object.assign(dosar, {
    numar: values.numar, instanta: values.instanta, stadiu: values.stadiu, titlu: values.titlu,
    obiect: values.obiect, portalUrl: values.portalUrl,
    dataInregistrare: values.dataInregistrare ? bucharestToDate(values.dataInregistrare, '12:00').toISOString() : null,
    liveMode: values.liveMode, updatedAt: new Date(now).toISOString(),
  });
  if (values.termenAt) {
    const next = nextTermen(dosar, now);
    if (next) {
      if (next.at !== values.termenAt) { next.at = values.termenAt; if (values.liveMode === 'off') dosar.liveMode = 'auto'; }
      next.sala = values.sala;
      next.complet = values.complet;
    } else {
      dosar.termene.push({ id: newId(), at: values.termenAt, sala: values.sala, complet: values.complet, rezultat: '' });
      // Termen nou: LIVE-ul oprit la termenul trecut nu trebuie să blocheze termenul următor.
      if (values.liveMode === 'off') dosar.liveMode = 'auto';
    }
  }
  if (values.featured) for (const other of data.dosare) other.featured = other === dosar;
  else dosar.featured = false;
}

function formValues(dosar, now) {
  if (!dosar) return { stadiu: STADII[0], liveMode: 'auto', featured: false, termenOra: '09:00' };
  const next = nextTermen(dosar, now);
  const inputs = toBucharestInputs(next?.at);
  return {
    ...dosar,
    dataInregistrare: dosar.dataInregistrare ? toBucharestInputs(dosar.dataInregistrare).date : '',
    termenData: inputs.date, termenOra: inputs.time, sala: next?.sala || '', complet: next?.complet || '',
  };
}

const withMessage = (url, kind, text) => `${url}${url.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`;

export function registerVoceaAdmin(app, ctx) {
  const { voceaStore, now, safely, adminGuard, requireCsrf } = ctx;
  const find = (data, id) => data.dosare.find(d => d.id === id);
  const common = (req, t) => ({
    STADII, LIVE_MODES, STATE_LABELS, liveState: d => liveState(d, t), adminPath: req.path,
    mesaj: req.query.mesaj || '', eroare: req.query.eroare || '',
  });
  const ok = (res, url, text) => res.redirect(303, withMessage(url, 'mesaj', text));
  const fail = (res, url, text) => res.redirect(303, withMessage(url, 'eroare', text));

  app.get('/admin/dosare', ...adminGuard, safely(async (req, res) => {
    const t = now();
    const data = await voceaStore.read();
    const featured = featuredDosar(data);
    res.render('admin-vocea-dosare', {
      ...common(req, t), featured, values: formValues(featured, t),
      dosare: sortDosare(data.dosare, t), nextTermen: d => nextTermen(d, t),
      whatsappUrl: data.settings.whatsappUrl || '',
      pending: data.anunturi.filter(a => a.status === 'in_asteptare').length,
    });
  }));

  app.get('/admin/dosare/nou', ...adminGuard, (req, res) => {
    res.render('admin-vocea-dosar', { ...common(req, now()), dosar: null, values: formValues(null, now()), terms: [] });
  });

  app.post('/admin/dosare', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const t = now();
    const { values, error } = readDosarForm(req.body);
    if (error) return res.status(400).render('admin-vocea-dosar', { ...common(req, t), eroare: error, dosar: null, values, terms: [] });
    const id = await voceaStore.update((data) => {
      const dosar = {
        id: uniqueSlug(slugify(values.numar || values.titlu, 60), new Set(data.dosare.map(d => d.id))),
        termene: [], updates: [], featured: false, createdAt: new Date(t).toISOString(),
      };
      data.dosare.push(dosar);
      applyDosar(data, dosar, values, t);
      return dosar.id;
    });
    ok(res, `/admin/dosare/${encodeURIComponent(id)}`, 'Dosarul a fost adăugat.');
  }));

  // Formularul de pe pagina „Procese cu Primăria” salvează dosarul evidențiat (setări vizibile pe prima pagină).
  app.post('/admin/dosare/setari', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const whatsappUrl = clean(req.body.whatsappUrl, 300);
    const safe = whatsappUrl ? safeUrl(whatsappUrl, { hosts: ['whatsapp.com', 'wa.me'] }) : '';
    if (safe === null) return fail(res, '/admin/dosare#setari', 'Linkul WhatsApp trebuie să fie de pe whatsapp.com sau wa.me.');
    await voceaStore.update((data) => { data.settings.whatsappUrl = safe; });
    ok(res, '/admin/dosare#setari', safe ? 'Linkul WhatsApp a fost salvat.' : 'Linkul WhatsApp a fost scos de pe site.');
  }));

  app.get('/admin/dosare/:id', ...adminGuard, safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const dosar = find(data, req.params.id);
    if (!dosar) return next();
    const t = now();
    res.render('admin-vocea-dosar', {
      ...common(req, t), dosar, values: formValues(dosar, t),
      terms: [...dosar.termene].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      inputs: toBucharestInputs,
    });
  }));

  app.post('/admin/dosare/:id', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const t = now();
    const { values, error } = readDosarForm(req.body);
    const back = req.body.inapoi === 'lista' ? '/admin/dosare' : `/admin/dosare/${encodeURIComponent(req.params.id)}`;
    if (error) return fail(res, back, error);
    await voceaStore.update((data) => {
      const dosar = find(data, req.params.id);
      if (!dosar) throw new ValidationError('Dosarul nu există.', 404);
      applyDosar(data, dosar, values, t);
    });
    ok(res, back, 'Salvat. Prima pagină se actualizează în cel mult un minut; fluxul live, în 30–40 de secunde.');
  }));

  app.post('/admin/dosare/:id/evidentiaza', ...adminGuard, requireCsrf, safely(async (req, res) => {
    await voceaStore.update((data) => {
      if (!find(data, req.params.id)) throw new ValidationError('Dosarul nu există.', 404);
      for (const d of data.dosare) d.featured = d.id === req.params.id;
    });
    ok(res, '/admin/dosare', 'Dosarul este acum evidențiat pe prima pagină.');
  }));

  app.post('/admin/dosare/:id/live', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const mode = Object.hasOwn(LIVE_MODES, req.body.liveMode) ? req.body.liveMode : 'auto';
    await voceaStore.update((data) => {
      const dosar = find(data, req.params.id);
      if (!dosar) throw new ValidationError('Dosarul nu există.', 404);
      dosar.liveMode = mode;
    });
    const back = req.body.inapoi === 'live' ? `/admin/live?dosar=${encodeURIComponent(req.params.id)}` : '/admin/dosare';
    ok(res, back, `LIVE: ${LIVE_MODES[mode]}.`);
  }));

  app.post('/admin/dosare/:id/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    if (req.body.confirmare !== 'STERGE') {
      return fail(res, `/admin/dosare/${encodeURIComponent(req.params.id)}`, 'Scrie STERGE în căsuța de confirmare pentru a șterge dosarul.');
    }
    await voceaStore.update((data) => { data.dosare = data.dosare.filter(d => d.id !== req.params.id); });
    ok(res, '/admin/dosare', 'Dosarul a fost șters.');
  }));

  /* -------------------------------- termene -------------------------------- */

  function readTermen(body) {
    const at = bucharestToDate(clean(body.data, 10), clean(body.ora, 5) || '09:00');
    return at ? { at: at.toISOString(), sala: clean(body.sala, 60), complet: clean(body.complet, 60), rezultat: clean(body.rezultat, 1000) } : null;
  }
  const termeneUrl = req => `/admin/dosare/${encodeURIComponent(req.params.id)}#termene`;

  app.post('/admin/dosare/:id/termene', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const termen = readTermen(req.body);
    if (!termen) return fail(res, termeneUrl(req), 'Data sau ora termenului nu este validă.');
    await voceaStore.update((data) => {
      const dosar = find(data, req.params.id);
      if (!dosar) throw new ValidationError('Dosarul nu există.', 404);
      dosar.termene.push({ id: newId(), ...termen });
      if (Date.parse(termen.at) > now() && dosar.liveMode === 'off') dosar.liveMode = 'auto';
    });
    ok(res, termeneUrl(req), 'Termenul a fost adăugat.');
  }));

  app.post('/admin/dosare/:id/termene/:tid', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const termen = readTermen(req.body);
    if (!termen) return fail(res, termeneUrl(req), 'Data sau ora termenului nu este validă.');
    await voceaStore.update((data) => {
      const target = find(data, req.params.id)?.termene.find(x => x.id === req.params.tid);
      if (!target) throw new ValidationError('Termenul nu există.', 404);
      Object.assign(target, termen);
    });
    ok(res, termeneUrl(req), 'Termenul a fost salvat.');
  }));

  app.post('/admin/dosare/:id/termene/:tid/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    await voceaStore.update((data) => {
      const dosar = find(data, req.params.id);
      if (dosar) dosar.termene = dosar.termene.filter(x => x.id !== req.params.tid);
    });
    ok(res, termeneUrl(req), 'Termenul a fost șters.');
  }));

  /* --------------------------- actualizări live ---------------------------- */

  app.get('/admin/live', ...adminGuard, safely(async (req, res) => {
    const t = now();
    const data = await voceaStore.read();
    const dosare = sortDosare(data.dosare, t);
    const selected = find(data, req.query.dosar) || featuredDosar(data) || dosare[0] || null;
    res.render('admin-vocea-live', {
      ...common(req, t), dosare, selected,
      updates: selected ? [...selected.updates].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : [],
    });
  }));

  app.post('/admin/live', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const t = now();
    const titlu = clean(req.body.titlu, 160);
    const text = clean(req.body.text, 2000);
    const dosarId = String(req.body.dosar || '');
    const back = req.body.inapoi === 'dosare' ? '/admin/dosare' : `/admin/live?dosar=${encodeURIComponent(dosarId)}`;
    if (!titlu) return fail(res, back, 'Scrie un titlu pentru actualizare.');
    let at = new Date(t);
    if (req.body.ora) {
      at = bucharestToDate(clean(req.body.data, 10) || toBucharestInputs(t).date, clean(req.body.ora, 5));
      if (!at) return fail(res, back, 'Ora actualizării nu este validă.');
    }
    const author = req.session.userId;
    await voceaStore.update((data) => {
      const dosar = find(data, dosarId);
      if (!dosar) throw new ValidationError('Alege un dosar.', 404);
      dosar.updates.push({ id: newId(), at: at.toISOString(), titlu, text, autor: author, createdAt: new Date(t).toISOString() });
    });
    ok(res, back, 'Publicat. Apare pe site în cel mult 30–40 de secunde.');
  }));

  app.post('/admin/live/:id/:uid/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    await voceaStore.update((data) => {
      const dosar = find(data, req.params.id);
      if (dosar) dosar.updates = dosar.updates.filter(u => u.id !== req.params.uid);
    });
    ok(res, `/admin/live?dosar=${encodeURIComponent(req.params.id)}`, 'Actualizarea a fost ștearsă.');
  }));

  /* -------------------------------- anunțuri -------------------------------- */

  app.get('/admin/anunturi', ...adminGuard, safely(async (req, res) => {
    const data = await voceaStore.read();
    const t = now();
    const sorted = [...data.anunturi].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.render('admin-vocea-anunturi', {
      ...common(req, t), AD_STATUS, adTypeName,
      pending: sorted.filter(a => a.status === 'in_asteptare'),
      published: sorted.filter(a => a.status === 'publicat'),
      expired: a => a.expiraLa && Date.parse(a.expiraLa) <= t,
    });
  }));

  app.get('/admin/anunturi/nou', ...adminGuard, (req, res) => {
    res.render('admin-vocea-anunt', { ...common(req, now()), types: AD_TYPES, ad: null, values: { tip: 'primarie' } });
  });

  function adFields(values, t, previous = null) {
    return {
      ...values,
      status: 'publicat',
      publicatLa: previous?.publicatLa || new Date(t).toISOString(),
      // Anunțurile cititorilor expiră după 30 de zile; cele ale redacției rămân până le ștergi.
      expiraLa: previous?.sursa === 'cititor' ? (previous.expiraLa || new Date(t + READER_AD_DAYS * DAY).toISOString()) : null,
      updatedAt: new Date(t).toISOString(),
    };
  }

  app.post('/admin/anunturi', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const t = now();
    const { values, error } = readAdForm(req.body);
    if (error) return res.status(400).render('admin-vocea-anunt', { ...common(req, t), eroare: error, types: AD_TYPES, ad: null, values });
    await voceaStore.update((data) => {
      data.anunturi.push({ id: newAdId(), sursa: 'redactie', createdAt: new Date(t).toISOString(), ...adFields(values, t) });
    });
    ok(res, '/admin/anunturi', 'Anunțul a fost publicat.');
  }));

  app.get('/admin/anunturi/:id', ...adminGuard, safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const ad = data.anunturi.find(a => a.id === req.params.id);
    if (!ad) return next();
    res.render('admin-vocea-anunt', { ...common(req, now()), types: AD_TYPES, ad, values: ad });
  }));

  // Salvarea unui anunț trimis de cititor îl și aprobă (îl publică).
  app.post('/admin/anunturi/:id', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const t = now();
    const { values, error } = readAdForm(req.body);
    if (error) return fail(res, `/admin/anunturi/${encodeURIComponent(req.params.id)}`, error);
    await voceaStore.update((data) => {
      const ad = data.anunturi.find(a => a.id === req.params.id);
      if (!ad) throw new ValidationError('Anunțul nu există.', 404);
      Object.assign(ad, adFields(values, t, ad));
    });
    ok(res, '/admin/anunturi', 'Anunțul a fost salvat și este publicat.');
  }));

  app.post('/admin/anunturi/:id/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    await voceaStore.update((data) => { data.anunturi = data.anunturi.filter(a => a.id !== req.params.id); });
    ok(res, '/admin/anunturi', 'Anunțul a fost șters definitiv.');
  }));
}
