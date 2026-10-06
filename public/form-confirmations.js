(() => {
  // Poate fi inclus de mai multe ori pe pagină; confirmarea se cere o singură dată.
  if (globalThis.__formConfirmations) return;
  globalThis.__formConfirmations = true;
  document.addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    const message = event.submitter?.dataset.confirm || event.target.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });
})();
