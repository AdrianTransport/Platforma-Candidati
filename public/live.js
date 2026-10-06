// Numărătoare inversă + flux „Actualizări live” (reîncărcat la 30 s, fără reîncărcarea paginii).
(() => {
  const root = document.querySelector('[data-live-root]');
  if (!root) return;
  const $ = sel => root.querySelector(sel);
  const feed = document.querySelector('[data-live-feed]');
  const countdown = $('[data-countdown]');
  const cells = Object.fromEntries(['d', 'h', 'm', 's'].map(k => [k, $(`[data-cd="${k}"]`)]));
  const POLL_MS = 30000;
  const STATE_CLASS = { upcoming: 'badge--upcoming', live: 'badge--live', ended: 'badge--ended', none: 'badge--ended' };
  const LIVE_LABEL = 'LIVE · ȘEDINȚA E ÎN DESFĂȘURARE';
  let target = Number(root.dataset.target) || 0;
  let state = root.dataset.state;
  let liveMode = root.dataset.liveMode || 'auto';
  let lastFetch = Date.now();
  let timer;

  const pad = n => String(n).padStart(2, '0');

  function setText(el, value) { if (el && el.textContent !== value) el.textContent = value; }

  function applyState(next, label, message) {
    state = next;
    root.dataset.state = next;
    const badge = $('[data-live-badge]');
    badge.classList.remove('badge--upcoming', 'badge--live', 'badge--ended');
    badge.classList.add(STATE_CLASS[next] || 'badge--ended');
    setText($('[data-live-badge-text]'), label);
    countdown.hidden = next !== 'upcoming';
    const status = $('[data-live-status]');
    status.hidden = next === 'upcoming';
    status.classList.toggle('hero__status--live', next === 'live');
    if (message) setText(status, message);
  }

  function tick() {
    if (state !== 'upcoming' || !target) return;
    const diff = Math.max(0, target - Date.now());
    setText(cells.d, String(Math.floor(diff / 864e5)));
    setText(cells.h, pad(Math.floor(diff / 36e5) % 24));
    setText(cells.m, pad(Math.floor(diff / 6e4) % 60));
    setText(cells.s, pad(Math.floor(diff / 1e3) % 60));
    if (diff === 0 && liveMode !== 'off') {
      // Ora termenului: trecem imediat pe LIVE și cerem starea confirmată de server.
      applyState('live', LIVE_LABEL, 'Ședința e în desfășurare. Urmărește actualizările de mai jos.');
      refresh();
    }
  }

  function renderFeed(updates) {
    if (!feed) return;
    const known = new Set([...feed.children].map(li => li.dataset.id));
    const hadItems = known.size > 0;
    const fragment = document.createDocumentFragment();
    for (const u of updates) {
      const li = document.createElement('li');
      li.className = 'feed__item';
      li.dataset.id = u.id;
      if (hadItems && !known.has(u.id)) li.classList.add('feed__new');
      const time = document.createElement('time');
      time.className = `feed__time${u.recent ? '' : ' feed__time--old'}`;
      time.title = u.full;
      time.textContent = u.time;
      const body = document.createElement('div');
      body.className = 'feed__body';
      const title = document.createElement('b');
      title.textContent = u.titlu;
      body.append(title);
      if (u.text) { const text = document.createElement('span'); text.textContent = u.text; body.append(text); }
      li.append(time, body);
      fragment.append(li);
    }
    feed.replaceChildren(fragment);
    const empty = document.querySelector('[data-live-empty]');
    if (empty) empty.hidden = updates.length > 0;
  }

  async function refresh() {
    lastFetch = Date.now();
    try {
      const res = await fetch(root.dataset.liveUrl, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      liveMode = data.liveMode;
      target = data.termenAt || 0;
      // Nu revenim la numărătoare dacă ceasul local a trecut deja de termen, iar CDN-ul are încă răspunsul de dinainte.
      const stale = data.state === 'upcoming' && state === 'live' && target && Date.now() >= target && liveMode !== 'off';
      if (!stale) applyState(data.state, data.stateLabel, data.stateMessage);
      setText($('[data-live-date]'), data.termenLabel);
      setText($('[data-live-sala]'), data.salaComplet || '—');
      setText($('[data-live-stadiu]'), data.stadiu || '—');
      renderFeed(data.updates);
      tick();
    } catch { /* rețea indisponibilă: încercăm din nou la următorul interval */ }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => { if (!document.hidden) await refresh(); schedule(); }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastFetch > POLL_MS) { refresh(); schedule(); }
  });

  tick();
  setInterval(tick, 1000);
  schedule();
})();
