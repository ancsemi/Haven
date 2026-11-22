/**
 * @name Focus Classic Layout
 * @description The original desktop Focus view, picked in Settings, Layout: a rail with Server, DMs, Activity and You shows one list at a time beside the chat. Click the open tab again to hide the list. Alt+1 to Alt+4 switch tabs. It is drawn by the Focus layout plugin.
 * @author Amni-Scient
 * @version 1.0.0
 */
class FocusClassicLayout {
  start() { this._started = true; }
  stop() { this._started && this._disengage(false); this._started = false; }
  _focus(wake) { const L = window.HavenPluginLoader; wake && L?.enablePlugin?.('FocusLayout.plugin.js'); return L?.loadedPlugins?.get('FocusLayout.plugin.js')?.instance; }
  _engage(persist = true) { persist && HavenApi.Data.save('FocusClassicLayout', 'layoutOn', '1'); this._focus(true)?._engage(false, 'classic'); }
  _disengage(persist = true) { persist && HavenApi.Data.save('FocusClassicLayout', 'layoutOn', '0'); const f = this._focus(); f?._style === 'classic' && f._disengage(false); }
}
if (typeof module !== 'undefined') module.exports = FocusClassicLayout;
if (typeof _win !== 'undefined') _win.FocusClassicLayout = FocusClassicLayout;
