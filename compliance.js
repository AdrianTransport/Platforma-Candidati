import { createHmac, randomUUID } from 'node:crypto';
import { createComplianceStore } from './compliance-store.js';
import { textField, ValidationError } from './publication.js';

export const TERMS_VERSION = '2026-09-07';
export const REPORT_STATUS = new Set(['noua', 'in_analiza', 'continut_suspendat', 'respinsa', 'inchisa']);
export const REPORT_REASONS = new Set(['defaimare', 'amenintare', 'discriminare', 'date_personale', 'drepturi_autor', 'informatii_false', 'electoral', 'altul']);
const CONTRACT_TYPES = new Set(['platit', 'gratuit']);
const CANDIDATE_TYPES = new Set(['independent', 'partid']);
const CURRENCIES = new Set(['RON', 'EUR']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DAY = 86400000;

function envText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

export function platformInfo(env = process.env) {
  const result = {
    name: envText(env.PLATFORM_NAME || 'VoceaCandidatului', 100),
    operatorName: envText(env.PLATFORM_OPERATOR_NAME, 200),
    operatorId: envText(env.PLATFORM_OPERATOR_ID, 100),
    legalEmail: envText(env.PLATFORM_LEGAL_EMAIL, 254).toLowerCase(),
    legalAddress: envText(env.PLATFORM_LEGAL_ADDRESS, 300),
  };
  result.complete = Boolean(result.operatorName && result.operatorId && result.legalEmail && result.legalAddress);
  return result;
}

function enumField(value, allowed, label, required = true) {
  const result = String(value || '').trim();
  if ((!result && required) || (result && !allowed.has(result))) throw new ValidationError(`${label}: valoare invalidă.`);
  return result;
}

function dateField(value, label, required = false) {
  const result = textField(value, label, 10, required);
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new ValidationError(`${label}: folosește formatul AAAA-LL-ZZ.`);
  return result;
}

function moneyField(value, contractType) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (contractType === 'gratuit') return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new ValidationError('Valoarea contractului trebuie să fie un număr pozitiv cu maximum două zecimale.');
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0 || number > 100000000) throw new ValidationError('Valoarea contractului este în afara limitelor acceptate.');
  return number;
}

export function legalProfileInput(body) {
  const tip_contract = enumField(body.tip_contract, CONTRACT_TYPES, 'Tip contract');
  const campanie_start = dateField(body.campanie_start, 'Început campanie');
  const campanie_end = dateField(body.campanie_end, 'Sfârșit campanie');
  if (campanie_start && campanie_end && campanie_end < campanie_start) {
    throw new ValidationError('Sfârșitul campaniei nu poate fi înaintea începutului.');
  }
  return {
    tip_candidat: enumField(body.tip_candidat, CANDIDATE_TYPES, 'Tip candidat'),
    entitate_responsabila: textField(body.entitate_responsabila, 'Responsabil editorial', 200, true),
    finantator_materiale: textField(body.finantator_materiale, 'Finanțator', 200, true),
    scrutin: textField(body.scrutin, 'Scrutin', 200, true),
    cod_mandatar_financiar: textField(body.cod_mandatar_financiar, 'Cod mandatar financiar', 100, true),
    tip_contract,
    numar_contract: textField(body.numar_contract, 'Număr contract', 100, true),
    data_contract: dateField(body.data_contract, 'Data contractului', true),
    valoare_contract: moneyField(body.valoare_contract, tip_contract),
    moneda_contract: enumField(body.moneda_contract || 'RON', CURRENCIES, 'Monedă'),
    campanie_start,
    campanie_end,
    confirmare_mandatar: body.confirmare_mandatar === 'on' || body.confirmare_mandatar === true,
  };
}

export function candidateComplianceMissing(user, platform = { complete: true }) {
  const missing = [];
  if (!platform.complete) missing.push('datele juridice ale operatorului platformei');
  for (const [key, label] of [
    ['functie_candidatura', 'funcția candidaturii'], ['zona', 'zona candidaturii'],
    ['tip_candidat', 'tipul candidatului'], ['entitate_responsabila', 'responsabilul editorial'],
    ['finantator_materiale', 'finanțatorul real'], ['scrutin', 'scrutinul'],
    ['cod_mandatar_financiar', 'codul mandatarului financiar'], ['tip_contract', 'tipul contractului'],
    ['numar_contract', 'numărul contractului'], ['data_contract', 'data contractului'],
  ]) if (!String(user?.[key] ?? '').trim()) missing.push(label);
  if (user?.tip_contract === 'platit' && !(Number(user.valoare_contract) > 0)) missing.push('valoarea contractului');
  if (!user?.confirmare_mandatar) missing.push('confirmarea datelor de către candidat/mandatar');
  if (user?.terms_version !== TERMS_VERSION || !user?.terms_accepted_at || !user?.editorial_responsibility_accepted_at) {
    missing.push('acceptarea termenilor și a responsabilității editoriale');
  }
  return missing;
}

export function transparencySnapshot(user, at = new Date().toISOString()) {
  return {
    material: 'publicitate_politica',
    publicat_de: user.nume_candidat,
    responsabil_editorial: user.entitate_responsabila || user.nume_candidat,
    finantat_de: user.finantator_materiale || user.nume_candidat,
    scrutin: user.scrutin || '',
    cod_mandatar_financiar: user.cod_mandatar_financiar || '',
    tip_contract: user.tip_contract || '',
    numar_contract: user.numar_contract || '',
    valoare_contract: Number(user.valoare_contract) || 0,
    moneda_contract: user.moneda_contract || 'RON',
    recorded_at: at,
  };
}

export function publicTransparency(user, article) {
  return article?.transparenta || transparencySnapshot(user, article?.data_publicare || new Date().toISOString());
}

export function createCompliance({ store = createComplianceStore(), now = () => Date.now(), secret = process.env.SESSION_SECRET } = {}) {
  async function records(prefix) {
    const values = [];
    const keys = await store.keys(prefix);
    for (let index = 0; index < keys.length; index += 20) {
      values.push(...(await Promise.all(keys.slice(index, index + 20).map(key => store.get(key)))).filter(Boolean));
    }
    return values;
  }

  async function deletePrefix(prefix) {
    for (const key of await store.keys(prefix)) await store.delete(key);
  }

  async function rateLimit(ip) {
    if (!secret || secret.length < 32) throw new ValidationError('Raportarea necesită SESSION_SECRET configurat cu minimum 32 de caractere.', 503);
    const timestamp = now();
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const hash = createHmac('sha256', secret).update(`reports:${day}:${ip}`).digest('hex');
    const prefix = `report-rate/${day}/${hash}/`;
    const recent = await records(prefix);
    if (recent.filter(r => timestamp - r.time < 60000).length >= 2 || recent.length >= 10) {
      throw new ValidationError('Prea multe sesizări. Așteaptă un minut și încearcă din nou.', 429);
    }
    await store.set(`${prefix}${randomUUID()}`, { time: timestamp });
    const cutoff = new Date(timestamp - DAY).toISOString().slice(0, 10);
    for (const key of await store.keys('report-rate/')) {
      if (key.split('/')[1] < cutoff) await store.delete(key);
    }
  }

  function applyEvents(report, events) {
    const history = events.filter(event => event.report_id === report.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const last = history.at(-1);
    return { ...report, status: last?.status || 'noua', version: last?.id || 'initial', history };
  }

  async function audit({ actorId, actorRole, action, targetType, targetId, details = {} }) {
    const created_at = new Date(now()).toISOString();
    const event = { id: randomUUID(), actor_id: actorId || null, actor_role: actorRole || 'public', action,
      target_type: targetType, target_id: String(targetId || ''), details, created_at };
    await store.set(`audit/${created_at.slice(0, 10)}/${event.id}`, event);
    return event;
  }

  return {
    audit,
    async purgeCandidate(candidateId) {
      await deletePrefix(`acceptance/${candidateId}/`);
      await deletePrefix(`reports/${candidateId}/`);
      await deletePrefix(`report-events/${candidateId}/`);
    },
    async acceptTerms({ candidateId, ip = 'unknown' }) {
      const created_at = new Date(now()).toISOString();
      const event = { id: randomUUID(), candidate_id: candidateId, terms_version: TERMS_VERSION,
        accepted_at: created_at, editorial_responsibility_accepted_at: created_at,
        // Nu păstrăm IP-ul; doar un identificator pseudonim pentru proba tehnică.
        request_fingerprint: secret && secret.length >= 32
          ? createHmac('sha256', secret).update(`acceptance:${candidateId}:${ip}`).digest('hex') : '' };
      await store.set(`acceptance/${candidateId}/${event.id}`, event);
      return event;
    },
    async submitReport({ candidate, article, body, ip }) {
      if (body.website) throw new ValidationError('Sesizare invalidă.');
      const motiv = enumField(body.motiv, REPORT_REASONS, 'Motiv');
      const descriere = textField(body.descriere, 'Descriere', 4000, true);
      if (descriere.length < 20) throw new ValidationError('Descrierea sesizării trebuie să aibă minimum 20 de caractere.');
      const nume = textField(body.nume, 'Nume', 100);
      const email = textField(body.email, 'Email', 254).toLowerCase();
      if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new ValidationError('Adresa de email nu este validă.');
      if (email && body.acord_contact !== 'on') throw new ValidationError('Confirmă folosirea adresei pentru soluționarea sesizării.');
      if (body.buna_credinta !== 'on') throw new ValidationError('Confirmă că trimiți sesizarea cu bună-credință.');
      await rateLimit(ip);
      const report = { id: randomUUID(), user_id: candidate.id, articol_id: article.id, motiv, descriere, nume, email,
        created_at: new Date(now()).toISOString(), evidence: {
          titlu: article.titlu, continut: article.continut, rezumat: article.rezumat || '', imagine_url: article.imagine_url || '',
          data_publicare: article.data_publicare || article.data_programata || null,
          transparenta: publicTransparency(candidate, article),
        } };
      await store.set(`reports/${candidate.id}/${article.id}/${report.id}`, report);
      await audit({ actorRole: 'public', action: 'report_submitted', targetType: 'article', targetId: article.id,
        details: { report_id: report.id, candidate_id: candidate.id, reason: motiv } });
      return report;
    },
    async listReports() {
      const [reports, events] = await Promise.all([records('reports/'), records('report-events/')]);
      return reports.map(report => applyEvents(report, events))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    },
    async resolveReport({ candidateId, articleId, id, status, note, action, adminId, version }) {
      if (!UUID.test(id) || !REPORT_STATUS.has(status) || !['none', 'suspend', 'restore'].includes(action)) {
        throw new ValidationError('Acțiune de soluționare invalidă.');
      }
      if ((action === 'suspend' && status !== 'continut_suspendat')
        || (action === 'restore' && status === 'continut_suspendat')) {
        throw new ValidationError('Starea sesizării nu corespunde acțiunii asupra articolului.');
      }
      const report = await store.get(`reports/${candidateId}/${articleId}/${id}`);
      if (!report) throw new ValidationError('Sesizarea nu există.', 404);
      const prefix = `report-events/${candidateId}/${articleId}/${id}/`;
      const current = applyEvents(report, await records(prefix));
      if (current.version !== version) throw new ValidationError('Sesizarea a fost deja modificată. Reîncarcă pagina.', 409);
      const event = { id: randomUUID(), report_id: id, admin_id: adminId, status,
        note: textField(note, 'Motivarea deciziei', 2000, true), action,
        previous_version: version, created_at: new Date(now()).toISOString() };
      await store.set(`${prefix}${event.id}`, event);
      return event;
    },
    async listAudit(limit = 100) {
      return (await records('audit/')).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
    },
  };
}
