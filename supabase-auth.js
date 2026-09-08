const PROJECT_URL = 'https://sfxdxatfcllwkihxqhra.supabase.co';

async function authRequest(path, { method = 'GET', body, key = process.env.SUPABASE_SECRET_KEY } = {}) {
  if (!key) throw new Error('SUPABASE_SECRET_KEY lipsește.');
  const response = await fetch(`${PROJECT_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || `Supabase Auth ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function listAuthUsers(key) {
  const result = await authRequest('admin/users?page=1&per_page=1000', { key });
  return result?.users || [];
}

export function createAuthUser(user, key) {
  return authRequest('admin/users', {
    method: 'POST', key,
    body: {
      email: user.email,
      password_hash: user.password_hash,
      email_confirm: true,
      app_metadata: { role: user.role, legacy_id: user.id },
    },
  });
}

export function createAuthUserWithPassword(user, password, key) {
  return authRequest('admin/users', {
    method: 'POST', key,
    body: {
      email: user.email,
      password,
      email_confirm: true,
      app_metadata: { role: user.role, legacy_id: user.id },
    },
  });
}

export function signInWithPassword(email, password) {
  return authRequest('token?grant_type=password', { method: 'POST', body: { email, password } });
}

export function updateAuthPassword(userId, password) {
  return authRequest(`admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: { password } });
}

export function deleteAuthUser(userId) {
  return authRequest(`admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}
