// Buttons whose whole label is a text symbol (+, ×, ‹ and the like) get a
// drawn icon in its place.
//
// A font draws "+" or "×" around the middle of its lowercase letters, not the
// middle of the line, so the symbol sits about a sixth of its size low in a
// button, by a different amount in every font and theme. A drawn icon is
// centred on the line exactly. The symbol stays in the button for screen
// readers and for any code that reads the label, and a button whose label is
// set again later (textContent = '×') is redrawn.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Each drawing is on a 24 by 24 square that stands for 1em, sized like the
// symbol it replaces. `adv` is the symbol's width, so the button keeps its size.
const ICONS = {
  '+': { adv: 0.68, d: 'M12 6.25v11.5M6.25 12h11.5' },
  '−': { adv: 0.68, d: 'M6.25 12h11.5' },
  '×': { adv: 0.68, d: 'M7 7l10 10M17 7L7 17' },
  '✕': { adv: 0.82, d: 'M4 4l16 16M20 4L4 20' },
  '‹': { adv: 0.32, d: 'M14 8l-4 4 4 4' },
  '›': { adv: 0.32, d: 'M10 8l4 4-4 4' },
  '☰': { adv: 0.9, d: 'M3.5 5h17M3.5 12h17M3.5 19h17' },
  '⋯': { adv: 0.86, dots: [5, 12, 19] },
};

function makeIcon(glyph) {
  const spec = ICONS[glyph];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'glyph-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.setProperty('--glyph-adv', spec.adv + 'em');
  if (spec.d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', spec.d);
    svg.appendChild(path);
  } else {
    for (const cx of spec.dots) {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', 12);
      dot.setAttribute('r', 1.6);
      svg.appendChild(dot);
    }
  }
  return svg;
}

// The one text node holding the button's label, when the label is a single
// symbol from the list and nothing else (no picture, no other words).
function labelNode(btn) {
  if (btn.querySelector('svg, img, .glyph-icon-label')) return null;
  const glyph = btn.textContent.trim();
  if (!ICONS[glyph]) return null;
  const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.trim()) return { node: n, glyph };
  }
  return null;
}

function convert(btn) {
  const found = labelNode(btn);
  if (!found) return;
  const label = document.createElement('span');
  label.className = 'glyph-icon-label';
  label.textContent = found.glyph;
  found.node.replaceWith(makeIcon(found.glyph), label);
}

function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'BUTTON') convert(root);
  else {
    const btn = root.closest?.('button');
    if (btn) convert(btn);
  }
  for (const btn of root.querySelectorAll('button')) convert(btn);
}

export function startGlyphIcons(root = document.body) {
  scan(root);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') {
        const btn = r.target.parentElement?.closest('button');
        if (btn) convert(btn);
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 1) scan(n);
        else if (n.nodeType === 3) {
          const btn = n.parentElement?.closest('button');
          if (btn) convert(btn);
        }
      }
    }
  }).observe(root, { childList: true, subtree: true, characterData: true });
}
