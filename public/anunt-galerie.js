// Galeria anunțului: pozele se deschid pe ecran întreg; pe telefon se trec prin glisare (scroll-snap nativ).
(() => {
  const gallery = document.querySelector('[data-gallery]');
  const dialog = document.querySelector('[data-lightbox]');
  if (!gallery || !dialog || typeof dialog.showModal !== 'function') return;
  const track = dialog.querySelector('[data-lightbox-track]');
  const count = dialog.querySelector('[data-lightbox-count]');
  const links = [...gallery.querySelectorAll('[data-gallery-open]')];

  // Pozele mari se creează doar la prima deschidere.
  function build() {
    if (track.children.length) return;
    for (const link of links) {
      const slide = document.createElement('figure');
      slide.className = 'lightbox__slide';
      const img = document.createElement('img');
      img.src = link.dataset.full;
      img.alt = link.querySelector('img')?.alt || '';
      img.width = Number(link.dataset.width);
      img.height = Number(link.dataset.height);
      img.decoding = 'async';
      slide.append(img);
      track.append(slide);
    }
  }

  const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const update = () => { count.textContent = `${current() + 1} / ${links.length}`; };
  const go = (index) => {
    const target = Math.max(0, Math.min(links.length - 1, index));
    track.scrollTo({ left: target * track.clientWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  gallery.addEventListener('click', (event) => {
    const link = event.target.closest('[data-gallery-open]');
    if (!link) return;
    event.preventDefault();
    build();
    dialog.showModal();
    track.scrollLeft = Number(link.dataset.galleryOpen) * track.clientWidth;
    update();
  });
  track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  dialog.querySelector('[data-lightbox-prev]').addEventListener('click', () => go(current() - 1));
  dialog.querySelector('[data-lightbox-next]').addEventListener('click', () => go(current() + 1));
  dialog.querySelector('[data-lightbox-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') go(current() - 1);
    if (event.key === 'ArrowRight') go(current() + 1);
  });
  // Clic pe fundal închide galeria.
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.classList.contains('lightbox__slide')) dialog.close(); });
})();
