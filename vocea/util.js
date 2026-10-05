// Utilitare de text pentru modulul Vocea (dosare, anunțuri).
export const clean = (value, max = 500) => String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

export function slugify(text, max = 80) {
  return String(text || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/g, '') || 'dosar';
}

export function uniqueSlug(base, taken) {
  let slug = base;
  for (let i = 2; taken.has(slug); i += 1) slug = `${base}-${i}`;
  return slug;
}

// Doar adrese http(s) fără credențiale; opțional limitate la anumite domenii.
export function safeUrl(value, { hosts } = {}) {
  const raw = clean(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (hosts && !hosts.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) return null;
    return url.href;
  } catch { return null; }
}

export function excerpt(text, max = 160) {
  const plain = clean(text, 5000).replace(/[#*]/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
