import bcrypt from 'bcryptjs';
import { createAuthUser, listAuthUsers } from './supabase-auth.js';
import { readSupabaseState, writeSupabaseState } from './supabase-store.js';

function basicCredentials(authorization) {
  const encoded = String(authorization || '').replace(/^Basic\s+/i, '');
  if (!encoded) return {};
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return separator < 0 ? {} : { email: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export async function migrateAuth({ authorization, key }) {
  const state = await readSupabaseState();
  if (!state?.users?.length) throw new Error('Nu există utilizatori pentru migrare.');
  const { email, password } = basicCredentials(authorization);
  const admin = state.users.find(user => user.role === 'admin' && String(user.email).toLowerCase() === String(email).toLowerCase());
  if (!admin || !await bcrypt.compare(String(password || ''), admin.password_hash)) {
    return { statusCode: 404, body: 'Not found' };
  }
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
