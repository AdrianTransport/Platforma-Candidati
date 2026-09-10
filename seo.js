// Metadate pentru paginile publice, fără servicii externe sau date private.
export const PORTAL_SITE_NAME = 'Vocea Locală Lenauheim';
export const PORTAL_DESCRIPTION = 'Știri locale și informații despre administrație, comunitate și inițiative din Bulgăruș, Lenauheim și Grabaț, județul Timiș.';

export function seoDescription(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  const excerpt = text.slice(0, 157);
  const wordEnd = excerpt.lastIndexOf(' ');
  return `${wordEnd > 110 ? excerpt.slice(0, wordEnd) : excerpt}…`;
}

export function seoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function jsonLd(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function publicImageUrl(value, baseUrl) {
  if (!value || !/^(?:https?:\/\/|\/(?!\/))/i.test(value)) return null;
  try {
    const url = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function portalPageSeo(baseUrl, { path = '/', title, description = PORTAL_DESCRIPTION, noindex = false } = {}) {
  const homeUrl = new URL('/', baseUrl).href;
  const canonical = new URL(path, homeUrl).href;
  return {
    title: title || `${PORTAL_SITE_NAME} — știri din Bulgăruș, Lenauheim și Grabaț`,
    description: seoDescription(description),
    canonical,
    type: 'website',
    siteName: PORTAL_SITE_NAME,
    image: null,
    imageAlt: '',
    robots: noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large',
    publishedAt: null,
    modifiedAt: null,
    structuredData: path === '/' ? {
      '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${homeUrl}#website`,
      name: PORTAL_SITE_NAME, url: homeUrl, inLanguage: 'ro-RO',
      description: seoDescription(description),
    } : null,
  };
}

export function portalArticleSeo(baseUrl, post) {
  const seo = portalPageSeo(baseUrl, {
    path: `/actualitate/${encodeURIComponent(post.slug)}`,
    title: `${post.titlu} — ${PORTAL_SITE_NAME}`,
    description: post.rezumat || post.continut,
  });
  // Aceeași dată ca în pagina publică, inclusiv pentru materialele vechi.
  const publishedAt = seoDate(post.data_publicare || post.updated_at || post.created_at);
  const updatedAt = seoDate(post.updated_at);
  const modifiedAt = updatedAt && (!publishedAt || updatedAt >= publishedAt) ? updatedAt : publishedAt;
  const image = publicImageUrl(post.imagine_url, baseUrl);
  return {
    ...seo, type: 'article', publishedAt, modifiedAt, image,
    imageAlt: image ? String(post.imagine_alt || '') : '',
    structuredData: {
      '@context': 'https://schema.org',
      '@type': post.tip === 'stire' ? 'NewsArticle' : 'Article',
      '@id': `${seo.canonical}#article`,
      headline: post.titlu,
      description: seo.description,
      url: seo.canonical,
      mainEntityOfPage: { '@type': 'WebPage', '@id': seo.canonical },
      inLanguage: 'ro-RO',
      ...(post.categorie ? { articleSection: post.categorie } : {}),
      ...(publishedAt ? { datePublished: publishedAt } : {}),
      ...(modifiedAt ? { dateModified: modifiedAt } : {}),
      ...(image ? { image: [image] } : {}),
      // Publicația este cunoscută; nu atribuim automat responsabilului editorial
      // calitatea de autor și nu includem emailuri ori alte date din contul admin.
      publisher: { '@type': 'Organization', name: PORTAL_SITE_NAME, url: new URL('/', baseUrl).href },
    },
  };
}
