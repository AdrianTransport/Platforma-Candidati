import test from 'node:test';
import assert from 'node:assert/strict';
import { raportareInput, statisticiPublice, totalPublic } from '../cost-reports.js';

test('raportarea anonimă nu stochează un nume', () => {
  const raportare = raportareInput({
    localitate: 'Bulgăruș', perioada: 'august 2026', suma: '218',
    mod_raspuns: 'anonim', tip_platitor: 'fizica',
  }, 'salubritate');
  assert.equal(raportare.nume, '');
  assert.equal(raportare.mod_raspuns, 'anonim');
});

test('raportarea cu nume cere acordul explicit', () => {
  assert.throws(() => raportareInput({
    localitate: 'Lenauheim', perioada: 'august 2026', suma: '180',
    mod_raspuns: 'nume', nume: 'Persoană Test', consum_mc: '12',
  }, 'apa'), /acordul/);
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
