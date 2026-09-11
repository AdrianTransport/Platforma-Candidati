import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import express from 'express';
import serverless from 'serverless-http';
import { SECURITY_HEADERS, securityHeaders } from '../security-headers.js';

test('Politica Netlify și Express rămâne identică; JavaScript inline/eval și pluginurile sunt blocate', async () => {
  const config = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  const block = config.split('[[headers]]').find(section => section.includes('for = "/*"'));
  assert.ok(block);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.ok(block.includes(`${name} = "${value}"`), name);
  }
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /(?:^|; )script-src 'self'(?:;|$)/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-hashes|nonce-/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(SECURITY_HEADERS['Permissions-Policy'], /clipboard-write=\(self\), web-share=\(self\)/);
});

test('Șabloanele rămân compatibile cu CSP: scripturi locale, fără evenimente inline, JSON-LD păstrat', async () => {
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { await inspect(url); continue; }
      if (!entry.name.endsWith('.ejs')) continue;
      const html = await readFile(url, 'utf8');
      assert.doesNotMatch(html, /\bon(?:click|submit|load|error|change|input)\s*=/i, entry.name);
      for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/type="application\/ld\+json"/.test(attributes)) {
          assert.match(body, /jsonLd\(seo.structuredData\)/);
          continue; // An inert data block, not executable JavaScript.
        }
        const src = attributes.match(/src="(\/[^"\s]+)"/)?.[1];
        assert.ok(src && !src.startsWith('//'), entry.name);
        assert.equal(body.trim(), '', entry.name);
        await readFile(new URL('../public' + src.split('?')[0], import.meta.url));
      }
      if (/data-confirm=/.test(html)) assert.match(html, /src="\/form-confirmations.js" defer/);
    }
  }
  await inspect(new URL('../views/', import.meta.url));
});

test('Adaptorul Netlify păstrează antetele în răspunsul funcției', async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.get('/', (req, res) => res.type('html').send('<!doctype html><title>Test</title>'));
  const result = await serverless(app)({
    httpMethod: 'GET', path: '/', headers: { host: 'example.test' },
    queryStringParameters: null, body: null, isBase64Encoded: false,
    requestContext: { identity: { sourceIp: '192.0.2.1' } },
  }, {});
  assert.equal(result.statusCode, 200);
  const headers = Object.fromEntries(Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value]));
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers[name.toLowerCase()], value);
});

const script = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
test('Confirmările externe păstrează anularea și butonul de moderare ales', async () => {
  let submit;
  const prompts = [];
  let accepted = false;
  vm.runInNewContext(await script('form-confirmations.js'), {
    document: { addEventListener(type, callback) { assert.equal(type, 'submit'); submit = callback; } },
    window: { confirm(message) { prompts.push(message); return accepted; } },
  });
  function event(formMessage, buttonMessage) {
    return { target: { dataset: { confirm: formMessage } },
      submitter: { name: 'status', value: 'sters', dataset: { confirm: buttonMessage } },
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  }
  const deleteCandidate = event('Ștergi candidatul?');
  submit(deleteCandidate);
  assert.equal(deleteCandidate.defaultPrevented, true);
  const deleteComment = event(undefined, 'Ascunzi comentariul?');
  accepted = true;
  submit(deleteComment);
  assert.equal(deleteComment.defaultPrevented, false);
  assert.equal(deleteComment.submitter.value, 'sters');
  submit(event()); // Approve/reject and unrelated forms need no deletion prompt.
  submit(deleteCandidate); // An already-cancelled submission stays cancelled.
  assert.deepEqual(prompts, ['Ștergi candidatul?', 'Ascunzi comentariul?']);
});

test('Raportarea cu nume și cea anonimă păstrează câmpurile și acordul corespunzătoare', async () => {
  const changes = {};
  const fields = {
    bloc_nume: { style: {} }, camp_nume: { value: 'Nume privat' }, acord_nume: { checked: true },
    mod_anonim: { addEventListener(type, callback) { changes.anonim = callback; } },
    mod_nume: { checked: true, addEventListener(type, callback) { changes.nume = callback; } },
  };
  vm.runInNewContext(await script('cost-report-form.js'), { document: { getElementById: id => fields[id] } });
  changes.nume();
  assert.equal(fields.bloc_nume.style.display, 'block');
  assert.equal(fields.camp_nume.required, true);
  assert.equal(fields.acord_nume.required, true);
  fields.mod_nume.checked = false;
  changes.anonim();
  assert.equal(fields.bloc_nume.style.display, 'none');
  assert.equal(fields.camp_nume.required, false);
  assert.equal(fields.acord_nume.required, false);
  assert.equal(fields.camp_nume.value, '');
  assert.equal(fields.acord_nume.checked, false);
});

test('Distribuirea și copierea linkului funcționează din scriptul local', async () => {
  const callbacks = {};
  const native = { dataset: { shareTitle: 'Știre', shareUrl: 'https://example.test/stire' },
    addEventListener(type, callback) { callbacks.native = callback; } };
  const copy = { dataset: native.dataset, addEventListener(type, callback) { callbacks.copy = callback; } };
  const copied = [];
  const shared = [];
  const navigator = { share: async data => shared.push(data.url), clipboard: { writeText: async url => copied.push(url) } };
  vm.runInNewContext(await script('share-actions.js'), {
    document: { querySelectorAll: selector => selector === '.native-share' ? [native] : [copy] }, navigator,
  });
  await callbacks.native();
  assert.deepEqual(shared, ['https://example.test/stire']);
  delete navigator.share;
  await callbacks.native();
  await callbacks.copy();
  assert.deepEqual(copied, ['https://example.test/stire', 'https://example.test/stire']);
  assert.equal(native.textContent, 'Link copiat');
  assert.equal(copy.textContent, 'Link copiat');
});
