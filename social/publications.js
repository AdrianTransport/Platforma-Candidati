import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dosarView } from '../vocea/dosare.js';
import { isActive as adIsActive, adTypeName, validAdType } from '../vocea/anunturi.js';
import { meetingTitle, meetingUrl, isPublished as meetingPublished } from '../vocea/sedinte.js';
import { formatDate } from '../vocea/time.js';

// O „publicație” comună pentru distribuire: știri, ședințe, procese, anunțuri și articolele candidaților.
export const TYPES = { stire: 'Știre', sedinta: 'Ședință de consiliu', dosar: 'Proces cu Primăria', anunt: 'Anunț', articol: 'Articol candidat' };

const plain = (text, max) => String(text || '').replace(/[#*>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// Marcajul obligatoriu pentru conținutul candidaților: material politic și cine îl plătește.
export function politicalLabel({ electoral, candidate, payer }) {
  return `${electoral ? 'Material de propagandă electorală' : 'Material politic'} · ${candidate} · Plătit de ${payer || candidate}`;
}

export function createPublications({ db, voceaStore, editorial, baseDir, now, isPortalPostPublic, portalCandidate, isArticlePublished, canPublishSite, electoralMode, publicationDate, portalPublicationDate }) {
  async function photoBuffer(url) {
    if (!url) return null;
    const media = /^\/media\/([\w-]+)$/.exec(url) || /^https?:\/\/[^/]+\/media\/([\w-]+)$/.exec(url);
    if (media) {
      const image = await editorial.media(media[1]).catch(() => null);
      return image?.base64 ? Buffer.from(String(image.base64).replace(/^data:[^,]+,/, ''), 'base64') : null;
    }
    // Doar fișiere proprii din public/ (fără cereri către alte site-uri).
    const local = /^\/((?:assets|candidate-assets|img)\/[\w./-]+)$/.exec(url);
    if (local && !local[1].includes('..')) return fs.readFile(path.join(baseDir, 'public', local[1])).catch(() => null);
    return null;
  }

  function fromPortalPost(post) {
    const candidate = post.tip === 'campanie' ? portalCandidate(post) : null;
    return {
      type: 'stire', id: post.slug, title: post.titlu, summary: plain(post.rezumat || post.continut, 300),
      kind: post.tip === 'campanie' ? 'Campanie candidat' : `Știre · ${post.categorie || 'Actualitate'}`,
      meta: formatDate(portalPublicationDate(post)), path: `/actualitate/${encodeURIComponent(post.slug)}`,
      photoUrl: post.imagine_url || '', updatedAt: post.updated_at || portalPublicationDate(post),
      political: candidate ? politicalLabel({ electoral: electoralMode, candidate: candidate.nume_candidat,
        payer: post.transparenta?.finantat_de || post.finantator || candidate.finantator_materiale }) : '',
    };
  }

  function fromArticle(article, user) {
    return {
      type: 'articol', id: String(article.id), title: article.titlu, summary: plain(article.continut, 300),
      kind: `${user.nume_candidat} · ${article.categorie || 'Articol'}`, meta: formatDate(publicationDate(article)),
      path: `/site/${encodeURIComponent(user.subdomeniu)}/articol/${article.id}`, photoUrl: article.imagine_url || '',
      updatedAt: article.updated_at || publicationDate(article),
      political: politicalLabel({ electoral: electoralMode, candidate: user.nume_candidat,
        payer: article.transparenta?.finantat_de || user.finantator_materiale || user.entitate_responsabila }),
    };
  }

  // Găsește o publicație publică după tip și identificator; null dacă nu există sau nu e publică.
  async function find(type, id, { includeDrafts = false } = {}) {
    const t = now();
    if (type === 'stire') {
      const post = db.data.portal_posts.find(item => item.slug === id || String(item.id) === id);
      return post && (includeDrafts || isPortalPostPublic(post)) ? fromPortalPost(post) : null;
    }
    if (type === 'articol') {
      const article = db.data.articole.find(item => String(item.id) === id);
      const user = article && db.data.users.find(item => item.id === article.user_id);
      return article && user && canPublishSite(user) && (includeDrafts || isArticlePublished(article)) ? fromArticle(article, user) : null;
    }
    const data = await voceaStore.read();
    if (type === 'sedinta') {
      const meeting = data.sedinte.find(item => item.id === id);
      if (!meeting || (!includeDrafts && !meetingPublished(meeting))) return null;
      return {
        type, id, title: meetingTitle(meeting), kind: 'Ședința Consiliului Local', meta: formatDate(meeting.at),
        summary: plain(meeting.comentariu?.titlu || meeting.rezumat || meeting.puncte.map(p => p.titlu).join('; '), 300),
        path: meetingUrl(meeting), photoUrl: '', updatedAt: meeting.updatedAt || meeting.publicatLa || meeting.createdAt, political: '',
      };
    }
    if (type === 'dosar') {
      const dosar = data.dosare.find(item => item.id === id);
      if (!dosar) return null;
      const view = dosarView(dosar, t);
      return {
        type, id, title: dosar.titlu, kind: `Proces cu Primăria${dosar.numar ? ` · ${dosar.numar}` : ''}`,
        meta: view.termenLabel.replace(/^TERMEN: /, 'Termen: ').toLowerCase().replace(/^termen/, 'Termen'),
        summary: plain(dosar.obiect, 300), path: `/dosare/${encodeURIComponent(dosar.id)}`, photoUrl: '',
        updatedAt: dosar.updatedAt || dosar.createdAt, political: '',
      };
    }
    if (type === 'anunt') {
      const ad = data.anunturi.find(item => item.id === id);
      if (!ad || !validAdType(ad.tip) || (!includeDrafts && !adIsActive(ad, t))) return null;
      return {
        type, id, title: ad.titlu, kind: `Anunț · ${adTypeName(ad.tip)}`, meta: formatDate(ad.publicatLa || ad.createdAt),
        summary: plain(ad.text, 300), path: `/anunturi/${ad.id}`, photoUrl: '', updatedAt: ad.updatedAt || ad.publicatLa, political: '',
      };
    }
    return null;
  }

  // Cele mai recente publicații, pentru panoul „Distribuie” din Super Admin.
  async function recent(limit = 40) {
    const t = now();
    const data = await voceaStore.read();
    const items = [
      ...db.data.portal_posts.filter(isPortalPostPublic).map(fromPortalPost),
      ...db.data.articole.filter(isArticlePublished).flatMap((article) => {
        const user = db.data.users.find(item => item.id === article.user_id);
        return user && canPublishSite(user) ? [fromArticle(article, user)] : [];
      }),
      ...data.sedinte.filter(meetingPublished).map(m => ({ type: 'sedinta', id: m.id, title: meetingTitle(m), updatedAt: m.updatedAt || m.publicatLa, path: meetingUrl(m) })),
      ...data.dosare.map(d => ({ type: 'dosar', id: d.id, title: d.titlu, updatedAt: d.updatedAt || d.createdAt, path: `/dosare/${encodeURIComponent(d.id)}` })),
      ...data.anunturi.filter(a => validAdType(a.tip) && adIsActive(a, t)).map(a => ({ type: 'anunt', id: a.id, title: a.titlu, updatedAt: a.publicatLa, path: `/anunturi/${a.id}` })),
    ];
    return items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
  }

  return { find, recent, photoBuffer };
}

// Versiunea imaginii se schimbă când se schimbă publicația: CDN-ul o poate ține mult timp.
export function imageVersion(publication) {
  return createHash('sha256').update(JSON.stringify([publication.title, publication.kind, publication.meta, publication.photoUrl, publication.political, publication.updatedAt])).digest('hex').slice(0, 10);
}

export const imageUrl = (publication, format) => `/imagini/${format}/${publication.type}/${encodeURIComponent(publication.id)}.jpg?v=${imageVersion(publication)}`;
