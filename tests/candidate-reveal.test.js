import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/candidate-reveal.js', import.meta.url), 'utf8');

function page({ reduced = false, supported = true } = {}) {
  const listeners = {};
  const motion = { matches: reduced, addEventListener: (type, fn) => { listeners.motion = fn; } };
  const observed = new Set();
  const animations = [];
  let enter;
  const cards = [100, 900, 1100].map(top => ({
    getBoundingClientRect: () => ({ top }),
    contains: target => target === top,
    animate(frames, options) {
      const animation = { frames, options, cancelled: false, addEventListener() {}, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    }
  }));
  class Observer {
    constructor(callback) { enter = callback; }
    observe(card) { observed.add(card); }
    unobserve(card) { observed.delete(card); }
    disconnect() { observed.clear(); }
  }
  const window = { innerHeight: 800, matchMedia: () => motion,
    addEventListener: (type, fn) => { listeners[type] = fn; } };
  if (supported) window.IntersectionObserver = Observer;
  vm.runInNewContext(source, { window, IntersectionObserver: Observer, Element: { prototype: { animate() {} } },
    document: { activeElement: null, querySelector: () => ({ querySelectorAll: () => cards,
      addEventListener: (type, fn) => { listeners[type] = fn; } }) } });
  return { cards, observed, animations, listeners, motion, enter: entries => enter(entries) };
}

test('Cardurile intră de jos în sus o singură dată și rămân accesibile la focus și la reducerea mișcării', () => {
  const p = page();
  assert.equal(p.observed.size, 2); // The initial viewport is immediately visible.
  p.enter([{ target: p.cards[1], isIntersecting: false }]);
  assert.equal(p.animations.length, 0);
  p.enter([{ target: p.cards[1], isIntersecting: true }, { target: p.cards[2], isIntersecting: true }]);
  assert.equal(p.observed.size, 0); // Re-entering the viewport will not replay the effect.
  assert.match(p.animations[0].frames[0].transform, /translateY\([1-9]\d*px\)/);
  assert.equal(p.animations[0].frames.at(-1).opacity, 1);
  assert.ok(p.animations[1].options.delay > p.animations[0].options.delay);
  p.listeners.focusin({ target: 900 });
  assert.equal(p.animations[0].cancelled, true);
  p.motion.matches = true;
  p.listeners.motion({ matches: true });
  assert.equal(p.animations[1].cancelled, true);
  for (const options of [{ reduced: true }, { supported: false }]) {
    const fallback = page(options);
    assert.equal(fallback.observed.size, 0);
    assert.equal(fallback.animations.length, 0);
  }
});
