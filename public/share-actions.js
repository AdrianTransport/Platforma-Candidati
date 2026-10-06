// Distribuire: meniul nativ al telefonului (Web Share API), copierea linkului și imaginea pentru Story/TikTok.
(() => {
  // Scriptul poate fi inclus de două ori pe aceeași pagină; legăm butoanele o singură dată.
  if (globalThis.__shareActions) return;
  globalThis.__shareActions = true;
  const nativeShare = () => typeof navigator.share === 'function';

  async function copy(text, button) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      // Rezervă pentru browsere fără acces la clipboard.
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      field.remove();
    }
    const label = button.querySelector?.('span') || button;
    const previous = label.textContent;
    label.textContent = ok ? 'Link copiat' : 'Copiază linkul din bara de adrese';
    globalThis.setTimeout?.(() => { label.textContent = previous; }, 2500);
  }

  // Butonul „Distribuie” apare doar unde există meniul nativ (în special pe telefon).
  document.querySelectorAll('.native-share').forEach((button) => {
    if (button.hasAttribute?.('hidden') && nativeShare()) button.hidden = false;
    button.addEventListener('click', async () => {
      const data = { title: button.dataset.shareTitle, url: button.dataset.shareUrl };
      if (nativeShare()) { await navigator.share(data).catch(() => {}); return; }
      await copy(data.url, button);
    });
  });

  document.querySelectorAll('.copy-share').forEach(button => button.addEventListener('click', () => copy(button.dataset.shareUrl, button)));

  // Pe telefon, imaginea Story se trimite direct în meniul nativ (Instagram, TikTok, Salvează imaginea);
  // pe calculator rămâne descărcarea obișnuită.
  document.addEventListener?.('click', async (event) => {
    const link = event.target.closest?.('[data-story-share]');
    if (!link) return;
    const touch = globalThis.matchMedia?.('(pointer: coarse)').matches;
    if (!touch || typeof navigator.canShare !== 'function') return;
    event.preventDefault();
    try {
      const response = await fetch(link.href);
      if (!response.ok) throw new Error();
      const file = new File([await response.blob()], 'vocea-lenauheim-story.jpg', { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: link.dataset.shareTitle });
      else window.location.href = link.href;
    } catch (error) {
      if (error?.name !== 'AbortError') window.location.href = link.href;
    }
  });
})();
