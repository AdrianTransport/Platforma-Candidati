import { internalImageId, imageBytes } from './editorial.js';
import { isPublished, ValidationError } from './publication.js';

export function attachEditorialRoutes(app, {
  db, editorial, requireRole, requireActiveAccount, requireCsrf, now, isPortalPostPublished = () => false,
}) {
  const candidate = [requireRole('candidate'), requireActiveAccount, (req, res, next) => {
    if (!db.data.users.find(u => u.id === req.session.userId)?.module?.site) {
      return res.status(403).json({ eroare: 'Modulul site nu este activ.' });
    }
    res.set('Cache-Control', 'private, no-store');
    next();
  }];
  const json = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const known = error instanceof ValidationError;
      res.status(known ? error.status : 503).json({
        eroare: known ? error.message : 'Operațiunea nu a putut fi salvată. Nu a fost publicat nimic.',
      });
    }
  };
  app.get('/dashboard/ai/config', ...candidate, (req, res) => res.json(editorial.config()));
  app.post('/dashboard/genereaza-ai', ...candidate, requireCsrf, json(async (req, res) => {
    res.status(202).json(await editorial.start(req.session.userId, req.body));
  }));
  app.post('/dashboard/ai/:id/status', ...candidate, requireCsrf, json(async (req, res) => {
    res.json(await editorial.status(req.session.userId, req.params.id));
  }));
  app.post('/dashboard/media', ...candidate, requireCsrf, json(async (req, res) => {
    if (req.body.acord_imagine !== true) throw new ValidationError('Confirmă dreptul de utilizare a imaginii.');
    res.status(201).json(await editorial.upload(req.session.userId, req.body.base64));
  }));
  app.get('/media/:id', json(async (req, res) => {
    const image = await editorial.media(req.params.id);
    const owner = image && db.data.users.find(u => u.id === image.userId && u.activ);
    const candidateOwner = owner?.role === 'candidate' && owner.status_cont === 'activ' && owner.module?.site;
    const adminOwner = owner?.role === 'admin';
    const ownPreview = owner && req.session.userId === owner.id && req.session.rol === owner.role;
    const published = candidateOwner && db.data.articole.some(a => a.user_id === owner.id
      && internalImageId(a.imagine_url) === req.params.id && isPublished(a, now()));
    const publishedOnPortal = adminOwner && db.data.portal_posts.some(post =>
      internalImageId(post.imagine_url) === req.params.id && isPortalPostPublished(post));
    const publishedOnProfile = candidateOwner && [owner.fotografie_profil_url, owner.fotografie_coperta_url]
      .some(url => internalImageId(url) === req.params.id);
    if (!owner || (!ownPreview && !published && !publishedOnPortal && !publishedOnProfile)) {
      res.set('Cache-Control', 'private, no-store');
      return res.status(404).send('Imagine inexistentă.');
    }
    if (published || publishedOnPortal) {
      // Imagine publica, deja publicata: continutul de la acest ID nu se mai schimba
      // niciodata (ID unic per imagine) - cache lung, atat in browser cat si in CDN,
      // ca sa nu se re-descarce la fiecare vizita.
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Netlify-CDN-Cache-Control', 'public, durable, max-age=31536000, immutable');
    } else {
      // Profilul și previzualizările reevaluează accesul la fiecare cerere.
      res.set('Cache-Control', 'private, no-store');
    }
    const { bytes, mime } = imageBytes(image.base64);
    res.set({ 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(bytes);
  }));
}
