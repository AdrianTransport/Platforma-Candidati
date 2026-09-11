(() => {
  document.querySelectorAll('.portal-news-card,.portal-campaign-grid article').forEach(card => {
    const link = card.querySelector('a[href]');
    if (!link) return;
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.addEventListener('click', event => {
      if (!event.target.closest('a,button')) location.href = link.href;
    });
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter') location.href = link.href;
    });
  });
})();
