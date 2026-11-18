// Profile themes: two colors a profile card (and its Edit Profile preview)
// fades between, top to bottom, and the frosted glass that carries the
// card's text over them. The color math here has no page to touch, so the
// tests run it as it is.

export default {

// A profile theme from the server: both colors exact, or no theme.
_cleanProfileTheme(theme) {
  const top = this._safeHexColor(theme?.top), bottom = this._safeHexColor(theme?.bottom);
  return top && bottom ? { top, bottom } : null;
},

// The colors a profile theme's fade has at t (0 at its top, 1 at its
// bottom), as sRGB 0 to 1, each way this browser might draw it. With OKLCH
// gradients (oklch true), as the card asks for: around the color wheel, so
// opposite colors stay vivid rather than going gray in the middle. When an
// end is all but gray it has no hue to speak of, and browsers differ on
// what that means for the blend, so the Oklab blend (what it comes to when
// that end takes the other's hue) is given too. Without OKLCH, the plain
// RGB blend the fallback draws.
_profileThemeColorsAt(top, bottom, t, oklch = true) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const mix = (x, y, k) => x.map((v, i) => v + (y[i] - v) * k);
  // sRGB to Oklab and back (Björn Ottosson's matrices).
  const toOklab = (c) => {
    const [r, g, b] = c.map(lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  };
  const fromOklab = ([L, A, B]) => {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076956610 * s]
      .map((c) => Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  };
  // OKLCH: lightness, chroma and hue, the hue taking the shorter way round.
  // A color with no chroma has no hue, so it takes the other end's.
  const toOklch = ([L, A, B]) => [L, Math.hypot(A, B), Math.atan2(B, A)];
  const a = rgb(top), b = rgb(bottom);
  if (!oklch) return [mix(a, b, t)];
  const la = toOklab(a), lb = toOklab(b);
  const ca = toOklch(la), cb = toOklch(lb);
  const grayEnd = Math.min(ca[1], cb[1]) < 0.02;
  if (ca[1] < 1e-4) ca[2] = cb[2];
  if (cb[1] < 1e-4) cb[2] = ca[2];
  let dh = cb[2] - ca[2];
  if (dh > Math.PI) dh -= 2 * Math.PI;
  if (dh < -Math.PI) dh += 2 * Math.PI;
  const [L, C] = mix(ca.slice(0, 2), cb.slice(0, 2), t), h = ca[2] + dh * t;
  const drawn = fromOklab([L, C * Math.cos(h), C * Math.sin(h)]);
  return grayEnd ? [drawn, fromOklab(mix(la, lb, t))] : [drawn];
},

// How much tint text on these colors (everything behind it, as sRGB 0 to
// 1) needs to keep 4.5:1 contrast (WCAG AA), for each text color: light
// (white) text reads on a black tint, dark (black) text on a white one.
// Text on a themed card is solid pure white or pure black, never
// see-through or a softer shade, which keeps the tint it needs as light as
// it can be. In steps of 1%, up to 90%, which always reads.
_profileThemeInkNeeds(colors) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = (x, y) => {
    const a = lum(x), b = lum(y);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const over = (c, top, alpha) => c.map((v, k) => v * (1 - alpha) + top[k] * alpha);
  const black = [0, 0, 0], white = [1, 1, 1];
  const need = (tint, text) => {
    let step = 0;
    while (step < 90 && !colors.every((c) => contrast(text, over(c, tint, step / 100)) >= 4.5)) step++;
    return step / 100;
  };
  return { light: need(black, white), dark: need(white, black) };
},

// The glass panel behind a themed card's text, from its two colors: white
// text on dark glass, or black text on light glass, whichever needs the
// lighter glass for every point of the fade (in each way this browser might
// draw it) to keep 4.5:1 contrast, and never under 25% so it always reads
// as a panel. One text color for the whole card. Gives { ink, alpha }:
// ink 'light' (white text, black glass) or 'dark' (black text, white glass).
_profileThemeGlass(top, bottom, oklch) {
  const colors = [];
  for (let i = 0; i <= 32; i++) colors.push(...this._profileThemeColorsAt(top, bottom, i / 32, oklch));
  const needs = this._profileThemeInkNeeds(colors);
  const ink = needs.dark < needs.light ? 'dark' : 'light';
  return { ink, alpha: Math.max(0.25, needs[ink]) };
},

// Whether this browser can draw a gradient in OKLCH, asked once. The fade
// is drawn in OKLCH where it can, and in plain RGB where not.
_profileThemeOklch() {
  if (this._profileThemeOklchKnown === undefined) {
    this._profileThemeOklchKnown = typeof CSS !== 'undefined'
      && CSS.supports('background', 'linear-gradient(in oklch, red, blue)');
  }
  return this._profileThemeOklchKnown;
},

// Fade a profile card (or the Edit Profile preview) between the member's two
// theme colors, top to bottom, or take the theme off (theme null). Below the
// banner a frosted glass panel carries the text, in one color for the whole
// card, picked with the glass to suit the colors (_profileThemeGlass).
_applyProfileTheme(el, theme) {
  if (!el) return;
  const top = this._safeHexColor(theme?.top), bottom = this._safeHexColor(theme?.bottom);
  if (!top || !bottom) {
    el.classList.remove('has-profile-theme');
    el.removeAttribute('data-ink');
    el.removeAttribute('data-fade');
    for (const p of ['--profile-theme-top', '--profile-theme-bottom', '--profile-theme-glass']) el.style.removeProperty(p);
    return;
  }
  const oklch = this._profileThemeOklch();
  const { ink, alpha } = this._profileThemeGlass(top, bottom, oklch);
  el.classList.add('has-profile-theme');
  el.dataset.ink = ink;
  // The stylesheet draws the fade in OKLCH only when told to here, so the
  // fade drawn and the fade the glass was worked out for are always one.
  el.dataset.fade = oklch ? 'oklch' : 'rgb';
  el.style.setProperty('--profile-theme-top', top);
  el.style.setProperty('--profile-theme-bottom', bottom);
  el.style.setProperty('--profile-theme-glass', String(alpha));
},

};
