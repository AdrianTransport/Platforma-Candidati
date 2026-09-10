import test from 'node:test';
import assert from 'node:assert/strict';
import { descriereDispozitiv, limitaRaportariDepasita, purjeazaRaportariExpirate,
  moderareRaportareInput, raportareInput, statisticiPublice, totalPublic } from '../cost-reports.js';

test('raportarea anonimă nu stochează un nume', () => {
  const raportare = raportareInput({
    localitate: 'Bulgăruș', perioada: 'august 2026', suma: '218',
    mod_raspuns: 'anonim', tip_platitor: 'fizica', confirmare_informare: 'on',
  }, 'salubritate');
  assert.equal(raportare.nume, '');
  assert.equal(raportare.mod_raspuns, 'anonim');
});

test('raportarea cu nume cere acordul explicit', () => {
  assert.throws(() => raportareInput({
    localitate: 'Lenauheim', perioada: 'august 2026', suma: '180',
    mod_raspuns: 'nume', nume: 'Persoană Test', consum_mc: '12', confirmare_informare: 'on',
  }, 'apa'), /acordul/);
});

test('raportarea cere confirmarea informării și a caracterului voluntar', () => {
  assert.throws(() => raportareInput({
    localitate: 'Grabaț', perioada: 'august 2026', suma: '200',
    mod_raspuns: 'anonim', consum_mc: '10',
  }, 'apa'), /informarea de confidențialitate/);
});

test('Super Adminul poate corecta datele statistice, dar nu poate introduce sume de ordinul milioanelor', () => {
  assert.deepEqual(moderareRaportareInput({
    localitate: 'Lenauheim', perioada: 'septembrie 2026', suma: '245,50',
    consum_mc: '11,5', numar_persoane: '3',
  }, 'apa'), {
    localitate: 'Lenauheim', perioada: 'septembrie 2026', suma: 245.5,
    consum_mc: 11.5, numar_persoane: 3,
  });
  assert.throws(() => moderareRaportareInput({
    localitate: 'Lenauheim', perioada: 'septembrie 2026', suma: '1000000',
  }, 'apa'), /cel mult 100\.000 lei/);
});

test('prima raportare este afișată public numai ca interval', () => {
  const grupuri = statisticiPublice([{
    tip: 'salubritate', localitate: 'Grabaț', perioada: '2026',
    suma: 218, nume: 'Nume privat', mod_raspuns: 'nume',
  }], 'salubritate');
  assert.deepEqual(grupuri, [{
    localitate: 'Grabaț', perioada: '2026', numarRaspunsuri: 1,
    sumaMedianaInterval: '200-250 lei', sumaMinInterval: '200-250 lei', sumaMaxInterval: '200-250 lei',
  }]);
  assert.equal(JSON.stringify(grupuri).includes('Nume privat'), false);
  assert.equal(JSON.stringify(grupuri).includes('218'), false);
});

test('totalul exact rămâne ascuns până la cinci raportări', () => {
  const raportari = Array.from({ length: 4 }, (_, index) => ({ tip: 'apa', suma: 100 + index }));
  assert.equal(totalPublic(raportari, 'apa'), null);
  raportari.push({ tip: 'apa', suma: 104 });
  assert.deepEqual(totalPublic(raportari, 'apa'), { suma: 510, numarRaspunsuri: 5 });
});

test('limita permite trei raportări per IP și serviciu, dar o respinge pe a patra', () => {
  const acum = Date.parse('2026-09-10T12:00:00Z');
  const raportari = Array.from({ length: 3 }, (_, id) => ({
    id, tip: 'apa', ip_hash: 'hash-test', created_at: '2026-09-01T12:00:00Z',
  }));
  assert.equal(limitaRaportariDepasita(raportari, 'apa', 'hash-test', acum), true);
  assert.equal(limitaRaportariDepasita(raportari, 'salubritate', 'hash-test', acum), false);
  assert.equal(limitaRaportariDepasita(raportari, 'apa', 'alt-hash', acum), false);
});

test('după 90 de zile dispar datele identificabile, dar statistica sumei rămâne', () => {
  const db = { data: { raportari_costuri: [{
    id: 7, tip: 'salubritate', localitate: 'Bulgăruș', perioada: '2026', suma: 418,
    nume: 'Nume privat', observatii: 'Detaliu privat', ip_hash: 'hash-secret',
    dispozitiv: 'Telefon Android · Android · Chrome', dispozitiv_acord_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  }], raportari_costuri_arhiva: [] } };
  assert.equal(purjeazaRaportariExpirate(db, Date.parse('2026-04-02T00:00:01Z')), true);
  assert.deepEqual(db.data.raportari_costuri, []);
  assert.deepEqual(db.data.raportari_costuri_arhiva, [{
    tip: 'salubritate', localitate: 'Bulgăruș', perioada: '2026',
    suma_interval: '400-450 lei', numar_raportari: 1, suma_totala: 418,
  }]);
  const serializat = JSON.stringify(db.data);
  assert.doesNotMatch(serializat, /Nume privat|Detaliu privat|hash-secret|Telefon Android|2026-01-01T00:00:00Z/);
  assert.deepEqual(statisticiPublice([], 'salubritate', db.data.raportari_costuri_arhiva), [{
    localitate: 'Bulgăruș', perioada: '2026', numarRaspunsuri: 1,
    sumaMedianaInterval: '400-450 lei', sumaMinInterval: '400-450 lei', sumaMaxInterval: '400-450 lei',
  }]);
});

test('informația despre dispozitiv este generală, fără identificator hardware', () => {
  assert.equal(descriereDispozitiv('Mozilla/5.0 (Linux; Android 14; Mobile) Chrome/120.0'),
    'Telefon Android · Android · Chrome');
  assert.equal(descriereDispozitiv('Mozilla/5.0 (Windows NT 10.0) Edg/120.0'),
    'Calculator · Windows · Edge');
});
