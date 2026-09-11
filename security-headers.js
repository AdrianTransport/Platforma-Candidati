// Keep the static-file policy in netlify.toml in sync. Netlify Functions must
// return their own headers; static routing headers do not cover Express pages.
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    // Existing templates use inline styles for layout, images and poll bars.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Article/profile URLs accept external photos; editor previews use data/blob.
    "img-src 'self' https: http: data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "media-src 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-write=(self), web-share=(self)',
});

export function securityHeaders(req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}
