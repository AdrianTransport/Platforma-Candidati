import path from 'path';
import fs from 'fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readSupabaseSnapshot, useSupabase, writeSupabaseState } from './supabase-store.js';
import { StateConflictError } from './state-conflict.js';

const LOCAL_FILE = path.join(process.cwd(), 'data', 'db.json');
const DEFAULT_DATA = {
  users: [], articole: [], portal_posts: [], polls: [], raportari_costuri: [], raportari_costuri_arhiva: [],
  nextUserId: 1, nextArticolId: 1, nextPortalPostId: 1, nextPollId: 1, nextRaportareId: 1,
};

// "process.env.NETLIFY" NU e setat garantat in interiorul unei functii Netlify -
// detectam mediul serverless prin variabilele standard AWS Lambda (Netlify Functions
// ruleaza pe Lambda), care sunt intotdeauna prezente acolo si niciodata local.
const ESTE_SERVERLESS = Boolean(
  process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
);

let blobsCredentials;
export function configureBlobsCredentials(credentials) {
  blobsCredentials = credentials;
}

async function getBlobsStore() {
  const { getStore } = await import('@netlify/blobs');
  // Adaptor nou pentru tokenul invocării curente. Credențialele explicite folosesc
  // API-ul de origine, evitând citirea unei copii vechi a întregii baze din edge.
  return getStore(blobsCredentials
    ? { name: 'campanie-db', ...blobsCredentials }
    : { name: 'campanie-db', consistency: 'strong' });
}

async function readLocalSnapshot() {
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8');
    return { data: JSON.parse(raw), version: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return { data: structuredClone(DEFAULT_DATA), version: null };
    throw error;
  }
}

export async function readDataSnapshot() {
  if (ESTE_SERVERLESS && useSupabase()) {
    const snapshot = await readSupabaseSnapshot();
    return { ...snapshot, data: snapshot.data || structuredClone(DEFAULT_DATA) };
  }
  if (ESTE_SERVERLESS) {
    const store = await getBlobsStore();
    const result = await store.getWithMetadata('db', { type: 'json' });
    if (!result) return { data: structuredClone(DEFAULT_DATA), version: null };
    if (!result.etag) throw new Error('Versiunea datelor lipsește din răspunsul Blobs.');
    return { data: result.data, version: result.etag };
  }
  return readLocalSnapshot();
}

export async function readData() {
  return (await readDataSnapshot()).data;
}

export async function writeData(data, expectedVersion) {
  if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !expectedVersion)) {
    throw new Error('Citește versiunea datelor înainte de salvare.');
  }
  if (ESTE_SERVERLESS && useSupabase()) return writeSupabaseState(data, expectedVersion);
  if (ESTE_SERVERLESS) {
    const store = await getBlobsStore();
    const result = await store.setJSON('db', data, expectedVersion === null
      ? { onlyIfNew: true } : { onlyIfMatch: expectedVersion });
    if (result?.modified === false) throw new StateConflictError();
    if (result?.modified !== true || !result.etag) throw new Error('Salvarea condiționată nu a fost confirmată de Blobs.');
    return result.etag;
  }
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  // Lacăt exclusiv între procese, ținut doar pe durata comparației și înlocuirii.
  // Nu eliminăm automat un lacăt al altui proces pe baza unui timeout.
  const lockFile = `${LOCAL_FILE}.lock`;
  let lock;
  try { lock = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new StateConflictError(); throw error; }
  const temporaryFile = `${LOCAL_FILE}.${randomUUID()}.tmp`;
  try {
    if ((await readLocalSnapshot()).version !== expectedVersion) throw new StateConflictError();
    const raw = JSON.stringify(data, null, 2);
    await fs.writeFile(temporaryFile, raw, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporaryFile, LOCAL_FILE);
    return createHash('sha256').update(raw).digest('hex');
  } finally {
    try { await fs.rm(temporaryFile, { force: true }); }
    finally { await lock.close(); await fs.unlink(lockFile); }
  }
}
