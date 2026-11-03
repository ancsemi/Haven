// Hover tooltips drawn by Haven in place of the browser's own.
//
// The browser draws a title tooltip up to 800px wide and only keeps it on the
// screen, not in the window, so a long hint ran far past the edge of the app
// and of Haven Desktop's window. This one wraps at a readable width, stays
// inside the window and follows the theme. While it shows, the element's
// title is set aside so the browser does not draw its own as well, and it is
// put back when the pointer leaves. Touch has no hover, so it is left alone.

const SHOW_DELAY = 500;   // about the browser's own
const WARM_DELAY = 60;    // moving straight from one tooltip to the next
const WARM_FOR = 400;
const EDGE = 8;           // kept clear of the window's edges
const BELOW = 18;         // under the pointer, clear of the cursor arrow

// Where the tooltip goes: under the pointer, or above it when there is no
// room below, and always inside the window.
export function placeTooltip(pointer, size, view) {
  const left = Math.max(EDGE, Math.min(pointer.x, view.width - size.width - EDGE));
  let top = pointer.y + BELOW;
  if (top + size.height > view.height - EDGE) top = pointer.y - size.height - EDGE;
  return { left, top: Math.max(EDGE, top) };
}

export function startTooltips(doc = document) {
  const win = doc.defaultView;
  if (!win) return;
  let tip = null;        // made on first use
  let anchor = null;     // the element whose title is set aside
  let text = '';
  let timer = 0;
  let poll = 0;
  let watch = null;
  let hiddenAt = 0;
  const pointer = { x: 0, y: 0 };
  const canPop = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

  const box = () => {
    if (tip) return tip;
    tip = doc.createElement('div');
    tip.className = 'haven-tooltip';
    tip.setAttribute('role', 'tooltip');
    // A popover sits above everything, open dialogs and fullscreen included.
    if (canPop) tip.popover = 'manual';
    else tip.hidden = true;
    doc.body.appendChild(tip);
    return tip;
  };
  const isOpen = () => !!tip && (canPop ? tip.matches(':popover-open') : !tip.hidden);

  const hide = () => {
    if (!isOpen()) return;
    if (canPop) tip.hidePopover();
    else tip.hidden = true;
    hiddenAt = Date.now();
  };

  const place = () => {
    tip.style.left = '0px';
    tip.style.top = '0px';
    const r = tip.getBoundingClientRect();
    const view = { width: doc.documentElement.clientWidth || win.innerWidth, height: doc.documentElement.clientHeight || win.innerHeight };
    const at = placeTooltip(pointer, { width: r.width, height: r.height }, view);
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
  };

  const show = () => {
    timer = 0;
    if (!anchor || !anchor.isConnected || !text.trim()) return;
    const el = box();
    el.textContent = text;
    if (canPop) { if (!isOpen()) el.showPopover(); } else el.hidden = false;
    place();
  };

  const release = () => {
    clearTimeout(timer);
    timer = 0;
    clearInterval(poll);
    poll = 0;
    watch?.disconnect();
    watch = null;
    if (anchor) {
      if (!anchor.hasAttribute('title')) anchor.setAttribute('title', text);
      if (anchor.dataset.tipLabel) {
        anchor.removeAttribute('aria-label');
        delete anchor.dataset.tipLabel;
      }
      anchor = null;
    }
    hide();
  };

  const take = (el) => {
    anchor = el;
    text = el.getAttribute('title') || '';
    el.removeAttribute('title');
    // An icon button's title is its only name; keep it named while hovered.
    if (!el.hasAttribute('aria-label') && !el.textContent.trim()) {
      el.setAttribute('aria-label', text);
      el.dataset.tipLabel = '1';
    }
    // The page may change the title meanwhile (a Copy button saying Copied):
    // take the new text and show that.
    watch = new win.MutationObserver(() => {
      const next = anchor && anchor.getAttribute('title');
      if (next === null || next === undefined) return;
      anchor.removeAttribute('title');
      text = next;
      if (anchor.dataset.tipLabel) anchor.setAttribute('aria-label', next);
      if (!next.trim()) hide();
      else if (isOpen()) { tip.textContent = next; place(); }
    });
    watch.observe(el, { attributes: true, attributeFilter: ['title'] });
    // An element taken off the page sends no pointer events on its way out.
    poll = setInterval(() => { if (anchor && !anchor.isConnected) release(); }, 300);
    timer = setTimeout(show, Date.now() - hiddenAt < WARM_FOR ? WARM_DELAY : SHOW_DELAY);
  };

  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || !(e.target instanceof win.Element)) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    const next = e.target.closest('[title]');
    // Still inside the same element: its title is set aside, so closest()
    // finds an ancestor's instead, which does not count.
    if (anchor && anchor.contains(e.target) && !(next && anchor.contains(next) && next !== anchor)) return;
    release();
    if (!next || next.tagName === 'IFRAME' || !next.getAttribute('title').trim()) return;
    take(next);
  }, true);

  doc.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || isOpen()) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { capture: true, passive: true });

  // A click, a key or a scroll puts the tooltip away until the pointer moves
  // to something else, as the browser's does. The title stays set aside till
  // then, or the browser would show its own right after.
  const dismiss = () => {
    clearTimeout(timer);
    timer = 0;
    hide();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll']) doc.addEventListener(type, dismiss, { capture: true, passive: true });
  doc.addEventListener('pointerout', (e) => { if (!e.relatedTarget) release(); }, true);
  win.addEventListener('blur', release);
}
