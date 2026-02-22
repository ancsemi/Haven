/**
 * Haven Desktop — Virtual Audio Router
 *
 * Manages per-application audio capture and routing through a virtual
 * audio cable driver. This allows users to stream specific application
 * audio (e.g., Spotify, a game) into their Haven voice channel without
 * sharing their entire desktop audio or microphone.
 *
 * Architecture:
 *   ┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
 *   │  App (game)  │────▸│ Virtual Cable In  │────▸│ Haven captures  │
 *   └─────────────┘     │  (render target)   │     │ cable output &  │
 *                        └──────────────────┘     │ mixes into voice│
 *   ┌─────────────┐     ┌──────────────────┐     └─────────────────┘
 *   │  Spotify     │────▸│ Virtual Cable 2   │────▸│ (same pipeline) │
 *   └─────────────┘     └──────────────────┘     └─────────────────┘
 *
 * On Windows, we use the Windows Audio Session API (WASAPI) via a
 * native addon to enumerate audio sessions per-process and reroute
 * them to virtual audio cable endpoints.
 *
 * Driver options (bundled in audio-drivers/):
 *   - VB-CABLE (free, well-known)
 *   - Virtual Audio Cable by Muzychenko (commercial, more cables)
 *   - Or a custom minimal WDM virtual audio driver
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

class AudioRouter {
  constructor(store) {
    this.store  = store;
    this.routes = store.get('audioRoutes') || [];
    this.platform = process.platform;
    this._audioSessions = new Map();  // pid -> { name, icon, volume }
    this._pollInterval = null;
  }

  /**
   * Initialize the audio subsystem.
   * Checks if a virtual audio driver is installed and starts polling
   * for audio sessions.
   */
  async initialize() {
    if (this.platform !== 'win32' && this.platform !== 'linux') {
      console.log('[AudioRouter] Per-app audio routing is currently supported on Windows and Linux only');
      return;
    }

    if (this.platform === 'linux') {
      this._detectLinuxAudioSystem();
    }

    const installed = this.isDriverInstalled();
    if (installed) {
      console.log('[AudioRouter] Virtual audio driver/module detected');
      this._startSessionPolling();
    } else {
      console.log('[AudioRouter] No virtual audio driver found — user will be prompted to install');
    }
  }

  /**
   * Detect whether the Linux system uses PipeWire or PulseAudio.
   */
  _detectLinuxAudioSystem() {
    try {
      const { execSync } = require('child_process');
      // Check PipeWire first (modern distros)
      try {
        execSync('pw-cli --version', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
        this._linuxAudio = 'pipewire';
        console.log('[AudioRouter] Detected PipeWire');
        return;
      } catch {}
      // Fall back to PulseAudio
      try {
        execSync('pactl --version', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
        this._linuxAudio = 'pulseaudio';
        console.log('[AudioRouter] Detected PulseAudio');
        return;
      } catch {}
      this._linuxAudio = null;
      console.log('[AudioRouter] No supported Linux audio system found');
    } catch {
      this._linuxAudio = null;
    }
  }

  /**
   * Check whether a compatible virtual audio cable driver is installed.
   * Windows: Looks for VB-CABLE in audio endpoint list or registry.
   * Linux: Checks for a PulseAudio/PipeWire null-sink or virtual module.
   */
  isDriverInstalled() {
    if (this.platform === 'linux') return this._isLinuxModuleLoaded();
    if (this.platform !== 'win32') return false;

    try {
      // Use WMI to query sound devices for virtual cable presence (built-in, no extra modules)
      const { execSync } = require('child_process');
      const output = execSync(
        'powershell -NoProfile -Command "Get-WmiObject Win32_SoundDevice | Select-Object -ExpandProperty Name"',
        { encoding: 'utf-8', timeout: 5000 }
      ).toLowerCase();

      return output.includes('cable') ||
             output.includes('virtual audio cable') ||
             output.includes('vb-audio') ||
             output.includes('haven virtual');
    } catch {
      // Fallback: check registry for known driver entries
      try {
        const { execSync } = require('child_process');
        const reg = execSync(
          'reg query "HKLM\\SOFTWARE\\VB-Audio" /s 2>nul',
          { encoding: 'utf-8', timeout: 3000 }
        );
        return reg.length > 0;
      } catch {
        return false;
      }
    }
  }

  /**
   * Install the virtual audio cable driver.
   * Windows: Auto-downloads VB-CABLE if not bundled, then prompts for
   *          UAC elevation and runs the installer silently.
   * Linux: Creates a PulseAudio/PipeWire null-sink module.
   */
  async installDriver() {
    if (this.platform === 'linux') return this._installLinuxModule();

    if (this.platform !== 'win32') {
      return { success: false, reason: 'Only supported on Windows and Linux' };
    }

    const driverDir = this._getDriverDir();
    // Ensure the driver directory exists
    if (!fs.existsSync(driverDir)) {
      fs.mkdirSync(driverDir, { recursive: true });
    }

    const installerPath = path.join(driverDir, 'VBCABLE_Setup_x64.exe');

    // Auto-download the VB-CABLE driver pack if the installer isn't bundled
    if (!fs.existsSync(installerPath)) {
      const dlResult = await this._downloadVBCable(driverDir);
      if (!dlResult.success) {
        return dlResult;
      }
    }

    // Final check — the installer must exist after download + extraction
    if (!fs.existsSync(installerPath)) {
      return {
        success: false,
        reason: 'Driver installer not found after download. Please download VB-CABLE manually from https://vb-audio.com/Cable/ and place VBCABLE_Setup_x64.exe in the audio-drivers folder.',
        downloadUrl: 'https://vb-audio.com/Cable/'
      };
    }

    return new Promise((resolve) => {
      // Run the installer with elevation (UAC prompt).
      // VB-CABLE's installer supports silent mode via the -i flag when
      // launched from an elevated process, but the standard exe also works
      // and shows a simple UI with an "Install" button.
      const proc = spawn('powershell', [
        '-NoProfile', '-Command',
        `Start-Process -FilePath '${installerPath}' -Verb RunAs -Wait`
      ], { stdio: 'pipe' });

      proc.on('close', (code) => {
        if (code === 0 && this.isDriverInstalled()) {
          this._startSessionPolling();
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            reason: 'Installation may have been cancelled or failed. Please try installing VB-CABLE manually.',
            downloadUrl: 'https://vb-audio.com/Cable/'
          });
        }
      });

      proc.on('error', (err) => {
        resolve({ success: false, reason: err.message });
      });
    });
  }

  /**
   * Download the VB-CABLE driver pack zip from vb-audio.com and extract
   * the installer into the given directory.
   * @param {string} destDir — directory to place the extracted installer
   * @returns {Promise<{success: boolean, reason?: string}>}
   */
  async _downloadVBCable(destDir) {
    const https = require('https');
    const zipUrl = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip';
    const zipPath = path.join(os.tmpdir(), 'VBCABLE_Driver_Pack.zip');

    console.log('[AudioRouter] Downloading VB-CABLE driver pack…');

    // ── 1. Download the zip ──────────────────────────────
    try {
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        const request = https.get(zipUrl, { timeout: 60000 }, (res) => {
          // Follow one redirect (vb-audio sometimes redirects)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            https.get(res.headers.location, { timeout: 60000 }, (res2) => {
              if (res2.statusCode !== 200) {
                file.close();
                reject(new Error(`Download failed — HTTP ${res2.statusCode}`));
                return;
              }
              res2.pipe(file);
              file.on('finish', () => file.close(resolve));
              file.on('error', reject);
            }).on('error', reject);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            reject(new Error(`Download failed — HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', reject);
        });
        request.on('error', reject);
        request.on('timeout', () => {
          request.destroy();
          reject(new Error('Download timed out'));
        });
      });
    } catch (err) {
      return {
        success: false,
        reason: `Failed to download VB-CABLE: ${err.message}. You can download it manually from https://vb-audio.com/Cable/`,
        downloadUrl: 'https://vb-audio.com/Cable/'
      };
    }

    // ── 2. Extract the zip using PowerShell ──────────────
    try {
      const { execSync } = require('child_process');
      const extractDir = path.join(os.tmpdir(), 'VBCABLE_extracted');

      // Clean previous extraction if any
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }

      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { timeout: 30000 }
      );

      // Find the 64-bit installer in the extracted files
      const candidates = [
        path.join(extractDir, 'VBCABLE_Setup_x64.exe'),
        ...this._findFilesRecursive(extractDir, 'VBCABLE_Setup_x64.exe'),
      ].filter(p => fs.existsSync(p));

      if (candidates.length === 0) {
        // Also look for the 32-bit fallback
        const fallbacks = [
          path.join(extractDir, 'VBCABLE_Setup.exe'),
          ...this._findFilesRecursive(extractDir, 'VBCABLE_Setup.exe'),
        ].filter(p => fs.existsSync(p));

        if (fallbacks.length > 0) {
          fs.copyFileSync(fallbacks[0], path.join(destDir, 'VBCABLE_Setup.exe'));
          console.log('[AudioRouter] Extracted VB-CABLE 32-bit installer (64-bit not found)');
        } else {
          return {
            success: false,
            reason: 'Downloaded VB-CABLE zip but could not find the installer inside it. Please download manually.',
            downloadUrl: 'https://vb-audio.com/Cable/'
          };
        }
      } else {
        fs.copyFileSync(candidates[0], path.join(destDir, 'VBCABLE_Setup_x64.exe'));
        console.log('[AudioRouter] Extracted VB-CABLE installer to', destDir);

        // Also grab the 32-bit installer if present (optional)
        const setup32 = [
          path.join(extractDir, 'VBCABLE_Setup.exe'),
          ...this._findFilesRecursive(extractDir, 'VBCABLE_Setup.exe'),
        ].filter(p => fs.existsSync(p));
        if (setup32.length > 0) {
          fs.copyFileSync(setup32[0], path.join(destDir, 'VBCABLE_Setup.exe'));
        }
      }

      // Cleanup temp files
      try { fs.unlinkSync(zipPath); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}

      return { success: true };
    } catch (err) {
      return {
        success: false,
        reason: `Failed to extract VB-CABLE zip: ${err.message}. You can download it manually from https://vb-audio.com/Cable/`,
        downloadUrl: 'https://vb-audio.com/Cable/'
      };
    }
  }

  /**
   * Recursively search a directory tree for a file by name.
   * @param {string} dir  — root directory to search
   * @param {string} name — filename to match (case-insensitive)
   * @returns {string[]} — array of matching absolute paths
   */
  _findFilesRecursive(dir, name) {
    const results = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this._findFilesRecursive(full, name));
        } else if (entry.name.toLowerCase() === name.toLowerCase()) {
          results.push(full);
        }
      }
    } catch {}
    return results;
  }

  /**
   * Get the list of applications currently producing audio.
   * Returns an array of { pid, name, icon, volume } objects.
   */
  getAudioApplications() {
    if (this.platform === 'linux') return this._getLinuxAudioApps();
    if (this.platform !== 'win32') return [];

    try {
      const { execSync } = require('child_process');

      // Use PowerShell + WASAPI COM to enumerate active audio sessions
      const script = `
        Add-Type -AssemblyName System.Runtime.InteropServices
        $code = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;

public class AudioSessionEnumerator {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorCom { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        int NotImpl1();
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2 {
        int NotImpl1();
        int NotImpl2();
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl {
        // We only need IAudioSessionControl2 methods via cast
    }

    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2 {
        int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3();
        int NotImpl4(); int NotImpl5(); int NotImpl6(); int NotImpl7();
        int NotImpl8(); int NotImpl9(); int NotImpl10(); int NotImpl11();
        int GetProcessId(out uint pid);
    }

    public static List<uint> GetAudioPids() {
        var pids = new List<uint>();
        try {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice device;
            enumerator.GetDefaultAudioEndpoint(0, 1, out device);
            Guid iid = typeof(IAudioSessionManager2).GUID;
            object o;
            device.Activate(ref iid, 1, IntPtr.Zero, out o);
            var mgr = (IAudioSessionManager2)o;
            IAudioSessionEnumerator sessions;
            mgr.GetSessionEnumerator(out sessions);
            int count;
            sessions.GetCount(out count);
            for (int i = 0; i < count; i++) {
                IAudioSessionControl ctl;
                sessions.GetSession(i, out ctl);
                var ctl2 = (IAudioSessionControl2)ctl;
                uint pid;
                ctl2.GetProcessId(out pid);
                if (pid > 0) pids.Add(pid);
            }
        } catch {}
        return pids;
    }
}
'@
        Add-Type -TypeDefinition $code -Language CSharp -ErrorAction SilentlyContinue
        $pids = [AudioSessionEnumerator]::GetAudioPids()
        foreach ($p in $pids) {
            try {
                $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
                if ($proc) {
                    "$($p)|$($proc.ProcessName)|$($proc.MainWindowTitle)"
                }
            } catch {}
        }
      `;

      const output = execSync(
        `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      const apps = [];
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split('|');
        if (parts.length >= 2) {
          const pid  = parseInt(parts[0]);
          const name = parts[1];
          const title = parts[2] || name;
          if (pid > 0 && name) {
            apps.push({ pid, name, title, routed: this.routes.some(r => r.processName === name) });
          }
        }
      }

      return apps;
    } catch (err) {
      console.error('[AudioRouter] Failed to enumerate audio sessions:', err.message);
      return [];
    }
  }

  /**
   * Set an audio route — redirect an application's audio to a virtual cable.
   * @param {{ processName: string, targetDevice: string }} route
   */
  setRoute(route) {
    if (!route?.processName || !route?.targetDevice) {
      return { success: false, reason: 'Invalid route: need processName and targetDevice' };
    }

    // Remove existing route for same app
    this.routes = this.routes.filter(r => r.processName !== route.processName);
    this.routes.push(route);
    this.store.set('audioRoutes', this.routes);

    // Apply the route using SoundVolumeView (free Nirsoft tool) or
    // Windows audio policy config
    this._applyRoute(route);

    return { success: true, routes: this.routes };
  }

  /**
   * Remove an audio route — restore app audio to default device.
   * @param {string} processName
   */
  removeRoute(processName) {
    this.routes = this.routes.filter(r => r.processName !== processName);
    this.store.set('audioRoutes', this.routes);

    // Restore the app's audio to the system default device
    if (this.platform === 'win32') {
      this._restoreWindowsDefault(processName);
    }
    // Linux: pactl will naturally fall back when the null-sink is removed

    return { success: true, routes: this.routes };
  }

  /** Get all current routes. */
  getRoutes() {
    return this.routes;
  }

  /** Get list of virtual audio devices available. */
  getVirtualDevices() {
    if (this.platform === 'linux') return this._getLinuxDevices();
    if (this.platform !== 'win32') return [];

    try {
      const { execSync } = require('child_process');
      const output = execSync(
        'powershell -NoProfile -Command "Get-WmiObject Win32_SoundDevice | Select-Object -ExpandProperty Name"',
        { encoding: 'utf-8', timeout: 5000 }
      );

      return output.trim().split('\n')
        .map(d => d.trim())
        .filter(d => d.length > 0)
        .map(name => ({
          name,
          isVirtual: /cable|virtual|vb-audio|haven/i.test(name)
        }));
    } catch {
      return [];
    }
  }

  /**
   * Get all system audio input and output devices.
   * Returns { inputs: [...], outputs: [...] } with id, name, isDefault.
   */
  getSystemAudioDevices() {
    if (this.platform === 'linux') return this._getLinuxSystemDevices();
    if (this.platform !== 'win32') return { inputs: [], outputs: [] };

    try {
      const { execSync } = require('child_process');

      // PowerShell script to enumerate all audio endpoints
      const script = `
        Add-Type -AssemblyName System.Runtime.InteropServices
        $code = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class AudioDeviceLister {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorCom { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr pap, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IPropertyStore props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore {
        int GetCount(out int count);
        int GetAt(int index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT val);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY {
        public Guid fmtid; public int pid;
        public PROPERTYKEY(Guid g, int p) { fmtid = g; pid = p; }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPVARIANT {
        public ushort vt; ushort r1; ushort r2; ushort r3;
        public IntPtr data1; public IntPtr data2;
    }

    static PROPERTYKEY PKEY_DeviceFriendlyName = new PROPERTYKEY(
        new Guid(0xa45c254e, 0xdf1c, 0x4efd, 0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0), 14);

    public static string ListDevices(int dataFlow) {
        var results = new List<string>();
        try {
            var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDeviceCollection col;
            e.EnumAudioEndpoints(dataFlow, 1, out col); // 1 = DEVICE_STATE_ACTIVE
            int count;
            col.GetCount(out count);

            IMMDevice defDevice = null;
            string defId = "";
            try { e.GetDefaultAudioEndpoint(dataFlow, 1, out defDevice); defDevice.GetId(out defId); } catch {}

            for (int i = 0; i < count; i++) {
                IMMDevice dev;
                col.Item(i, out dev);
                string id;
                dev.GetId(out id);
                IPropertyStore ps;
                dev.OpenPropertyStore(0, out ps);
                PROPVARIANT pv;
                ps.GetValue(ref PKEY_DeviceFriendlyName, out pv);
                string name = Marshal.PtrToStringUni(pv.data1) ?? "Unknown";
                bool isDef = id == defId;
                results.Add(id + "|" + name + "|" + (isDef ? "1" : "0"));
            }
        } catch {}
        return string.Join("\\n", results);
    }
}
'@
        Add-Type -TypeDefinition $code -Language CSharp -ErrorAction SilentlyContinue
        Write-Host "OUTPUTS:"
        [AudioDeviceLister]::ListDevices(0)
        Write-Host "INPUTS:"
        [AudioDeviceLister]::ListDevices(1)
      `;

      const output = execSync(
        `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      const inputs = [];
      const outputs = [];
      let section = null;

      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'OUTPUTS:') { section = 'output'; continue; }
        if (trimmed === 'INPUTS:')  { section = 'input'; continue; }
        if (!trimmed || !section) continue;

        const parts = trimmed.split('|');
        if (parts.length >= 3) {
          const device = {
            id: parts[0],
            name: parts[1],
            isDefault: parts[2] === '1',
            isVirtual: /cable|virtual|vb-audio|haven/i.test(parts[1])
          };
          if (section === 'output') outputs.push(device);
          else inputs.push(device);
        }
      }

      return { inputs, outputs };
    } catch (err) {
      console.error('[AudioRouter] Failed to enumerate system devices:', err.message);
      return { inputs: [], outputs: [] };
    }
  }

  /**
   * Get the current default input and output device IDs.
   */
  getDefaultDevices() {
    const stored = {
      input: this.store.get('defaultInputDevice') || null,
      output: this.store.get('defaultOutputDevice') || null,
    };
    return stored;
  }

  /**
   * Set a preferred audio device. Stores the selection and, on Linux,
   * applies it via pactl set-default-sink / set-default-source.
   * @param {string} deviceId
   * @param {'input'|'output'} type
   */
  setDefaultDevice(deviceId, type) {
    if (type === 'input') {
      this.store.set('defaultInputDevice', deviceId);
    } else {
      this.store.set('defaultOutputDevice', deviceId);
    }

    if (this.platform === 'linux') {
      try {
        const { execSync } = require('child_process');
        if (type === 'output') {
          execSync(`pactl set-default-sink "${deviceId}"`, { timeout: 3000, stdio: 'pipe' });
        } else {
          execSync(`pactl set-default-source "${deviceId}"`, { timeout: 3000, stdio: 'pipe' });
        }
      } catch (err) {
        console.error('[AudioRouter] Failed to set Linux default device:', err.message);
        return { success: false, reason: err.message };
      }
    }

    return { success: true, deviceId, type };
  }

  /**
   * Get all system audio devices on Linux via pactl.
   */
  _getLinuxSystemDevices() {
    try {
      const { execSync } = require('child_process');

      // Get output devices (sinks)
      const sinksRaw = execSync('pactl list sinks', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      const defaultSink = execSync('pactl get-default-sink', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();

      const outputs = [];
      for (const block of sinksRaw.split('Sink #')) {
        if (!block.trim()) continue;
        const nameMatch = block.match(/Name:\s*(.+)/);
        const descMatch = block.match(/Description:\s*(.+)/);
        if (nameMatch) {
          outputs.push({
            id: nameMatch[1].trim(),
            name: descMatch ? descMatch[1].trim() : nameMatch[1].trim(),
            isDefault: nameMatch[1].trim() === defaultSink,
            isVirtual: /haven_virtual|null/i.test(nameMatch[1])
          });
        }
      }

      // Get input devices (sources)
      const sourcesRaw = execSync('pactl list sources', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      const defaultSource = execSync('pactl get-default-source', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();

      const inputs = [];
      for (const block of sourcesRaw.split('Source #')) {
        if (!block.trim()) continue;
        // Skip monitor sources — they're not real microphones
        const nameMatch = block.match(/Name:\s*(.+)/);
        const descMatch = block.match(/Description:\s*(.+)/);
        if (nameMatch && !nameMatch[1].includes('.monitor')) {
          inputs.push({
            id: nameMatch[1].trim(),
            name: descMatch ? descMatch[1].trim() : nameMatch[1].trim(),
            isDefault: nameMatch[1].trim() === defaultSource,
            isVirtual: /haven_virtual/i.test(nameMatch[1])
          });
        }
      }

      return { inputs, outputs };
    } catch (err) {
      console.error('[AudioRouter] Failed to enumerate Linux system devices:', err.message);
      return { inputs: [], outputs: [] };
    }
  }

  /**
   * Apply a per-app audio route.
   * Windows: Uses SoundVolumeView (free Nirsoft CLI) to set per-app audio device.
   * Linux: Uses PulseAudio/PipeWire to move a sink input.
   */
  _applyRoute(route) {
    if (this.platform === 'linux') return this._applyLinuxRoute(route);
    if (this.platform !== 'win32') return;

    const svvPath = this._findSoundVolumeView();
    if (svvPath) {
      try {
        const { execSync } = require('child_process');
        // SoundVolumeView /SetAppDefault sets the per-app audio output device.
        // Syntax: /SetAppDefault "<DeviceName>" <render=0|capture=1|all> "<process.exe>"
        const procExe = route.processName.endsWith('.exe')
          ? route.processName
          : `${route.processName}.exe`;
        execSync(
          `"${svvPath}" /SetAppDefault "${route.targetDevice}" 0 "${procExe}"`,
          { timeout: 5000, stdio: 'pipe' }
        );
        console.log(`[AudioRouter] Routed ${route.processName} → ${route.targetDevice} via SoundVolumeView`);
        return;
      } catch (err) {
        console.error('[AudioRouter] SoundVolumeView routing failed:', err.message);
      }
    }

    // Fallback: open Windows per-app audio settings so user can route manually
    try {
      const { exec } = require('child_process');
      exec('start ms-settings:apps-volume');
      console.warn(
        `[AudioRouter] SoundVolumeView not found. Opening Windows Sound Settings.\n` +
        `  Place SoundVolumeView.exe in: ${this._getDriverDir()}\n` +
        `  Download: https://www.nirsoft.net/utils/sound_volume_view.html`
      );
    } catch {}
  }

  /**
   * Restore a Windows app's audio output to the system default device.
   * @param {string} processName
   */
  _restoreWindowsDefault(processName) {
    const svvPath = this._findSoundVolumeView();
    if (!svvPath) return;
    try {
      const { execSync } = require('child_process');
      const procExe = processName.endsWith('.exe')
        ? processName
        : `${processName}.exe`;
      // Setting empty device name restores to system default
      execSync(
        `"${svvPath}" /SetAppDefault "DefaultRenderDevice" 0 "${procExe}"`,
        { timeout: 5000, stdio: 'pipe' }
      );
      console.log(`[AudioRouter] Restored ${processName} to default device`);
    } catch (err) {
      console.error('[AudioRouter] Failed to restore default device:', err.message);
    }
  }

  /**
   * Find SoundVolumeView.exe — checks audio-drivers/, common locations, and PATH.
   * @returns {string|null} Path to SoundVolumeView.exe or null
   */
  _findSoundVolumeView() {
    const locations = [
      path.join(this._getDriverDir(), 'SoundVolumeView.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'SoundVolumeView', 'SoundVolumeView.exe'),
      path.join(process.env.PROGRAMFILES || '', 'NirSoft', 'SoundVolumeView.exe'),
      path.join(process.env.PROGRAMFILES || '', 'SoundVolumeView', 'SoundVolumeView.exe'),
    ];
    for (const loc of locations) {
      if (loc && fs.existsSync(loc)) return loc;
    }
    // Check system PATH
    try {
      const { execSync } = require('child_process');
      const result = execSync('where SoundVolumeView.exe', {
        encoding: 'utf-8', timeout: 3000, stdio: 'pipe'
      }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}
    return null;
  }

  /**
   * Check if SoundVolumeView is available for automated per-app audio routing.
   * @returns {{ available: boolean, path: string|null, driverDir: string }}
   */
  isSoundVolumeViewAvailable() {
    const svvPath = this._findSoundVolumeView();
    return {
      available: !!svvPath,
      path: svvPath,
      driverDir: this._getDriverDir(),
    };
  }

  /** Poll for audio sessions periodically to update the app list. */
  _startSessionPolling() {
    if (this._pollInterval) return;
    this._pollInterval = setInterval(() => {
      // Re-apply routes for any newly launched apps
      const apps = this.getAudioApplications();
      for (const route of this.routes) {
        const app = apps.find(a => a.name === route.processName);
        if (app && !app.routed) {
          this._applyRoute(route);
        }
      }
    }, 5000); // every 5 seconds
  }

  /** Get the path to bundled audio drivers. */
  _getDriverDir() {
    // In development, it's relative to the project
    // In production, it's in the app's resources
    const devPath = path.join(__dirname, '..', '..', 'audio-drivers');
    if (fs.existsSync(devPath)) return devPath;

    // Packaged app
    return path.join(process.resourcesPath, 'audio-drivers');
  }

  /** Cleanup on app quit. */
  cleanup() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    // Clean up Linux null-sink if we created one this session
    if (this.platform === 'linux' && this._linuxModuleId) {
      try {
        const { execSync } = require('child_process');
        execSync(`pactl unload-module ${this._linuxModuleId}`, { timeout: 3000, stdio: 'pipe' });
      } catch {}
    }
  }

  // ═══════════════════════════════════════════════════════
  // Linux audio routing (PulseAudio / PipeWire)
  // ═══════════════════════════════════════════════════════

  /**
   * Check if a Haven virtual sink already exists on Linux.
   */
  _isLinuxModuleLoaded() {
    if (!this._linuxAudio) return false;
    try {
      const { execSync } = require('child_process');
      const sinks = execSync('pactl list short sinks', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
      return sinks.includes('haven_virtual') || sinks.includes('HavenVirtual');
    } catch {
      return false;
    }
  }

  /**
   * Create a PulseAudio/PipeWire null-sink for Haven routing.
   * No root/sudo required — null-sinks are user-level modules.
   */
  async _installLinuxModule() {
    if (!this._linuxAudio) {
      return { success: false, reason: 'No PulseAudio or PipeWire detected. Please install PulseAudio or PipeWire.' };
    }

    try {
      const { execSync } = require('child_process');

      // Create a null sink (virtual output device) that Haven captures from
      const moduleId = execSync(
        'pactl load-module module-null-sink sink_name=haven_virtual sink_properties=device.description="Haven\\ Virtual\\ Cable"',
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }
      ).trim();

      this._linuxModuleId = moduleId;

      // Also create a loopback so we can monitor it (optional, helps with some setups)
      try {
        execSync(
          'pactl load-module module-loopback source=haven_virtual.monitor sink_input_properties=media.name="Haven\\ Monitor"',
          { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }
        );
      } catch {} // non-critical

      if (this._isLinuxModuleLoaded()) {
        this._startSessionPolling();
        return { success: true };
      }
      return { success: false, reason: 'Module loaded but virtual sink not detected.' };
    } catch (err) {
      return { success: false, reason: `Failed to create virtual sink: ${err.message}` };
    }
  }

  /**
   * List applications currently producing audio on Linux.
   * Uses `pactl list sink-inputs` to find active audio streams.
   */
  _getLinuxAudioApps() {
    try {
      const { execSync } = require('child_process');
      const output = execSync('pactl list sink-inputs', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });

      const apps = [];
      const blocks = output.split('Sink Input #');

      for (const block of blocks) {
        if (!block.trim()) continue;

        const idMatch = block.match(/^(\d+)/);
        const pidMatch = block.match(/application\.process\.id\s*=\s*"(\d+)"/);
        const nameMatch = block.match(/application\.name\s*=\s*"([^"]+)"/);
        const binMatch = block.match(/application\.process\.binary\s*=\s*"([^"]+)"/);

        if (idMatch && (nameMatch || binMatch)) {
          const sinkInputId = parseInt(idMatch[1]);
          const pid = pidMatch ? parseInt(pidMatch[1]) : 0;
          const name = binMatch ? binMatch[1] : nameMatch[1];
          const title = nameMatch ? nameMatch[1] : name;

          apps.push({
            pid,
            name,
            title,
            sinkInputId,
            routed: this.routes.some(r => r.processName === name)
          });
        }
      }

      return apps;
    } catch (err) {
      console.error('[AudioRouter] Failed to enumerate Linux audio apps:', err.message);
      return [];
    }
  }

  /**
   * Get audio devices on Linux via pactl.
   */
  _getLinuxDevices() {
    try {
      const { execSync } = require('child_process');
      const output = execSync('pactl list short sinks', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });

      return output.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split('\t');
          const name = parts[1] || parts[0];
          return {
            name,
            isVirtual: /haven_virtual|null/i.test(name)
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Move a sink-input (app audio stream) to the Haven virtual sink on Linux.
   * Uses `pactl move-sink-input <sink-input-id> <sink-name>`.
   */
  _applyLinuxRoute(route) {
    try {
      const { execSync } = require('child_process');
      // Find the sink-input ID for this process
      const apps = this._getLinuxAudioApps();
      const app = apps.find(a => a.name === route.processName);
      if (!app || !app.sinkInputId) {
        console.warn(`[AudioRouter] Cannot find sink-input for ${route.processName}`);
        return;
      }
      const targetSink = route.targetDevice || 'haven_virtual';
      execSync(`pactl move-sink-input ${app.sinkInputId} ${targetSink}`, {
        timeout: 3000, stdio: 'pipe'
      });
      console.log(`[AudioRouter] Routed ${route.processName} → ${targetSink}`);
    } catch (err) {
      console.error(`[AudioRouter] Failed to route on Linux:`, err.message);
    }
  }
}

module.exports = { AudioRouter };
