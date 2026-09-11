import { randomUUID } from 'node:crypto';
import { StateConflictError } from './state-conflict.js';

const PROJECT_URL = 'https://sfxdxatfcllwkihxqhra.supabase.co';

function config() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE_SECRET_KEY lipsește.');
  return { url: PROJECT_URL, key };
}

async function request(path, { method = 'GET', body, prefer } = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = new Error(`Supabase ${method} ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function useSupabase() {
  return process.env.DATA_BACKEND === 'supabase';
}

export async function readSupabaseState() {
  return (await readSupabaseSnapshot()).data;
}

export async function readSupabaseSnapshot() {
  const rows = await request('platform_state?id=eq.db&select=payload');
  if (!rows?.length) return { data: null, version: null };
  const { _stateRevision, ...data } = rows[0].payload || {};
  return { data, version: _stateRevision || 'legacy' };
}

export async function writeSupabaseState(payload, expectedVersion) {
  if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !expectedVersion)) {
    throw new Error('Citește versiunea datelor înainte de salvare.');
  }
  const version = randomUUID();
  const body = { payload: { ...payload, _stateRevision: version }, updated_at: new Date().toISOString() };
  let rows;
  if (expectedVersion === null) {
    try {
      rows = await request('platform_state?select=id', {
        method: 'POST', body: { id: 'db', ...body }, prefer: 'return=representation',
      });
    } catch (error) {
      if (error.status === 409) throw new StateConflictError();
      throw error;
    }
  } else {
    // Condiția este parte din UPDATE: PostgreSQL o reverifică după așteptarea
    // unei scrieri concurente. Nu folosim un SELECT urmat de upsert necondiționat.
    const filter = expectedVersion === 'legacy' ? 'is.null' : `eq.${encodeURIComponent(expectedVersion)}`;
    rows = await request(`platform_state?id=eq.db&payload->>_stateRevision=${filter}&select=id`, {
      method: 'PATCH', body, prefer: 'return=representation',
    });
  }
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== 'db') throw new StateConflictError();
  return version;
}

export function createSupabaseKeyStore(namespace) {
  if (!['comments', 'compliance', 'editorial'].includes(namespace)) throw new Error('Namespace Supabase invalid.');
  return {
    async get(key) {
      const rows = await request(`platform_kv?namespace=eq.${namespace}&key=eq.${encodeURIComponent(key)}&select=payload`);
      return rows?.[0]?.payload || null;
    },
    async set(key, payload) {
      try {
        await request('platform_kv', { method: 'POST', body: { namespace, key, payload }, prefer: 'return=minimal' });
      } catch (error) {
        if (error.status === 409) error.code = 'EEXIST';
        throw error;
      }
    },
    async keys(prefix) {
      const rows = await request(`platform_kv?namespace=eq.${namespace}&key=like.${encodeURIComponent(prefix)}*&select=key&order=key`);
      return (rows || []).map(row => row.key);
    },
    async delete(key) {
      await request(`platform_kv?namespace=eq.${namespace}&key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });
    },
  };
}
