import { timingSafeEqual } from 'node:crypto';
import { createAuthUser, listAuthUsers } from './supabase-auth.js';
import { readSupabaseState, writeSupabaseState } from './supabase-store.js';

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function migrateAuth({ authorization, token, key }) {
  const supplied = String(authorization || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(supplied, token)) return { statusCode: 404, body: 'Not found' };
  const state = await readSupabaseState();
  if (!state?.users?.length) throw new Error('Nu există utilizatori pentru migrare.');
  const existing = await listAuthUsers(key);
  const byEmail = new Map(existing.map(user => [String(user.email || '').toLowerCase(), user]));
  const migrated = [];
  for (const user of state.users) {
    let authUser = byEmail.get(String(user.email).toLowerCase());
    if (!authUser) authUser = await createAuthUser(user, key);
    user.auth_user_id = authUser.id;
    migrated.push({ legacy_id: user.id, auth_user_id: authUser.id, role: user.role });
  }
  await writeSupabaseState(state);
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ migrated }) };
}
