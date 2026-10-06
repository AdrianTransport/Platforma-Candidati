import express from 'express';
import { randomUUID } from 'node:crypto';
import { termenIcs } from './ics.js';
import { bucharestToDate, formatDateTime, toBucharestInputs } from './time.js';
import { clean } from './util.js';
import { ValidationError } from '../publication.js';
import { PORTAL_SITE_NAME } from '../seo.js';
import {
  MEETING_TYPES, MEETING_STATES, RESULTS, DOC_TYPES, DOC_GROUP_TITLES, MAX_PDF_BYTES,
  meetingTitle, meetingFullTitle, meetingUrl, meetingIdFromSlug, meetingSlug, meetingState, isPublished, publicMeetings, nextMeeting,
  resultCounts, resultLabel, readMeetingForm, verifyPdf, formatComment, formatSize, docUrl, docFileName, newMeetingId,
} from './sedinte.js';

const helpers = { MEETING_TYPES, MEETING_STATES, RESULTS, DOC_TYPES, DOC_GROUP_TITLES, meetingTitle, meetingFullTitle, meetingUrl, meetingState, resultCounts, resultLabel, formatSize, docUrl, formatComment };
const withMessage = (url, kind, text) => `${url}${url.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`;
const isAdmin = req => req.session?.rol === 'admin' && Boolean(req.session.userId);

// Documentul principal din vizualizator: procesul-verbal, apoi hotărârile, apoi primul PDF.
function featuredDoc(meeting) {
  for (const tip of ['proces-verbal', 'hotarare', 'convocator', 'proiect', 'altul']) {
    const doc = meeting.documente.find(d => d.tip === tip);
    if (doc) return doc;
  }
  return null;
}

function findDoc(data, docId) {
  for (const meeting of data.sedinte) {
    const doc = meeting.documente.find(d => d.id === docId);
    if (doc) return { meeting, doc };
  }
  return null;
}

export function registerSedinte(app, ctx) {
  const { voceaStore, pdfStore, now, safely, setPublicCdnCache, requireCsrf, adminGuard, pageSeo, baseUrl, isActiveAdmin, defaultAuthor, shareFor, withShare } = ctx;

  /* --------------------------------- public --------------------------------- */

  app.get('/sedinte', safely(async (req, res) => {
    const t = now();
    const data = await voceaStore.read();
    const all = publicMeetings(data);
    const years = [...new Set(all.map(m => toBucharestInputs(m.at).date.slice(0, 4)))].sort().reverse();
    const tip = Object.hasOwn(MEETING_TYPES, req.query.tip) ? req.query.tip : '';
    const an = years.includes(String(req.query.an)) ? String(req.query.an) : '';
    const next = nextMeeting(data, t);
    const done = all.filter(m => m !== next && meetingState(m, t) === 'incheiata')
      .filter(m => (!tip || m.tip === tip) && (!an || toBucharestInputs(m.at).date.startsWith(an)));
    const filtered = Boolean(tip || an);
    setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    if (filtered) res.set('X-Robots-Tag', 'noindex, follow');
    res.render('vocea-sedinte', {
      // Cu filtru activ arătăm doar arhiva filtrată.
      ...helpers, section: 'primarie', next: filtered ? null : next,
      done, tip, an, years, nowMs: t,
      seo: pageSeo(req, { path: '/sedinte', title: `Ședințele Consiliului Local Lenauheim — ${PORTAL_SITE_NAME}`, noindex: filtered,
        description: 'Ședințele Consiliului Local Lenauheim: ordinea de zi, rezultatul votului la fiecare punct, hotărârile și procesele-verbale (PDF).' }),
    });
  }));

  app.get('/sedinte/:slug', safely(async (req, res, next) => {
    const t = now();
    const data = await voceaStore.read();
    const meeting = data.sedinte.find(m => m.id === meetingIdFromSlug(req.params.slug));
    const preview = isAdmin(req) && isActiveAdmin(req);
    if (!meeting || (!isPublished(meeting) && !preview)) return next();
    if (req.params.slug !== meetingSlug(meeting)) return res.redirect(301, meetingUrl(meeting));
    if (isPublished(meeting) && !preview) setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    else {
      res.set('Cache-Control', 'private, no-store');
      res.set('Netlify-CDN-Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    const url = `${baseUrl(req)}${meetingUrl(meeting)}`;
    const share = isPublished(meeting) ? await shareFor(req, 'sedinta', meeting.id) : null;
    res.render('vocea-sedinta', {
      ...helpers, section: 'primarie', meeting, state: meetingState(meeting, t), draft: !isPublished(meeting),
      featured: featuredDoc(meeting), shareUrl: url, nowMs: t, share,
      seo: withShare(pageSeo(req, {
        path: meetingUrl(meeting), noindex: !isPublished(meeting),
        title: `${meetingTitle(meeting)} — Consiliul Local Lenauheim — ${PORTAL_SITE_NAME}`,
        description: meeting.rezumat || `${meetingTitle(meeting)}: ordinea de zi, voturile și documentele PDF ale Consiliului Local Lenauheim.`,
      }), share),
    });
  }));

  app.get('/sedinte/:slug/calendar.ics', safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const meeting = data.sedinte.find(m => m.id === meetingIdFromSlug(req.params.slug) && isPublished(m));
    if (!meeting?.at) return next();
    const url = `${baseUrl(req)}${meetingUrl(meeting)}`;
    setPublicCdnCache(res, { maxAge: 60, stale: 300 });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sedinta-${meetingSlug(meeting)}.ics"`);
    res.send(termenIcs({
      uid: `sedinta-${meeting.id}@vocealenauheim.ro`, start: meeting.at, durationMinutes: 120,
      summary: `${meetingTitle(meeting)} a Consiliului Local Lenauheim`,
      location: meeting.loc || 'Primăria Lenauheim',
      description: `${formatDateTime(meeting.at)}\nOrdinea de zi și documentele: ${url}`, url, now: now(),
    }));
  }));

  // PDF-urile ședințelor publicate; ciornele doar pentru Super Admin.
  app.get('/documente/:id/:name', safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const found = findDoc(data, req.params.id);
    const preview = isAdmin(req) && isActiveAdmin(req);
    if (!found || (!isPublished(found.meeting) && !preview)) return next();
    const bytes = await pdfStore.get(found.doc.id);
    if (!bytes) return next();
    const download = req.query.descarca === '1';
    if (isPublished(found.meeting)) {
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Netlify-CDN-Cache-Control', 'public, durable, max-age=3600, stale-while-revalidate=600');
    } else {
      res.set('Cache-Control', 'private, no-store');
      res.set('Netlify-CDN-Cache-Control', 'no-store');
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${docFileName(found.doc)}"`,
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(bytes);
  }));

  /* ------------------------------- Super Admin ------------------------------- */

  const common = req => ({ ...helpers, adminPath: req.path, mesaj: req.query.mesaj || '', eroare: req.query.eroare || '' });
  const ok = (res, url, text) => res.redirect(303, withMessage(url, 'mesaj', text));
  const fail = (res, url, text) => res.redirect(303, withMessage(url, 'eroare', text));
  const editUrl = id => `/admin/sedinte/${encodeURIComponent(id)}`;
  const findMeeting = (data, id) => data.sedinte.find(m => m.id === id);

  app.get('/admin/sedinte', ...adminGuard, safely(async (req, res) => {
    const t = now();
    const data = await voceaStore.read();
    res.render('admin-vocea-sedinte', {
      ...common(req), nowMs: t,
      sedinte: [...data.sedinte].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0)),
    });
  }));

  app.post('/admin/sedinte', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const tip = Object.hasOwn(MEETING_TYPES, req.body.tip) ? req.body.tip : 'ordinara';
    const at = clean(req.body.data, 10) ? toAt(req.body.data, req.body.ora) : null;
    if (clean(req.body.data, 10) && !at) return fail(res, '/admin/sedinte', 'Data sau ora ședinței nu este validă.');
    const id = await voceaStore.update((data) => {
      const meeting = {
        id: newMeetingId(), tip, at, stare: 'programata', status: 'ciorna', loc: 'Sala de consiliu, Primăria Lenauheim',
        rezumat: '', puncte: [], documente: [], comentariu: { titlu: '', text: '', autor: defaultAuthor, notaReplica: true },
        createdAt: new Date(now()).toISOString(),
      };
      data.sedinte.push(meeting);
      return meeting.id;
    });
    ok(res, editUrl(id), 'Ședința a fost creată ca ciornă. Completează detaliile și publică-o când e gata.');
  }));

  app.get('/admin/sedinte/:id', ...adminGuard, safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const meeting = findMeeting(data, req.params.id);
    if (!meeting) return next();
    res.render('admin-vocea-sedinta', {
      ...common(req), meeting, inputs: toBucharestInputs(meeting.at), maxPdf: formatSize(MAX_PDF_BYTES), maxPdfBytes: MAX_PDF_BYTES,
    });
  }));

  // Salvează tot formularul (detalii, documente, puncte, comentariu). Folosit și înainte de ștergerea unui PDF,
  // ca modificările nesalvate din pagină să nu se piardă.
  async function saveMeeting(req, action) {
    let result = null;
    await voceaStore.update((data) => {
      const meeting = findMeeting(data, req.params.id);
      if (!meeting) throw new ValidationError('Ședința nu există.', 404);
      const { values, error } = readMeetingForm(req.body, new Set(meeting.documente.map(d => d.id)));
      if (error) { result = error; return; }
      for (const doc of meeting.documente) {
        const tip = req.body[`doc_tip_${doc.id}`];
        if (Object.hasOwn(DOC_TYPES, tip)) doc.tip = tip;
      }
      Object.assign(meeting, {
        tip: values.tip, stare: values.stare, at: values.at, loc: values.loc, rezumat: values.rezumat, puncte: values.puncte,
        comentariu: { ...values.comentariu, autor: values.comentariu.autor || defaultAuthor, updatedAt: new Date(now()).toISOString() },
        updatedAt: new Date(now()).toISOString(),
      });
      if (action === 'publica') { meeting.status = 'publicat'; meeting.publicatLa ||= new Date(now()).toISOString(); }
      if (action === 'ciorna') meeting.status = 'ciorna';
    });
    return result;
  }

  app.post('/admin/sedinte/:id', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const action = ['publica', 'ciorna', 'previzualizeaza'].includes(req.body.actiune) ? req.body.actiune : 'salveaza';
    const error = await saveMeeting(req, action);
    if (error) return fail(res, editUrl(req.params.id), error);
    if (action === 'previzualizeaza') {
      const meeting = findMeeting(await voceaStore.read(), req.params.id);
      return res.redirect(303, meetingUrl(meeting));
    }
    const messages = { publica: 'Ședința este publicată pe site.', ciorna: 'Ședința a fost retrasă: acum este ciornă și nu mai apare pe site.', salveaza: 'Modificările au fost salvate.' };
    ok(res, editUrl(req.params.id), messages[action]);
  }));

  // Încărcare PDF: corpul cererii este fișierul (application/pdf), tokenul CSRF vine în antet.
  app.post('/admin/sedinte/:id/documente', ...adminGuard,
    express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES + 1024 }),
    safely(async (req, res) => {
      if (!req.get('x-csrf-token') || req.get('x-csrf-token') !== req.session.csrfToken) {
        return res.status(403).json({ eroare: 'Cererea a expirat. Reîncarcă pagina.' });
      }
      if (!req.is('application/pdf')) return res.status(415).json({ eroare: 'Se acceptă doar fișiere PDF.' });
      const problem = verifyPdf(req.body);
      if (problem) return res.status(400).json({ eroare: problem });
      const nume = clean(String(req.query.nume || 'document.pdf').replace(/[\\/]/g, '-'), 120) || 'document.pdf';
      const tip = Object.hasOwn(DOC_TYPES, req.query.tip) ? req.query.tip : guessDocType(nume);
      const exists = findMeeting(await voceaStore.read(), req.params.id);
      if (!exists) return res.status(404).json({ eroare: 'Ședința nu există.' });
      const doc = { id: randomUUID(), nume, tip, marime: req.body.length, createdAt: new Date(now()).toISOString() };
      await pdfStore.put(doc.id, req.body);
      try {
        await voceaStore.update((data) => {
          const meeting = findMeeting(data, req.params.id);
          if (!meeting) throw new ValidationError('Ședința nu există.', 404);
          meeting.documente.push(doc);
        });
      } catch (error) {
        await pdfStore.delete(doc.id).catch(() => {});
        throw error;
      }
      res.status(201).json({ id: doc.id, nume: doc.nume, tip: doc.tip, marime: formatSize(doc.marime) });
    }));

  async function deleteDoc(docId) {
    const removed = await voceaStore.update((data) => {
      for (const meeting of data.sedinte) {
        const before = meeting.documente.length;
        meeting.documente = meeting.documente.filter(d => d.id !== docId);
        if (meeting.documente.length !== before) {
          for (const point of meeting.puncte) if (point.docId === docId) point.docId = '';
          return true;
        }
      }
      return false;
    });
    if (removed) await pdfStore.delete(docId);
    return removed;
  }

  app.post('/admin/sedinte/:id/documente/:docId/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const error = await saveMeeting(req, 'salveaza');
    await deleteDoc(req.params.docId);
    if (error) return fail(res, `${editUrl(req.params.id)}#documente`, `PDF-ul a fost șters, dar restul formularului nu s-a salvat: ${error}`);
    ok(res, `${editUrl(req.params.id)}#documente`, 'PDF-ul a fost șters.');
  }));

  app.post('/admin/sedinte/:id/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    if (req.body.confirmare !== 'STERGE') return fail(res, editUrl(req.params.id), 'Scrie STERGE în căsuța de confirmare pentru a șterge ședința.');
    const docs = await voceaStore.update((data) => {
      const meeting = findMeeting(data, req.params.id);
      data.sedinte = data.sedinte.filter(m => m.id !== req.params.id);
      return meeting ? meeting.documente.map(d => d.id) : [];
    });
    await Promise.all(docs.map(id => pdfStore.delete(id).catch(() => {})));
    ok(res, '/admin/sedinte', 'Ședința și documentele ei au fost șterse.');
  }));

  app.get('/admin/documente', ...adminGuard, safely(async (req, res) => {
    const data = await voceaStore.read();
    const docs = data.sedinte.flatMap(meeting => meeting.documente.map(doc => ({ doc, meeting })))
      .sort((a, b) => String(b.doc.createdAt).localeCompare(String(a.doc.createdAt)));
    res.render('admin-vocea-documente', {
      ...common(req), docs,
      total: formatSize(docs.reduce((sum, { doc }) => sum + (doc.marime || 0), 0)),
    });
  }));

  app.post('/admin/documente/:docId/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const removed = await deleteDoc(req.params.docId);
    (removed ? ok : fail)(res, '/admin/documente', removed ? 'PDF-ul a fost șters.' : 'PDF-ul nu mai există.');
  }));
}

// Data și ora din formular sunt ora României.
const toAt = (date, time) => bucharestToDate(clean(date, 10), clean(time, 5) || '10:00')?.toISOString() || null;

function guessDocType(name) {
  const n = name.toLowerCase();
  if (n.includes('convoc')) return 'convocator';
  if (n.includes('verbal') || /\bpv\b/.test(n)) return 'proces-verbal';
  if (n.includes('proiect')) return 'proiect';
  if (n.includes('hotar') || n.includes('hcl')) return 'hotarare';
  return 'altul';
}
