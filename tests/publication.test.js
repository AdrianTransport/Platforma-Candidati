import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduledDate, localDateTime, displayDate, isPublished, articleInput, profileInput, filterArticles } from '../publication.js';

const now = Date.parse('2026-01-01T00:00:00Z');
const body = { titlu: 'Titlu', continut: 'Text articol', tip: 'idee', categorie: 'Proiecte' };

test('Ora României: iarnă/vară și conversie simetrică', () => {
  assert.equal(parseScheduledDate('2026-02-10T12:30', now), '2026-02-10T10:30:00.000Z');
  assert.equal(parseScheduledDate('2026-07-10T12:30', now), '2026-07-10T09:30:00.000Z');
  assert.equal(localDateTime('2026-07-10T09:30:00Z'), '2026-07-10T12:30');
  assert.match(displayDate('2026-07-10T09:30:00Z'), /12:30/);
});
test('Date invalide, trecute, ore inexistente/duble respinse', () => {
  for (const date of ['', 'nu', '2026-02-30T12:00', '2026-03-29T03:30', '2026-10-25T03:30', '2025-12-01T12:00', '2026-01-01T02:00']) {
    assert.throws(() => parseScheduledDate(date, now));
  }
  assert.throws(() => parseScheduledDate(['2026-02-10T12:30'], now));
});
test('Vizibilitate exact la termen, fără a modifica înregistrarea', () => {
  const article = articleInput({ ...body, status: 'programat', data_programata: '2026-07-10T12:30' }, null, now);
  const at = Date.parse(article.data_programata);
  assert.equal(isPublished(article, at - 1), false);
  assert.equal(isPublished(article, at), true);
  assert.equal(article.status, 'programat');
  assert.equal(isPublished({ status: 'ciorna' }, now), false);
  assert.equal(isPublished({ status: 'programat', data_programata: 'invalid' }, now), false);
  assert.equal(isPublished({ status: 'publicat' }, now), true);
});
test('Ciornă, publicare imediată, retragere și reprogramare', () => {
  const draft = articleInput({ ...body, status: 'ciorna', data_programata: 'invalid' }, null, now);
  assert.equal(draft.data_publicare, null);
  const live = articleInput({ ...body, status: 'publicat' }, draft, now);
  assert.equal(live.data_publicare, new Date(now).toISOString());
  assert.equal(articleInput({ ...body, status: 'publicat' }, live, now + 60000).data_publicare, live.data_publicare);
  const scheduled = articleInput({ ...body, status: 'programat', data_programata: '2026-07-10T12:30' }, live, now);
  assert.equal(scheduled.data_publicare, null);
  const due = Date.parse(scheduled.data_programata);
  assert.equal(articleInput({ ...body, status: 'publicat' }, scheduled, due + 60000).data_publicare, scheduled.data_programata);
  assert.equal(articleInput({ ...body, status: 'ciorna' }, scheduled, due).data_programata, null);
});
test('Validare strictă articole și contact; câmpurile de acces nu pot fi schimbate', () => {
  for (const extra of [{ titlu: [] }, { titlu: '' }, { continut: 'x'.repeat(30001) }, { tip: 'evil' }, { status: 'aprobat' }]) {
    assert.throws(() => articleInput({ ...body, status: 'publicat', ...extra }, null, now));
  }
  assert.throws(() => profileInput({ email_contact: 'a@b.ro\nBcc:other@b.ro' }));
  assert.throws(() => profileInput({ telefon_contact: 'javascript:alert(1)' }));
  assert.throws(() => profileInput({ zona: ['Timișoara'] }));
  const profile = profileInput({ email_contact: ' PUBLIC@example.ro ', telefon_contact: '+40 (722) 123-456', role: 'admin', module: { site: true } });
  assert.equal(profile.email_contact, 'public@example.ro');
  assert.equal(profile.role, undefined);
  assert.equal(profile.module, undefined);
});
test('Căutare cu diacritice, categorie combinată, interogări invalide', () => {
  const articles = [{ titlu: 'Școală nouă', continut: 'Timișoara', categorie: 'Proiecte' }, { titlu: 'Program', continut: 'școală', categorie: 'Program' }];
  assert.equal(filterArticles(articles, { cauta: 'SCOALA' }).filtrate.length, 2);
  assert.equal(filterArticles(articles, { cauta: 'scoala', categorie: 'Proiecte' }).filtrate.length, 1);
  assert.equal(filterArticles(articles, { cauta: 'xyz' }).filtrate.length, 0);
  assert.throws(() => filterArticles(articles, { cauta: { q: 'x' } }));
});
