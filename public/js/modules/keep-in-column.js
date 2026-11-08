// Keeps a menu that opens inside the chat column on screen.
//
// The sidebars are drawn above the chat column on purpose (their menus may
// spill over the chat; see style-status-effects.css), so anything from the
// chat column that crosses into a sidebar disappears under it. Call this
// right after showing such a menu: it slides the menu sideways until it fits
// between the column's edges, and caps its width at the column's.

const MARGIN = 8;

export function keepInColumn(menu) {
  if (!menu) return;
  menu.style.translate = '';
  const column = menu.closest('.main');
  if (!column || menu.offsetParent === null) return;
  const col = column.getBoundingClientRect();
  menu.style.maxWidth = `${Math.max(0, col.width - MARGIN * 2)}px`;
  const r = menu.getBoundingClientRect();
  let shift = 0;
  if (r.right > col.right - MARGIN) shift = col.right - MARGIN - r.right;
  if (r.left + shift < col.left + MARGIN) shift = col.left + MARGIN - r.left;
  if (shift) menu.style.translate = `${Math.round(shift)}px 0`;
}
