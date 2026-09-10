(() => {
  const notice = document.getElementById('cookie-notice');
  if (!notice) return;
  const acknowledge = notice.querySelector('[data-cookie-acknowledge]');
  const reopen = document.querySelector('[data-cookie-reopen]');
  const title = document.getElementById('cookie-notice-title');
  const storageKey = 'vocea-cookie-notice-v1';
  const lifetime = 180 * 24 * 60 * 60 * 1000;
  let returnFocus;

  function show() {
    notice.hidden = false;
    reopen.setAttribute('aria-expanded', 'true');
  }

  acknowledge.addEventListener('click', () => {
    try {
      // Reține doar închiderea informării, nu acordul pentru cookie-uri opționale.
      localStorage.setItem(storageKey, String(Date.now() + lifetime));
    } catch { /* Mesajul poate fi închis și când stocarea este blocată. */ }
    notice.hidden = true;
    reopen.setAttribute('aria-expanded', 'false');
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });

  reopen.addEventListener('click', () => {
    returnFocus = reopen;
    show();
    title.focus({ preventScroll: true });
  });
  reopen.hidden = false;

  let dismissed = false;
  try {
    const now = Date.now();
    const expiresAt = Number(localStorage.getItem(storageKey));
    dismissed = Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + lifetime;
    if (!dismissed) localStorage.removeItem(storageKey);
  } catch { /* Informarea rămâne disponibilă fără stocare în browser. */ }
  if (!dismissed) show();
})();
