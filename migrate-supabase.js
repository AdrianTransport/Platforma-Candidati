import { createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

const NAMESPACES = [
  ['comments', 'campanie-comments'],
  ['compliance', 'campanie-compliance'],
  ['editorial', 'campanie-editorial'],
];

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function checksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function supabaseRequest({ url, key }, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Supabase ${method} ${response.status}`);
  if (response.status === 204 || method === 'HEAD') return null;
  return response.json();
}

async function allBlobKeys(store) {
  const keys = [];
  for await (const page of store.list({ paginate: true })) {
    keys.push(...page.blobs.map(blob => blob.key));
  }
  return keys.sort();
}

export async function migrateBlobsToSupabase({ authorization, env }) {
  const token = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(token, env.MIGRATION_TOKEN)) return { statusCode: 404, body: 'Not found' };
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    const missing = [!env.SUPABASE_URL && 'SUPABASE_URL', !env.SUPABASE_SECRET_KEY && 'SUPABASE_SECRET_KEY'].filter(Boolean);
    return { statusCode: 503, body: `Missing environment variables: ${missing.join(', ')}` };
  }
  const client = { url: env.SUPABASE_URL.replace(/\/$/, ''), key: env.SUPABASE_SECRET_KEY };
  const database = await getStore('campanie-db').get('db', { type: 'json' });
  if (!database) throw new Error('Source database is empty');
  await supabaseRequest(client, 'platform_state?on_conflict=id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { id: 'db', payload: database, updated_at: new Date().toISOString() },
  });

  const report = { state: { source: checksum(database), destination: '' }, namespaces: {} };
  for (const [namespace, storeName] of NAMESPACES) {
    const store = getStore(storeName);
    const keys = await allBlobKeys(store);
    const sourceHashes = [];
    for (const key of keys) {
      const payload = await store.get(key, { type: 'json' });
      sourceHashes.push([key, checksum(payload)]);
      await supabaseRequest(client, 'platform_kv?on_conflict=namespace,key', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { namespace, key, payload, updated_at: new Date().toISOString() },
      });
    }
    const destination = await supabaseRequest(client,
      `platform_kv?namespace=eq.${encodeURIComponent(namespace)}&select=key,payload&order=key`);
    const destinationHashes = destination.map(row => [row.key, checksum(row.payload)]);
    report.namespaces[namespace] = {
      sourceCount: keys.length,
      destinationCount: destination.length,
      match: checksum(sourceHashes) === checksum(destinationHashes),
    };
  }
  const stateRows = await supabaseRequest(client, 'platform_state?id=eq.db&select=payload');
  report.state.destination = checksum(stateRows[0]?.payload);
  report.state.match = report.state.source === report.state.destination;
  report.complete = report.state.match && Object.values(report.namespaces).every(item => item.match);
  return { statusCode: report.complete ? 200 : 409, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) };
}
