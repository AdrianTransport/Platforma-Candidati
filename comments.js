import { createHmac, randomUUID } from 'node:crypto';
import { createCommentStore } from './comment-store.js';
import { textField, ValidationError } from './publication.js';

export const COMMENT_STATUS = new Set(['in_asteptare', 'aprobat', 'respins', 'sters']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DAY = 86400000;

export function createComments({ store = createCommentStore(), now = () => Date.now(), secret = process.env.SESSION_SECRET } = {}) {
  async function records(prefix) {
    const values = [];
    // Loturi mici pentru a nu porni mii de cereri Blobs simultan.
    const keys = await store.keys(prefix);
    for (let index = 0; index < keys.length; index += 20) {
      values.push(...(await Promise.all(keys.slice(index, index + 20).map(key => store.get(key)))).filter(Boolean));
    }
    return values;
  }

  function applyEvents(comment, events) {
    const history = events.filter(e => e.comment_id === comment.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    // Ștergerea logică este terminală, inclusiv pentru moderări simultane.
    const last = history.findLast(e => e.status === 'sters') || history.at(-1);
    return { ...comment, status: last?.status || 'in_asteptare', version: last?.id || 'initial', history };
  }

  async function list(candidateId, articleId) {
    const prefix = candidateId == null ? 'comments/' : `comments/${candidateId}/${articleId}/`;
    const eventPrefix = candidateId == null ? 'moderation/' : `moderation/${candidateId}/${articleId}/`;
    const [comments, events] = await Promise.all([records(prefix), records(eventPrefix)]);
    return comments.map(c => applyEvents(c, events)).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  }

  async function rateLimit(ip) {
    if (!secret || secret.length < 32) throw new ValidationError('Comentariile necesită SESSION_SECRET configurat cu minimum 32 de caractere.', 503);
    const timestamp = now();
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const hash = createHmac('sha256', secret).update(`comments:${day}:${ip}`).digest('hex');
    const prefix = `rate/${day}/${hash}/`;
    const recent = await records(prefix);
    if (recent.filter(r => timestamp - r.time < 60000).length >= 1 || recent.length >= 10) {
      throw new ValidationError('Prea multe comentarii. Așteaptă un minut; limita este de 10 trimiteri pe zi.', 429);
    }
    await store.set(`${prefix}${randomUUID()}`, { time: timestamp });
    // Identificatorul se schimbă zilnic, nu conține IP și nu este legat de text.
    // Curățare oportunistă: la următoarea trimitere ștergem zilele expirate.
    const cutoff = new Date(timestamp - DAY).toISOString().slice(0, 10);
    for (const key of await store.keys('rate/')) {
      if (key.split('/')[1] < cutoff) await store.delete(key);
    }
  }

  return {
    list,
    async submit({ candidateId, articleId, body, ip }) {
      if (body.website) throw new ValidationError('Trimitere invalidă.');
      const nume = textField(body.nume, 'Nume sau pseudonim', 80, true);
      const text = textField(body.text, 'Comentariu', 2000, true);
      if (text.length < 3) throw new ValidationError('Comentariul trebuie să conțină minimum 3 caractere.');
      if (body.acord_publicare !== 'on') throw new ValidationError('Confirmă că numele și comentariul pot fi afișate public după moderare.');
      await rateLimit(ip);
      const comment = { id: randomUUID(), user_id: candidateId, articol_id: articleId, nume, text, created_at: new Date(now()).toISOString() };
      await store.set(`comments/${candidateId}/${articleId}/${comment.id}`, comment);
      return comment;
    },
    async moderate({ candidateId, articleId, id, status, adminId, version }) {
      if (!UUID.test(id) || !['aprobat', 'respins', 'sters'].includes(status)) throw new ValidationError('Acțiune de moderare invalidă.');
      const comment = await store.get(`comments/${candidateId}/${articleId}/${id}`);
      if (!comment) throw new ValidationError('Comentariul nu există.', 404);
      const eventPrefix = `moderation/${candidateId}/${articleId}/${id}/`;
      const current = applyEvents(comment, await records(eventPrefix));
      if (current.status === 'sters' || current.version !== version) {
        throw new ValidationError('Comentariul a fost deja modificat. Reîncarcă lista înainte de moderare.', 409);
      }
      const event = { id: randomUUID(), comment_id: id, admin_id: adminId, status, created_at: new Date(now()).toISOString(), previous_version: version };
      await store.set(`${eventPrefix}${event.id}`, event);
      return event;
    },
  };
}
