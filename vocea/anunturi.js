import { randomUUID } from 'node:crypto';
import { clean, excerpt } from './util.js';

// Avizierul comunei. Redacția publică direct; cititorii trimit spre verificare.
export const AD_TYPES = [
  { slug: 'primarie', name: 'Primărie' },
  { slug: 'biserica', name: 'Biserică' },
  { slug: 'decese', name: 'Decese' },
  { slug: 'mica-publicitate', name: 'Mica publicitate' },
  { slug: 'locuri-de-munca', name: 'Locuri de muncă' },
];
// Cititorii pot trimite doar aceste tipuri (anunțurile oficiale vin de la redacție).
export const READER_AD_TYPES = ['mica-publicitate', 'decese', 'locuri-de-munca'];
export const AD_STATUS = { publicat: 'Publicat', in_asteptare: 'De verificat' };
export const ADS_PAGE_SIZE = 12;
export const READER_AD_DAYS = 30;
export const READER_LIMIT_PER_DAY = 3;

export const adTypeName = slug => AD_TYPES.find(t => t.slug === slug)?.name || 'Anunț';
export const validAdType = slug => AD_TYPES.some(t => t.slug === slug);
export const newAdId = () => randomUUID().slice(0, 8);

export function isActive(ad, now) {
  return ad.status === 'publicat' && Date.parse(ad.publicatLa) <= now && (!ad.expiraLa || Date.parse(ad.expiraLa) > now);
}

export function activeAds(data, now, tip = null) {
  return data.anunturi
    .filter(a => isActive(a, now) && (!tip || a.tip === tip))
    .sort((a, b) => Date.parse(b.publicatLa) - Date.parse(a.publicatLa));
}

// Banda „IMPORTANT”: cel mai recent anunț marcat important și încă valabil.
export function importantAd(data, now) {
  return activeAds(data, now).find(a => a.important) || null;
}

export function adView(ad) {
  return {
    ...ad,
    url: `/anunturi/${ad.id}`,
    typeName: adTypeName(ad.tip),
    summary: excerpt(ad.text, 200),
    hasPhone: phoneDigits(ad.telefon).length >= 6,
    long: String(ad.text || '').length > 200,
  };
}

export const phoneDigits = value => String(value || '').replace(/[^+\d]/g, '');

// Citește formularul (redacție sau cititor); întoarce { values, error }.
export function readAdForm(body, { reader = false } = {}) {
  const values = {
    tip: validAdType(body.tip) ? body.tip : '',
    titlu: clean(body.titlu, 140),
    text: clean(body.text, reader ? 1500 : 5000),
    telefon: clean(body.telefon, 30),
    pret: clean(body.pret, 40),
    important: !reader && body.important === 'da',
  };
  if (!values.tip || (reader && !READER_AD_TYPES.includes(values.tip))) return { values, error: 'Alege tipul anunțului.' };
  if (values.titlu.length < 3) return { values, error: 'Scrie un titlu pentru anunț.' };
  if (reader && values.text.length < 10) return { values, error: 'Scrie câteva detalii despre anunț.' };
  if (values.telefon && phoneDigits(values.telefon).length < 6) return { values, error: 'Numărul de telefon nu pare valid.' };
  if (reader && values.tip === 'mica-publicitate' && !values.telefon) return { values, error: 'Lasă un număr de telefon la care să te sune cumpărătorii.' };
  return { values };
}
