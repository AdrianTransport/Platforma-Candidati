// Fișier .ics (RFC 5545) pentru „Adaugă în calendar”: ora în UTC, cu memento cu 1 zi și 1 oră înainte.
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escapeText = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Liniile mai lungi de 75 de octeți se împart (continuarea începe cu un spațiu), fără a tăia caractere UTF-8.
function fold(line) {
  const out = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (out.length ? 74 : 75)) { out.push(current); current = ''; }
    current += ch;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function termenIcs({ uid, start, durationMinutes = 120, summary, location, description, url, now = Date.now() }) {
  const startMs = Date.parse(start);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vocea Lenauheim//Termene//RO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(startMs + durationMinutes * 60000)}`,
    `SUMMARY:${escapeText(summary)}`,
    location ? `LOCATION:${escapeText(location)}` : null,
    `DESCRIPTION:${escapeText(description)}`,
    url ? `URL:${url}` : null,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', `DESCRIPTION:${escapeText(`Mâine: ${summary}`)}`, 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', `DESCRIPTION:${escapeText(`Peste o oră: ${summary}`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
