/**
 * Haven Desktop — System Tray Manager
 *
 * Provides a tray icon with context menu for:
 *   - Show/hide window
 *   - Connection status indicator
 *   - Quick mute/deafen toggles
 *   - Audio routing shortcut
 *   - Quit
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

class TrayManager {
  constructor(mainWindow, store) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.tray = null;
    this._create();
  }

  _create() {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
    let trayIcon;
    try {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } catch {
      // Fallback: create a simple colored icon
      trayIcon = nativeImage.createEmpty();
    }

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Haven');
    this._updateMenu();

    // Double-click tray icon to show window
    this.tray.on('double-click', () => {
      this.mainWindow?.show();
      this.mainWindow?.focus();
    });
  }

  _updateMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Haven',
        click: () => {
          this.mainWindow?.show();
          this.mainWindow?.focus();
        }
      },
      { type: 'separator' },
      {
        label: 'Start Minimized',
        type: 'checkbox',
        checked: this.store.get('startMinimized'),
        click: (item) => this.store.set('startMinimized', item.checked),
      },
      {
        label: 'Minimize to Tray',
        type: 'checkbox',
        checked: this.store.get('minimizeToTray'),
        click: (item) => this.store.set('minimizeToTray', item.checked),
      },
      { type: 'separator' },
      {
        label: 'Quit Haven',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /** Update tray tooltip (e.g., show connected server). */
  setTooltip(text) {
    this.tray?.setToolTip(text);
  }

  /** Destroy the tray icon. */
  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}

module.exports = { TrayManager };
