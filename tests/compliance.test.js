import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalCommentStore } from '../comment-store.js';
import {
  TERMS_VERSION,
  candidateComplianceMissing,
  createCompliance,
  legalProfileInput,
  platformInfo,
  publicTransparency,
  transparencySnapshot,
} from '../compliance.js';

const secret = 'test-compliance-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const platform = platformInfo({ PLATFORM_NAME: 'Test', PLATFORM_OPERATOR_NAME: 'Operator SRL',
  PLATFORM_OPERATOR_ID: 'RO123', PLATFORM_LEGAL_EMAIL: 'JURIDIC@EXAMPLE.TEST', PLATFORM_LEGAL_ADDRESS: 'Adresă test' });

function legalCandidate() {
  return {
    id: 7, nume_candidat: 'Ana Test', functie_candidatura: 'Primar', zona: 'Timișoara', judet: 'Timiș',
    tip_candidat: 'independent', entitate_responsabila: 'Ana Test', finantator_materiale: 'Ana Test',
    scrutin: 'Alegeri locale de test', cod_mandatar_financiar: 'MANDAT-7', tip_contract: 'platit',
    numar_contract: 'CONTRACT-7', data_contract: '2026-06-01', valoare_contract: 1200, moneda_contract: 'RON',
    confirmare_mandatar: true, terms_version: TERMS_VERSION, terms_accepted_at: '2026-06-01T00:00:00Z',
    editorial_responsibility_accepted_at: '2026-06-01T00:00:00Z',
  };
}

test('Profil juridic strict, operator complet și instantaneu de transparență', () => {
  assert.equal(platform.complete, true);
  assert.equal(platform.legalEmail, 'juridic@example.test');
  assert.equal(platformInfo({}).complete, false);
  const input = legalProfileInput({ tip_candidat: 'independent', entitate_responsabila: 'Ana Test',
    finantator_materiale: 'Ana Test', scrutin: 'Alegeri locale', cod_mandatar_financiar: 'MANDAT',
    tip_contract: 'gratuit', numar_contract: 'G-1', data_contract: '2026-06-01', valoare_contract: '999',
    moneda_contract: 'RON', campanie_start: '2026-06-01', campanie_end: '2026-06-30', confirmare_mandatar: 'on' });
  assert.equal(input.valoare_contract, 0);
  assert.equal(input.confirmare_mandatar, true);
  assert.throws(() => legalProfileInput({ ...input, tip_contract: 'platit', valoare_contract: '0' }), /în afara limitelor/);
  assert.throws(() => legalProfileInput({ ...input, campanie_start: '2026-07-01', campanie_end: '2026-06-30' }), /nu poate fi înainte/);
  const candidate = legalCandidate();
  assert.deepEqual(candidateComplianceMissing(candidate, platform), []);
  assert.ok(candidateComplianceMissing({ ...candidate, terms_version: '' }, platform).includes('acceptarea termenilor și a responsabilității editoriale'));
  assert.ok(candidateComplianceMissing(candidate, platformInfo({})).includes('datele juridice ale operatorului platformei'));
  const snapshot = transparencySnapshot(candidate, '2026-06-02T00:00:00Z');
  candidate.finantator_materiale = 'Alt finanțator';
  assert.equal(snapshot.finantat_de, 'Ana Test');
  assert.equal(publicTransparency(candidate, { transparenta: snapshot }).finantat_de, 'Ana Test');
});

test('Profilul civic nu cere date electorale înainte de 2028, dar modul electoral le cere', () => {
  const civic = {
    functie_candidatura: 'Primar', zona: 'Lenauheim', tip_candidat: 'independent',
    entitate_responsabila: 'Ana Test', terms_version: TERMS_VERSION,
    terms_accepted_at: '2026-09-08T00:00:00Z', editorial_responsibility_accepted_at: '2026-09-08T00:00:00Z',
  };
  assert.deepEqual(candidateComplianceMissing(civic, platform, false), []);
  const electoralMissing = candidateComplianceMissing(civic, platform, true);
  assert.ok(electoralMissing.includes('codul mandatarului financiar'));
  assert.ok(electoralMissing.includes('numărul contractului'));
  const input = legalProfileInput({ tip_candidat: 'independent', entitate_responsabila: 'Ana Test' }, false);
  assert.equal(input.cod_mandatar_financiar, '');
  assert.equal(input.tip_contract, 'gratuit');
});

test('Acceptări, sesizări, dovezi, ratelimit, versiuni și audit append-only', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-compliance-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-06-10T09:00:00Z');
  const store = createLocalCommentStore(directory);
  const compliance = createCompliance({ store, now: () => clock, secret });
  const candidate = legalCandidate();
  const article = { id: 11, titlu: 'Material test', continut: 'Conținut păstrat ca dovadă', rezumat: 'Rezumat',
    status: 'publicat', data_publicare: '2026-06-09T12:00:00Z', transparenta: transparencySnapshot(candidate, '2026-06-09T12:00:00Z') };

  const acceptance = await compliance.acceptTerms({ candidateId: candidate.id, ip: '192.0.2.10' });
  assert.equal(acceptance.terms_version, TERMS_VERSION);
  assert.ok(acceptance.request_fingerprint);
  assert.ok(!JSON.stringify(acceptance).includes('192.0.2.10'));

  const body = { motiv: 'electoral', descriere: 'Datele de finanțare ale acestui material trebuie verificate.',
    nume: 'Cititor', email: 'cititor@example.test', acord_contact: 'on', buna_credinta: 'on' };
  const first = await compliance.submitReport({ candidate, article, body, ip: '192.0.2.20' });
  article.titlu = 'Titlu schimbat ulterior';
  await compliance.submitReport({ candidate, article, body: { ...body, email: '', acord_contact: '' }, ip: '192.0.2.20' });
  await assert.rejects(() => compliance.submitReport({ candidate, article, body, ip: '192.0.2.20' }), error => error.status === 429);
  let report = (await compliance.listReports()).find(item => item.id === first.id);
  assert.equal(report.evidence.titlu, 'Material test');
  assert.equal(report.status, 'noua');
  await assert.rejects(() => compliance.resolveReport({ candidateId: 7, articleId: 11, id: first.id,
    status: 'in_analiza', action: 'suspend', note: 'Acțiune incompatibilă.', adminId: 1, version: 'initial' }), /nu corespunde/);
  clock += 1000;
  await compliance.resolveReport({ candidateId: 7, articleId: 11, id: first.id, status: 'continut_suspendat',
    action: 'suspend', note: 'Suspendat pentru verificare.', adminId: 1, version: 'initial' });
  await assert.rejects(() => compliance.resolveReport({ candidateId: 7, articleId: 11, id: first.id,
    status: 'inchisa', action: 'restore', note: 'Versiune veche.', adminId: 1, version: 'initial' }), error => error.status === 409);
  report = (await compliance.listReports()).find(item => item.id === first.id);
  assert.equal(report.status, 'continut_suspendat');
  assert.equal(report.history.length, 1);

  await Promise.all(Array.from({ length: 30 }, (_, index) => compliance.audit({ actorId: 1, actorRole: 'admin',
    action: 'test_event', targetType: 'test', targetId: index, details: { index } })));
  const events = await compliance.listAudit(100);
  assert.equal(events.filter(event => event.action === 'test_event').length, 30);
  assert.ok(events.some(event => event.action === 'report_submitted'));
});
