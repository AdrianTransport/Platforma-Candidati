import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { readSupabaseState, useSupabase, writeSupabaseState } from './supabase-store.js';

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

export async function readData() {
  if (ESTE_SERVERLESS && useSupabase()) return (await readSupabaseState()) || structuredClone(DEFAULT_DATA);
  if (ESTE_SERVERLESS) {
    const store = await getBlobsStore();
    const data = await store.get('db', { type: 'json' });
    return data || structuredClone(DEFAULT_DATA);
  }
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(DEFAULT_DATA);
    throw error;
  }
}

export async function writeData(data) {
  if (ESTE_SERVERLESS && useSupabase()) return writeSupabaseState(data);
  if (ESTE_SERVERLESS) {
    const store = await getBlobsStore();
    await store.setJSON('db', data);
    return;
  }
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  const temporaryFile = `${LOCAL_FILE}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, JSON.stringify(data, null, 2));
    await fs.rename(temporaryFile, LOCAL_FILE);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}
