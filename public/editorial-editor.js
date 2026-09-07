(() => {
  const $ = id => document.getElementById(id);
  const csrf = document.querySelector('input[name=csrf_token]').value;
  const workspace = document.querySelector('.editorial-workspace');
  const apiPrefix = workspace.dataset.apiPrefix || '/dashboard';
  const mediaEndpoint = workspace.dataset.mediaEndpoint || '/dashboard/media';
  const storageKey = `editor-ai:${workspace.dataset.account}:${location.pathname}`;
  let settings = { text: false, image: false }, busy = false, uploading = false, proposal, pending;
  function persist(job) {
    pending = job;
    try { if (job) sessionStorage.setItem(storageKey, JSON.stringify(job)); else sessionStorage.removeItem(storageKey); } catch { /* Stocare browser opțională. */ }
  }
  function buttons() {
    $('btn-genereaza').disabled = busy || !settings.text;
    $('btn-imagine-ai').disabled = busy || !settings.image;
  }
  async function request(url, body) {
    let response;
    try {
      response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify({ ...body, csrf_token: csrf }) } : {}),
        signal: AbortSignal.timeout(30000) });
    } catch { throw new Error('Nu am putut confirma răspunsul serverului. Verifică rezultatul înainte să trimiți o nouă generare.'); }
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('Sesiunea sau cererea nu mai este validă. Salvează local textul și reîncarcă pagina.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.eroare || 'Operațiunea nu a reușit.');
    return result;
  }
  function previewImage() {
    const raw = $('imagine-url').value.trim();
    let valid = false;
    try { valid = /^\/media\/[a-f0-9-]+$/.test(raw) || (['https:', 'http:'].includes(new URL(raw).protocol)); } catch { /* Nu încărcăm adrese invalide. */ }
    $('image-preview').hidden = !valid;
    if (valid) { $('preview-image').referrerPolicy = 'no-referrer'; $('preview-image').src = raw; }
    else $('preview-image').removeAttribute('src');
  }
  $('imagine-url').addEventListener('change', previewImage);
  $('preview-image').addEventListener('error', () => { $('stare-imagine').textContent = 'Imaginea nu poate fi afișată. Verifică adresa sau încarcă un fișier valid.'; });
  previewImage();

  async function normalizedPhoto(file) {
    if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
      throw new Error('Selectează un PNG, JPEG sau WebP de maximum 12 MB.');
    }
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('Fișierul nu poate fi deschis ca imagine.'); }
    try {
      const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // Re-encodarea elimină metadatele EXIF, inclusiv coordonatele GPS ale fotografiei.
      const data = canvas.toDataURL('image/jpeg', .84).split(',')[1];
      if (!data || data.length > 4 * 1024 * 1024) throw new Error('Imaginea rămâne prea mare după redimensionare. Alege una mai mică.');
      return data;
    } finally { bitmap.close(); }
  }
  $('incarca-imagine').addEventListener('click', async () => {
    const button = $('incarca-imagine');
    if (!$('acord-imagine').checked) { $('stare-imagine').textContent = 'Confirmă dreptul de utilizare a imaginii.'; return; }
    uploading = true; button.disabled = true; $('stare-imagine').textContent = 'Pregătesc și salvez fotografia…';
    try {
      const base64 = await normalizedPhoto($('fisier-imagine').files[0]);
      const result = await request(mediaEndpoint, { base64, acord_imagine: true });
      $('imagine-url').value = result.imagine_url;
      $('imagine-alt').value = ''; $('imagine-legenda').value = ''; $('imagine-credit').value = '';
      // Nu presupunem că un fișier încărcat de utilizator nu a fost creat anterior cu AI.
      previewImage(); $('stare-imagine').textContent = 'Fotografie încărcată. Completează descrierea și sursa, apoi salvează articolul.';
    } catch (error) { $('stare-imagine').textContent = error.message; }
    finally { uploading = false; button.disabled = false; }
  });
  document.querySelector('.editor-article form').addEventListener('submit', event => {
    if (uploading) { event.preventDefault(); $('stare-imagine').textContent = 'Așteaptă finalizarea încărcării înainte să salvezi articolul.'; }
  });

  function showProposal(result) {
    proposal = result;
    const image = result.tip === 'image';
    $('ai-title').textContent = image ? 'Ilustrația propusă' : result.titlu;
    $('ai-summary').textContent = image ? '' : result.rezumat;
    $('ai-text').textContent = image ? '' : result.continut;
    $('ai-image').hidden = !image;
    if (image) $('ai-image').src = result.imagine_url;
    else $('ai-image').removeAttribute('src');
    $('ai-checks').textContent = image ? 'Ilustrație AI, nu fotografie a unui eveniment real. Verifică dacă se potrivește articolului.' : result.verificari;
    $('ai-result').hidden = false; $('reia-ai').hidden = true;
    $('stare-ai').textContent = 'Propunerea este gata. Verific-o și aplic-o numai dacă vrei să o folosești.';
  }
  async function poll(job) {
    busy = true; buttons(); $('reia-ai').hidden = true;
    try {
      for (let attempt = 0; attempt < 90; attempt++) {
        const result = await request(`${apiPrefix}/ai/${encodeURIComponent(job.id)}/status`, {});
        if (result.status === 'gata') { showProposal(result); return; }
        $('stare-ai').textContent = 'OpenAI lucrează la propunere. Poți continua să scrii; articolul nu se publică automat.';
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      throw new Error('Generarea durează mai mult. Verifică din nou rezultatul, fără să trimiți o nouă cerere.');
    } catch (error) { $('stare-ai').textContent = error.message; $('reia-ai').hidden = false; }
    finally { busy = false; buttons(); }
  }
  async function generate(tip) {
    const idee = $('idee-ai').value.trim();
    if (!idee) { $('stare-ai').textContent = 'Descrie mai întâi subiectul și informațiile confirmate.'; return; }
    if (!$('acord-ai').checked) { $('stare-ai').textContent = 'Confirmă trimiterea informațiilor către OpenAI.'; return; }
    if (pending && !proposal && !confirm('Există o cerere anterioară. O nouă generare poate produce costuri suplimentare. Continui?')) return;
    busy = true; buttons(); $('ai-result').hidden = true; $('stare-ai').textContent = 'Trimit cererea către OpenAI…';
    const job = { id: crypto.randomUUID(), tip };
    persist(job); proposal = undefined;
    try {
      await request(`${apiPrefix}/genereaza-ai`, { tip, idee, ton: $('ton-ai').value, acord_ai: true, request_id: job.id });
      await poll(job);
    } catch (error) { $('stare-ai').textContent = error.message; $('reia-ai').hidden = false; }
    finally { busy = false; buttons(); }
  }
  $('btn-genereaza').addEventListener('click', () => generate('text'));
  $('btn-imagine-ai').addEventListener('click', () => generate('image'));
  $('reia-ai').addEventListener('click', () => { if (pending && !busy) poll(pending); });
  $('aplica-ai').addEventListener('click', () => {
    if (!proposal) return;
    if (proposal.tip === 'image') {
      if ($('imagine-url').value && !confirm('Înlocuiești imaginea selectată cu ilustrația AI?')) return;
      $('imagine-url').value = proposal.imagine_url; $('imagine-generata-ai').checked = true;
      $('imagine-alt').value = ''; $('imagine-legenda').value = '';
      $('imagine-credit').value = 'Ilustrație generată cu OpenAI'; previewImage();
    } else {
      if (($('titlu').value || $('continut').value) && !confirm('Aplicarea va înlocui titlul, rezumatul și textul din formular. Continui?')) return;
      $('titlu').value = proposal.titlu; $('rezumat').value = proposal.rezumat; $('continut').value = proposal.continut; $('generat_de_ai').checked = true;
    }
    $('stare-ai').textContent = 'Propunere aplicată în formular. Verifică și salvează articolul; nu a fost publicat automat.';
    persist(null);
  });
  request(`${apiPrefix}/ai/config`).then(result => {
    settings = result; buttons();
    $('config-ai').textContent = result.text || result.image
      ? `Generare text: ${result.text ? 'disponibilă' : 'dezactivată'}. Generare imagini: ${result.image ? 'disponibilă' : 'dezactivată'}. Se aplică limite zilnice.`
      : 'Generarea OpenAI nu este activată încă. Poți scrie manual și încărca fotografii.';
    try {
      const job = JSON.parse(sessionStorage.getItem(storageKey));
      if (job && /^[a-f0-9-]{36}$/.test(job.id) && ['text', 'image'].includes(job.tip)) {
        pending = job; $('reia-ai').hidden = false;
        $('stare-ai').textContent = 'Ai o cerere anterioară. Poți verifica rezultatul fără o nouă generare.';
      }
    } catch { /* Fără job de recuperat. */ }
  }).catch(error => { $('config-ai').textContent = error.message; });
})();
