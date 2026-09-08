import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupabaseKeyStore, useSupabase } from './supabase-store.js';

// Fiecare comentariu/eveniment are o cheie proprie. Nu rescriem db.json.
export function createLocalCommentStore(directory = path.join(process.cwd(), 'data', 'comments')) {
  function location(key) {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.split('/').some(p => !p)) throw new Error('Cheie invalidă.');
    return path.join(directory, `${key}.json`);
  }
  return {
    async get(key) {
      try { return JSON.parse(await fs.readFile(location(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async set(key, value) {
      const file = location(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await fs.link(temporary, file); // Vizibil atomic; nu suprascrie o cheie existentă.
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async keys(prefix) {
      const found = [];
      async function walk(directoryPath, keyPrefix = '') {
        let entries;
        try { entries = await fs.readdir(directoryPath, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          const key = keyPrefix + entry.name;
          if (entry.isDirectory()) await walk(path.join(directoryPath, entry.name), `${key}/`);
          else if (key.endsWith('.json') && key.startsWith(prefix)) found.push(key.slice(0, -5));
        }
      }
      await walk(directory);
      return found;
    },
    async delete(key) { await fs.rm(location(key), { force: true }); },
  };
}

export function createBlobCommentStore(store) {
  return {
    // SDK 8.2 connectLambda nu propagă uncachedEdgeURL pentru citiri strong.
    // Comentariile și moderările sunt exclusiv obiecte noi, niciodată actualizate.
    // Netlify face disponibile imediat bloburile noi și cu consistența implicită.
    get: key => store.get(key, { type: 'json' }),
    set: (key, value) => store.setJSON(key, value),
    keys: async prefix => (await store.list({ prefix })).blobs.map(blob => blob.key),
    delete: key => store.delete(key),
  };
}

export function createCommentStore() {
  const serverless = process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!serverless) return createLocalCommentStore();
  if (useSupabase()) return createSupabaseKeyStore('comments');
  let adapter;
  async function ready() {
    if (!adapter) {
      const { getStore, getDeployStore } = await import('@netlify/blobs');
      const options = { name: 'campanie-comments' };
      const preview = process.env.CONTEXT && process.env.CONTEXT !== 'production';
      // Handlerul Lambda v8 nu propagă primaryRegion. Regiunea Lambda existentă
      // permite getDeployStore fără a alege arbitrar o altă regiune de stocare.
      const deployOptions = process.env.AWS_REGION ? { ...options, region: process.env.AWS_REGION } : options;
      adapter = createBlobCommentStore(preview ? getDeployStore(deployOptions) : getStore(options));
    }
    return adapter;
  }
  // Erorile Blobs se propagă. Nicio scriere pe discul temporar din Functions.
  return Object.fromEntries(['get', 'set', 'keys', 'delete'].map(method =>
    [method, async (...args) => (await ready())[method](...args)]));
}
