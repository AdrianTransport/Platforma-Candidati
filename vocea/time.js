// Toate orele afișate și introduse în admin sunt ora României, indiferent de fusul serverului.
export const TIME_ZONE = 'Europe/Bucharest';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function zonedParts(date) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

// Diferența (ms) dintre ora României și UTC la momentul dat.
function offsetAt(ms) {
  const p = zonedParts(new Date(ms));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// "2026-10-08" + "09:00" (ora României) → Date (UTC). Întoarce null pentru valori invalide.
export function bucharestToDate(dateStr, timeStr = '00:00') {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  const t = /^(\d{2}):(\d{2})$/.exec(String(timeStr || '').trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const wallClock = Date.UTC(y, mo - 1, da, h, mi);
  let ms = wallClock - offsetAt(wallClock);
  // A doua trecere corectează zilele în care se schimbă ora (DST).
  ms = wallClock - offsetAt(ms);
  const check = zonedParts(new Date(ms));
  if (check.day !== da || check.month !== mo) return null; // ex. 31 februarie
  return new Date(ms);
}

const pad = n => String(n).padStart(2, '0');

// Pentru câmpurile <input type="date"> și <input type="time"> din admin.
export function toBucharestInputs(value) {
  if (!value) return { date: '', time: '' };
  const p = zonedParts(new Date(value));
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

export function bucharestDayKey(value) {
  return toBucharestInputs(value).date;
}

function fmt(value, options) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ro-RO', { timeZone: TIME_ZONE, ...options }).format(date);
}

export const formatTime = v => fmt(v, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const formatDate = v => fmt(v, { day: '2-digit', month: '2-digit', year: 'numeric' });
export const formatShortDate = v => fmt(v, { day: '2-digit', month: '2-digit' });
export const formatLongDate = v => fmt(v, { day: 'numeric', month: 'long', year: 'numeric' });
export const formatWeekdayDate = v => fmt(v, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const formatDateTime = v => (v ? `${formatDate(v)}, ora ${formatTime(v)}` : '');

// "TERMEN: JOI, 8 OCTOMBRIE 2026 · ORA 09:00" (ca în machetă).
export function termenLabel(value) {
  if (!value) return 'TERMEN: urmează să fie stabilit';
  return `TERMEN: ${formatWeekdayDate(value).toUpperCase()} · ORA ${formatTime(value)}`;
}
