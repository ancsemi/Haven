// Server branding: the server icon and name in the sidebar, the tab icon,
// and the admin controls that set them.

export default {

/* ── Server Branding (icon + name) ──────────────────── */

_applyServerBranding() {
  // server_name_effective folds in SERVER_NAME from the environment, so a
  // server named only through docker doesn't read as "HAVEN" in here. (#5489)
  const name = this.serverSettings.server_name || this.serverSettings.server_name_effective || 'HAVEN';
  const icon = this.serverSettings.server_icon || '';

  // Sidebar brand text
  const brandText = document.querySelector('.brand-text');
  if (brandText) {
    brandText.textContent = name;
    // Keep glitch scramble system in sync. The scrambler captures each element's
    // original text in a data-original-text attribute and restores it at the end of
    // every animation. If the cache is stale (e.g. "HAVEN" from the HTML default) it
    // will overwrite the real server name on every tick.
    // We also abort any in-progress animation: the animation closure captures
    // trueOriginal as a const at start time, so updating the attribute alone won't
    // prevent that specific closure from writing the stale name when it finishes.
    brandText.dataset.originalText = name;
    if (brandText._scrambleInterval) {
      clearInterval(brandText._scrambleInterval);
      brandText._scrambleInterval = null;
    }
    brandText._scrambling = false;
    brandText.classList.remove('scrambling');
  }

  // Sidebar brand icon
  const logoSm = document.querySelector('.logo-sm');
  if (logoSm) {
    if (icon) {
      logoSm.style.display = 'none';
      let brandIcon = document.querySelector('.brand-icon');
      if (!brandIcon) {
        brandIcon = document.createElement('img');
        brandIcon.className = 'brand-icon';
        logoSm.parentNode.insertBefore(brandIcon, logoSm);
      }
      brandIcon.src = icon;
      brandIcon.style.display = '';
    } else {
      logoSm.style.display = '';
      const brandIcon = document.querySelector('.brand-icon');
      if (brandIcon) brandIcon.style.display = 'none';
    }
  }

  // Server bar icon
  const homeServer = document.getElementById('home-server');
  if (homeServer) {
    const existingImg = homeServer.querySelector('img');
    const iconText = homeServer.querySelector('.server-icon-text');
    if (icon) {
      if (iconText) iconText.style.display = 'none';
      if (!existingImg) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = name;
        homeServer.insertBefore(img, homeServer.firstChild);
      } else {
        existingImg.src = icon;
        existingImg.style.display = '';
      }
    } else {
      if (existingImg) existingImg.style.display = 'none';
      if (iconText) iconText.style.display = '';
    }
    homeServer.title = name;
  }

  // Admin preview
  const preview = document.getElementById('server-icon-preview');
  if (preview) {
    if (icon) {
      preview.innerHTML = `<img src="${icon}" alt="${t('media.server_icon_alt')}">`;
    } else {
      preview.innerHTML = '<span class="server-icon-text">⬡</span>';
    }
  }

  // Browser tab branding (issue #5284)
  // Refresh the document title with the new server name, and swap the favicon
  // to the server icon when one is set so multi-server tab juggling is easier.
  this._updateTabTitle?.();
  this._applyFaviconBranding?.(icon);
},

_applyFaviconBranding(iconUrl) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (iconUrl) {
    // Remember the original (default) favicon so we can restore it if the
    // server icon is later removed.
    if (!this._defaultFaviconHref) this._defaultFaviconHref = link.getAttribute('href') || '';
    if (!this._defaultFaviconType) this._defaultFaviconType = link.getAttribute('type') || '';
    link.removeAttribute('type');
    link.href = iconUrl;
  } else if (this._defaultFaviconHref) {
    if (this._defaultFaviconType) link.type = this._defaultFaviconType;
    link.href = this._defaultFaviconHref;
  }
},

_initServerBranding() {
  // Server name — saved via admin Save button (no auto-save)

  // Server icon upload
  document.getElementById('server-icon-upload-btn')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('server-icon-file');
    if (!fileInput || !fileInput.files[0]) return this._showToast(t('settings.admin.select_image_first'), 'error');
    const form = new FormData();
    form.append('image', fileInput.files[0]);
    try {
      const res = await fetch('/api/upload-server-icon', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: form
      });
      const data = await res.json();
      if (data.error) return this._showToast(data.error, 'error');
      this.socket.emit('update-server-setting', { key: 'server_icon', value: data.url });
      this._showToast(t('settings.admin.server_icon_updated'), 'success');
      fileInput.value = '';
    } catch (err) {
      this._showToast(t('settings.admin.upload_failed'), 'error');
    }
  });

  // Server icon remove
  document.getElementById('server-icon-remove-btn')?.addEventListener('click', () => {
    this.socket.emit('update-server-setting', { key: 'server_icon', value: '' });
    this._showToast(t('settings.admin.server_icon_removed'), 'success');
  });

  // Server banner upload
  document.getElementById('server-banner-upload-btn')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('server-banner-file');
    if (!fileInput || !fileInput.files[0]) return this._showToast(t('settings.admin.select_image_first'), 'error');
    const form = new FormData();
    form.append('image', fileInput.files[0]);
    try {
      const res = await fetch('/api/upload-server-banner', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: form
      });
      const data = await res.json();
      if (data.error) return this._showToast(data.error, 'error');
      this.socket.emit('update-server-setting', { key: 'server_banner', value: data.url });
      this._showToast(t('settings.admin.server_banner_updated'), 'success');
      fileInput.value = '';
    } catch (err) {
      this._showToast(t('settings.admin.upload_failed'), 'error');
    }
  });

  // Server banner remove
  document.getElementById('server-banner-remove-btn')?.addEventListener('click', () => {
    this.socket.emit('update-server-setting', { key: 'server_banner', value: '' });
    this._showToast(t('settings.admin.server_banner_removed'), 'success');
  });

  // Banner header mode dropdown (client-side / localStorage)
  document.getElementById('banner-header-mode')?.addEventListener('change', (e) => {
    localStorage.setItem('haven_banner_header_mode', e.target.value);
    this._applyServerSettings();
    const labels = {
      full: t('settings.admin.banner_mode_full'),
      shaded: t('settings.admin.banner_mode_shaded'),
      minimal: t('settings.admin.banner_mode_minimal'),
      transparent: t('settings.admin.banner_mode_transparent')
    };
    this._showToast(labels[e.target.value] || t('settings.admin.header_mode_updated'), 'success');
  });

  // Banner height slider (client-side / localStorage)
  const bannerSlider = document.getElementById('banner-height-slider');
  const bannerSliderLabel = document.getElementById('banner-height-value');
  if (bannerSlider) {
    bannerSlider.addEventListener('input', (e) => {
      if (bannerSliderLabel) bannerSliderLabel.textContent = e.target.value + 'px';
      const bd = document.getElementById('server-banner-display');
      if (bd) bd.style.height = e.target.value + 'px';
    });
    bannerSlider.addEventListener('change', (e) => {
      localStorage.setItem('haven_banner_height', e.target.value);
    });
  }

  // Banner vertical offset slider (client-side / localStorage)
  const bannerOffsetSlider = document.getElementById('banner-offset-slider');
  const bannerOffsetLabel = document.getElementById('banner-offset-value');
  if (bannerOffsetSlider) {
    bannerOffsetSlider.addEventListener('input', (e) => {
      if (bannerOffsetLabel) bannerOffsetLabel.textContent = e.target.value + '%';
      const img = document.getElementById('server-banner-img');
      if (img) img.style.objectPosition = 'center ' + e.target.value + '%';
    });
    bannerOffsetSlider.addEventListener('change', (e) => {
      localStorage.setItem('haven_banner_offset', e.target.value);
    });
  }

  // Vanity code
  document.getElementById('vanity-code-save-btn')?.addEventListener('click', () => {
    const val = document.getElementById('vanity-code-input')?.value.trim() || '';
    if (val && (val.length < 3 || val.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(val))) {
      return this._showToast(t('settings.admin.vanity_invalid'), 'error');
    }
    this.socket.emit('update-server-setting', { key: 'vanity_code', value: val });
    this._showToast(t(val ? 'settings.admin.vanity_saved' : 'settings.admin.vanity_cleared'), 'success');
  });

  document.getElementById('vanity-code-clear-btn')?.addEventListener('click', () => {
    document.getElementById('vanity-code-input').value = '';
    this.socket.emit('update-server-setting', { key: 'vanity_code', value: '' });
    this._showToast(t('settings.admin.vanity_cleared'), 'success');
  });
},

};
