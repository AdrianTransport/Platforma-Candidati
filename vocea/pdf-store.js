import path from 'node:path';
import fs from 'node:fs/promises';
import { getBlobsCredentials } from '../store.js';

// Fișierele PDF ale ședințelor: Netlify Blobs (store „vocea-pdf”), local în data/pdf/.
// Metadatele (nume, tip, mărime) stau în documentul „vocea-db”; aici doar conținutul.
export function blobsPdfStore(name = 'vocea-pdf') {
  const open = async () => {
    const { getStore } = await import('@netlify/blobs');
    const credentials = getBlobsCredentials();
    return getStore(credentials ? { name, ...credentials } : { name, consistency: 'strong' });
  };
  return {
    async put(id, buffer) { await (await open()).set(id, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)); },
    async get(id) {
      const data = await (await open()).get(id, { type: 'arrayBuffer' });
      return data ? Buffer.from(data) : null;
    },
    async delete(id) { await (await open()).delete(id); },
  };
}

export function filePdfStore(dir = path.join(process.cwd(), 'data', 'pdf')) {
  const safe = id => path.join(dir, `${String(id).replace(/[^\w-]/g, '')}.pdf`);
  return {
    async put(id, buffer) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(safe(id), buffer); },
    async get(id) {
      try { return await fs.readFile(safe(id)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async delete(id) { await fs.rm(safe(id), { force: true }); },
  };
}

export function memoryPdfStore() {
  const items = new Map();
  return {
    async put(id, buffer) { items.set(id, Buffer.from(buffer)); },
    async get(id) { return items.get(id) || null; },
    async delete(id) { items.delete(id); },
  };
}

export function defaultPdfStore() {
  const serverless = Boolean(process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
  return serverless ? blobsPdfStore() : filePdfStore();
}
