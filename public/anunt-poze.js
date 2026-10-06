// Pozele din formularul public de anunțuri: alegere din galerie sau cu camera, micșorare și comprimare
// în browser (re-encodarea elimină și datele EXIF, inclusiv locația GPS), încărcare separată cu progres,
// ordonare și alegerea pozei principale (prima).
(() => {
  const box = document.querySelector('[data-photos]');
  if (!box) return;
  const form = box.closest('form');
  const csrf = form.querySelector('input[name="csrf_token"]').value;
  const input = box.querySelector('[data-photos-input]');
  const list = box.querySelector('[data-photos-list]');
  const status = box.querySelector('[data-photos-status]');
  const drop = box.querySelector('[data-photos-drop]');
  const MAX = Number(box.dataset.max) || 5;
  const BIG = 1600;
  const SMALL = 640;
  const LIMIT = 1.4 * 1024 * 1024;
  let pendingSubmit = false;
  box.hidden = false;

  const items = () => [...list.querySelectorAll('[data-photo]')];
  const say = (text) => { status.textContent = text; };

  function button(label, text, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'photo__btn';
    b.setAttribute('aria-label', label);
    b.textContent = text;
    b.dataset.action = action;
    return b;
  }

  function decorate(li) {
    if (li.querySelector('.photo__tools')) return;
    const tools = document.createElement('div');
    tools.className = 'photo__tools';
    tools.append(button('Mută mai în față', '←', 'left'), button('Mută mai în spate', '→', 'right'), button('Fă-o poza principală', '★', 'main'), button('Șterge poza', '✕', 'remove'));
    const badge = document.createElement('span');
    badge.className = 'photo__main';
    badge.textContent = 'Principală';
    li.append(badge, tools);
  }

  function refresh() {
    const all = items();
    all.forEach((li, index) => {
      li.classList.toggle('is-main', index === 0);
      li.querySelector('[data-action="left"]').disabled = index === 0;
      li.querySelector('[data-action="main"]').disabled = index === 0;
      li.querySelector('[data-action="right"]').disabled = index === all.length - 1;
    });
    input.disabled = all.length >= MAX;
    box.classList.toggle('is-full', all.length >= MAX);
    if (!all.some(li => li.classList.contains('is-busy'))) say(all.length ? `${all.length} din ${MAX} poze · prima este poza principală.` : '');
  }

  list.addEventListener('click', (event) => {
    const b = event.target.closest('[data-action]');
    if (!b) return;
    const li = b.closest('[data-photo]');
    if (b.dataset.action === 'remove') { URL.revokeObjectURL(li.dataset.preview || ''); li.remove(); }
    if (b.dataset.action === 'left' && li.previousElementSibling) li.previousElementSibling.before(li);
    if (b.dataset.action === 'right' && li.nextElementSibling) li.nextElementSibling.after(li);
    if (b.dataset.action === 'main') list.prepend(li);
    refresh();
    li.isConnected && b.isConnected && !b.disabled ? b.focus() : input.focus();
  });

  /* --------------------------- micșorare în browser --------------------------- */

  async function decode(file) {
    // createImageBitmap aplică orientarea din EXIF; varianta cu <img> e rezerva pentru browsere mai vechi.
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* rezerva de mai jos */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  const toBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));

  async function encode(source, maxSide) {
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.7, 0.6, 0.5]) {
      // WebP unde browserul îl poate produce (ex. Safari mai vechi întoarce PNG), altfel JPEG.
      let blob = await toBlob(canvas, 'image/webp', quality);
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
      if (blob && blob.size <= LIMIT) return blob;
    }
    throw new Error('Poza nu a putut fi micșorată suficient.');
  }

  function send(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', blob.type);
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded / event.total);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* răspuns gol */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.eroare || (xhr.status === 413 ? 'Poza este prea mare.' : 'Încărcarea a eșuat.')));
      };
      xhr.onerror = () => reject(new Error('Fără conexiune. Încearcă din nou.'));
      xhr.send(blob);
    });
  }

  async function add(file) {
    const li = document.createElement('li');
    li.className = 'photo is-busy';
    li.dataset.photo = '';
    const img = document.createElement('img');
    img.alt = '';
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = 0;
    bar.setAttribute('aria-label', `Încărcare ${file.name}`);
    li.append(img, bar);
    decorate(li);
    list.append(li);
    refresh();
    try {
      if (file.type && !file.type.startsWith('image/')) throw new Error('Fișierul nu este o poză.');
      const source = await decode(file);
      const [big, small] = [await encode(source, BIG), await encode(source, SMALL)];
      source.close?.();
      li.dataset.preview = URL.createObjectURL(small);
      img.src = li.dataset.preview;
      const result = await send('/anunturi/poze', big, p => { bar.value = Math.round(p * 85); });
      await send(`/anunturi/poze/${encodeURIComponent(result.id)}/mic`, small, p => { bar.value = 85 + Math.round(p * 15); });
      li.dataset.serverId = result.id;
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'poze';
      hidden.value = result.id;
      li.append(hidden);
      li.classList.replace('is-busy', 'is-done');
      bar.remove();
    } catch (error) {
      li.classList.replace('is-busy', 'is-error');
      bar.remove();
      const note = document.createElement('span');
      note.className = 'photo__error';
      note.textContent = error.message === 'Fișierul nu este o poză.' ? error.message : `${error.message || 'Poza nu a putut fi citită.'}`;
      li.append(note);
    }
    refresh();
    if (pendingSubmit && !items().some(item => item.classList.contains('is-busy'))) { pendingSubmit = false; form.requestSubmit(); }
  }

  async function addFiles(files) {
    const free = MAX - items().length;
    const chosen = [...files].slice(0, Math.max(0, free));
    if (files.length > chosen.length) say(`Poți adăuga cel mult ${MAX} poze; am păstrat primele ${chosen.length}.`);
    // Una câte una, ca telefonul să nu rămână fără memorie la poze mari.
    for (const file of chosen) await add(file);
  }

  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  for (const type of ['dragenter', 'dragover']) box.addEventListener(type, (event) => { event.preventDefault(); box.classList.add('is-over'); });
  for (const type of ['dragleave', 'drop']) box.addEventListener(type, () => box.classList.remove('is-over'));
  box.addEventListener('drop', (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });
  drop.hidden = !window.matchMedia('(pointer: fine)').matches;

  // Anunțul se trimite abia după ce pozele s-au încărcat; cele eșuate nu se trimit.
  form.addEventListener('submit', (event) => {
    if (items().some(li => li.classList.contains('is-busy'))) {
      event.preventDefault();
      pendingSubmit = true;
      say('Se încarcă pozele… anunțul se trimite automat imediat după.');
    }
  });

  items().forEach(decorate);
  refresh();
})();
