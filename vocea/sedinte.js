import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { clean, slugify } from './util.js';
import { bucharestToDate, formatDate, toBucharestInputs } from './time.js';

// Ședințele Consiliului Local: ordinea de zi, voturile, documentele PDF și comentariul redacției.
export const MEETING_TYPES = { ordinara: 'Ordinară', extraordinara: 'Extraordinară', 'de-indata': 'De îndată' };
export const MEETING_STATES = { programata: 'Programată', live: 'În desfășurare (LIVE)', incheiata: 'Încheiată' };
export const RESULTS = { adoptat: 'Adoptat', respins: 'Respins', amanat: 'Amânat', nevotat: 'Nevotat încă' };
export const DOC_TYPES = { convocator: 'Convocator', proiect: 'Proiect de hotărâre', hotarare: 'Hotărâre adoptată', 'proces-verbal': 'Proces-verbal', altul: 'Alt document' };
// Titlurile din lista „Documente (PDF)” de pe pagina ședinței.
export const DOC_GROUP_TITLES = { convocator: 'Convocator', proiect: 'Proiecte de hotărâre', hotarare: 'Hotărâri adoptate', 'proces-verbal': 'Proces-verbal', altul: 'Alte documente' };
export const MAX_POINTS = 60;

// O funcție Netlify primește și trimite cel mult ~6 MB (codificat base64), deci ~4 MB de PDF.
export const MAX_PDF_BYTES = 4 * 1024 * 1024;

const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
export const newMeetingId = () => randomUUID().slice(0, 8);

export function meetingTitle(meeting) {
  const tip = (MEETING_TYPES[meeting.tip] || 'Ordinară').toLowerCase();
  if (!meeting.at) return `Ședința ${tip} a Consiliului Local`;
  const { date } = toBucharestInputs(meeting.at);
  const [year, month] = date.split('-').map(Number);
  return `Ședința ${tip} din ${MONTHS[month - 1]} ${year}`;
}

// „Ședința ordinară a Consiliului Local din octombrie 2026” (titlul paginii ședinței).
export const meetingFullTitle = meeting => meetingTitle(meeting).replace(/^(Ședința \S+(?: \S+)?) din /, '$1 a Consiliului Local din ');

export const meetingSlug =meeting => `${meeting.at ? toBucharestInputs(meeting.at).date : 'fara-data'}-${meeting.tip}-${meeting.id}`;
export const meetingUrl = meeting => `/sedinte/${meetingSlug(meeting)}`;
export const meetingIdFromSlug = slug => String(slug || '').split('-').pop();

export const isPublished = meeting => meeting.status === 'publicat';

// Stare efectivă: o ședință „programată” a cărei zi a trecut apare ca încheiată.
export function meetingState(meeting, now) {
  if (meeting.stare === 'live' || meeting.stare === 'incheiata') return meeting.stare;
  return meeting.at && Date.parse(meeting.at) + 12 * 3600000 < now ? 'incheiata' : 'programata';
}

export function resultCounts(meeting) {
  const counts = { adoptat: 0, respins: 0, amanat: 0, nevotat: 0 };
  for (const point of meeting.puncte || []) counts[point.rezultat in counts ? point.rezultat : 'nevotat'] += 1;
  return counts;
}

export function resultLabel(point) {
  const base = RESULTS[point.rezultat] || RESULTS.nevotat;
  if (point.rezultat === 'adoptat' && point.pentru) return `${base} · ${point.pentru} pentru`;
  if (point.rezultat === 'respins' && point.contra) return `${base} · ${point.contra} contra`;
  return base;
}

export function publicMeetings(data) {
  return data.sedinte.filter(isPublished).sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
}

// Următoarea ședință publicată (sau cea în desfășurare), pentru blocul de sus.
export function nextMeeting(data, now) {
  return publicMeetings(data)
    .filter(m => meetingState(m, now) !== 'incheiata')
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0))[0] || null;
}

export function docFileName(doc) {
  return `${slugify(doc.nume.replace(/\.pdf$/i, ''), 70) || 'document'}.pdf`;
}
export const docUrl = doc => `/documente/${doc.id}/${docFileName(doc)}`;

export function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ------------------------------ formular admin ------------------------------ */

const toInt = value => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
};

// Câmpurile repetate (puncte) vin ca liste: puncte_titlu[], puncte_nota[], ...
const list = value => (Array.isArray(value) ? value : value == null ? [] : [value]);

export function readMeetingForm(body, docIds = new Set()) {
  const values = {
    tip: Object.hasOwn(MEETING_TYPES, body.tip) ? body.tip : 'ordinara',
    stare: Object.hasOwn(MEETING_STATES, body.stare) ? body.stare : 'programata',
    data: clean(body.data, 10),
    ora: clean(body.ora, 5),
    loc: clean(body.loc, 160),
    rezumat: clean(body.rezumat, 600),
    comentariu: {
      titlu: clean(body.comentariu_titlu, 160),
      text: clean(body.comentariu_text, 12000),
      autor: clean(body.comentariu_autor, 120),
      notaReplica: body.comentariu_nota === 'da',
    },
  };
  const titles = list(body.punct_titlu);
  const ids = list(body.punct_id);
  values.puncte = titles.map((titlu, index) => ({
    id: clean(ids[index], 12) || randomUUID().slice(0, 8),
    titlu: clean(titlu, 400),
    nota: clean(list(body.punct_nota)[index], 1200),
    rezultat: Object.hasOwn(RESULTS, list(body.punct_rezultat)[index]) ? list(body.punct_rezultat)[index] : 'nevotat',
    pentru: toInt(list(body.punct_pentru)[index]),
    contra: toInt(list(body.punct_contra)[index]),
    abtineri: toInt(list(body.punct_abtineri)[index]),
    docId: docIds.has(list(body.punct_doc)[index]) ? list(body.punct_doc)[index] : '',
  })).filter(point => point.titlu).slice(0, MAX_POINTS);
  if (!values.data) return { values, error: 'Completează data ședinței.' };
  values.at = bucharestToDate(values.data, values.ora || '10:00')?.toISOString();
  if (!values.at) return { values, error: 'Data sau ora ședinței nu este validă.' };
  if (values.comentariu.text && !values.comentariu.titlu) return { values, error: 'Dă un titlu comentariului redacției.' };
  return { values };
}

/* ------------------------------- verificare PDF ------------------------------- */

// Dicționarele pot fi ascunse în fluxuri comprimate de obiecte (/ObjStm): le despachetăm și pe acelea.
function hiddenActiveContent(buffer) {
  const text = buffer.toString('latin1');
  const marker = /\/Type\s*\/ObjStm[\s\S]{0,400}?stream\r?\n/g;
  let budget = 40 * 1024 * 1024;
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) break;
    try {
      const inflated = inflateSync(buffer.subarray(start, end), { maxOutputLength: budget });
      budget -= inflated.length;
      if (ACTIVE_CONTENT.test(inflated.toString('latin1'))) return true;
    } catch { /* flux necomprimat cu Flate sau deteriorat: îl ignorăm */ }
    if (budget <= 0) break;
  }
  return false;
}

// Acceptăm doar PDF-uri reale, fără conținut activ: antet %PDF-, sfârșit %%EOF,
// fără JavaScript, acțiuni de lansare, fișiere încorporate sau formulare XFA.
const ACTIVE_CONTENT = /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/;
export function verifyPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'Fișierul este gol.';
  if (buffer.length > MAX_PDF_BYTES) return `Fișierul depășește ${formatSize(MAX_PDF_BYTES)}. Comprimă PDF-ul (de exemplu cu „Salvează ca PDF redus”) și încearcă din nou.`;
  if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) return 'Fișierul nu este un PDF.';
  if (buffer.subarray(Math.max(0, buffer.length - 2048)).indexOf('%%EOF') === -1) return 'PDF-ul pare incomplet sau deteriorat.';
  if (ACTIVE_CONTENT.test(buffer.toString('latin1')) || hiddenActiveContent(buffer)) return 'PDF-ul conține scripturi, fișiere atașate sau formulare active și nu poate fi publicat. Tipărește-l din nou ca PDF simplu.';
  if (/\/Encrypt\b/.test(buffer.toString('latin1'))) return 'PDF-ul este protejat cu parolă. Încarcă o versiune fără parolă.';
  return null;
}

/* ----------------------------- textul comentariului ----------------------------- */

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // Linkuri doar spre documentele site-ului sau adrese https.
    .replace(/\[([^\]\n]+)\]\((\/documente\/[\w-]+\/[\w.-]+|https:\/\/[^\s)]+)\)/g, (match, label, href) => `<a href="${href}"${href.startsWith('https:') ? ' rel="nofollow noopener" target="_blank"' : ''}>${label}</a>`);
}

// Text simplu → HTML sigur: paragrafe, citate cu „> ”, **îngroșat**, *cursiv*, [text](link).
export function formatComment(text) {
  return clean(text, 12000).split(/\n{2,}/).map(block => block.trim()).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    if (lines.every(line => line.startsWith('>'))) return `<blockquote>${inline(lines.map(line => line.replace(/^>\s?/, '')).join(' '))}</blockquote>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

export const meetingDateLabel = meeting => (meeting.at ? formatDate(meeting.at) : '');
