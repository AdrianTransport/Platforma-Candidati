import { randomUUID } from 'node:crypto';
import { formatTime, formatDate, formatShortDate, bucharestDayKey, termenLabel } from './time.js';

// Cât timp după ora termenului afișăm automat „LIVE” (dacă redacția nu oprește manual).
export const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const STADII = ['Înregistrat', 'Fond', 'Apel', 'Recurs', 'Definitiv', 'Suspendat'];
export const LIVE_MODES = { auto: 'Automat la ora termenului', on: 'Pornit manual', off: 'Oprit (ședința s-a încheiat)' };

const ts = value => Date.parse(value);
const sortedTerms = dosar => [...(dosar.termene || [])].filter(t => !Number.isNaN(ts(t.at))).sort((a, b) => ts(a.at) - ts(b.at));

// Termenul care urmează sau care e în desfășurare (încă în fereastra LIVE).
export function nextTermen(dosar, now) {
  return sortedTerms(dosar).find(t => ts(t.at) + LIVE_WINDOW_MS > now) || null;
}

export function lastTermen(dosar) {
  const terms = sortedTerms(dosar);
  return terms[terms.length - 1] || null;
}

export function upcomingTermen(dosar, now) {
  return sortedTerms(dosar).find(t => ts(t.at) > now) || null;
}

// upcoming → live → ended; „none” = niciun termen stabilit.
export function liveState(dosar, now) {
  if (dosar.liveMode === 'on') return 'live';
  const next = nextTermen(dosar, now);
  if (!next) return sortedTerms(dosar).length ? 'ended' : 'none';
  if (now < ts(next.at)) return 'upcoming';
  return dosar.liveMode === 'off' ? 'ended' : 'live';
}

export const STATE_LABELS = {
  upcoming: 'URMĂTORUL TERMEN',
  live: 'LIVE · ȘEDINȚA E ÎN DESFĂȘURARE',
  ended: 'ȘEDINȚA S-A ÎNCHEIAT',
  none: 'TERMEN NESTABILIT',
};

export const STATE_MESSAGES = {
  live: 'Ședința e în desfășurare. Urmărește actualizările de mai jos.',
  ended: 'Următorul termen va fi anunțat aici imediat ce e stabilit.',
  none: 'Termenul va fi anunțat aici imediat ce e stabilit.',
};

export function featuredDosar(data) {
  return data.dosare.find(d => d.featured) || null;
}

// Prima pagină și pagina dosarului folosesc aceeași „vedere” calculată.
export function dosarView(dosar, now) {
  const state = liveState(dosar, now);
  const termen = nextTermen(dosar, now) || lastTermen(dosar);
  return {
    dosar,
    state,
    stateLabel: STATE_LABELS[state],
    stateMessage: STATE_MESSAGES[state] || '',
    termen,
    termenAt: termen ? ts(termen.at) : null,
    termenLabel: termen ? termenLabel(termen.at) : 'TERMEN: urmează să fie stabilit',
    salaComplet: termen ? [termen.sala, termen.complet].filter(Boolean).join(' · ') : '',
    countdown: countdownParts(termen ? ts(termen.at) - now : 0),
    feed: feedEntries(dosar, now),
  };
}

// Valorile inițiale ale numărătorii (randate pe server; scriptul le actualizează la fiecare secundă).
export function countdownParts(ms) {
  const diff = Math.max(0, ms);
  const pad = n => String(n).padStart(2, '0');
  return {
    d: String(Math.floor(diff / 864e5)), h: pad(Math.floor(diff / 36e5) % 24),
    m: pad(Math.floor(diff / 6e4) % 60), s: pad(Math.floor(diff / 1e3) % 60),
  };
}

export function caseTag(dosar, now) {
  const state = liveState(dosar, now);
  if (state === 'live') return { text: 'LIVE', kind: 'live' };
  const next = upcomingTermen(dosar, now);
  if (next) return { text: `Termen ${formatDate(next.at)}`, kind: 'termen' };
  return { text: dosar.stadiu || 'Înregistrat', kind: 'stadiu' };
}

export function sortDosare(dosare, now) {
  const key = d => upcomingTermen(d, now)?.at;
  return [...dosare].sort((a, b) => (b.featured - a.featured)
    || ((key(a) ? ts(key(a)) : Infinity) - (key(b) ? ts(key(b)) : Infinity))
    || String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Actualizările live, cele mai noi primele, plus intrarea „Dosarul a fost înregistrat”.
export function feedEntries(dosar, now) {
  const today = bucharestDayKey(now);
  const entries = [...(dosar.updates || [])]
    .sort((a, b) => ts(b.at) - ts(a.at))
    .map(u => ({
      id: u.id, titlu: u.titlu, text: u.text, at: u.at,
      time: bucharestDayKey(u.at) === today ? formatTime(u.at) : formatShortDate(u.at),
      full: `${formatDate(u.at)} ${formatTime(u.at)}`,
      recent: now - ts(u.at) < 12 * 60 * 60 * 1000,
    }));
  if (dosar.dataInregistrare) {
    const first = sortedTerms(dosar)[0];
    entries.push({
      id: 'inregistrare', titlu: 'Dosarul a fost înregistrat', at: dosar.dataInregistrare,
      text: `${formatDate(dosar.dataInregistrare)}${first ? ` · Primul termen fixat pentru ${formatDate(first.at)}` : ''}`,
      time: formatShortDate(dosar.dataInregistrare), full: formatDate(dosar.dataInregistrare), recent: false,
    });
  }
  return entries;
}

// Răspunsul pentru fluxul live (reîncărcat la 30 s de prima pagină și de pagina dosarului).
export function liveJson(dosar, now) {
  const view = dosarView(dosar, now);
  return {
    id: dosar.id,
    state: view.state,
    stateLabel: view.stateLabel,
    stateMessage: view.stateMessage,
    liveMode: dosar.liveMode || 'auto',
    termenAt: view.termenAt,
    termenLabel: view.termenLabel,
    salaComplet: view.salaComplet,
    stadiu: dosar.stadiu,
    updates: view.feed.map(({ id, titlu, text, time, full, recent }) => ({ id, titlu, text, time, full, recent })),
  };
}

export const newId = () => randomUUID().slice(0, 8);
