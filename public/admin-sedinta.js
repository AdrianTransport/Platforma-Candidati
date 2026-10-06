// Editorul ședinței din Super Admin: încărcare PDF (drag & drop), puncte noi pe ordinea de zi, formatarea comentariului.
(() => {
  const form = document.querySelector('[data-sedinta-form]');
  if (!form) return;
  const csrf = form.querySelector('input[name="csrf_token"]').value;

  /* --------------------------------- PDF --------------------------------- */
  const drop = form.querySelector('[data-pdf-drop]');
  const input = form.querySelector('[data-pdf-input]');
  const log = form.querySelector('[data-pdf-log]');
  const max = Number(drop.dataset.maxBytes);
  const kb = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  function line(text, kind) {
    const li = document.createElement('li');
    li.textContent = text;
    if (kind) li.className = `is-${kind}`;
    log.append(li);
    return li;
  }

  async function upload(files) {
    const pdfs = [...files];
    if (!pdfs.length) return;
    let uploaded = 0;
    for (const file of pdfs) {
      const row = line(`${file.name} · se încarcă…`);
      // Verificări rapide în browser; serverul verifică din nou conținutul.
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { row.textContent = `${file.name}: nu este PDF.`; row.className = 'is-error'; continue; }
      if (file.size > max) { row.textContent = `${file.name}: ${kb(file.size)} depășește limita de ${kb(max)}.`; row.className = 'is-error'; continue; }
      const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
      if (String.fromCharCode(...header) !== '%PDF-') { row.textContent = `${file.name}: conținutul nu este PDF.`; row.className = 'is-error'; continue; }
      try {
        const response = await fetch(`${drop.dataset.uploadUrl}?nume=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/pdf', 'X-CSRF-Token': csrf, Accept: 'application/json' },
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.eroare || (response.status === 413 ? 'Fișierul este prea mare.' : 'Încărcarea a eșuat.'));
        row.textContent = `${result.nume} · ${result.marime} · încărcat`;
        row.className = 'is-ok';
        uploaded += 1;
      } catch (error) {
        row.textContent = `${file.name}: ${error.message}`;
        row.className = 'is-error';
      }
    }
    if (uploaded) {
      // Salvăm și restul formularului, ca nimic din ce ai scris să nu se piardă la reîncărcare.
      line('Se salvează ședința…');
      const save = form.querySelector('button[name="actiune"][value="salveaza"]');
      form.requestSubmit(save);
    }
  }

  input.addEventListener('change', () => { upload(input.files); input.value = ''; });
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('is-over'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => { event.preventDefault(); upload(event.dataTransfer.files); });
  drop.addEventListener('click', (event) => { if (event.target === drop) input.click(); });

  /* ------------------------------ ordinea de zi ------------------------------ */
  const points = form.querySelector('[data-points]');
  const template = document.querySelector('[data-point-template]');
  const renumber = () => points.querySelectorAll('[data-point-nr]').forEach((nr, index) => { nr.textContent = String(index + 1).padStart(2, '0'); });
  form.querySelector('[data-add-point]').addEventListener('click', () => {
    points.append(template.content.cloneNode(true));
    renumber();
    points.lastElementChild.querySelector('input[name="punct_titlu"]').focus();
  });

  /* ------------------------------- comentariul ------------------------------- */
  const comment = form.querySelector('[data-comment]');
  function wrap(before, after, placeholder) {
    const { selectionStart: start, selectionEnd: end, value } = comment;
    const selected = value.slice(start, end) || placeholder;
    comment.setRangeText(`${before}${selected}${after}`, start, end, 'end');
    comment.focus();
  }
  form.querySelectorAll('[data-format]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.format === 'bold') wrap('**', '**', 'text îngroșat');
    if (button.dataset.format === 'italic') wrap('*', '*', 'text cursiv');
    // Citatul este un paragraf separat care începe cu „> ”.
    if (button.dataset.format === 'quote') wrap('\n\n> „', '”\n\n', 'fragment citat');
  }));
  const pdfSelect = form.querySelector('[data-format-pdf]');
  pdfSelect.addEventListener('change', () => {
    const option = pdfSelect.selectedOptions[0];
    if (option.value) wrap('[', `](${option.value})`, option.dataset.label || option.textContent);
    pdfSelect.value = '';
  });
})();
