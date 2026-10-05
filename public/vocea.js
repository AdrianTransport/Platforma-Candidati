// Meniul de pe telefon: deschidere/închidere, Escape și click în afară.
(() => {
  const button = document.querySelector('[data-menu-toggle]');
  const panel = button && document.getElementById(button.getAttribute('aria-controls'));
  if (!panel) return;
  const setOpen = (open) => {
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Închide meniul' : 'Deschide meniul');
    panel.classList.toggle('is-open', open);
  };
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) { setOpen(false); button.focus(); }
  });
  document.addEventListener('click', (event) => {
    if (panel.classList.contains('is-open') && !panel.contains(event.target) && !button.contains(event.target)) setOpen(false);
  });
})();

// Telefonul din anunțuri apare doar la apăsare (nu e în HTML, ca să nu fie cules de roboți).
document.addEventListener('click', async (event) => {
  const link = event.target.closest('[data-phone]');
  if (!link || link.dataset.loaded) return;
  event.preventDefault();
  try {
    const res = await fetch(`/api/anunturi/${encodeURIComponent(link.dataset.phone)}/telefon`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error();
    const { telefon, tel } = await res.json();
    link.textContent = `Sună: ${telefon}`;
    link.href = `tel:${tel}`;
    link.dataset.loaded = '1';
  } catch { link.textContent = 'Telefon indisponibil'; }
});
