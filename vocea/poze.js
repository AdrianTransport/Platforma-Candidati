import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getBlobsCredentials } from '../store.js';

// Pozele din anunțuri: verificate pe server după conținut (nu după extensie), fără metadate EXIF/GPS.
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;
export const MAX_SIDE = 1600;
export const THUMB_SIDE = 640;
// Încărcările neatașate unui anunț se șterg după o zi.
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const UPLOADS_PER_DAY = 25;

export const newPhotoId = () => randomUUID();

const MIME = { jpeg: 'image/jpeg', webp: 'image/webp' };
export const mimeOf = format => MIME[format] || 'application/octet-stream';

export function detectFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Dimensiunile reale, citite din antetul imaginii.
export function imageSize(buffer, format) {
  if (format === 'jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0–SOF15, fără DHT (C4), JPG (C8) și DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (format === 'webp') {
    const chunk = buffer.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

// JPEG: scoate segmentele APP1 (EXIF, XMP, inclusiv GPS), APP13 (IPTC) și comentariile.
function stripJpeg(buffer) {
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xda) { parts.push(buffer.subarray(offset)); return Buffer.concat(parts); }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(buffer.subarray(offset, offset + 2)); offset += 2; continue; }
    const end = offset + 2 + buffer.readUInt16BE(offset + 2);
    if (end > buffer.length) return null;
    if (![0xe1, 0xed, 0xfe].includes(marker)) parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  return null;
}

// WebP: scoate blocurile EXIF și XMP și actualizează antetul.
function stripWebp(buffer) {
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length + 1) return null;
    if (id !== 'EXIF' && id !== 'XMP ') chunks.push(Buffer.from(buffer.subarray(offset, Math.min(end, buffer.length))));
    offset = end;
  }
  const vp8x = chunks.find(chunk => chunk.toString('latin1', 0, 4) === 'VP8X');
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // fără steagurile EXIF și XMP
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

// Întoarce { buffer, format, width, height } sau { error }.
export function checkPhoto(buffer, { maxSide = MAX_SIDE } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { error: 'Fișierul este gol.' };
  if (buffer.length > MAX_PHOTO_BYTES) return { error: 'Poza este prea mare. Încearcă din nou: site-ul o micșorează automat.' };
  const format = detectFormat(buffer);
  if (!format) return { error: 'Fișierul nu este o poză JPEG sau WebP.' };
  const clean = format === 'jpeg' ? stripJpeg(buffer) : stripWebp(buffer);
  const size = clean && imageSize(clean, format);
  if (!clean || !size?.width || !size?.height) return { error: 'Poza pare deteriorată.' };
  if (size.width > maxSide + 8 || size.height > maxSide + 8) return { error: `Poza depășește ${maxSide} px pe latura mare.` };
  return { buffer: clean, format, ...size };
}

/* -------------------------------- stocare -------------------------------- */

export function blobsPhotoStore(name = 'vocea-poze') {
  const open = async () => {
    const { getStore } = await import('@netlify/blobs');
    const credentials = getBlobsCredentials();
    return getStore(credentials ? { name, ...credentials } : { name, consistency: 'strong' });
  };
  return {
    async put(id, buffer) { await (await open()).set(id, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)); },
    async get(id) { const data = await (await open()).get(id, { type: 'arrayBuffer' }); return data ? Buffer.from(data) : null; },
    async delete(id) { await (await open()).delete(id); },
  };
}

export function filePhotoStore(dir = path.join(process.cwd(), 'data', 'poze')) {
  const safe = id => path.join(dir, String(id).replace(/[^\w-]/g, ''));
  return {
    async put(id, buffer) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(safe(id), buffer); },
    async get(id) { try { return await fs.readFile(safe(id)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async delete(id) { await fs.rm(safe(id), { force: true }); },
  };
}

export function memoryPhotoStore() {
  const items = new Map();
  return {
    async put(id, buffer) { items.set(id, Buffer.from(buffer)); },
    async get(id) { return items.get(id) || null; },
    async delete(id) { items.delete(id); },
    size: () => items.size,
  };
}

export function defaultPhotoStore() {
  const serverless = Boolean(process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
  return serverless ? blobsPhotoStore() : filePhotoStore();
}

// Ambele variante ale unei poze (mare și miniatură) se șterg împreună.
export async function deletePhotoFiles(store, photos) {
  await Promise.all((photos || []).flatMap(photo => [store.delete(photo.id), store.delete(`${photo.id}-mic`)]).map(p => p.catch(() => {})));
}
