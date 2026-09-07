import crypto from 'crypto';

const META_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const META_GRAPH = `https://graph.facebook.com/${META_VERSION}`;

function encryptionKey() {
  const secret = process.env.OAUTH_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('OAUTH_ENCRYPTION_KEY trebuie configurata cu minimum 32 de caractere.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const [ivText, tagText, encryptedText] = String(payload).split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Tokenul salvat nu are un format valid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function randomState() {
  return crypto.randomBytes(32).toString('base64url');
}

export function publicBaseUrl(req) {
  return String(process.env.URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

export function metaConfigured() {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.OAUTH_ENCRYPTION_KEY);
}

export function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.OAUTH_ENCRYPTION_KEY);
}

export function metaAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish',
  });
  return `https://www.facebook.com/${META_VERSION}/dialog/oauth?${params}`;
}

async function responseJson(response, label) {
  const data = await response.json().catch(() => ({}));
  const providerError = data.error && !(typeof data.error === 'object' && data.error.code === 'ok');
  if (!response.ok || providerError) {
    const message = data.error?.message || data.error_description || (typeof data.error === 'string' ? data.error : '') || `${label} a raspuns cu HTTP ${response.status}.`;
    throw new Error(message);
  }
  return data;
}

export async function exchangeMetaCode(code, redirectUri) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });
  const shortToken = await responseJson(await fetch(`${META_GRAPH}/oauth/access_token?${params}`), 'Meta OAuth');
  const longParams = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: shortToken.access_token,
  });
  return responseJson(await fetch(`${META_GRAPH}/oauth/access_token?${longParams}`), 'Meta OAuth');
}

export async function fetchMetaPages(userAccessToken) {
  const params = new URLSearchParams({
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    access_token: userAccessToken,
  });
  const result = await responseJson(await fetch(`${META_GRAPH}/me/accounts?${params}`), 'Meta Pages');
  return (result.data || []).map((page) => ({
    id: page.id,
    name: page.name,
    access_token_enc: encryptSecret(page.access_token),
    instagram_id: page.instagram_business_account?.id || '',
    instagram_username: page.instagram_business_account?.username || '',
  }));
}

export async function publishFacebook(page, message, link) {
  const body = new URLSearchParams({
    message,
    link,
    access_token: decryptSecret(page.access_token_enc),
  });
  return responseJson(await fetch(`${META_GRAPH}/${encodeURIComponent(page.id)}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }), 'Facebook');
}

export async function publishInstagram(page, caption, imageUrl) {
  if (!page.instagram_id) throw new Error('Pagina Facebook selectata nu are un cont Instagram profesional asociat.');
  if (!imageUrl) throw new Error('Instagram necesita o imagine publica pentru articol.');
  const token = decryptSecret(page.access_token_enc);
  const mediaBody = new URLSearchParams({ image_url: imageUrl, caption, access_token: token });
  const container = await responseJson(await fetch(`${META_GRAPH}/${encodeURIComponent(page.instagram_id)}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: mediaBody,
  }), 'Instagram media');
  const publishBody = new URLSearchParams({ creation_id: container.id, access_token: token });
  return responseJson(await fetch(`${META_GRAPH}/${encodeURIComponent(page.instagram_id)}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishBody,
  }), 'Instagram publish');
}

export function tiktokAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: 'user.info.basic,video.publish',
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

export async function exchangeTikTokCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  return responseJson(await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body,
  }), 'TikTok OAuth');
}

async function tiktokAccessToken(connection) {
  if (new Date(connection.expires_at || 0).getTime() > Date.now() + 5 * 60 * 1000) {
    return decryptSecret(connection.access_token_enc);
  }
  if (!connection.refresh_token_enc) throw new Error('Sesiunea TikTok a expirat. Reconecteaza contul.');
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: decryptSecret(connection.refresh_token_enc),
  });
  const token = await responseJson(await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body,
  }), 'TikTok refresh');
  connection.access_token_enc = encryptSecret(token.access_token);
  connection.refresh_token_enc = encryptSecret(token.refresh_token);
  connection.expires_at = new Date(Date.now() + Number(token.expires_in || 86400) * 1000).toISOString();
  connection.refresh_expires_at = new Date(Date.now() + Number(token.refresh_expires_in || 31536000) * 1000).toISOString();
  connection.scope = token.scope || connection.scope;
  return token.access_token;
}

export async function publishTikTokPhoto(connection, title, description, imageUrl) {
  if (!imageUrl) throw new Error('TikTok necesita o imagine publica pentru aceasta publicare.');
  const token = await tiktokAccessToken(connection);
  const creator = await responseJson(await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
  }), 'TikTok creator info');
  const options = creator.data?.privacy_level_options || [];
  const privacy = options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
  if (!privacy) throw new Error('TikTok nu a returnat o optiune de vizibilitate permisa.');
  return responseJson(await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: {
        title: String(title || '').slice(0, 90),
        description: String(description || '').slice(0, 2200),
        disable_comment: false,
        privacy_level: privacy,
        auto_add_music: true,
      },
      source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: [imageUrl] },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO',
    }),
  }), 'TikTok publish');
}
