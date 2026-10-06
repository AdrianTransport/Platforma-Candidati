// Vizualizatorul PDF din pagina ședinței. pdf.js (găzduit local) se încarcă abia când
// vizualizatorul ajunge aproape de ecran; fără JavaScript rămâne linkul spre PDF.
const PDFJS = '/pdfjs-6.4.299';
const root = document.querySelector('[data-pdf-viewer]');

if (root) {
  const $ = selector => root.querySelector(selector);
  const canvas = $('[data-pdf-canvas]');
  const placeholder = $('[data-pdf-placeholder]');
  const status = $('[data-pdf-status]');
  const prev = $('[data-pdf-prev]');
  const next = $('[data-pdf-next]');
  const download = $('[data-pdf-download]');
  const nameEl = $('[data-pdf-name]');
  const stage = $('[data-pdf-stage]');
  let pdfjsPromise;
  let doc;
  let task;
  let loads = 0;
  let page = 1;
  let rendering = Promise.resolve();
  let src = root.dataset.src;

  // O singură încărcare a bibliotecii, oricâte documente se deschid.
  const library = () => (pdfjsPromise ||= import(`${PDFJS}/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
    return lib;
  }));

  function render() {
    const pdf = doc;
    rendering = rendering.then(async () => {
      if (!pdf || pdf !== doc) return;
      const current = await pdf.getPage(page);
      const base = current.getViewport({ scale: 1 });
      // Pagina întreagă încape în cadru (lățime și înălțime), ca o foaie.
      const fit = Math.min((stage.clientWidth - 24) / base.width, (stage.clientHeight - 24) / base.height);
      const ratio = window.devicePixelRatio || 1;
      const viewport = current.getViewport({ scale: Math.max(fit, 0.2) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      await current.render({ canvas, viewport }).promise;
      canvas.hidden = false;
      placeholder.hidden = true;
      status.textContent = `PAGINA ${page} DIN ${pdf.numPages}`;
      prev.disabled = page <= 1;
      next.disabled = page >= pdf.numPages;
    }).catch(() => { if (pdf === doc) fail(); });
    return rendering;
  }

  function fail() {
    canvas.hidden = true;
    placeholder.hidden = false;
    status.textContent = 'PREVIZUALIZAREA NU E DISPONIBILĂ · DESCHIDE SAU DESCARCĂ PDF-UL';
  }

  async function open(url, title) {
    src = url;
    page = 1;
    placeholder.href = url;
    download.href = `${url}?descarca=1`;
    if (title) nameEl.textContent = title;
    status.textContent = 'SE ÎNCARCĂ…';
    prev.disabled = true;
    next.disabled = true;
    // Dacă între timp s-a ales alt document, rezultatul acestei încărcări se ignoră.
    const generation = ++loads;
    try {
      const lib = await library();
      if (generation !== loads) return;
      // Documentul anterior se închide prin sarcina lui de încărcare (eliberează memoria workerului).
      task?.destroy();
      doc = null;
      task = lib.getDocument({
        url, isEvalSupported: false,
        standardFontDataUrl: `${PDFJS}/standard_fonts/`, wasmUrl: `${PDFJS}/wasm/`,
      });
      const loaded = await task.promise;
      if (generation !== loads) return;
      doc = loaded;
      await render();
    } catch {
      if (generation === loads) fail();
    }
  }

  prev.addEventListener('click', () => { if (doc && page > 1) { page -= 1; render(); } });
  next.addEventListener('click', () => { if (doc && page < doc.numPages) { page += 1; render(); } });
  $('[data-pdf-fullscreen]').addEventListener('click', () => {
    if (root.requestFullscreen && document.fullscreenEnabled) root.requestFullscreen().then(() => doc && render()).catch(() => window.open(src, '_blank'));
    else window.open(src, '_blank', 'noopener');
  });
  document.addEventListener('fullscreenchange', () => { if (doc) render(); });

  // Documentele din listă se deschid în vizualizator, fără să părăsești pagina.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-pdf-open]');
    if (!link || event.metaKey || event.ctrlKey) return;
    const target = document.querySelector(`[data-pdf-src][data-pdf-open="${CSS.escape(link.dataset.pdfOpen)}"]`) || link;
    event.preventDefault();
    for (const item of document.querySelectorAll('.doc-link')) {
      const active = item === target;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
    }
    open(target.dataset.pdfSrc || target.href, target.dataset.pdfTitle);
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const start = () => open(src);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); start(); }
    }, { rootMargin: '300px' });
    observer.observe(root);
  } else start();

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => doc && render(), 200); });
}
