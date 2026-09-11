(() => {
  document.querySelectorAll('.native-share').forEach(button => button.addEventListener('click', async () => {
    const data = { title: button.dataset.shareTitle, url: button.dataset.shareUrl };
    if (navigator.share) {
      await navigator.share(data).catch(() => {});
    } else {
      await navigator.clipboard.writeText(data.url);
      button.textContent = 'Link copiat';
    }
  }));
  document.querySelectorAll('.copy-share').forEach(button => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.shareUrl);
    button.textContent = 'Link copiat';
  }));
})();
