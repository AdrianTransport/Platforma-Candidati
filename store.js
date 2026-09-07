import path from 'path';
import fs from 'fs/promises';

const LOCAL_FILE = path.join(process.cwd(), 'data', 'db.json');
const DEFAULT_DATA = {
  users: [], articole: [], portal_posts: [],
  nextUserId: 1, nextArticolId: 1, nextPortalPostId: 1,
};

// "process.env.NETLIFY" NU e setat garantat in interiorul unei functii Netlify -
// detectam mediul serverless prin variabilele standard AWS Lambda (Netlify Functions
// ruleaza pe Lambda), care sunt intotdeauna prezente acolo si niciodata local.
const ESTE_SERVERLESS = Boolean(
  process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY
);

let blobsStorePromise = null;
function getBlobsStore() {
  if (!blobsStorePromise) {
    blobsStorePromise = import('@netlify/blobs')
      .then(({ getStore }) => getStore('campanie-db'))
      .catch((err) => {
        console.error('Nu am putut initializa Netlify Blobs:', err);
        return null;
      });
  }
  return blobsStorePromise;
}

export async function readData() {
  if (ESTE_SERVERLESS) {
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
  if (ESTE_SERVERLESS) {
    const store = await getBlobsStore();
    if (store) {
      await store.setJSON('db', data);
      return;
    }
    // Daca Blobs chiar nu e disponibil pe Netlify, nu incercam sa scriem pe disc -
    // acolo sistemul de fisiere e needitabil si am arunca exact eroarea ENOENT
    // intalnita. Aruncam o eroare clara in schimb.
    throw new Error('Netlify Blobs indisponibil si scrierea locala nu e permisa in acest mediu.');
  }
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  await fs.writeFile(LOCAL_FILE, JSON.stringify(data, null, 2));
}
