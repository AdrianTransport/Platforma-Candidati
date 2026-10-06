import express from 'express';
import { createHmac } from 'node:crypto';
import { isActive } from './anunturi.js';
import { bucharestDayKey } from './time.js';
import {
  MAX_PHOTOS, MAX_PHOTO_BYTES, THUMB_SIDE, UPLOAD_TTL_MS, UPLOADS_PER_DAY,
  checkPhoto, mimeOf, newPhotoId, deletePhotoFiles,
} from './poze.js';

// Amprenta sesiunii care a încărcat poza: doar ea o poate atașa unui anunț.
export const photoOwner = req => createHmac('sha256', process.env.SESSION_SECRET || 'local')
  .update(`poze:${req.session?.csrfToken || ''}`).digest('hex').slice(0, 24);

// Scoate încărcările vechi neatașate și pozele anunțurilor expirate; întoarce pozele de șters.
export function purgePhotos(data, now) {
  const remove = [];
  data.poze_incarcate = (data.poze_incarcate || []).filter((upload) => {
    if (now - Date.parse(upload.at) < UPLOAD_TTL_MS) return true;
    remove.push(upload);
    return false;
  });
  for (const ad of data.anunturi) {
    const expired = ad.expiraLa && Date.parse(ad.expiraLa) <= now;
    if (expired && ad.poze?.length) { remove.push(...ad.poze); ad.poze = []; }
  }
  return remove;
}

// Atașează pozele încărcate de această sesiune, în ordinea aleasă (prima = principala).
export function claimPhotos(data, ids, owner) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : ids ? [ids] : []).map(String))].slice(0, MAX_PHOTOS);
  const photos = [];
  for (const id of wanted) {
    const upload = (data.poze_incarcate || []).find(item => item.id === id && item.owner === owner && item.mic);
    if (!upload) continue;
    photos.push({ id: upload.id, width: upload.width, height: upload.height, format: upload.format, mic: upload.mic });
  }
  data.poze_incarcate = (data.poze_incarcate || []).filter(item => !photos.some(photo => photo.id === item.id));
  return photos;
}

export function registerPoze(app, ctx) {
  const { voceaStore, photoStore, now, safely, adminGuard, requireCsrf, clientIp, isActiveAdmin } = ctx;
  const raw = express.raw({ type: ['image/jpeg', 'image/webp'], limit: MAX_PHOTO_BYTES + 1024 });
  const json = (res, status, body) => { res.set('Cache-Control', 'private, no-store'); return res.status(status).json(body); };
  const csrfOk = req => Boolean(req.session?.csrfToken) && req.get('x-csrf-token') === req.session.csrfToken;

  async function cleanup() {
    const remove = await voceaStore.update(data => purgePhotos(data, now()));
    if (remove.length) await deletePhotoFiles(photoStore, remove);
  }

  // Pasul 1: poza mare (max. 1600 px), deja micșorată și fără EXIF în browser; serverul verifică din nou.
  app.post('/anunturi/poze', raw, safely(async (req, res) => {
    if (!csrfOk(req)) return json(res, 403, { eroare: 'Pagina a expirat. Reîncarcă formularul și adaugă din nou pozele.' });
    const photo = checkPhoto(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    if (photo.error) return json(res, 400, { eroare: photo.error });
    const t = now();
    const day = bucharestDayKey(t);
    const key = `poze:${day}:${createHmac('sha256', process.env.SESSION_SECRET || 'local').update(clientIp(req)).digest('hex').slice(0, 24)}`;
    const id = newPhotoId();
    const limited = await voceaStore.update((data) => {
      for (const name of Object.keys(data.limite)) if (name.startsWith('poze:') && !name.startsWith(`poze:${day}:`)) delete data.limite[name];
      if ((data.limite[key] || 0) >= UPLOADS_PER_DAY) return true;
      data.limite[key] = (data.limite[key] || 0) + 1;
      data.poze_incarcate = [...(data.poze_incarcate || []), {
        id, owner: photoOwner(req), at: new Date(t).toISOString(), width: photo.width, height: photo.height, format: photo.format, size: photo.buffer.length,
      }];
      return false;
    });
    if (limited) return json(res, 429, { eroare: 'Ai încărcat prea multe poze azi. Încearcă mâine.' });
    await photoStore.put(id, photo.buffer);
    cleanup().catch(() => {});
    json(res, 201, { id, width: photo.width, height: photo.height });
  }));

  // Pasul 2: miniatura pentru carduri (max. 640 px).
  app.post('/anunturi/poze/:id/mic', raw, safely(async (req, res) => {
    if (!csrfOk(req)) return json(res, 403, { eroare: 'Pagina a expirat. Reîncarcă formularul.' });
    const photo = checkPhoto(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { maxSide: THUMB_SIDE });
    if (photo.error) return json(res, 400, { eroare: photo.error });
    const owner = photoOwner(req);
    const found = await voceaStore.update((data) => {
      const upload = (data.poze_incarcate || []).find(item => item.id === req.params.id && item.owner === owner);
      if (!upload) return false;
      upload.mic = { width: photo.width, height: photo.height, format: photo.format };
      return true;
    });
    if (!found) return json(res, 404, { eroare: 'Poza nu mai există. Adaug-o din nou.' });
    await photoStore.put(`${req.params.id}-mic`, photo.buffer);
    json(res, 201, { id: req.params.id });
  }));

  // Pozele sunt publice doar cât anunțul e publicat și valabil; Super Admin le vede și la moderare.
  app.get('/anunturi/poze/:id/:size(mare|mic)', safely(async (req, res, next) => {
    const data = await voceaStore.read();
    const ad = data.anunturi.find(item => (item.poze || []).some(photo => photo.id === req.params.id));
    const small = req.params.size === 'mic';
    if (!ad) {
      // O poză încă neatașată o vede doar sesiunea care a încărcat-o (formularul reafișat după o eroare).
      const upload = (data.poze_incarcate || []).find(item => item.id === req.params.id && item.owner === photoOwner(req));
      const bytes = upload && await photoStore.get(small ? `${upload.id}-mic` : upload.id);
      if (!bytes) return next();
      res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': mimeOf(small ? upload.mic?.format : upload.format), 'X-Content-Type-Options': 'nosniff' });
      return res.send(bytes);
    }
    const preview = req.session?.rol === 'admin' && isActiveAdmin(req);
    if (!isActive(ad, now()) && !preview) return next();
    const photo = ad.poze.find(item => item.id === req.params.id);
    const bytes = await photoStore.get(small ? `${photo.id}-mic` : photo.id);
    if (!bytes) return next();
    if (isActive(ad, now())) {
      res.set('Cache-Control', 'public, max-age=600');
      res.set('Netlify-CDN-Cache-Control', 'public, durable, max-age=600, stale-while-revalidate=60');
    } else {
      res.set('Cache-Control', 'private, no-store');
    }
    res.set({ 'Content-Type': mimeOf(small ? photo.mic?.format : photo.format), 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' });
    res.send(bytes);
  }));

  // Moderare: Super Admin scoate o poză nepotrivită fără să respingă anunțul.
  app.post('/admin/anunturi/:id/poze/:pid/sterge', ...adminGuard, requireCsrf, safely(async (req, res) => {
    const removed = await voceaStore.update((data) => {
      const ad = data.anunturi.find(item => item.id === req.params.id);
      const photo = ad?.poze?.find(item => item.id === req.params.pid);
      if (!photo) return null;
      ad.poze = ad.poze.filter(item => item !== photo);
      return photo;
    });
    if (removed) await deletePhotoFiles(photoStore, [removed]);
    const back = req.body.inapoi === 'lista' ? '/admin/anunturi' : `/admin/anunturi/${encodeURIComponent(req.params.id)}`;
    res.redirect(303, `${back}?mesaj=${encodeURIComponent(removed ? 'Poza a fost ștearsă.' : 'Poza nu mai există.')}`);
  }));

  return { cleanup };
}
