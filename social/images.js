import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import jpeg from 'jpeg-js';

// Imaginile de distribuire: Open Graph 1200×630 (Facebook, WhatsApp, Instagram) și Story 1080×1920
// (Instagram/Facebook Story, TikTok). Doar JavaScript și WebAssembly: rulează identic în funcția Netlify.
export const FORMATS = {
  og: { width: 1200, height: 630 },
  story: { width: 1080, height: 1920 },
};

const COLORS = { bg: '#f3f6fb', ink: '#0b1220', muted: '#4a5568', violet: '#5b34ff', violetSoft: '#ece7ff', red: '#e11d48', white: '#ffffff' };

// Fișierele .wasm se caută pornind de la directorul proiectului: după împachetarea funcției
// Netlify, import.meta.url nu mai este definit.
function resolveModuleFile(baseDir, specifier) {
  try { return createRequire(path.join(baseDir, 'package.json')).resolve(specifier); } catch { return path.join(baseDir, 'node_modules', ...specifier.split('/')); }
}

let ready;
// Fonturile și motorul WASM se încarcă o singură dată pe instanța funcției.
function prepare(baseDir) {
  ready ||= (async () => {
    await initWasm(await fs.readFile(resolveModuleFile(baseDir, '@resvg/resvg-wasm/index_bg.wasm')));
    const font = file => fs.readFile(path.join(baseDir, 'assets-social', file));
    const [display, text, bold] = await Promise.all([font('bricolage-800.ttf'), font('instrument-500.ttf'), font('instrument-700.ttf')]);
    return [
      { name: 'Bricolage', data: display, weight: 800, style: 'normal' },
      { name: 'Instrument', data: text, weight: 500, style: 'normal' },
      { name: 'Instrument', data: bold, weight: 700, style: 'normal' },
    ];
  })().catch((error) => { ready = undefined; throw error; });
  return ready;
}

// Element simplu pentru satori, fără JSX.
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter(c => c !== null && c !== undefined && c !== false) } });
const img = (src, style) => ({ type: 'img', props: { src, style } });

function fit(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

const titleSize = (title, sizes) => sizes.find(([limit]) => title.length <= limit)?.[1] || sizes[sizes.length - 1][1];

function brand(size) {
  return h('div', { alignItems: 'center', gap: Math.round(size * 0.45) },
    h('div', { width: Math.round(size * 0.55), height: Math.round(size * 0.55), borderRadius: 999, background: COLORS.red, boxShadow: `0 0 0 ${Math.round(size * 0.22)}px rgba(225,29,72,0.18)` }),
    h('div', { fontFamily: 'Bricolage', fontWeight: 800, fontSize: size, letterSpacing: -1, color: COLORS.ink }, 'vocea lenauheim'));
}

function label(text, size) {
  return h('div', { alignSelf: 'flex-start', padding: `${Math.round(size * 0.45)}px ${Math.round(size * 0.9)}px`, borderRadius: 999, background: '#ffe4ea', color: '#be123c', fontFamily: 'Instrument', fontWeight: 700, fontSize: size, letterSpacing: 2 }, text.toUpperCase());
}

function political(card, size) {
  if (!card.political) return null;
  return h('div', { fontFamily: 'Instrument', fontWeight: 700, fontSize: size, color: COLORS.ink, background: '#fff7df', padding: `${Math.round(size * 0.5)}px ${Math.round(size * 0.8)}px`, borderRadius: 12 }, fit(card.political, 140));
}

function ogTree(card) {
  const title = fit(card.title, 110);
  return h('div', { width: 1200, height: 630, background: COLORS.bg, position: 'relative', fontFamily: 'Instrument' },
    h('div', { position: 'absolute', top: -160, left: -120, width: 560, height: 560, borderRadius: 999, background: '#d9d0ff' }),
    h('div', { position: 'absolute', bottom: -220, right: -160, width: 560, height: 560, borderRadius: 999, background: '#ffd9e2' }),
    h('div', { position: 'absolute', top: 40, left: 40, right: 40, bottom: 40, borderRadius: 36, background: 'rgba(255,255,255,0.86)', padding: 48, gap: 40 },
      h('div', { flexDirection: 'column', flex: 1, gap: 22, justifyContent: 'space-between' },
        h('div', { flexDirection: 'column', gap: 22 },
          brand(34),
          label(card.kind, 18),
          h('div', { fontFamily: 'Bricolage', fontWeight: 800, color: COLORS.ink, lineHeight: 1.04, letterSpacing: -1.5, fontSize: titleSize(title, card.photo ? [[40, 56], [70, 46], [999, 38]] : [[40, 64], [70, 54], [999, 44]]) }, title)),
        h('div', { flexDirection: 'column', gap: 12 },
          political(card, 18),
          h('div', { fontSize: 22, color: COLORS.muted, fontWeight: 500 }, fit([card.meta, 'vocealenauheim.ro'].filter(Boolean).join(' · '), 80)))),
      card.photo ? img(card.photo, { width: 400, height: 470, objectFit: 'cover', borderRadius: 28 }) : null));
}

function storyTree(card) {
  const title = fit(card.title, 150);
  return h('div', { width: 1080, height: 1920, background: COLORS.bg, position: 'relative', fontFamily: 'Instrument', flexDirection: 'column' },
    h('div', { position: 'absolute', top: -200, left: -200, width: 900, height: 900, borderRadius: 999, background: '#d9d0ff' }),
    h('div', { position: 'absolute', bottom: -260, right: -260, width: 900, height: 900, borderRadius: 999, background: '#ffd9e2' }),
    // Marginile de sus și de jos rămân libere: acolo Instagram și TikTok își pun butoanele.
    h('div', { position: 'absolute', top: 230, left: 70, right: 70, bottom: 330, borderRadius: 56, background: 'rgba(255,255,255,0.9)', padding: 64, flexDirection: 'column', gap: 40 },
      brand(56),
      card.photo ? img(card.photo, { width: 812, height: 560, objectFit: 'cover', borderRadius: 40 }) : null,
      label(card.kind, 30),
      h('div', { fontFamily: 'Bricolage', fontWeight: 800, color: COLORS.ink, lineHeight: 1.05, letterSpacing: -2, fontSize: titleSize(title, card.photo ? [[45, 84], [80, 70], [999, 58]] : [[45, 104], [80, 88], [999, 72]]) }, title),
      h('div', { flexGrow: 1 }),
      political(card, 26),
      h('div', { alignSelf: 'flex-start', padding: '22px 34px', borderRadius: 999, background: COLORS.ink, color: COLORS.white, fontSize: 34, fontWeight: 700 }, card.cta || 'Citește pe vocealenauheim.ro')),
    h('div', { position: 'absolute', bottom: 200, left: 0, right: 0, justifyContent: 'center', fontSize: 30, fontWeight: 700, color: COLORS.muted }, 'vocealenauheim.ro'));
}

// card: { kind, title, meta, photo (data URI JPEG/PNG sau null), political, cta }
export async function renderShareImage(card, format, { baseDir = process.cwd(), quality = 84 } = {}) {
  const fonts = await prepare(baseDir);
  const { width, height } = FORMATS[format];
  const svg = await satori(format === 'story' ? storyTree(card) : ogTree(card), { width, height, fonts });
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  const encoded = jpeg.encode({ data: rendered.pixels, width: rendered.width, height: rendered.height }, quality);
  rendered.free?.();
  return encoded.data;
}

let webpDecoder;
// WebP (formatul fotografiilor site-ului) se decodează în WebAssembly, apoi se trece în JPEG,
// singurele formate încorporabile fiind PNG și JPEG.
async function decodeWebp(buffer, baseDir) {
  webpDecoder ||= (async () => {
    // Codecul emscripten creează ImageData, care nu există în Node.
    globalThis.ImageData ||= class ImageData {
      constructor(data, width, height) { Object.assign(this, { data, width, height }); }
    };
    const { default: decode, init } = await import('@jsquash/webp/decode.js');
    await init(await WebAssembly.compile(await fs.readFile(resolveModuleFile(baseDir, '@jsquash/webp/codec/dec/webp_dec.wasm'))));
    return decode;
  })().catch((error) => { webpDecoder = undefined; throw error; });
  const decode = await webpDecoder;
  const image = await decode(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  return Buffer.from(jpeg.encode({ data: image.data, width: image.width, height: image.height }, 82).data);
}

const isWebp = buffer => buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';

// Fotografia publicației ca data URI JPEG/PNG; null dacă lipsește sau nu poate fi citită.
export async function photoDataUri(buffer, { baseDir = process.cwd() } = {}) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  if (buffer.subarray(1, 4).toString('latin1') === 'PNG') return `data:image/png;base64,${buffer.toString('base64')}`;
  if (isWebp(buffer)) {
    try { return `data:image/jpeg;base64,${(await decodeWebp(buffer, baseDir)).toString('base64')}`; } catch { return null; }
  }
  return null;
}
