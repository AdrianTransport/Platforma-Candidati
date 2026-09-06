import path from 'path';
import fs from 'fs/promises';

const LOCAL_FILE = path.join(process.cwd(), 'data', 'db.json');

const DEFAULT_DATA = { users: [], articole: [], nextUserId: 1, nextArticolId: 1 };

let blobsStorePromise = null;
function getBlobsStore() {
  // @netlify/blobs functioneaza doar in mediul de runtime Netlify (functions).
  // Local, import-ul esueaza silentios si cadem pe fisierul JSON.
  if (!blobsStorePromise) {
    blobsStorePromise = import('@netlify/blobs')
      .then(({ getStore }) => getStore('campanie-db'))
      .catch(() => null);
  }
  return blobsStorePromise;
}

export async function readData() {
  if (process.env.NETLIFY) {
    const store = await getBlobsStore();
    if (store) {
      const data = await store.get('db', { type: 'json' });
      return data || structuredClone(DEFAULT_DATA);
    }
  }
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}

export async function writeData(data) {
  if (process.env.NETLIFY) {
    const store = await getBlobsStore();
    if (store) {
      await store.setJSON('db', data);
      return;
    }
  }
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(data, null, 2));
}
