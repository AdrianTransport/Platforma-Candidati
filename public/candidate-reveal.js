(() => {
  'use strict';

  const root = document.querySelector('.candidate-design');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!root || motion.matches || !('IntersectionObserver' in window)
    || !('animate' in Element.prototype)) return;

  const cards = root.querySelectorAll([
    '.candidate-facts-strip > div', '.candidate-topic-grid > a',
    '.candidate-intro-visual', '.candidate-locality-visual', '.candidate-feature-visual',
    '.section-news-card', '.front-main', '.front-sidebar > article', '.photo-card',
    '.category-list > a', '.candidate-contact-options > a'
  ].join(','));
  const animations = new Map();
  let observer;
  const stop = () => {
    observer?.disconnect();
    animations.forEach(animation => animation.cancel());
    animations.clear();
  };

  // Content remains visible without JavaScript and if an animation fails.
  // Animate only on entry; never hide cards while waiting for the observer.
  try {
    observer = new IntersectionObserver(entries => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (motion.matches || entry.target.contains(document.activeElement)) continue;
        try {
          const animation = entry.target.animate([
            { opacity: 0, transform: 'translateY(48px)' },
            { opacity: 1, transform: 'translateY(0)' }
          ], {
            duration: 700, delay: Math.min(order++, 2) * 100,
            easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards'
          });
          animations.set(entry.target, animation);
          const release = () => animations.delete(entry.target);
          animation.addEventListener('finish', release, { once: true });
          animation.addEventListener('cancel', release, { once: true });
        } catch { /* Leave the card visible if this browser cannot animate it. */ }
      }
    }, { threshold: 0, rootMargin: '0px 0px 32px 0px' });
    cards.forEach(card => {
      if (card.getBoundingClientRect().top >= window.innerHeight) observer.observe(card);
    });
  } catch {
    stop();
    return;
  }

  root.addEventListener('focusin', event => {
    cards.forEach(card => {
      if (!card.contains(event.target)) return;
      observer.unobserve(card);
      animations.get(card)?.cancel();
      animations.delete(card);
    });
  });
  motion.addEventListener('change', event => { if (event.matches) stop(); });
  window.addEventListener('beforeprint', stop);
  window.addEventListener('pagehide', stop);
})();
