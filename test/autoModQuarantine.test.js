'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const AutoModQuarantine = require('../plugins/AutoModQuarantine.plugin.js');

test('AutoModQuarantine initializes with valid default settings', () => {
  const plugin = new AutoModQuarantine();
  assert.equal(plugin._started, false);
  assert.equal(plugin._settings.enabled, true);
  assert.equal(plugin._settings.autoReleaseSafe, true);
  assert.equal(plugin._settings.autoWarnUsers, false, 'warnings post in the moderator name, so they start off');
  assert.equal(plugin._settings.maxStrikes, 3);
  assert.equal(plugin._settings.aiProvider, 'gemini');
  assert.ok(plugin._settings.trustedDomains.includes('github.com'));
  assert.ok(plugin._settings.blockedDomains.includes('grabify.link'));
});

test('Multi-Provider AI configurations are properly defined', () => {
  const providers = AutoModQuarantine.PROVIDERS;
  assert.ok(providers.gemini, 'Gemini provider missing');
  assert.ok(providers.claude, 'Claude provider missing');
  assert.ok(providers.openai, 'OpenAI/Codex provider missing');
  assert.ok(providers.grok, 'Grok provider missing');
  assert.ok(providers.ollama, 'Ollama provider missing');
  assert.ok(providers.agy, 'AGY provider missing');
  assert.ok(providers.opencode, 'OpenCode provider missing');
  assert.ok(providers.muse, 'Muse provider missing');
  assert.ok(providers.custom, 'Custom provider missing');

  // Verify provider endpoints & types
  assert.equal(providers.gemini.type, 'gemini');
  assert.equal(providers.claude.type, 'anthropic');
  assert.equal(providers.openai.type, 'openai');
  assert.equal(providers.grok.type, 'openai');
  assert.equal(providers.ollama.type, 'openai');
  assert.equal(providers.ollama.needsKey, false);
  assert.equal(providers.agy.type, 'openai');
  assert.equal(providers.muse.type, 'openai');
});

test('getEffectiveAiConfig correctly resolves custom and default provider settings', () => {
  const plugin = new AutoModQuarantine();

  // Default Gemini
  const geminiConfig = plugin.getEffectiveAiConfig();
  assert.equal(geminiConfig.providerId, 'gemini');
  assert.equal(geminiConfig.model, 'gemini-3.8-flash');
  assert.equal(geminiConfig.auth, 'key');

  // Switch to Grok
  plugin._settings.aiProvider = 'grok';
  plugin._settings.aiApiKey = 'xai-test-key';
  const grokConfig = plugin.getEffectiveAiConfig();
  assert.equal(grokConfig.providerId, 'grok');
  assert.equal(grokConfig.endpoint, 'https://api.x.ai/v1/chat/completions');
  assert.equal(grokConfig.model, 'grok-4.7');
  assert.equal(grokConfig.apiKey, 'xai-test-key');

  // Switch to Ollama with custom model
  plugin._settings.aiProvider = 'ollama';
  plugin._settings.aiModel = 'mistral:latest';
  const ollamaConfig = plugin.getEffectiveAiConfig();
  assert.equal(ollamaConfig.providerId, 'ollama');
  assert.equal(ollamaConfig.endpoint, 'http://localhost:11434/v1/chat/completions');
  assert.equal(ollamaConfig.model, 'mistral:latest');

  // Switch to Claude with custom endpoint
  plugin._settings.aiProvider = 'claude';
  plugin._settings.aiEndpoint = 'https://my-proxy.internal/v1/messages';
  plugin._settings.aiApiKey = 'Bearer sso-token-xyz';
  const claudeConfig = plugin.getEffectiveAiConfig();
  assert.equal(claudeConfig.providerId, 'claude');
  assert.equal(claudeConfig.endpoint, 'https://my-proxy.internal/v1/messages');
  assert.equal(claudeConfig.apiKey, 'Bearer sso-token-xyz');
  const ssoHeaders = plugin._authHeaders(claudeConfig);
  assert.equal(ssoHeaders.Authorization, 'Bearer sso-token-xyz');
  assert.equal(ssoHeaders['anthropic-beta'], undefined, 'Bearer tokens go to proxies as-is, never dressed up as another client');
  assert.equal(ssoHeaders['x-api-key'], undefined);

  plugin._settings.aiProvider = 'opencode';
  plugin._settings.aiAuth = 'sso';
  plugin._settings.aiApiKey = 'oc_sk_test';
  plugin._settings.aiEndpoint = '';
  plugin._settings.aiModel = '';
  const openCode = plugin.getEffectiveAiConfig();
  assert.equal(openCode.providerId, 'opencode');
  assert.equal(openCode.endpoint, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(openCode.model, 'glm-5.3-flash');
  assert.equal(openCode.auth, 'sso');
  const ocHeaders = plugin._authHeaders(openCode);
  assert.equal(ocHeaders.Authorization, 'Bearer oc_sk_test');
  assert.ok(ocHeaders['x-opencode-session']);

  plugin._settings.aiProvider = 'gemini';
  plugin._settings.aiAuth = 'sso';
  plugin._settings.aiApiKey = 'ya29-test';
  const geminiSso = plugin._authHeaders(plugin.getEffectiveAiConfig());
  assert.equal(geminiSso.Authorization, 'Bearer ya29-test');
  assert.equal(geminiSso['x-goog-api-key'], undefined);
  plugin._settings.aiAuth = 'key';
  const geminiKey = plugin._authHeaders(plugin.getEffectiveAiConfig());
  assert.equal(geminiKey['x-goog-api-key'], 'ya29-test');
  assert.equal(geminiKey.Authorization, undefined);
});

test('_parseAiResponse cleanly parses structured JSON or fallbacks', () => {
  const plugin = new AutoModQuarantine();

  // Valid clean JSON
  const res1 = plugin._parseAiResponse('{"safe": true, "reason": "Repository is clean", "confidence": 0.99}', 'test');
  assert.equal(res1.safe, true);
  assert.equal(res1.reason, 'Repository is clean');

  // JSON inside markdown fences
  const res2 = plugin._parseAiResponse('```json\n{"safe": false, "reason": "Phishing token grabber"}\n```', 'test');
  assert.equal(res2.safe, false);
  assert.equal(res2.reason, 'Phishing token grabber');

  // Prose or a missing verdict is never guessed at: the caller falls back to
  // the keyword checks, which do not earn the AI badge.
  assert.throws(() => plugin._parseAiResponse('This link looks fine to me.', 'test'), /not valid JSON/);
  assert.throws(() => plugin._parseAiResponse('{"reason": "ran out of tokens"}', 'test'), /no safe\/unsafe verdict/);
});

test('extractUrls extracts both raw URLs and markdown links', () => {
  const plugin = new AutoModQuarantine();
  const text = 'Check out https://github.com/torvalds/linux and also [docs](https://wikipedia.org/wiki/Linux) here!';
  const urls = plugin.extractUrls(text);

  assert.equal(urls.length, 2);
  assert.equal(urls[0].url, 'https://wikipedia.org/wiki/Linux');
  assert.equal(urls[0].label, 'docs');
  assert.equal(urls[0].isMarkdown, true);

  assert.equal(urls[1].url, 'https://github.com/torvalds/linux');
  assert.equal(urls[1].isMarkdown, false);
});

test('normalizeHost handles www, ports, trailing dots, and case', () => {
  const plugin = new AutoModQuarantine();
  assert.equal(plugin.normalizeHost('WWW.Example.COM:8080'), 'example.com');
  assert.equal(plugin.normalizeHost('sub.domain.org.'), 'sub.domain.org');
  assert.equal(plugin.normalizeHost('github.com'), 'github.com');
});

test('Source Trust: releases trusted domains', () => {
  const plugin = new AutoModQuarantine();
  const resGithub = plugin.checkSourceTrust('https://github.com/amnibro/haven');
  assert.equal(resGithub.ok, true);
  assert.equal(resGithub.trusted, true);

  const resWiki = plugin.checkSourceTrust('https://en.wikipedia.org/wiki/Computer_security');
  assert.equal(resWiki.ok, true);
  assert.equal(resWiki.trusted, true);
});

test('Source Trust: blocks raw IP URLs', () => {
  const plugin = new AutoModQuarantine();
  const res = plugin.checkSourceTrust('http://45.33.32.156/setup.exe');
  assert.equal(res.ok, false);
  assert.match(res.reason, /IP address/i);
});

test('Source Trust: blocks punycode domains', () => {
  const plugin = new AutoModQuarantine();
  const res = plugin.checkSourceTrust('https://xn--e1awd7f.com/login');
  assert.equal(res.ok, false);
  assert.match(res.reason, /punycode/i);
});

test('Source Trust: blocks dangerous file extensions', () => {
  const plugin = new AutoModQuarantine();
  const resExe = plugin.checkSourceTrust('https://some-unverified-site.org/downloads/game_installer.exe');
  assert.equal(resExe.ok, false);
  assert.match(resExe.reason, /executable/i);

  const resBat = plugin.checkSourceTrust('https://some-unverified-site.org/script.bat');
  assert.equal(resBat.ok, false);
  assert.match(resBat.reason, /executable/i);
});

test('Source Trust: blocks server denylist domains', () => {
  const plugin = new AutoModQuarantine();
  const res = plugin.checkSourceTrust('https://grabify.link/track/123');
  assert.equal(res.ok, false);
  assert.match(res.reason, /server blocked/i);
});

test('Source Trust: flags Discord Nitro and Steam phishing scams', () => {
  const plugin = new AutoModQuarantine();
  const nitro = plugin.checkSourceTrust('https://free-nitro-gift.xyz/claim');
  assert.equal(nitro.ok, false);
  assert.match(nitro.reason, /Discord Nitro/i);

  const steam = plugin.checkSourceTrust('https://steamcommunity-tradeoffer.ru/trade');
  assert.equal(steam.ok, false);
  assert.match(steam.reason, /Steam/i);

  const crypto = plugin.checkSourceTrust('https://airdrop-claim-tokens.site/connect-wallet');
  assert.equal(crypto.ok, false);
  assert.match(crypto.reason, /wallet drainer/i);
});

test('AI Heuristic scanner catches social engineering messages', async () => {
  const plugin = new AutoModQuarantine();
  const verdictScam = await plugin.scanContentAndLink(
    'https://unverified-zone.xyz/win',
    'Hey bro click here to claim free nitro gift right now!'
  );
  assert.equal(verdictScam.status, 'blocked');
  assert.ok(verdictScam.reason.length > 0);

  const verdictSafe = await plugin.scanContentAndLink(
    'https://cool-project.org/about',
    'Here is an open source blog post discussing protocol architectures'
  );
  assert.equal(verdictSafe.status, 'safe');
});

test('transformMessageHtml quarantines unverified links initially', () => {
  const plugin = new AutoModQuarantine();
  const rawText = 'Check this https://unknown-site.org/item';
  const initialHtml = 'Check this <a href="https://unknown-site.org/item" target="_blank">https://unknown-site.org/item</a>';

  const quarantinedHtml = plugin.transformMessageHtml(initialHtml, rawText);
  assert.match(quarantinedHtml, /haven-quarantine-capsule/);
  assert.match(quarantinedHtml, /Quarantined Link/);
  assert.doesNotMatch(quarantinedHtml, /<a href="https:\/\/unknown-site\.org\/item"/);
});

test('transformMessageHtml displays verified safe link when cached safe', () => {
  const plugin = new AutoModQuarantine();
  const url = 'https://github.com/torvalds/linux';
  plugin._cache.set(url, { status: 'safe', reason: 'Trusted source', url });

  const rawText = `Check ${url}`;
  const initialHtml = `Check <a href="${url}" target="_blank">${url}</a>`;

  const safeHtml = plugin.transformMessageHtml(initialHtml, rawText);
  assert.match(safeHtml, /haven-automod-released/);
  assert.match(safeHtml, /hq-verified-check/);
  assert.match(safeHtml, /href="https:\/\/github\.com\/torvalds\/linux"/);
});

test('transformMessageHtml displays blocked card when cached blocked', () => {
  const plugin = new AutoModQuarantine();
  const url = 'https://grabify.link/test';
  plugin._cache.set(url, { status: 'blocked', reason: 'Denylisted IP logger', url });

  const rawText = `Check ${url}`;
  const initialHtml = `Check <a href="${url}" target="_blank">${url}</a>`;

  const blockedHtml = plugin.transformMessageHtml(initialHtml, rawText);
  assert.match(blockedHtml, /haven-automod-blocked-card/);
  assert.match(blockedHtml, /Link Blocked by AutoMod/);
  assert.match(blockedHtml, /Denylisted IP logger/);
});

test('transformMessageHtml catches bare root URLs and HTML-escaped &amp; query params', () => {
  const plugin = new AutoModQuarantine();
  const rawText = 'Visit https://grabify.link and https://evil.example/login?user=1&token=2';
  const initialHtml = 'Visit <a href="https://grabify.link" target="_blank">https://grabify.link</a> and <a href="https://evil.example/login?user=1&amp;token=2" target="_blank">https://evil.example/login?user=1&amp;token=2</a>';

  const out = plugin.transformMessageHtml(initialHtml, rawText);
  assert.doesNotMatch(out, /<a href="https:\/\/grabify\.link"/);
  assert.doesNotMatch(out, /<a href="https:\/\/evil\.example/);
  assert.equal((out.match(/haven-quarantine-capsule/g) || []).length, 2);
});

test('a link with $& in it cannot paste HTML back into the quarantine markup', () => {
  const plugin = new AutoModQuarantine();
  const url = 'https://x.com/a/$&/style=position:fixed';
  const rawText = `look ${url}`;
  const html = `look <a href="${url}">${url}</a>`;
  const out = plugin.transformMessageHtml(html, rawText);
  assert.ok(!out.includes('<a href'), 'the original tag is replaced, not pasted back');
  assert.ok(out.includes('$&amp;') || out.includes('$&'), 'the $& stays literal text');
  plugin._cache.set(plugin.extractUrls(rawText)[0].url, { status: 'blocked', reason: 'x $& y' });
  const blocked = plugin.transformMessageHtml(html, rawText);
  assert.ok(!blocked.includes('<a href'), 'blocked card is literal too');
});

test('text from an encrypted DM is never quarantined or sent for a scan', () => {
  const plugin = new AutoModQuarantine();
  plugin._settings.enabled = true;
  const queued = [];
  plugin._enqueueScan = (url) => queued.push(url);
  let patched = null;
  const prevApi = global.HavenApi, prevWindow = global.window;
  global.HavenApi = { Patcher: { instead: (id, obj, name, fn) => { patched = fn; } } };
  global.window = { app: { _formatContent: () => '' } };
  try {
    plugin._patchMessageFormatting();
    const html = '<a href="https://evil.example/x">https://evil.example/x</a>';
    const orig = () => html;
    assert.equal(patched(['https://evil.example/x', { e2e: true }], orig), html);
    assert.deepEqual(queued, []);
    assert.notEqual(patched(['https://evil.example/x'], orig), html, 'channel messages are still checked');
    assert.equal(queued.length, 1);
  } finally {
    global.HavenApi = prevApi;
    global.window = prevWindow;
  }
});

test('recordInfraction and issueWarning tracks strikes and escalates', () => {
  const plugin = new AutoModQuarantine();
  assert.equal(plugin.getUserStrikes(42), 0);

  const warn1 = plugin.issueWarning('badguy', 42, 'Phishing link', 'https://bad.xyz', 'testchan');
  assert.equal(warn1.strikes, 1);
  assert.match(warn1.message, /Warning 1\/3/);

  const warn2 = plugin.issueWarning('badguy', 42, 'Malicious executable', 'https://bad.xyz/evil.exe', 'testchan');
  assert.equal(warn2.strikes, 2);
  assert.match(warn2.message, /Warning 2\/3/);

  const warn3 = plugin.issueWarning('badguy', 42, 'IP logger', 'https://grabify.link/1', 'testchan');
  assert.equal(warn3.strikes, 3);
  assert.match(warn3.message, /Warning 3\/3/);
  assert.equal(plugin.getUserStrikes(42), 3);

  plugin.clearUserStrikes(42);
  assert.equal(plugin.getUserStrikes(42), 0);
});
test('Muse points at Meta and the new presets are OpenAI-compatible', () => {
  const p = AutoModQuarantine.PROVIDERS;
  assert.equal(p.muse.defaultEndpoint, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(p.muse.defaultModel, 'muse-spark-1.3');
  for (const id of ['openrouter', 'mistral', 'deepseek']) assert.equal(p[id].type, 'openai', id);
});
test('testAiConnection reports real provider errors instead of the heuristic fallback', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'muse';
  assert.match((await plugin.testAiConnection()).message, /No API key/);
  plugin._settings.aiApiKey = 'bad-key';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }) }));
  const res = await plugin.testAiConnection();
  assert.equal(res.ok, false);
  assert.match(res.message, /401: Invalid API key/);
  assert.equal((await plugin._dispatchAiScan('https://example.com', '', plugin.getEffectiveAiConfig())).source, 'heuristic_ai');
});
test('Browser-blocked providers go through the Haven relay with the session token', async (t) => {
  const plugin = new AutoModQuarantine(), calls = [];
  plugin._settings.aiProvider = 'opencode';
  plugin._settings.aiApiKey = 'sk-zen';
  globalThis.localStorage = { getItem: () => 'haven-session' };
  t.after(() => { delete globalThis.localStorage; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (url !== '/api/automod/relay') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"safe":true,"reason":"fine"}' } }] }) }) };
  });
  const res = await plugin.testAiConnection();
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /through the Haven relay/);
  const relay = calls.find(c => c.url === '/api/automod/relay');
  assert.equal(relay.init.headers.Authorization, 'Bearer haven-session');
  const sent = JSON.parse(relay.init.body);
  assert.equal(sent.url, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(sent.headers.Authorization, 'Bearer sk-zen');
  calls.length = 0;
  await plugin._dispatchAiScan('https://example.org', '', plugin.getEffectiveAiConfig(), true);
  assert.deepEqual(calls.map(c => c.url), ['/api/automod/relay']);
});
test('Local endpoints never fall back to the server relay', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'ollama';
  globalThis.localStorage = { getItem: () => 'haven-session' };
  t.after(() => { delete globalThis.localStorage; });
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); throw new TypeError('Failed to fetch'); });
  const res = await plugin.testAiConnection();
  assert.equal(res.ok, false);
  assert.deepEqual(urls, ['http://localhost:11434/v1/chat/completions']);
});
test('_autoDetectLocalAi switches fresh and localhost-Ollama setups to the Haven server AI', async (t) => {
  const plugin = new AutoModQuarantine();
  const seen = [];
  globalThis.localStorage = { getItem: () => 'haven-session' };
  t.after(() => { delete globalThis.localStorage; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    if (url === '/api/automod/local-status') return { ok: true, json: async () => ({ available: true, model: 'granite4.2:latest', rules: 'No crypto shilling.' }) };
    throw new Error('Unexpected fetch');
  });
  const probe = await plugin._autoDetectLocalAi(true);
  assert.deepEqual([probe.provider, probe.model, probe.source], ['haven', 'granite4.2:latest', 'server']);
  assert.equal(plugin._settings.aiProvider, 'gemini', 'the settings button only previews');
  await plugin._autoDetectLocalAi(false);
  assert.equal(plugin._settings.aiProvider, 'haven');
  assert.equal(plugin._settings.serverRules, 'No crypto shilling.');
  assert.ok(seen.every(s => s.url === '/api/automod/local-status' && s.auth === 'Bearer haven-session'), 'startup never probes localhost from member devices');
  const saved = new AutoModQuarantine();
  saved._hasSavedSettings = true;
  saved._settings.aiProvider = 'gemini';
  assert.equal(await saved._autoDetectLocalAi(false), null);
  saved._settings.aiProvider = 'ollama';
  await saved._autoDetectLocalAi(false);
  assert.equal(saved._settings.aiProvider, 'haven', 'old localhost Ollama configs move to the server AI');
});
test('Haven server AI scans go through the server with the session token', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'haven';
  globalThis.localStorage = { getItem: () => 'haven-session' };
  t.after(() => { delete globalThis.localStorage; });
  const calls = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return { ok: status === 200, status, json: async () => ({ safe: false, reason: 'Phishing' }), text: async () => '{"error":"The Haven server AI is busy or offline"}' };
  });
  const v = await plugin._dispatchAiScan('https://scam-gift.org/login', 'free gift', plugin.getEffectiveAiConfig());
  assert.deepEqual(v, { safe: false, reason: 'Phishing', source: 'haven_ai' });
  assert.equal(calls[0].url, '/api/automod/scan');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer haven-session');
  assert.deepEqual(JSON.parse(calls[0].init.body), { url: 'https://scam-gift.org/login' }, 'only the link leaves the browser');
  status = 202;
  assert.equal((await plugin._dispatchAiScan('https://new.org/', '', plugin.getEffectiveAiConfig())).source, 'heuristic_ai');
  await assert.rejects(plugin._dispatchAiScan('https://new.org/', '', plugin.getEffectiveAiConfig(), true), /Only moderators/);
  status = 503;
  await assert.rejects(plugin._dispatchAiScan('https://new.org/', '', plugin.getEffectiveAiConfig(), true), /Haven server AI status 503: The Haven server AI is busy/);
});
test('Heuristic fallback verdicts never blacklist a whole domain', async (t) => {
  const plugin = new AutoModQuarantine();
  t.mock.method(plugin, '_dispatchAiScan', async () => ({ safe: false, reason: 'Suspicious words', source: 'heuristic_ai' }));
  assert.equal((await plugin.scanContentAndLink('https://shop.example.org/free-gift', 'free gift')).status, 'blocked');
  assert.ok(!plugin._settings.blockedDomains.includes('shop.example.org'));
});
test('Auto-warnings need a moderator and a server claim, so only one moderator posts each', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'haven';
  plugin._settings.autoWarnUsers = true;
  globalThis.localStorage = { getItem: () => 'tok' };
  globalThis.HavenApi = { currentUser: { isAdmin: false }, currentChannel: 'abcd1234' };
  globalThis.window = { app: { _hasPerm: p => p === 'delete_message', _canModerate: () => false } };
  t.after(() => { delete globalThis.localStorage; delete globalThis.HavenApi; delete globalThis.window; });
  let claims = 0;
  t.mock.method(globalThis, 'fetch', async (url) => url === '/api/automod/claim-warn' ? { ok: true, status: 200, json: async () => ({ claimed: claims++ === 0 }) } : { ok: true, status: 200, json: async () => ({ safe: false, reason: 'Phishing' }) });
  const warned = [];
  t.mock.method(plugin, 'issueWarning', (...a) => warned.push(a));
  assert.equal(plugin._isMod(), true, 'Haven mods have delete_message, not isMod');
  plugin._enqueueScan('https://scam-one.org/a', 'x');
  while (plugin._activeScans > 0 || plugin._pendingQueue.length > 0) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(warned.length, 1);
  plugin._autoWarned.clear();
  plugin._cache.clear();
  plugin._settings.blockedDomains = [];
  plugin._enqueueScan('https://scam-one.org/a', 'x');
  while (plugin._activeScans > 0 || plugin._pendingQueue.length > 0) await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(warned.length, 1, 'another moderator already claimed this warning');
  globalThis.window.app._hasPerm = () => false;
  assert.equal(plugin._isMod(), false);
});
test('Cloud and server AI scans run in parallel; direct local Ollama stays one at a time', async (t) => {
  for (const [provider, want] of [['gemini', 4], ['ollama', 1]]) {
    const plugin = new AutoModQuarantine();
    plugin._settings.aiProvider = provider;
    let active = 0, peak = 0;
    t.mock.method(plugin, '_dispatchAiScan', async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 15)); active--; return { safe: true, reason: 'ok', source: `${provider}_ai` }; });
    for (let i = 0; i < 7; i++) plugin._enqueueScan(`https://site-${i}.org/`, '');
    while (plugin._activeScans > 0 || plugin._pendingQueue.length > 0) await new Promise(r => setTimeout(r, 5));
    assert.equal(peak, want, provider);
  }
});
test('Multi-link bursts are queued serially (no GPU/RAM overload) and bad domains are auto-blacklisted', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'ollama';
  plugin._settings.maxConcurrentScans = 1;
  plugin._settings.autoBlacklistBadHosts = true;

  let active = 0;
  let maxConcurrentObserved = 0;
  let aiCallCount = 0;

  t.mock.method(plugin, '_dispatchAiScan', async (url) => {
    aiCallCount++;
    active++;
    if (active > maxConcurrentObserved) maxConcurrentObserved = active;
    await new Promise(r => setTimeout(r, 20));
    active--;
    if (url.includes('scam-drop.org')) {
      return { safe: false, reason: 'Phishing domain detected by AI', source: 'ollama_ai' };
    }
    return { safe: true, reason: 'Clean link', source: 'ollama_ai' };
  });

  // Enqueue 3 links at once: two on the same bad domain + one clean domain
  plugin._enqueueScan('https://scam-drop.org/page1', 'check this out');
  plugin._enqueueScan('https://scam-drop.org/page2', 'check this out too');
  plugin._enqueueScan('https://clean-docs.org/guide', 'normal guide');

  // Wait for serial queue to finish draining
  while (plugin._activeScans > 0 || plugin._pendingQueue.length > 0) {
    await new Promise(r => setTimeout(r, 10));
  }

  // 1. Concurrency never exceeded 1 (no GPU/RAM spike)
  assert.equal(maxConcurrentObserved, 1, 'Queue must run 1 scan at a time');
  // 2. First scam-drop.org link triggered AI scan and blacklisted scam-drop.org
  assert.ok(plugin._settings.blockedDomains.includes('scam-drop.org'), 'Bad host should be added to blockedDomains');
  // 3. Second scam-drop.org link was caught by checkSourceTrust (blockedDomains) without calling the AI a second time!
  assert.equal(aiCallCount, 2, 'Second link on blacklisted host should bypass AI and block immediately');
  assert.equal(plugin._cache.get('https://scam-drop.org/page2')?.status, 'blocked');
  assert.equal(plugin._cache.get('https://scam-drop.org/page2')?.source, 'source_trust');
  assert.equal(plugin._cache.get('https://clean-docs.org/guide')?.status, 'safe');
});
test('unloadModelAfterQueue keeps Ollama model warm during multi-link queue and unloads on completion', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'ollama';
  plugin._settings.aiModel = 'granite4.2:8b';
  plugin._settings.unloadModelAfterQueue = true;

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, keep_alive: body.keep_alive });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"safe":true,"reason":"ok"}' } }] })
    };
  });

  // Enqueue 2 links at once: first scan should pass keep_alive: '2m' (since item #2 is waiting),
  // second scan should pass keep_alive: 0 (since queue is now empty)
  plugin._enqueueScan('https://site-one.org/a', 'first link');
  plugin._enqueueScan('https://site-two.org/b', 'second link');

  while (plugin._activeScans > 0 || plugin._pendingQueue.length > 0) {
    await new Promise(r => setTimeout(r, 10));
  }

  const chatCalls = calls.filter(c => c.url.endsWith('/v1/chat/completions'));
  assert.equal(chatCalls.length, 2);
  assert.equal(chatCalls[0].keep_alive, '2m', 'First queued item keeps model loaded for the next item');
  assert.equal(chatCalls[1].keep_alive, 0, 'Final item in queue sets keep_alive: 0 to immediately unload from VRAM/RAM');
});
test('An empty AI answer is never treated as safe', async (t) => {
  const plugin = new AutoModQuarantine();
  plugin._settings.aiProvider = 'openai';
  plugin._settings.aiApiKey = 'sk-test';
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' } }] }) }));
  assert.equal((await plugin._dispatchAiScan('https://steam-gift-drop.org/login', 'free steam gift, login', plugin.getEffectiveAiConfig())).source, 'heuristic_ai');
  assert.equal((await plugin.testAiConnection()).ok, false);
});
test('Scans wait for startup detection so early links use the Haven server AI', async (t) => {
  const plugin = new AutoModQuarantine();
  let release;
  plugin._detecting = new Promise(r => { release = r; });
  t.mock.method(plugin, '_dispatchAiScan', async (url, ctx, config) => ({ safe: true, reason: config.providerId, source: `${config.providerId}_ai` }));
  const pending = plugin.scanContentAndLink('https://early.example.org/', '');
  plugin._settings.aiProvider = 'haven';
  release();
  assert.equal((await pending).source, 'haven_ai');
});
