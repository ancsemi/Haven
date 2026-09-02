/**
 * Haven — shared auto-mod link rules (v3.44.0)
 *
 * Loaded by BOTH the Node server (src/automod.js requires this file) and the
 * browser (plain <script> tag). One copy on purpose: the server decides
 * whether a message may be sent, and the client decides whether a decrypted
 * DM's links may be rendered as clickable. If those two ever disagreed about
 * what "the host of this URL" means, the client-side check would become a
 * false reassurance, which is worse than not having it.
 *
 * Pure functions only. No DOM, no database, no settings lookups — callers
 * pass a policy object in and get a verdict out.
 *
 * ── Why the URL parsing is this paranoid ──
 *
 * A domain allowlist is only as good as its ability to work out the real host
 * of a link. All of these defeat a naive regex and are handled explicitly:
 *
 *   https://youtube.com@evil.com/x   userinfo, real host is evil.com
 *   https://evilyoutube.com/         suffix match without a dot boundary
 *   https://youtube.com.evil.com/    same, from the other direction
 *   https://аbout.com/               Cyrillic 'а', a different domain entirely
 *   https://you<ZWSP>tube.com/       zero-width char splitting the hostname
 *   hxxps://evil[.]com/              defanged, still readable by a human
 *   [youtube.com](https://evil.com)  markdown label lying about its target
 *   https://192.0.2.10/pics.rar      bare IP, no domain to match at all
 *
 * The rule throughout: never pattern-match a hostname out of raw text. Strip
 * the invisible characters, undo the defanging, then let the WHATWG URL parser
 * say what the host actually is. It already handles userinfo, ports, backslash
 * normalisation and IDN punycode conversion correctly, which is exactly the
 * set of things hand-rolled regexes get wrong.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HavenAutomodRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Written as escapes on purpose: these characters are invisible in an
  // editor, so a literal character class would be impossible to review.
  var INVISIBLE_RE = new RegExp(
    '[' +
    '\\u00AD' +              // soft hyphen
    '\\u180E' +              // Mongolian vowel separator
    '\\u200B-\\u200F' +      // zero-width space/joiners, LTR/RTL marks
    '\\u202A-\\u202E' +      // bidi embedding / override
    '\\u2060-\\u2064' +      // word joiner, invisible operators
    '\\u206A-\\u206F' +      // deprecated formatting
    '\\uFEFF' +              // BOM / zero-width no-break space
    ']', 'g'
  );

  // Only consulted for schemeless candidates. Haven's client auto-links
  // http(s):// URLs only, so a bare "evil.foo" is inert text nobody can click.
  // We still catch bare domains a human would retype, without flagging every
  // "readme.md" or "main.py" in a technical conversation — several file
  // extensions collide with real ccTLDs, so a permissive rule here would block
  // ordinary messages.
  var COMMON_TLDS = {};
  ('com net org io co gg tv me app dev gov edu info biz xyz online site shop ' +
   'store live link click top fun icu cyou rest cfd sbs lol zip mov download ' +
   'uk de fr nl ru cn jp br au ca us eu ch se no fi dk pl es it pt ie nz za ' +
   'in mx ar kr').split(' ').forEach(function (t) { COMMON_TLDS[t] = true; });

  var NEVER_ALLOWED_HOSTS = {
    'localhost': true, 'localhost.localdomain': true,
    '127.0.0.1': true, '0.0.0.0': true, '::1': true
  };

  // ── Host normalisation ────────────────────────────────────────────
  // Reduces a hostname to the form used for storage and comparison. The URL
  // parser has already done IDN -> punycode by this point, which is what makes
  // the homoglyph case fall out naturally: "аbout.com" with a Cyrillic 'а'
  // arrives as "xn--bout-8cd.com" and simply is not "about.com".
  function normalizeHost(host) {
    if (typeof host !== 'string') return '';
    var h = host.trim().toLowerCase();
    if (!h) return '';
    if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') h = h.slice(1, -1);
    while (h.charAt(h.length - 1) === '.') h = h.slice(0, -1);
    if (h.indexOf('www.') === 0) h = h.slice(4);
    return h;
  }

  // Suffix match with an explicit dot boundary. endsWith(entry) alone is the
  // classic hole: it happily matches "evilyoutube.com" against "youtube.com".
  function hostMatches(host, entry, includeSubdomains) {
    if (host === entry) return true;
    if (!includeSubdomains) return false;
    return host.length > entry.length &&
           host.slice(-(entry.length + 1)) === '.' + entry;
  }

  // `table` is an array of { domain, includeSubdomains }.
  function lookup(host, table) {
    if (!table) return false;
    for (var i = 0; i < table.length; i++) {
      if (hostMatches(host, table[i].domain, table[i].includeSubdomains !== false)) return true;
    }
    return false;
  }

  function isIpLiteral(host) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      return host.split('.').every(function (o) { return Number(o) >= 0 && Number(o) <= 255; });
    }
    return host.indexOf(':') !== -1 && /^[0-9a-f:.]+$/.test(host);
  }

  function hasPunycodeLabel(host) {
    return host.split('.').some(function (l) { return l.indexOf('xn--') === 0; });
  }

  // ── Deobfuscation ─────────────────────────────────────────────────
  // Undo the conventions people use to write a hostile URL without making it
  // clickable. Attackers use the same syntax to slip past filters that only
  // look for "http", so normalise first and remember that we had to.
  function deobfuscate(text) {
    var before = text;
    var out = text
      .replace(/\bh(?:xx|XX|\*\*)p(s?)\b/gi, 'http$1')
      .replace(/\bhttp(s?)\s*:\s*\/\s*\//gi, 'http$1://')
      .replace(/[\[({<]\s*(?:\.|dot|DOT)\s*[\])}>]/g, '.')
      .replace(/\s+(?:\[dot\]|\(dot\)|dot)\s+/gi, '.')
      .replace(/[\[({<]\s*(?::|colon)\s*[\])}>]/gi, ':');
    return { text: out, obfuscated: out !== before };
  }

  // ── URL extraction ────────────────────────────────────────────────
  // Returns [{ raw, host, url, viaMarkdown, label, obfuscated }]. `host` is the
  // normalised hostname a browser would actually connect to, which is the only
  // thing worth making a policy decision about.
  function extractUrls(rawText) {
    if (typeof rawText !== 'string' || !rawText) return [];

    var stripped = rawText.replace(INVISIBLE_RE, '');
    var d = deobfuscate(stripped);
    var text = d.text;
    var obfuscated = d.obfuscated;

    var found = [];
    var seen = {};

    function push(candidate, opts) {
      if (!candidate) return;
      opts = opts || {};
      var u;
      try {
        u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : 'http://' + candidate);
      } catch (e) { return; }

      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;

      var host = normalizeHost(u.hostname);
      if (!host) return;
      if (host.indexOf('.') === -1 && !isIpLiteral(host) && host !== 'localhost') return;

      var key = host + '|' + (opts.label || '');
      if (seen[key]) return;
      seen[key] = true;

      found.push({
        raw: candidate,
        host: host,
        url: u.href,
        viaMarkdown: !!opts.viaMarkdown,
        label: opts.label || '',
        obfuscated: obfuscated || !!opts.obfuscated
      });
    }

    // Markdown links and images. Both the label and the target matter: the
    // label is what the reader sees, so `[youtube.com](https://evil.com)`
    // needs the target checked and the mismatch surfaced separately.
    var MD_RE = /!?\[([^\]]*)\]\(\s*([^\s)]+)\s*\)/g;
    var m;
    while ((m = MD_RE.exec(text)) !== null) push(m[2], { viaMarkdown: true, label: m[1] });
    var withoutMd = text.replace(MD_RE, ' ');

    // Scheme-ful URLs — the ones Haven turns into clickable anchors and inline
    // <img> tags, so they carry all the real risk.
    var SCHEME_RE = /\bhttps?:\/\/[^\s<>"'`\])]+/gi;
    while ((m = SCHEME_RE.exec(withoutMd)) !== null) push(m[0].replace(/[.,;:!?]+$/, ''));
    var withoutScheme = withoutMd.replace(SCHEME_RE, ' ');

    // Bare domains, restricted to the curated TLD list.
    var BARE_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{1,5})?(\/[^\s<>"'`)]*)?/gi;
    while ((m = BARE_RE.exec(withoutScheme)) !== null) {
      var tld = m[2].toLowerCase();
      if (!COMMON_TLDS[tld] && !m[3]) continue;
      push(m[0].replace(/[.,;:!?]+$/, ''));
    }

    return found;
  }

  // Does a markdown label claim a different domain than its target? Purely a
  // display-deception signal; the target is what gets policy-checked.
  function labelLiesAboutTarget(link) {
    if (!link.viaMarkdown || !link.label) return false;
    var labelLinks = extractUrls(link.label);
    if (!labelLinks.length) return false;
    for (var i = 0; i < labelLinks.length; i++) {
      if (labelLinks[i].host !== link.host) return true;
    }
    return false;
  }

  // ── Policy evaluation ─────────────────────────────────────────────
  //
  // policy = {
  //   mode: 'off' | 'allowlist' | 'blocklist',
  //   allow: [{ domain, includeSubdomains }],
  //   deny:  [{ domain, includeSubdomains }],
  //   blockIpUrls, blockPunycode, blockObfuscated   (booleans)
  // }
  //
  // Returns { allowed: bool, reason: string }.
  function checkHost(host, policy) {
    var h = normalizeHost(host);
    if (!h) return { allowed: false, reason: 'unparseable host', reasonKey: 'unparseable_host' };
    if (!policy) return { allowed: true, reason: '' };

    if (lookup(h, policy.deny)) return { allowed: false, reason: 'domain is blocklisted', reasonKey: 'blocklisted' };
    if (lookup(h, policy.allow)) return { allowed: true, reason: '' };

    if (NEVER_ALLOWED_HOSTS[h]) return { allowed: false, reason: 'loopback address', reasonKey: 'loopback' };
    if (isIpLiteral(h) && policy.blockIpUrls !== false) {
      return { allowed: false, reason: 'links to a raw IP address are not allowed', reasonKey: 'raw_ip' };
    }
    // A punycode host nobody has explicitly allowed is a strong signal:
    // legitimate IDN domains exist, but in a chat server the overwhelming
    // majority of unapproved xn-- hosts are homoglyph impersonations.
    if (hasPunycodeLabel(h) && policy.blockPunycode !== false) {
      return { allowed: false, reason: 'internationalized domain that looks like a lookalike', reasonKey: 'lookalike' };
    }
    if (policy.mode === 'allowlist') return { allowed: false, reason: 'domain is not on the allowlist', reasonKey: 'not_allowed' };
    return { allowed: true, reason: '' };
  }

  // Evaluate a whole block of text. Returns null when everything is fine, or
  // the first offending { rule, host, url, message }.
  function checkText(text, policy) {
    if (!policy || policy.mode === 'off') return null;
    var links = extractUrls(text);
    if (!links.length) return null;

    for (var i = 0; i < links.length; i++) {
      var link = links[i];

      if (link.obfuscated && policy.blockObfuscated !== false &&
          !lookup(link.host, policy.allow)) {
        return {
          rule: 'link_obfuscated', host: link.host, url: link.url,
          message: 'That link looks deliberately disguised, so it was blocked.'
        };
      }

      var verdict = checkHost(link.host, policy);
      if (!verdict.allowed) {
        return {
          rule: 'link_blocked', host: link.host, url: link.url, reasonKey: verdict.reasonKey,
          message: 'Links to ' + link.host + ' aren\'t allowed here (' + verdict.reason + ').'
        };
      }

      if (labelLiesAboutTarget(link)) {
        return {
          rule: 'link_masked', host: link.host, url: link.url,
          message: 'That link is labelled as one site but points to ' + link.host + ', so it was blocked.'
        };
      }
    }
    return null;
  }

  return {
    INVISIBLE_RE: INVISIBLE_RE,
    normalizeHost: normalizeHost,
    hostMatches: hostMatches,
    isIpLiteral: isIpLiteral,
    hasPunycodeLabel: hasPunycodeLabel,
    deobfuscate: deobfuscate,
    extractUrls: extractUrls,
    labelLiesAboutTarget: labelLiesAboutTarget,
    checkHost: checkHost,
    checkText: checkText,
    lookup: lookup
  };
}));
