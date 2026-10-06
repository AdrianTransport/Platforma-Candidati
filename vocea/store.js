import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { getBlobsCredentials } from '../store.js';
import { StateConflictError } from '../state-conflict.js';

// Dosarele, actualizările live și anunțurile stau separat de starea platformei:
// un document JSON mic în Netlify Blobs (store „vocea-db”), scris condiționat cu etag.
// Local (și în teste) același document stă în data/vocea.json.
export function emptyVocea() {
  return { schema: 1, dosare: [], anunturi: [], settings: {}, limite: {} };
}

function normalize(data) {
  const out = { ...emptyVocea(), ...(data || {}) };
  for (const key of ['dosare', 'anunturi']) if (!Array.isArray(out[key])) out[key] = [];
  for (const key of ['settings', 'limite']) if (!out[key] || typeof out[key] !== 'object' || Array.isArray(out[key])) out[key] = {};
  for (const dosar of out.dosare) {
    dosar.termene ||= [];
    dosar.updates ||= [];
  }
  return out;
}

const sha = raw => createHash('sha256').update(raw).digest('hex');

export function blobsBackend({ name = 'vocea-db', key = 'db' } = {}) {
  const open = async () => {
    const { getStore } = await import('@netlify/blobs');
    const credentials = getBlobsCredentials();
    // Cu credențialele invocării citim de la origine, nu o copie veche din edge.
    return getStore(credentials ? { name, ...credentials } : { name, consistency: 'strong' });
  };
  return {
    async read() {
      const result = await (await open()).getWithMetadata(key, { type: 'json' });
      if (!result) return { data: null, version: null };
      if (!result.etag) throw new Error('Versiunea datelor lipsește din răspunsul Blobs.');
      return { data: result.data, version: result.etag };
    },
    async write(data, version) {
      const result = await (await open()).setJSON(key, data, version === null ? { onlyIfNew: true } : { onlyIfMatch: version });
      if (result?.modified === false) throw new StateConflictError();
      if (result?.modified !== true) throw new Error('Salvarea condiționată nu a fost confirmată de Blobs.');
    },
  };
}

export function fileBackend(file = path.join(process.cwd(), 'data', 'vocea.json')) {
  let queue = Promise.resolve();
  const read = async () => {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return { data: JSON.parse(raw), version: sha(raw) };
    } catch (error) {
      if (error.code === 'ENOENT') return { data: null, version: null };
      throw error;
    }
  };
  return {
    read,
    write(data, version) {
      // Scrierile din procesul local sunt serializate; o versiune veche înseamnă conflict.
      const run = queue.then(async () => {
        if ((await read()).version !== version) throw new StateConflictError();
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data, null, 2));
        await fs.rename(tmp, file);
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

export function memoryBackend(initial = null) {
  let raw = initial ? JSON.stringify(initial) : null;
  return {
    async read() { return raw ? { data: JSON.parse(raw), version: sha(raw) } : { data: null, version: null }; },
    async write(data, version) {
      if ((raw ? sha(raw) : null) !== version) throw new StateConflictError();
      raw = JSON.stringify(data);
    },
  };
}

export function defaultVoceaBackend() {
  const serverless = Boolean(process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
  return serverless ? blobsBackend() : fileBackend();
}

export function createVoceaStore(backend = defaultVoceaBackend()) {
  return {
    async read() {
      return normalize((await backend.read()).data);
    },
    // `mutate` poate rula de mai multe ori la conflict: să modifice doar datele primite.
    async update(mutate, { attempts = 6 } = {}) {
      for (let i = 0; i < attempts; i += 1) {
        if (i) await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 60 * i));
        const snapshot = await backend.read();
        const data = normalize(snapshot.data);
        const result = await mutate(data);
        try {
          await backend.write(data, snapshot.version);
          return result;
        } catch (error) {
          if (!(error instanceof StateConflictError) || i === attempts - 1) throw error;
        }
      }
      throw new StateConflictError();
    },
  };
}
