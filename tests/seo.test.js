import test from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL_SITE_NAME, seoDescription, seoDate, jsonLd, portalPageSeo, portalArticleSeo } from '../seo.js';

const base = 'https://vocealenauheim.ro';

test('SEO: descrieri compacte și date reale, fără date de actualizare inventate', () => {
  assert.equal(seoDescription('  Știri\n din   Lenauheim  '), 'Știri din Lenauheim');
  assert.equal(seoDescription(null), '');
  assert.ok(seoDescription('Știri locale '.repeat(30)).length <= 160);
  assert.equal(seoDate('2026-09-10T10:30:00+03:00'), '2026-09-10T07:30:00.000Z');
  assert.equal(seoDate('data necunoscută'), null);
  assert.equal(seoDate(null), null);
});

test('SEO: JSON-LD sigur pentru inserare în HTML, cu păstrarea textului original', () => {
  const value = { headline: '</script><script>alert("x")</script> & > \u2028\u2029' };
  const encoded = jsonLd(value);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(encoded), value);
});

test('SEO: identitatea portalului și adrese absolute pentru pagini și paginare', () => {
  const home = portalPageSeo(base);
  assert.equal(home.siteName, PORTAL_SITE_NAME);
  assert.equal(home.canonical, `${base}/`);
  assert.equal(home.structuredData['@type'], 'WebSite');
  assert.equal(home.structuredData.name, PORTAL_SITE_NAME);
  assert.equal(home.structuredData.url, home.canonical);
  const page = portalPageSeo(`${base}/`, { path: '/candidati?pagina=2', noindex: true });
  assert.equal(page.canonical, `${base}/candidati?pagina=2`);
  assert.equal(page.robots, 'noindex, follow');
  assert.equal(page.structuredData, null);
});

test('SEO: NewsArticle descrie materialul real și nu exportă datele private din înregistrare', () => {
  const post = { tip: 'stire', slug: 'buget & școli', titlu: 'Bugetul local', rezumat: 'Rezumatul știrii.',
    categorie: 'Administrație', data_publicare: '2026-09-01T09:00:00Z', updated_at: '2026-09-02T10:00:00Z',
    imagine_url: '/media/imagine-publica', imagine_alt: 'Consiliul local', email: 'privat@example.test', ip_hash: 'secret',
    transparenta: { responsabil_editorial: 'Nume care nu este declarat autor' } };
  const seo = portalArticleSeo(base, post);
  const schema = seo.structuredData;
  assert.equal(seo.canonical, `${base}/actualitate/${encodeURIComponent(post.slug)}`);
  assert.equal(seo.title, `${post.titlu} — ${PORTAL_SITE_NAME}`);
  assert.equal(schema['@type'], 'NewsArticle');
  assert.equal(schema.headline, post.titlu);
  assert.equal(schema.description, post.rezumat);
  assert.equal(schema.mainEntityOfPage['@id'], seo.canonical);
  assert.equal(schema.datePublished, '2026-09-01T09:00:00.000Z');
  assert.equal(schema.dateModified, '2026-09-02T10:00:00.000Z');
  assert.deepEqual(schema.image, [`${base}/media/imagine-publica`]);
  assert.equal(seo.image, `${base}/media/imagine-publica`);
  assert.equal(seo.imageAlt, post.imagine_alt);
  assert.equal(schema.author, undefined);
  assert.doesNotMatch(JSON.stringify(schema), /privat@example|secret|Nume care/);
  assert.equal(portalArticleSeo(base, { ...post, tip: 'campanie' }).structuredData['@type'], 'Article');
  assert.equal(portalArticleSeo(base, { ...post, data_publicare: null, created_at: '2026-08-01T09:00:00Z' }).publishedAt,
    '2026-09-02T10:00:00.000Z', 'Materialele vechi folosesc aceeași dată ca pagina vizibilă');
  assert.equal(portalArticleSeo(base, { ...post, updated_at: '2026-08-01T09:00:00Z' }).modifiedAt,
    '2026-09-01T09:00:00.000Z', 'Data modificării nu este înainte de publicare');
});

test('SEO: fără imagini substituite, protocoale periculoase sau date invalide', () => {
  const post = { tip: 'stire', slug: 'fara-fotografie', titlu: 'Știre fără fotografie', continut: 'Conținut real.',
    data_publicare: 'invalid', updated_at: 'invalid' };
  for (const imagine_url of ['', 'javascript:alert(1)', 'data:image/png;base64,abc', '//other.example/image', 'https://user:pass@example.test/photo']) {
    const seo = portalArticleSeo(base, { ...post, imagine_url });
    const schema = seo.structuredData;
    assert.equal(seo.image, null);
    assert.equal(schema.image, undefined);
    assert.equal(schema.datePublished, undefined);
    assert.equal(schema.dateModified, undefined);
  }
  assert.deepEqual(portalArticleSeo(base, { ...post, imagine_url: 'https://example.test/photo.webp' }).structuredData.image,
    ['https://example.test/photo.webp']);
});
