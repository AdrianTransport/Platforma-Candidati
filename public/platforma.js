// Meniul lateral din Super Admin pe telefon.
(() => {
  const button = document.querySelector("[data-pf-menu]");
  const side = document.querySelector("[data-pf-side]");
  if (!button || !side) return;
  button.addEventListener("click", () => {
    const open = !side.classList.contains("is-open");
    side.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
  });
})();

// Căutare și filtru în tabelul de candidați (fără reîncărcare).
(() => {
  const table = document.querySelector('[data-pf-table]');
  const search = document.querySelector('[data-pf-search]');
  const filters = document.querySelectorAll('[data-pf-filter]');
  if (!table) return;
  let status = '';
  const apply = () => {
    const query = (search?.value || '').trim().toLowerCase();
    for (const row of table.querySelectorAll('tbody tr[data-status]')) {
      row.hidden = Boolean((status && row.dataset.status !== status) || (query && !row.dataset.search.includes(query)));
    }
  };
  search?.addEventListener('input', apply);
  for (const link of filters) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      status = link.dataset.pfFilter;
      for (const other of filters) {
        if (other === link) other.setAttribute('aria-current', 'page');
        else other.removeAttribute('aria-current');
      }
      apply();
    });
  }
})();
