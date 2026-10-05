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
