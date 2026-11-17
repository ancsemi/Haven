// The login page's own look (#5819), under Settings > Branding: the server
// icon as a logo, the server banner as the background, a short message under
// the title, and custom CSS for the login and registration page alone. The
// page reads them from /api/public-config (public/js/auth.js).
//
// They save as they change, like the auto-mod controls, rather than through
// the section's Save button. Custom CSS is the admin's alone: it reaches every
// visitor before they sign in, and only the admin owns that page.

export default {

_setupLoginBranding() {
  const icon = document.getElementById('login-show-icon');
  const banner = document.getElementById('login-show-banner');
  const message = document.getElementById('login-message-input');
  const css = document.getElementById('login-css-input');
  if (!icon || !banner || !message || !css) return;
  const save = (key, value) => this.socket.emit('update-server-setting', { key, value });
  icon.addEventListener('change', () => save('login_show_icon', icon.checked ? 'true' : 'false'));
  banner.addEventListener('change', () => save('login_show_banner', banner.checked ? 'true' : 'false'));
  message.addEventListener('change', () => save('login_message', message.value.trim()));
  css.addEventListener('change', () => save('login_css', css.value));
},

// Called whenever the server's settings are put into the settings page.
_fillLoginBranding() {
  const s = this.serverSettings || {};
  const icon = document.getElementById('login-show-icon');
  const banner = document.getElementById('login-show-banner');
  const message = document.getElementById('login-message-input');
  const css = document.getElementById('login-css-input');
  const cssRow = document.getElementById('login-css-row');
  if (icon) icon.checked = s.login_show_icon === 'true';
  if (banner) banner.checked = s.login_show_banner === 'true';
  if (message && document.activeElement !== message) message.value = s.login_message || '';
  if (css && document.activeElement !== css) css.value = s.login_css || '';
  if (cssRow) cssRow.style.display = this.user?.isAdmin ? '' : 'none';
},

};
