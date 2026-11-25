const td = new TextDecoder(), te = new TextEncoder(), N = Number;
export async function start(o = {}) {
  const url = o.wasm || document.querySelector('script[data-wasm]')?.dataset.wasm || 'app.wasm';
  let closed = false, ex = null, mem = null, busy = 0, cur = null, frames = false, raf = 0, dead = false, gl = null, list = [], obuf = '', ebuf = '';
  const q = [], H = [null, document, window, document.body, document.documentElement], hix = new Map(H.map((v, i) => [v, i])), free = [], fetches = new Map(), jsres = new Map(), timers = new Map(), holes = [];
  hix.delete(null);
  let nid = 1, nfd = 3, G = null, jspi = false, px = {};
  const files = o.files instanceof Map ? o.files : new Map(Object.entries(o.files || {})), fds = new Map(), fb = v => v instanceof Uint8Array ? v : new Uint8Array(v.buffer || v);
  const nh = v => { if (v == null) return 0; const k = hix.get(v); if (k) return k; const i = free.length ? free.pop() : H.length; H[i] = v; hix.set(v, i); return i; };
  const rel = i => { if (i > 4 && H[i] !== undefined) { hix.delete(H[i]); H[i] = undefined; free.push(i); } };
  const u8 = () => new Uint8Array(mem.buffer), dv = () => new DataView(mem.buffer);
  const B = (p, n) => u8().subarray(p, p + n);
  const S = (p, n) => td.decode(B(p, n)), cz = p => { const m = u8(); let e = p; while (m[e]) e++; return td.decode(m.subarray(p, e)); };
  const wst = (p, n) => { u8().fill(0, p, p + 144); dv().setUint32(p + 24, 0o100644, true); dv().setBigInt64(p + 48, BigInt(n), true); };
  const put = (r, v) => { const b = typeof v === 'string' ? te.encode(v) : v, p = ex.he_grow(r, b.length); u8().set(b, p); return b.length; };
  const out = (s, err) => { let b = (err ? ebuf : obuf) + s, i; while ((i = b.indexOf('\n')) >= 0) { { const l = b.slice(0, i); err ? console.error(o.err = l) : console.log(l); } b = b.slice(i + 1); } err ? ebuf = b : obuf = b; };
  const fail = e => { if (closed) return; dead = true; frames = false; if (e && e.helium_exit !== undefined) { e.helium_exit && o.onerror?.(e); return; } console.error('helium trapped:', e); o.onerror?.(e); };
  const run = (f, a) => { if (dead || !ex[f]) return; busy++; let r; try { r = (px[f] || ex[f])(...a); } catch (e) { busy--; fail(e); return; } if (r instanceof Promise) return r.then(v => v, fail).finally(() => { busy--; drain(); }); busy--; return r; };
  const drain = () => { while (!busy && q.length && !dead) { const [f, a, c] = q.shift(); cur = c; run(f, a); cur = null; } };
  const fire = (tag, kind, c) => { q.push(['he_event', [tag, kind], c]); drain(); };
  const evc = () => cur || {};
  const ev = () => evc().e || {};
  const loop = t => { raf = 0; if (!frames || dead) return; if (!busy) { G?.raf(1); run('he_frame', [t]); G?.raf(0); drain(); } if (frames) raf = (o.raf || requestAnimationFrame)(loop); };
  const now = () => performance.now();
  const unmap = (p, l) => { l = Math.ceil(l / 65536) * 65536; if (p % 65536 === 0 && l > 0) holes.push([p, l]); };
  const mmap = len => { len = Math.ceil(len / 65536) * 65536; const k = holes.findIndex(h => h[1] >= len); if (k >= 0) { const [a, l] = holes[k]; if (l === len) holes.splice(k, 1); else holes[k] = [a + len, l - len]; u8().fill(0, a, a + len); return a; } try { return mem.grow(len / 65536) * 65536; } catch { return -12; } };
  const sys = (n, a, b, c, d) => {
    switch (N(n)) {
      case 0: { const f = fds.get(N(a)); if (!f?.b) return -9n; const k = Math.min(N(c), f.b.length - f.o); u8().set(f.b.subarray(f.o, f.o + k), N(b)); f.o += k; return BigInt(k); }
      case 1: { const fd = N(a), f = fds.get(fd); if (f?.w) { f.w.push(B(N(b), N(c)).slice()); return c; } if (fd !== 1 && fd !== 2) return -9n; out(td.decode(B(N(b), N(c))), fd === 2); return c; }
      case 2: { const p = cz(N(a)), fl = N(b); if (fl & 0x10000 || !(fl & 3) && !files.has(p)) return -2n; fds.set(nfd, fl & 3 ? { p, w: fl & 0x400 && files.has(p) ? [fb(files.get(p))] : [] } : { b: fb(files.get(p)), o: 0 }); return BigInt(nfd++); }
      case 3: { const f = fds.get(N(a)); if (!f) return -9n; if (f.w) { const t = new Uint8Array(f.w.reduce((k, x) => k + x.length, 0)); let k = 0; for (const x of f.w) { t.set(x, k); k += x.length; } files.set(f.p, t); o.onsave?.(f.p); } fds.delete(N(a)); return 0n; }
      case 4: { const p = cz(N(a)); if (!files.has(p)) return -2n; wst(N(b), fb(files.get(p)).length); return 0n; }
      case 5: { const f = fds.get(N(a)); if (!f) return -9n; wst(N(b), f.b ? f.b.length : 0); return 0n; }
      case 8: { const f = fds.get(N(a)); if (!f?.b) return -9n; f.o = Math.max(0, Math.min(N(b), f.b.length)); return BigInt(f.o); }
      case 87: return files.delete(cz(N(a))) ? 0n : -2n;
      case 9: return BigInt(mmap(N(b)));
      case 11: unmap(N(a), N(b)); return 0n;
      case 28: { if (N(c) === 4) u8().fill(0, N(a), N(a) + N(b)); return 0n; }
      case 228: { const t = N(a) === 0 ? Date.now() * 1e6 : now() * 1e6, p = N(b), w = dv(); w.setBigInt64(p, BigInt(Math.floor(t / 1e9)), true); w.setBigInt64(p + 8, BigInt(Math.floor(t % 1e9)), true); return 0n; }
      case 318: { const k = N(b), t = new Uint8Array(k); crypto.getRandomValues(t); u8().set(t, N(a)); return b; }
      case 204: { u8().fill(0, N(c), N(c) + 8); u8()[N(c)] = 1; return 8n; }
      case 60: case 231: throw { helium_exit: N(a) };
      case 10: case 13: case 14: case 35: case 131: case 202: return 0n;
      default: return -38n;
    }
  };
  const el = h => H[h];
  const mods = e => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  const loc = { protocol: () => location.protocol, host: () => location.host, hostname: () => location.hostname, pathname: () => location.pathname, search: () => location.search, hash: () => location.hash, href: () => location.href, origin: () => location.origin };
  const finish = (id, tag, rec) => { fetches.set(id, rec); fire(tag, 3, { id, status: rec.status }); };
  const gunzip = async (u, b) => /\.gz(\?|#|$)/.test(u) && b[0] === 0x1f && b[1] === 0x8b && globalThis.DecompressionStream ? new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : b;
  const doFetch = (u, init, tag, ms) => {
    const id = nid++, ctl = new AbortController(), to = ms > 0 ? setTimeout(() => ctl.abort(), ms) : 0;
    (async () => {
      try {
        const r = await fetch(u, { ...init, signal: ctl.signal }), total = +r.headers.get('content-length') || 0;
        if (!r.body || !total) { const b = new Uint8Array(await r.arrayBuffer()); finish(id, tag, { status: r.status, bytes: await gunzip(u, b) }); return; }
        const rd = r.body.getReader(), parts = []; let got = 0, last = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; const t = now(); if (t - last > 70) { last = t; fire(tag, 4, { id, loaded: got, total }); } }
        const b = new Uint8Array(got); let k = 0; for (const p of parts) { b.set(p, k); k += p.length; }
        finish(id, tag, { status: r.status, bytes: await gunzip(u, b) });
      } catch (e) { finish(id, tag, { status: 0, bytes: te.encode(String(e && e.message || e)) }); } finally { clearTimeout(to); }
    })();
    return id;
  };
  const jsv = v => v === null || ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v) || (v && v.constructor === Object);
  const revive = a => Array.isArray(a) ? a.map(revive) : a && typeof a === 'object' ? ('$cb' in a ? (...x) => fire(a.$cb, 6, { json: JSON.stringify(x, (k, v) => typeof v === 'bigint' ? Number(v) : v) }) : '$h' in a ? H[a.$h] : Object.fromEntries(Object.entries(a).map(([k, v]) => [k, revive(v)]))) : a;
  const jsdone = (id, tag, v, err) => { jsres.set(id, err ? { err: String(err && err.message || err) } : jsv(v) ? { json: JSON.stringify(v) } : { h: nh(v) }); fire(tag, 5, { id, status: err ? 0 : 1 }); };
  const path = (o, p) => p.split('.').filter(Boolean).reduce((a, k) => a == null ? a : a[k], o);
  const env = {
    sys,
    he_log: (p, n) => console.log(S(p, n)), he_warn: (p, n) => console.warn(S(p, n)), he_error: (p, n) => console.error(S(p, n)),
    he_now: now, he_epoch_ms: () => Date.now(),
    he_frames: on => { frames = !!on; if (frames && !raf) raf = (o.raf || requestAnimationFrame)(loop); },
    he_timer: (ms, tag) => { const id = nid++; timers.set(id, setTimeout(() => { timers.delete(id); fire(tag, 2, { id }); }, ms)); return id; },
    he_clear_timer: id => { clearTimeout(timers.get(id)); timers.delete(id); },
    he_win_w: () => innerWidth, he_win_h: () => innerHeight, he_dpr: () => devicePixelRatio || 1, he_device_memory: () => navigator.deviceMemory || 0,
    he_user_agent: r => { put(r, navigator.userAgent); }, he_secure: () => isSecureContext ? 1 : 0, he_has_webgpu: () => navigator.gpu ? 1 : 0,
    he_prefers_dark: () => matchMedia('(prefers-color-scheme: dark)').matches ? 1 : 0, he_reduced_motion: () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0,
    he_location: (p, n, r) => { put(r, (loc[S(p, n)] || (() => ''))()); },
    he_param: (p, n, r) => { const v = new URLSearchParams(location.search).get(S(p, n)); if (v == null) return 0; put(r, v); return 1; },
    he_set_url: (p, n, rep) => history[rep ? 'replaceState' : 'pushState'](null, '', S(p, n)), he_navigate: (p, n) => { location.href = S(p, n); }, he_open: (p, n) => { open(S(p, n), '_blank', 'noopener'); },
    he_title: (p, n) => { document.title = S(p, n); }, he_clipboard: (p, n) => { navigator.clipboard?.writeText(S(p, n)).catch(() => {}); },
    he_el: (p, n) => nh(document.getElementById(S(p, n))), he_query: (h, p, n) => nh(el(h)?.querySelector(S(p, n))),
    he_query_all: (h, p, n) => { list = [...(el(h)?.querySelectorAll(S(p, n)) || [])]; return list.length; }, he_list_at: i => nh(list[i]),
    he_create: (p, n) => nh(document.createElement(S(p, n))), he_create_svg: (p, n) => nh(document.createElementNS('http://www.w3.org/2000/svg', S(p, n))),
    he_append: (p, c) => { el(p)?.appendChild(el(c)); }, he_insert_before: (p, c, b) => { el(p)?.insertBefore(el(c), el(b) || null); },
    he_remove: h => el(h)?.remove(), he_release: rel, he_clear: h => { const e = el(h); if (e) e.replaceChildren(); },
    he_parent: h => nh(el(h)?.parentElement), he_closest: (h, p, n) => nh(el(h)?.closest?.(S(p, n))), he_child: (h, i) => nh(el(h)?.children[i]), he_child_count: h => el(h)?.children.length || 0,
    he_contains: (a, b) => el(a)?.contains(el(b)) ? 1 : 0, he_same: (a, b) => el(a) === el(b) ? 1 : 0,
    he_text: (h, p, n) => { const e = el(h); if (e) e.textContent = S(p, n); }, he_html: (h, p, n) => { const e = el(h); if (e) e.innerHTML = S(p, n); },
    he_append_html: (h, p, n) => el(h)?.insertAdjacentHTML('beforeend', S(p, n)), he_get_text: (h, r) => { put(r, el(h)?.textContent || ''); },
    he_attr: (h, a, an, v, vn) => el(h)?.setAttribute(S(a, an), S(v, vn)), he_del_attr: (h, a, an) => el(h)?.removeAttribute(S(a, an)),
    he_get_attr: (h, a, an, r) => { const v = el(h)?.getAttribute(S(a, an)); if (v == null) return 0; put(r, v); return 1; },
    he_style: (h, a, an, v, vn) => { const e = el(h), k = S(a, an); if (e) k.startsWith('--') || k.includes('-') ? e.style.setProperty(k, S(v, vn)) : e.style[k] = S(v, vn); },
    he_cls: (h, a, an, on) => { el(h)?.classList.toggle(S(a, an), !!on); }, he_has_cls: (h, a, an) => el(h)?.classList.contains(S(a, an)) ? 1 : 0,
    he_prop: (h, a, an, v, vn) => { const e = el(h); if (e) e[S(a, an)] = S(v, vn); }, he_prop_num: (h, a, an, v) => { const e = el(h); if (e) e[S(a, an)] = v; }, he_prop_bool: (h, a, an, v) => { const e = el(h); if (e) e[S(a, an)] = !!v; },
    he_get_prop: (h, a, an, r) => { const v = el(h)?.[S(a, an)]; if (v == null) return 0; put(r, String(v)); return 1; },
    he_get_num: (h, a, an) => +(el(h)?.[S(a, an)]) || 0, he_get_bool: (h, a, an) => el(h)?.[S(a, an)] ? 1 : 0,
    he_call: (h, a, an) => { const e = el(h), k = S(a, an); e?.[k]?.call(e); },
    he_scroll_into: (h, sm, c) => el(h)?.scrollIntoView({ behavior: sm ? 'smooth' : 'auto', block: c ? 'center' : 'nearest' }),
    he_rect: (h, p) => { const r = el(h)?.getBoundingClientRect() || { x: 0, y: 0, width: 0, height: 0 }, d = dv(); d.setFloat64(p, r.x, true); d.setFloat64(p + 8, r.y, true); d.setFloat64(p + 16, r.width, true); d.setFloat64(p + 24, r.height, true); },
    he_put_pixels: (h, w, ht, p, n) => { const c = el(h); if (!c || w <= 0 || ht <= 0) return; if (c.width !== w) c.width = w; if (c.height !== ht) c.height = ht; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(B(p, n).slice().buffer), w, ht), 0, 0); },
    he_listen: (h, k, kn, tag, f) => el(h)?.addEventListener(S(k, kn), e => { if (f & 1) e.preventDefault(); if (f & 8) e.stopPropagation(); fire(tag, 1, { e }); }, { passive: !!(f & 2), capture: !!(f & 4) }),
    he_capture_pointer: (h, id) => { try { el(h)?.setPointerCapture(id); } catch {} },
    he_ev_type: r => { put(r, ev().type || ''); }, he_ev_target: () => nh(ev().target),
    he_ev_x: () => ev().clientX ?? ev().touches?.[0]?.clientX ?? 0, he_ev_y: () => ev().clientY ?? ev().touches?.[0]?.clientY ?? 0,
    he_ev_dx: () => ev().deltaX ?? ev().movementX ?? 0, he_ev_dy: () => { const e = ev(); return (e.deltaY ?? e.movementY ?? 0) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1); },
    he_ev_button: () => ev().button ?? -1, he_ev_buttons: () => ev().buttons ?? 0, he_ev_pointer: () => ev().pointerId ?? 0, he_ev_mods: () => mods(ev()),
    he_ev_key: r => { put(r, ev().key || ''); }, he_ev_value: r => { put(r, ev().target?.value ?? ''); }, he_ev_checked: () => ev().target?.checked ? 1 : 0,
    he_ev_touches: () => ev().touches?.length || 0, he_ev_touch_x: i => ev().touches?.[i]?.clientX || 0, he_ev_touch_y: i => ev().touches?.[i]?.clientY || 0,
    he_ev_num: (p, n) => +path(ev(), S(p, n)) || 0, he_ev_str: (p, n, r) => { const v = path(ev(), S(p, n)); if (v == null) return 0; put(r, String(v)); return 1; },
    he_ev_prevent: () => ev().preventDefault?.(), he_ev_stop: () => ev().stopPropagation?.(),
    he_ev_id: () => evc().id || 0, he_ev_status: () => evc().status || 0, he_ev_loaded: () => evc().loaded || 0, he_ev_total: () => evc().total || 0, he_ev_json: r => { put(r, evc().json || ''); },
    he_store_get: (k, kn, r) => { try { const v = localStorage.getItem(S(k, kn)); if (v == null) return 0; put(r, v); return 1; } catch { return 0; } },
    he_store_set: (k, kn, v, vn) => { try { localStorage.setItem(S(k, kn), S(v, vn)); } catch {} }, he_store_del: (k, kn) => { try { localStorage.removeItem(S(k, kn)); } catch {} },
    he_fetch: (u, un, tag) => doFetch(S(u, un), {}, tag, 0),
    he_request: (u, un, m, mn, hj, hn, b, bn, tag, ms) => { const hs = S(hj, hn), body = B(b, bn); return doFetch(S(u, un), { method: S(m, mn), headers: hs ? JSON.parse(hs) : {}, body: body.length ? body.slice() : undefined }, tag, ms); },
    he_fetch_take: (id, r) => { const f = fetches.get(id); if (!f) return 0; put(r, f.bytes); return 1; }, he_fetch_free: id => { fetches.delete(id); },
    he_js_global: (p, n) => nh(path(globalThis, S(p, n))), he_js_get: (h, p, n) => nh(path(H[h], S(p, n))),
    he_js_import: (u, un, tag) => { const id = nid++; import(S(u, un)).then(m => jsdone(id, tag, m), e => jsdone(id, tag, null, e)); return id; },
    he_js_call: (h, m, mn, a, an, tag) => { const id = nid++, o = H[h], ms = S(m, mn), i = ms.lastIndexOf('.'), args = revive(JSON.parse(S(a, an) || '[]')); Promise.resolve().then(() => Reflect.apply(ms ? path(o, ms) : o, i < 0 ? o : path(o, ms.slice(0, i)), args)).then(v => jsdone(id, tag, v), e => jsdone(id, tag, null, e)); return id; },
    he_js_result: (id, r) => { const v = jsres.get(id); if (!v) return 0; put(r, v.json ?? v.err ?? ''); return v.err === undefined ? 1 : 0; }, he_js_handle: id => jsres.get(id)?.h || 0,
    he_gl_init: (c, aa, al) => { gl = el(c)?.getContext('webgl2', { antialias: !!aa, alpha: !!al, premultipliedAlpha: false, preserveDrawingBuffer: false }); return gl ? 1 : 0; },
    he_gl_viewport: (x, y, w, h) => gl.viewport(x, y, w, h), he_gl_clear_color: (r, g, b, a) => gl.clearColor(r, g, b, a), he_gl_clear: m => gl.clear(m),
    he_gl_enable: c => gl.enable(c), he_gl_disable: c => gl.disable(c), he_gl_blend_func: (s, d) => gl.blendFunc(s, d), he_gl_blend_func_sep: (a, b, c, d) => gl.blendFuncSeparate(a, b, c, d),
    he_gl_depth_mask: on => gl.depthMask(!!on), he_gl_depth_func: f => gl.depthFunc(f),
    he_gl_create_shader: k => nh(gl.createShader(k)), he_gl_shader_source: (s, p, n) => gl.shaderSource(H[s], S(p, n)),
    he_gl_compile_shader: s => { gl.compileShader(H[s]); return gl.getShaderParameter(H[s], gl.COMPILE_STATUS) ? 1 : 0; }, he_gl_shader_log: (s, r) => { put(r, gl.getShaderInfoLog(H[s]) || ''); },
    he_gl_create_program: () => nh(gl.createProgram()), he_gl_attach_shader: (p, s) => gl.attachShader(H[p], H[s]), he_gl_bind_attrib: (p, i, a, n) => gl.bindAttribLocation(H[p], i, S(a, n)),
    he_gl_link_program: p => { gl.linkProgram(H[p]); return gl.getProgramParameter(H[p], gl.LINK_STATUS) ? 1 : 0; }, he_gl_program_log: (p, r) => { put(r, gl.getProgramInfoLog(H[p]) || ''); },
    he_gl_use_program: p => gl.useProgram(H[p] || null), he_gl_uniform_loc: (p, a, n) => nh(gl.getUniformLocation(H[p], S(a, n))),
    he_gl_uniform1f: (l, x) => gl.uniform1f(H[l], x), he_gl_uniform2f: (l, x, y) => gl.uniform2f(H[l], x, y), he_gl_uniform3f: (l, x, y, z) => gl.uniform3f(H[l], x, y, z), he_gl_uniform4f: (l, x, y, z, w) => gl.uniform4f(H[l], x, y, z, w),
    he_gl_uniform1i: (l, v) => gl.uniform1i(H[l], v), he_gl_uniform_mat4: (l, p, n) => gl.uniformMatrix4fv(H[l], false, new Float32Array(B(p, n * 4).slice().buffer, 0, 16)),
    he_gl_create_buffer: () => nh(gl.createBuffer()), he_gl_bind_buffer: (t, b) => gl.bindBuffer(t, H[b] || null),
    he_gl_buffer_data: (t, p, n, u) => gl.bufferData(t, B(p, n), u), he_gl_buffer_alloc: (t, n, u) => gl.bufferData(t, n, u), he_gl_buffer_sub: (t, off, p, n) => gl.bufferSubData(t, off, B(p, n)),
    he_gl_create_vao: () => nh(gl.createVertexArray()), he_gl_bind_vao: v => gl.bindVertexArray(H[v] || null),
    he_gl_attrib_ptr: (i, s, k, n, st, off) => gl.vertexAttribPointer(i, s, k, !!n, st, off), he_gl_enable_attrib: i => gl.enableVertexAttribArray(i), he_gl_disable_attrib: i => gl.disableVertexAttribArray(i), he_gl_attrib_divisor: (i, d) => gl.vertexAttribDivisor(i, d),
    he_gl_draw_arrays: (m, f, c) => gl.drawArrays(m, f, c), he_gl_draw_elements: (m, c, k, o) => gl.drawElements(m, c, k, o), he_gl_draw_arrays_instanced: (m, f, c, n) => gl.drawArraysInstanced(m, f, c, n),
    he_gl_create_texture: () => nh(gl.createTexture()), he_gl_bind_texture: (t, x) => gl.bindTexture(t, H[x] || null), he_gl_active_texture: u => gl.activeTexture(u),
    he_gl_tex_rgba: (w, h, p, n) => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, B(p, n)), he_gl_tex_param: (t, n, v) => gl.texParameteri(t, n, v), he_gl_generate_mipmap: t => gl.generateMipmap(t),
    he_gl_delete: h => { const v = H[h]; if (!v || !gl) return; for (const k of ['Buffer', 'Shader', 'Program', 'Texture', 'VertexArray']) if (v instanceof globalThis['WebGL' + k + (k === 'VertexArray' ? 'Object' : '')]) gl['delete' + k](v); rel(h); },
    he_gl_drawing_w: () => gl?.drawingBufferWidth || 0, he_gl_drawing_h: () => gl?.drawingBufferHeight || 0,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10, pow: Math.pow, cbrt: Math.cbrt, hypot: Math.hypot, expm1: Math.expm1, log1p: Math.log1p,
    sinf: Math.sin, cosf: Math.cos, tanf: Math.tan, asinf: Math.asin, acosf: Math.acos, atanf: Math.atan, atan2f: Math.atan2, expf: Math.exp, logf: Math.log, log2f: Math.log2, log10f: Math.log10, powf: Math.pow, cbrtf: Math.cbrt, hypotf: Math.hypot
  };
  const res = await fetch(url), bytes = await res.arrayBuffer(), mod = await WebAssembly.compile(bytes);
  const meta = new Uint8Array(WebAssembly.Module.customSections(mod, 'he.mem')[0] || new ArrayBuffer(5)), pages = meta[0] | meta[1] << 8 | meta[2] << 16 | meta[3] << 24;
  mem = new WebAssembly.Memory({ initial: pages, maximum: 65536, shared: meta[4] === 1 });
  if (WebAssembly.Module.imports(mod).some(i => i.name === 'SDL_CreateGPUDevice')) { G = sdlgpu({ u8, dv, mmap, munmap: unmap, files, canvas: () => o.canvas || document.querySelector('canvas[data-helium]'), canWait: () => jspi, saved: o.onsave, input: o.input }); jspi = !!WebAssembly.Suspending && o.jspi !== false; await G.init(); for (const [k, f] of Object.entries(G.env)) env[k] = jspi && G.waiting.includes(k) ? new WebAssembly.Suspending(f) : f; }
  const imports = { env: new Proxy({ ...env, ...(o.imports || {}), memory: mem }, { get: (t, n) => t[n] || ((...a) => { console.warn('helium: missing import', n, a); return 0; }) }) };
  ex = (await WebAssembly.instantiate(mod, imports)).exports;
  if (jspi) for (const k of ['he_start', 'he_frame', 'he_event']) if (ex[k]) px[k] = WebAssembly.promising(ex[k]);
  const argv = o.args || ['app'], envs = Object.entries(o.env || {}).map(([k, v]) => k + '=' + v), strs = [...argv, ...envs].map(x => te.encode(x + '\0')), hdr = 8 * (argv.length + envs.length + 3), base = mmap(hdr + strs.reduce((k, b) => k + b.length, 0));
  let sq = base + hdr, sw = base; const pw = v => { dv().setBigInt64(sw, BigInt(v), true); sw += 8; };
  pw(argv.length); strs.forEach((b, i) => { if (i === argv.length) pw(0); u8().set(b, sq); pw(sq); sq += b.length; }); if (!envs.length) pw(0); pw(0);
  const done = Promise.resolve(run('he_start', [BigInt(base)]));
  drain();
  return { exports: ex, handle: nh, get: i => H[i], fire, call: (f, ...a) => { const r = busy ? undefined : run(f, a); drain(); return r; }, files, done, mem: () => mem, gpu: () => G?.stats(), alive: () => !dead, close: () => { closed = dead = true; frames = false; raf = 0; G?.close(); } };
}
function sdlgpu(R) {
  const N = Number, td = new TextDecoder(), te = new TextEncoder(), O = new Map(), u8 = R.u8, dv = R.dv, RING = 1 << 20, files = R.files;
  let nid = 1, GL = null, dev = null, info = null, CM = false, err = '', spage = 0, tring = 0, raf = 0, clip = '', textOn = false, focusW = null, inside = false, gx = 0, gy = 0, gb = 0, uev = 0x8000, nfail = 0;
  const evq = [], ring = [], waits = [], bgc = new Map(), sm = {}, bp = {};
  const nh = o => { const i = nid++; O.set(i, o); return BigInt(i); }, g = h => O.get(N(h)), del = h => { O.delete(N(h)); bgc.clear(); };
  const r32 = (p, o) => dv().getUint32(N(p) + o, true), s32 = (p, o) => dv().getInt32(N(p) + o, true), rf = (p, o) => dv().getFloat32(N(p) + o, true), r64 = (p, o) => N(dv().getBigUint64(N(p) + o, true));
  const w32 = (p, o, v) => dv().setInt32(N(p) + o, v, true), wf = (p, o, v) => dv().setFloat32(N(p) + o, v, true), w64 = (p, o, v) => dv().setBigUint64(N(p) + o, BigInt(v), true);
  const cs = p => { p = N(p); if (!p) return ''; const m = u8(); let e = p; while (m[e]) e++; return td.decode(m.subarray(p, e)); };
  const page = () => spage || (spage = R.mmap(65536));
  const cstr = (k, s, cap = 1024) => { const b = te.encode(s).subarray(0, cap - 1), p = page() + k; u8().set(b, p); u8()[p + b.length] = 0; return BigInt(p); };
  const fail = (m, r = 0n) => { err = m; return r; };
  const al = (n, a) => Math.ceil(n / a) * a;
  const F = {}; '2 r8unorm 1,3 rg8unorm 2,4 rgba8unorm 4,8 rgb10a2unorm 4,12 bgra8unorm 4,13 bc1-rgba-unorm 8,15 bc3-rgba-unorm 16,16 bc4-r-unorm 8,17 bc5-rg-unorm 16,18 bc7-rgba-unorm 16,54 bc1-rgba-unorm-srgb 8,56 bc3-rgba-unorm-srgb 16,57 bc7-rgba-unorm-srgb 16,21 r8snorm 1,22 rg8snorm 2,23 rgba8snorm 4,27 r16float 2,28 rg16float 4,29 rgba16float 8,30 r32float 4,31 rg32float 8,32 rgba32float 16,33 rg11b10ufloat 4,34 r8uint 1,35 rg8uint 2,36 rgba8uint 4,37 r16uint 2,38 rg16uint 4,39 rgba16uint 8,40 r32uint 4,41 rg32uint 8,42 rgba32uint 16,43 r8sint 1,44 rg8sint 2,45 rgba8sint 4,46 r16sint 2,47 rg16sint 4,48 rgba16sint 8,49 r32sint 4,50 rg32sint 8,51 rgba32sint 16,52 rgba8unorm-srgb 4,53 bgra8unorm-srgb 4,58 depth16unorm 2,59 depth24plus 4,60 depth32float 4,61 depth24plus-stencil8 4,62 depth32float-stencil8 8'.split(',').forEach(s => { const [k, f, b] = s.split(' '); F[k] = [f, +b]; });
  const VF = [, 'sint32', 'sint32x2', 'sint32x3', 'sint32x4', 'uint32', 'uint32x2', 'uint32x3', 'uint32x4', 'float32', 'float32x2', 'float32x3', 'float32x4', 'sint8x2', 'sint8x4', 'uint8x2', 'uint8x4', 'snorm8x2', 'snorm8x4', 'unorm8x2', 'unorm8x4', 'sint16x2', 'sint16x4', 'uint16x2', 'uint16x4', 'snorm16x2', 'snorm16x4', 'unorm16x2', 'unorm16x4', 'float16x2', 'float16x4'];
  const CMP = [, 'never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'], BF = [, 'zero', 'one', 'src', 'one-minus-src', 'dst', 'one-minus-dst', 'src-alpha', 'one-minus-src-alpha', 'dst-alpha', 'one-minus-dst-alpha', 'constant', 'one-minus-constant', 'src-alpha-saturated'], BO = [, 'add', 'subtract', 'reverse-subtract', 'min', 'max'];
  const dead = []; let live = 0;
  const TOPO = ['triangle-list', 'triangle-strip', 'line-list', 'line-strip', 'point-list'], DIM = ['2d', 'cube', '3d', '2d-array', 'cube-array'], SFMT = { 1: 'rgba32float', 2: 'rgba16float', 3: 'r32float', 4: 'rgba8unorm', 6: 'rg32float', 7: 'rg16float', 9: 'r16float', 32: 'rgba8uint', 33: 'r32uint' };
  const MS = n => n > 0 && !CM ? 4 : 1;
  const sl = (w, i, ps) => { const a = []; let d = 0, st = i; for (; i < w.length; i++) { const c = w[i]; if (c === '(' || c === '[' || ps && c === '<') d++; else if (c === ')' || c === ']' || ps && c === '>' && w[i - 1] !== '-') { if (!d) break; d--; } else if (c === ',' && !d) { a.push(w.slice(st, i)); st = i + 1; } } a.push(w.slice(st, i)); return [a.map(x => x.trim()).filter((x, k, A) => x || k < A.length - 1), i]; };
const sp = w => { const F = {}, GL = new Set([...w.matchAll(/var\s+(\w+)\s*:\s*(?:texture|sampler)\w*/g)].map(x => x[1])), fre = /\bfn\s+(\w+)\s*\(/g; let m; while ((m = fre.exec(w))) { const [pa, e] = sl(w, fre.lastIndex, 1), ps = pa.map(x => [x.split(':')[0].trim(), /:\s*(?:texture|sampler)/.test(x), x]); if (!ps.some(p => p[1])) continue; const b0 = w.indexOf('{', e); let d = 0, i = b0; for (; i < w.length; i++) { if (w[i] === '{') d++; else if (w[i] === '}' && !--d) break; } F[m[1]] = { ps, sig: w.slice(e + 1, b0), body: w.slice(b0, i + 1) }; } const ks = Object.keys(F); if (!ks.length) return w; const nf = new Set(); let ch = true; while (ch) { ch = false; const cre = new RegExp('(?<!fn\\s+)\\b(' + ks.join('|') + ')\\s*\\(', 'g'); let o = '', at = 0, ad = ''; while ((m = cre.exec(w))) { const f = F[m[1]], [a, e] = sl(w, cre.lastIndex, 0); if (a.length !== f.ps.length || f.ps.some((p, k) => p[1] && !GL.has(a[k]))) continue; const key = m[1] + '__' + f.ps.map((p, k) => p[1] ? a[k] : '').filter(Boolean).join('__'); if (!nf.has(key)) { nf.add(key); ch = true; let b = f.body; for (const [k, p] of f.ps.entries()) if (p[1]) b = b.replace(new RegExp('\\b' + p[0] + '\\b', 'g'), a[k]); ad += '\nfn ' + key + '(' + f.ps.filter(p => !p[1]).map(p => p[2]).join(', ') + ')' + f.sig + b; } o += w.slice(at, m.index) + key + '(' + a.filter((x, k) => !f.ps[k][1]).join(', ') + ')'; at = e + 1; cre.lastIndex = at; } w = o + w.slice(at) + ad; } return w; };
const cw = w => { if (!CM) return w; w = sp(w); const cv = new Set(); w = w.replace(/(\w+)\s*:\s*texture_cube_array<f32>/g, (m, n) => (cv.add(n), n + ': texture_cube<f32>')).replaceAll('@interpolate(flat)', '@interpolate(flat, either)'); if (!cv.size) return w; const re = /(textureSample(?:Level|Grad|Bias)?)\(\s*(\w+)\s*,|textureNumLayers\(\s*(\w+)\s*\)/g; let o = '', at = 0, m; while ((m = re.exec(w))) { if (m[3]) { if (cv.has(m[3])) { o += w.slice(at, m.index) + '1'; at = re.lastIndex; } continue; } if (!cv.has(m[2])) continue; let i = m.index + m[1].length + 1, d = 0, st = i; const a = []; for (; i < w.length; i++) { const c = w[i]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') { if (!d) break; d--; } else if (c === ',' && !d) { a.push(w.slice(st, i)); st = i + 1; } } a.push(w.slice(st, i)); a.splice(3, 1); o += w.slice(at, m.index) + m[1] + '(' + a.join(',') + ')'; at = i + 1; re.lastIndex = at; } return o + w.slice(at); };
  const SC = ',,,,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z,1,2,3,4,5,6,7,8,9,0,Return,Escape,Backspace,Tab,Space,-,=,[,],\\,#,;,\',`,{,.,/,CapsLock,F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,F11,F12,PrintScreen,ScrollLock,Pause,Insert,Home,PageUp,Delete,End,PageDown,Right,Left,Down,Up,Numlock,Keypad /,Keypad *,Keypad -,Keypad +,Keypad Enter,Keypad 1,Keypad 2,Keypad 3,Keypad 4,Keypad 5,Keypad 6,Keypad 7,Keypad 8,Keypad 9,Keypad 0,Keypad .,NonUSBackslash,Application,Power,Keypad =,F13,F14,F15,F16,F17,F18,F19,F20,F21,F22,F23,F24'.split(',').map(s => s === '{' ? ',' : s);
  SC[270] = 'AC Back';
  const SCX = { 224: 'Left Ctrl', 225: 'Left Shift', 226: 'Left Alt', 227: 'Left GUI', 228: 'Right Ctrl', 229: 'Right Shift', 230: 'Right Alt', 231: 'Right GUI' }; Object.entries(SCX).forEach(([k, v]) => SC[k] = v);
  const CODE = { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, NumpadDecimal: 99, IntlBackslash: 100, ContextMenu: 101, NumpadEqual: 103, ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231 };
  const scOf = c => CODE[c] ?? (/^Key[A-Z]$/.test(c) ? c.charCodeAt(3) - 61 : /^Digit\d$/.test(c) ? (+c[5] + 9) % 10 + 30 : /^Numpad\d$/.test(c) ? (+c[6] + 9) % 10 + 89 : /^F\d+$/.test(c) ? (+c.slice(1) <= 12 ? 57 + +c.slice(1) : 91 + +c.slice(1)) : 0);
  const keyOf = sc => ({ 40: 13, 41: 27, 42: 8, 43: 9, 44: 32, 76: 127 })[sc] ?? (SC[sc]?.length === 1 ? SC[sc].toLowerCase().charCodeAt(0) : (sc | 0x40000000) >>> 0);
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const png = (w, h, px) => {
    const rl = w * 4 + 1, raw = new Uint8Array(rl * h), nb = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + 5 * nb + 4); let o = 2, a = 1, b = 0;
    for (let y = 0; y < h; y++) raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * rl + 1);
    z[0] = 0x78; z[1] = 1; for (let i = 0; i < nb; i++) { const s = raw.subarray(i * 65535, (i + 1) * 65535), n = s.length; z.set([i === nb - 1 ? 1 : 0, n & 255, n >> 8, ~n & 255, ~n >> 8 & 255], o); z.set(s, o + 5); o += 5 + n; }
    for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; } new DataView(z.buffer).setUint32(o, (b << 16 | a) >>> 0);
    const ch = (t, d) => { const c = new Uint8Array(12 + d.length), q = new DataView(c.buffer); q.setUint32(0, d.length); c.set(te.encode(t), 4); c.set(d, 8); let r = ~0; for (let i = 4; i < 8 + d.length; i++) r = crcT[(r ^ c[i]) & 255] ^ (r >>> 8); q.setUint32(8 + d.length, ~r >>> 0); return c; };
    const hd = new Uint8Array(13), q = new DataView(hd.buffer); q.setUint32(0, w); q.setUint32(4, h); hd.set([8, 6, 0, 0, 0], 8);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', hd), ch('IDAT', z), ch('IEND', new Uint8Array(0))], out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0)); let k = 0; for (const p of parts) { out.set(p, k); k += p.length; } return out;
  };
  const view = (t, dim, mip = 0, nm = t.mips, lay = 0, nl = dim === '2d-array' || dim === 'cube-array' ? t.layers : dim === 'cube' ? 6 : 1) => { const k = `${dim} ${mip} ${nm} ${lay} ${nl}`; let v = t.views.get(k); if (!v) t.views.set(k, v = t.g.createView({ dimension: dim, baseMipLevel: mip, mipLevelCount: nm, baseArrayLayer: dim === '3d' ? 0 : lay, arrayLayerCount: dim === '3d' ? 1 : nl, aspect: t.f.startsWith('depth') ? 'depth-only' : 'all' })); return v; };
  const att = (t, mip, lay) => t.d3 ? view(t, '3d', mip, 1) : view(t, '2d', mip, 1, lay, 1);
  const chunk = () => ring.pop() || { g: dev.createBuffer({ size: RING, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), cpu: new Uint8Array(RING), id: nid++, used: 0 };
  const cmd = () => ({ enc: dev.createCommandEncoder(), ub: [], cur: null, off: 0, push: [[], [], []], st: [], downs: [] });
  const stage = (c, n) => { const b = dev.createBuffer({ size: al(Math.max(n, 4), 4), usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, mappedAtCreation: true }); c.st.push(b); return [b, new Uint8Array(b.getMappedRange())]; };
  const submit = c => {
    if (!dev || !c) return Promise.resolve();
    for (const k of c.ub) dev.queue.writeBuffer(k.g, 0, k.cpu, 0, al(k.used, 4));
    dev.queue.submit([c.enc.finish()]); ring.push(...c.ub); for (const b of c.st) b.destroy(); if (--live <= 0) { live = 0; for (const b of dead.splice(0)) b.destroy(); }
    for (const d of c.downs) d.p = d.buf.mapAsync(GPUMapMode.READ).then(() => { d.ok = 1; }, e => { d.ok = 2; err = String(e); });
    const p = Promise.all([dev.queue.onSubmittedWorkDone(), ...c.downs.map(d => d.p)]); waits.push(p); p.then(() => waits.splice(waits.indexOf(p), 1)); return p;
  };
  const blob = (p, n) => {
    const b = u8().slice(N(p), N(p) + N(n)), q = new DataView(b.buffer), u16 = i => q.getUint16(i, true), u32 = i => q.getUint32(i, true);
    if (td.decode(b.subarray(0, 4)) !== 'GSHD' || u16(4) !== 2) return null;
    const s = { stage: b[6], n: [20, 22, 24, 26, 28, 30].map(u16), wgsl: td.decode(b.subarray(u32(56), u32(56) + u32(60))), usz: [], binds: [], dims: {} }, go = u32(56) + u32(60) + 1; let o = 68; s.gl = td.decode(b.subarray(go, go + 4)) === 'GLES' ? td.decode(b.subarray(go + 4, b.indexOf(0, go + 4) < 0 ? b.length : b.indexOf(0, go + 4))) : '';
    for (let k = 0; k < s.n[5]; k++, o += 4) s.usz.push(u32(o));
    o += 2 * b[7]; for (let k = u16(64); k > 0; k--, o += 4) s.binds.push({ group: b[o], binding: b[o + 1], kind: b[o + 2], info: b[o + 3] });
    for (const [, gr, bi, d] of s.wgsl.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var\s*\w+\s*:\s*texture_storage_(2d_array|2d|3d)/g)) s.dims[gr + ' ' + bi] = d.replace('_', '-');
    s.nofilt = new Set([...s.wgsl.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var\s+(\w+)\s*:\s*texture_(?:2d|2d_array|3d|cube|cube_array)<f32>/g)].filter(([, , , v]) => !new RegExp(`\\b${v}\\s*,\\s*(${[...s.wgsl.matchAll(/(\w+)\s*:\s*sampler\b/g)].map(x => x[1]).join('|') || '\\B\\b'})\\b`).test(s.wgsl)).map(([, gr, bi]) => gr + ' ' + bi));
    return s;
  };
  const role = (b, sh, comp) => {
    const x = b.binding >> 1, [nsmp, nstro, nstrw] = sh.n;
    if (b.kind === 1) return ['u', b.info];
    if (comp && b.group === 1) return b.kind >= 9 ? ['rwt', x] : ['rwb', x - nstrw];
    return b.kind >= 4 && b.kind <= 8 ? ['smp', x] : b.kind >= 9 ? ['stx', x - nsmp] : ['sbuf', x - nsmp - nstro];
  };
  const layout = shs => {
    const G = [], vis = [GPUShaderStage.VERTEX, GPUShaderStage.FRAGMENT, GPUShaderStage.COMPUTE], comp = shs[0].stage === 2;
    for (const sh of shs) for (const b of sh.binds) {
      const k = b.kind, e = { binding: b.binding, visibility: vis[sh.stage] }, [src, slot] = role(b, sh, comp);
      if (k <= 3) e.buffer = { type: ['uniform', 'read-only-storage', 'storage'][k - 1], hasDynamicOffset: k === 1 }; else if (k <= 6) e.texture = { sampleType: k === 4 && sh.nofilt?.has(b.group + ' ' + b.binding) ? 'unfilterable-float' : ['float', 'uint', 'depth'][k - 4], viewDimension: CM && DIM[b.info] === 'cube-array' ? 'cube' : DIM[b.info] }; else if (k <= 8) e.sampler = { type: k === 7 ? 'filtering' : 'comparison' }; else e.storageTexture = { access: ['write-only', 'read-only', 'read-write'][k - 9], format: SFMT[b.info], viewDimension: sh.dims[b.group + ' ' + b.binding] || '2d' };
      (G[b.group] ||= { ents: [], es: [] }).ents.push({ ...b, st: sh.stage, src, slot, size: k === 1 ? sh.usz[b.info] : 0, dim: e.texture?.viewDimension || e.storageTexture?.viewDimension }); G[b.group].es.push(e);
    }
    const n = G.length, gs = []; for (let i = 0; i < n; i++) { const x = G[i] || { ents: [], es: [] }; x.ents.sort((a, b) => a.binding - b.binding); x.es.sort((a, b) => a.binding - b.binding); x.lay = dev.createBindGroupLayout({ entries: x.es }); x.id = nid++; gs.push(x); }
    return { gs, pl: dev.createPipelineLayout({ bindGroupLayouts: gs.map(x => x.lay) }) };
  };
  const bind = pa => {
    const pl = pa.pipe; if (!pl) return false;
    for (let i = 0; i < pl.gs.length; i++) {
      const G = pl.gs[i], ents = [], dyn = []; let key = G.id + '', ok = true;
      for (const b of G.ents) {
        const S = pa.st[b.st], c = pa.c; let r;
        if (b.src === 'u') { const u = c.push[b.st][b.slot]; if (!u) { ok = false; break; } r = { buffer: u.k.g, offset: 0, size: b.size }; dyn.push(u.off); key += ' u' + u.k.id; }
        else if (b.src === 'smp') { const s = S.smp[b.slot]; if (!s) { ok = false; break; } r = b.kind <= 6 ? view(s.t, b.dim) : s.s.g; key += ' ' + s.t.id + ':' + s.s.id; }
        else if (b.src === 'stx' || b.src === 'rwt') { const t = S[b.src][b.slot]; if (!t) { ok = false; break; } r = t.v ? t.v(b.dim) : view(t, b.dim, 0, 1); key += ' t' + t.id; }
        else { const s = S[b.src][b.slot]; if (!s) { ok = false; break; } r = { buffer: s.g }; key += ' b' + s.id; }
        ents.push({ binding: b.binding, resource: r });
      }
      if (!ok) return !!fail('a draw or dispatch reads a resource that is not bound', 0);
      let bg = bgc.get(key); if (!bg) bgc.set(key, bg = dev.createBindGroup({ layout: G.lay, entries: ents }));
      if (pa.bk[i] !== key || dyn.length) { pa.e.setBindGroup(i, bg, dyn); pa.bk[i] = key; }
    }
    return true;
  };
  const tex = (u, f, ty, w, h, l, m, s) => {
    const [fmt, bs] = F[f] || [], ms = MS(s), us = (u & 1 ? GPUTextureUsage.TEXTURE_BINDING : 0) | (u & 6 ? GPUTextureUsage.RENDER_ATTACHMENT : 0) | (u & 120 ? GPUTextureUsage.STORAGE_BINDING : 0) | (ms > 1 ? 0 : GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);
    if (!fmt) return fail(`texture format ${f} has no WebGPU match`);
    return nh({ g: dev.createTexture({ size: [w, h, ty === 3 ? 6 : l], dimension: ty === 2 ? '3d' : '2d', format: fmt, mipLevelCount: m, sampleCount: ms, usage: us, ...(CM ? { textureBindingViewDimension: ty === 2 ? '3d' : ty === 3 || ty === 4 && l === 6 ? 'cube' : ty === 1 || ty === 4 || l > 1 ? '2d-array' : '2d' } : {}) }), bd: CM ? (ty === 2 ? '3d' : ty === 3 || ty === 4 && l === 6 ? 'cube' : ty === 1 || ty === 4 || l > 1 ? '2d-array' : '2d') : '', f: fmt, bs, w, h, layers: ty === 2 ? 1 : ty === 3 ? 6 : l, depth: ty === 2 ? l : 1, mips: m, d3: ty === 2, views: new Map(), id: nid++ });
  };
  const blitter = (f, sd = '2d') => bp[f + sd] || (bp[f + sd] = (() => { const m = dev.createShaderModule({ code: `struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }\n@group(0) @binding(0) var t: ${sd === 'cube' ? 'texture_cube<f32>' : sd === '2d-array' ? 'texture_2d_array<f32>' : 'texture_2d<f32>'};\n@group(0) @binding(1) var s: sampler;\n@group(0) @binding(2) var<uniform> r: array<vec4f, 2>;\n@vertex fn vs(@builtin(vertex_index) i: u32) -> V { let q = vec2f(f32(i & 1u) * 2.0, f32(i >> 1u) * 2.0); return V(vec4f(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0), mix(r[0].xy, r[0].zw, q)); }\n@fragment fn fs(v: V) -> @location(0) vec4f { ${sd === 'cube' ? 'let c = v.uv * 2.0 - 1.0; let k = i32(r[1].x); var d = vec3f(1.0, -c.y, -c.x); if (k == 1) { d = vec3f(-1.0, -c.y, c.x); } else if (k == 2) { d = vec3f(c.x, 1.0, c.y); } else if (k == 3) { d = vec3f(c.x, -1.0, -c.y); } else if (k == 4) { d = vec3f(c.x, -c.y, 1.0); } else if (k == 5) { d = vec3f(-c.x, -c.y, -1.0); } return textureSampleLevel(t, s, d, 0.0);' : sd === '2d-array' ? 'return textureSampleLevel(t, s, v.uv, i32(r[1].x), 0.0);' : 'return textureSampleLevel(t, s, v.uv, 0.0);'} }` }); return dev.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: f }] }, primitive: { topology: 'triangle-list' } }); })());
  const blit = (c, s, smip, slay, sx, sy, sw, sh, d, dmip, dlay, dx, dy, dw, dh, lin, flip, load, clr) => {
    const sd = CM && s.bd && s.bd !== '2d' && s.bd !== '3d' ? s.bd : '2d', p = blitter(d.f, sd), mw = Math.max(1, s.w >> smip), mh = Math.max(1, s.h >> smip), r = [sx / mw, sy / mh, (sx + sw) / mw, (sy + sh) / mh, slay, 0, 0, 0], ub = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    if (flip & 1) [r[0], r[2]] = [r[2], r[0]]; if (flip & 2) [r[1], r[3]] = [r[3], r[1]];
    new Float32Array(ub.getMappedRange()).set(r); ub.unmap(); c.st.push(ub);
    const smp = sm[lin] || (sm[lin] = dev.createSampler({ minFilter: lin ? 'linear' : 'nearest', magFilter: lin ? 'linear' : 'nearest' })), dw0 = Math.max(1, d.w >> dmip), dh0 = Math.max(1, d.h >> dmip);
    const e = c.enc.beginRenderPass({ colorAttachments: [{ view: att(d, dmip, dlay), loadOp: load === 1 || load === 2 && !dx && !dy && dw === dw0 && dh === dh0 ? 'clear' : 'load', clearValue: clr, storeOp: 'store' }] });
    e.setPipeline(p); e.setBindGroup(0, dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: sd === '2d' ? view(s, '2d', smip, 1, slay, 1) : view(s, sd, smip, 1, 0, sd === 'cube' ? 6 : s.layers) }, { binding: 1, resource: smp }, { binding: 2, resource: { buffer: ub } }] })); e.setViewport(dx, dy, dw, dh, 0, 1); e.draw(3); e.end();
  };
  const win = h => g(h)?.cv ? g(h) : null;
  const ev = (t, wid = 1) => { const b = new Uint8Array(128), q = new DataView(b.buffer); q.setUint32(0, t, true); q.setBigUint64(8, BigInt(Math.round(performance.now() * 1e6)), true); q.setUint32(16, wid, true); evq.push(b); return q; };
  const fit = W => {
    const cv = W.cv, d = W.f & 8192 ? devicePixelRatio || 1 : 1, cw = cv.clientWidth || W.w, ch = cv.clientHeight || W.h, pw = Math.max(1, Math.round(cw * d)), ph = Math.max(1, Math.round(ch * d));
    if (cw !== W.w || ch !== W.h) { W.w = cw; W.h = ch; const q = ev(518); q.setInt32(20, cw, true); q.setInt32(24, ch, true); }
    if (pw !== cv.width || ph !== cv.height) { cv.width = pw; cv.height = ph; const q = ev(519); q.setInt32(20, pw, true); q.setInt32(24, ph, true); }
  };
  const listen = W => {
    const cv = W.cv, at = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }, mine = e => e.target === cv || e.target === document.body || e.target === document.documentElement;
    const L = [[cv, 'pointermove', e => { const [x, y] = at(e); gx = e.clientX; gy = e.clientY; if (e.pointerType === 'touch') { const q = ev(1794); finger(q, e, x, y); return; } const q = ev(1024); q.setUint32(24, e.buttons, true); q.setFloat32(28, x, true); q.setFloat32(32, y, true); q.setFloat32(36, e.movementX, true); q.setFloat32(40, e.movementY, true); }],
      [cv, 'pointerdown', e => { cv.focus?.(); const [x, y] = at(e); if (e.pointerType === 'touch') { finger(ev(1792), e, x, y); return; } gb |= 1 << e.button; const q = ev(1025); q.setUint8(24, [1, 2, 3, 4, 5][e.button] || 1); q.setUint8(25, 1); q.setUint8(26, e.detail || 1); q.setFloat32(28, x, true); q.setFloat32(32, y, true); }],
      [cv, 'pointerup', e => { const [x, y] = at(e); if (e.pointerType === 'touch') { finger(ev(1793), e, x, y); return; } gb &= ~(1 << e.button); const q = ev(1026); q.setUint8(24, [1, 2, 3, 4, 5][e.button] || 1); q.setUint8(26, e.detail || 1); q.setFloat32(28, x, true); q.setFloat32(32, y, true); }],
      [cv, 'pointercancel', e => { if (e.pointerType === 'touch') finger(ev(1795), e, ...at(e)); }],
      [cv, 'wheel', e => { e.preventDefault(); const k = e.deltaMode ? 1 : 0.01, [x, y] = at(e), q = ev(1027); q.setFloat32(24, -e.deltaX * k, true); q.setFloat32(28, -e.deltaY * k, true); q.setFloat32(36, x, true); q.setFloat32(40, y, true); }],
      [cv, 'pointerenter', () => { inside = true; ev(524); }], [cv, 'pointerleave', () => { inside = false; ev(525); }], [cv, 'contextmenu', e => e.preventDefault()],
      [window, 'focus', () => ev(526)], [window, 'blur', () => ev(527)], [document, 'paste', e => { clip = e.clipboardData?.getData('text') ?? clip; }],
      [window, 'keydown', e => { if (!mine(e)) return; const sc = scOf(e.code); if (sc) { e.preventDefault(); key(768, sc, e); } if (textOn && e.key.length === 1 && !e.ctrlKey && !e.metaKey) { const p = page() + 8192 + (tring++ & 31) * 256, b = te.encode(e.key).subarray(0, 255); u8().set(b, p); u8()[p + b.length] = 0; ev(771).setBigUint64(24, BigInt(p), true); } }],
      [window, 'keyup', e => { if (!mine(e)) return; const sc = scOf(e.code); if (sc) { e.preventDefault(); key(769, sc, e); } }]];
    if (R.input !== false) for (const [t, k, f] of L) t.addEventListener(k, f, { passive: k !== 'wheel' && k !== 'keydown' && k !== 'keyup' && k !== 'contextmenu' });
    W.off = () => { for (const [t, k, f] of L) t.removeEventListener(k, f); };
  };
  const key = (t, sc, e) => { const q = ev(t); q.setUint32(24, sc, true); q.setUint32(28, keyOf(sc), true); q.setUint16(32, (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 0x40 : 0) | (e.altKey ? 0x100 : 0) | (e.metaKey ? 0x400 : 0), true); q.setUint8(36, t === 768 ? 1 : 0); q.setUint8(37, e.repeat ? 1 : 0); };
  const finger = (q, e, x, y) => { const W = focusW; q.setBigUint64(16, 1n, true); q.setBigUint64(24, BigInt(e.pointerId), true); q.setFloat32(32, x / (W?.w || 1), true); q.setFloat32(36, y / (W?.h || 1), true); q.setFloat32(48, e.pressure, true); q.setUint32(52, 1, true); };
  const nextFrame = () => new Promise(r => requestAnimationFrame(r));
  const env = {
    SDL_InitSubSystem: () => 1, SDL_QuitSubSystem: () => {}, SDL_SetHint: () => 1, SDL_ResetHint: () => 1, SDL_GetError: () => cstr(0, err), SDL_free: () => {},
    SDL_CreateGPUDevice: () => dev ? nh({ dev }) : fail('no WebGPU device: ' + (err || (navigator.gpu ? 'no adapter' : 'this browser has no WebGPU'))),
    SDL_GetGPUShaderFormats: () => 64, SDL_GetGPUDeviceDriver: () => cstr(1024, 'webgpu'), SDL_DestroyGPUDevice: h => del(h),
    SDL_GPUTextureSupportsFormat: (d, f, t, u) => F[f] && (!F[f][0].startsWith('bc') || u === 1 && dev.features.has('texture-compression-bc')) && (!(u & 120) || /^(rgba8(unorm|snorm|uint|sint)|(rgba16|rgba32|r32|rg32)(float|uint|sint))$/.test(F[f][0])) && (!(u & 4) || F[f][0].startsWith('depth')) ? 1 : 0,
    SDL_GPUTextureFormatTexelBlockSize: f => F[f]?.[1] || 0,
    SDL_CreateGPUTexture: (d, p) => tex(r32(p, 8), s32(p, 4), s32(p, 0), r32(p, 12), r32(p, 16), r32(p, 20), r32(p, 24), s32(p, 28)),
    SDL_ReleaseGPUTexture: (d, h) => { const t = g(h); if (t && !t.sw) { dead.push(t.g); del(h); } },
    SDL_CreateGPUSampler: (d, p) => { const fl = ['nearest', 'linear'], A = ['repeat', 'mirror-repeat', 'clamp-to-edge'], mi = s32(p, 0), ma = s32(p, 4), mm = s32(p, 8), an = u8()[N(p) + 44] && mi && ma && mm ? Math.min(16, Math.max(1, Math.floor(rf(p, 28)))) : 1; return nh({ g: dev.createSampler({ minFilter: fl[mi], magFilter: fl[ma], mipmapFilter: fl[mm], addressModeU: A[s32(p, 12)], addressModeV: A[s32(p, 16)], addressModeW: A[s32(p, 20)], lodMinClamp: rf(p, 36), lodMaxClamp: rf(p, 40), compare: u8()[N(p) + 45] ? CMP[s32(p, 32)] : undefined, maxAnisotropy: an }), id: nid++ }); },
    SDL_ReleaseGPUSampler: (d, h) => del(h),
    SDL_CreateGPUBuffer: (d, p) => { const u = r32(p, 0), B = GPUBufferUsage; return nh({ g: dev.createBuffer({ size: al(r32(p, 4), 4), usage: (u & 1 ? B.VERTEX : 0) | (u & 2 ? B.INDEX : 0) | (u & 4 ? B.INDIRECT : 0) | (u & 56 ? B.STORAGE : 0) | B.COPY_SRC | B.COPY_DST }), id: nid++ }); },
    SDL_ReleaseGPUBuffer: (d, h) => { const t = g(h); if (t) dead.push(t.g); del(h); },
    SDL_CreateGPUTransferBuffer: (d, p) => { const n = r32(p, 4), a = R.mmap(n); return a < 0 ? fail('out of memory for a transfer buffer') : nh({ up: r32(p, 0) === 0, n, ptr: a, downs: [] }); },
    SDL_ReleaseGPUTransferBuffer: (d, h) => { const t = g(h); if (!t) return; R.munmap(t.ptr, t.n); for (const x of t.downs) x.buf.destroy(); O.delete(N(h)); },
    SDL_MapGPUTransferBuffer: (d, h) => { const t = g(h); if (!t) return 0n; t.downs = t.downs.filter(x => { if (x.ok !== 1) return true; const m = new Uint8Array(x.buf.getMappedRange()), o = u8(); for (let r = 0; r < x.rows; r++) o.set(m.subarray(r * x.ar, r * x.ar + x.row), t.ptr + x.off + r * x.prow); x.buf.unmap(); x.buf.destroy(); return false; }); return BigInt(t.ptr); },
    SDL_UnmapGPUTransferBuffer: () => {},
    SDL_AcquireGPUCommandBuffer: () => { if (!dev) return fail('gfx: no device'); live++; return nh(cmd()); },
    SDL_SubmitGPUCommandBuffer: c => { submit(g(c)); O.delete(N(c)); return 1; },
    SDL_SubmitGPUCommandBufferAndAcquireFence: c => { const f = { done: false }; f.p = submit(g(c)).then(() => { f.done = true; }); O.delete(N(c)); return nh(f); },
    SDL_CancelGPUCommandBuffer: c => { const C = g(c); if (C) { for (const b of C.st) b.destroy(); ring.push(...C.ub); live = Math.max(0, live - 1); } O.delete(N(c)); return 1; },
    SDL_WaitForGPUFences: (d, all, p, n) => { const fs = []; for (let i = 0; i < n; i++) { const f = g(r64(p, 8 * i)); if (f && !f.done) fs.push(f.p); } return fs.length && R.canWait() ? (all ? Promise.all(fs) : Promise.race(fs)).then(() => 1) : 1; },
    SDL_ReleaseGPUFence: (d, f) => { O.delete(N(f)); }, SDL_WaitForGPUIdle: () => R.canWait() && dev ? Promise.all([dev.queue.onSubmittedWorkDone(), ...waits]).then(() => 1) : 1,
    SDL_BeginGPUCopyPass: c => nh({ c: g(c) }), SDL_EndGPUCopyPass: p => { O.delete(N(p)); },
    SDL_UploadToGPUBuffer: (cp, s, d) => { const c = g(cp).c, t = g(r64(s, 0)), b = g(r64(d, 0)), n = r32(d, 12), [sb, m] = stage(c, n); m.set(u8().subarray(t.ptr + r32(s, 8), t.ptr + r32(s, 8) + n)); sb.unmap(); c.enc.copyBufferToBuffer(sb, 0, b.g, r32(d, 8), al(n, 4)); },
    SDL_DownloadFromGPUBuffer: (cp, s, d) => { const c = g(cp).c, b = g(r64(s, 0)), t = g(r64(d, 0)), n = r32(s, 12), rb = dev.createBuffer({ size: al(n, 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); c.enc.copyBufferToBuffer(b.g, r32(s, 8), rb, 0, al(n, 4)); const x = { buf: rb, off: r32(d, 8), row: n, ar: 0, rows: 1, prow: 0 }; t.downs.push(x); c.downs.push(x); },
    SDL_UploadToGPUTexture: (cp, s, d) => { const c = g(cp).c, t = g(r64(s, 0)), x = g(r64(d, 0)), k = x.f.startsWith('bc') ? 4 : 1, w = Math.ceil(r32(d, 28) / k), h = Math.ceil(r32(d, 32) / k), dp = r32(d, 36), row = w * x.bs, ar = al(row, 256), prow = (k > 1 ? w : r32(s, 12) || w) * x.bs, rows = h * dp, src = t.ptr + r32(s, 8), [sb, m] = stage(c, ar * rows), o = u8(); for (let r = 0; r < rows; r++) m.set(o.subarray(src + r * prow, src + r * prow + row), r * ar); sb.unmap(); c.enc.copyBufferToTexture({ buffer: sb, bytesPerRow: ar, rowsPerImage: h }, { texture: x.g, mipLevel: r32(d, 8), origin: [r32(d, 16), r32(d, 20), x.d3 ? r32(d, 24) : r32(d, 12)] }, [w * k, h * k, dp]); },
    SDL_DownloadFromGPUTexture: (cp, s, d) => { const c = g(cp).c, x = g(r64(s, 0)), t = g(r64(d, 0)), w = r32(s, 28), h = r32(s, 32), dp = r32(s, 36), row = w * x.bs, ar = al(row, 256), rb = dev.createBuffer({ size: ar * h * dp, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); c.enc.copyTextureToBuffer({ texture: x.g, mipLevel: r32(s, 8), origin: [r32(s, 16), r32(s, 20), x.d3 ? r32(s, 24) : r32(s, 12)] }, { buffer: rb, bytesPerRow: ar, rowsPerImage: h }, [w, h, dp]); const q = { buf: rb, off: r32(d, 8), row, ar, rows: h * dp, prow: (r32(d, 12) || w) * x.bs }; t.downs.push(q); c.downs.push(q); },
    SDL_CreateGPUShader: (d, p) => { if (r32(p, 24) !== 64) return fail('gfx on the web takes WGSL shaders (format 64)'); const s = blob(r64(p, 8), r64(p, 0)); if (!s) return fail('not a version 2 shader blob'); if (!s.wgsl) return fail('this shader has no WGSL (hc --wgsl on it names the reason)'); s.mod = dev.createShaderModule({ code: cw(s.wgsl) }); return nh(s); },
    SDL_ReleaseGPUShader: (d, h) => { O.delete(N(h)); },
    SDL_CreateGPUGraphicsPipeline: (d, p) => {
      const vs = g(r64(p, 0)), fs = g(r64(p, 8)), bufs = [], tg = [], L = layout([vs, fs]), m = u8(), q = N(p);
      for (let i = 0; i < r32(p, 24); i++) { const b = r64(p, 16) + 16 * i; bufs[r32(b, 0)] = { arrayStride: r32(b, 4), stepMode: s32(b, 8) ? 'instance' : 'vertex', attributes: [] }; }
      for (let i = 0; i < r32(p, 40); i++) { const a = r64(p, 32) + 16 * i; bufs[r32(a, 4)]?.attributes.push({ shaderLocation: r32(a, 0), format: VF[s32(a, 8)], offset: r32(a, 12) }); }
      for (let i = 0; i < r32(p, 144); i++) { const c = r64(p, 136) + 36 * i, eb = m[c + 29]; tg.push({ format: F[s32(c, 0)][0], writeMask: m[c + 30] ? m[c + 28] : 15, blend: eb ? { color: { srcFactor: BF[s32(c, 4)], dstFactor: BF[s32(c, 8)], operation: BO[s32(c, 12)] }, alpha: { srcFactor: BF[s32(c, 16)], dstFactor: BF[s32(c, 20)], operation: BO[s32(c, 24)] } } : undefined }); }
      for (let i = 0; i < bufs.length; i++) bufs[i] ||= null;
      const prim = s32(p, 48), ds = m[q + 152] ? { format: F[s32(p, 148)][0], depthWriteEnabled: !!m[q + 131], depthCompare: m[q + 130] ? CMP[s32(p, 92)] : 'always', depthBias: m[q + 76] ? Math.round(rf(p, 64)) : 0, depthBiasSlopeScale: m[q + 76] ? rf(p, 72) : 0, depthBiasClamp: m[q + 76] ? rf(p, 68) : 0 } : undefined;
      return nh({ g: dev.createRenderPipeline({ layout: L.pl, vertex: { module: vs.mod, entryPoint: 'main', buffers: bufs }, fragment: { module: fs.mod, entryPoint: 'main', targets: tg }, primitive: { topology: TOPO[prim], cullMode: ['none', 'front', 'back'][s32(p, 56)], frontFace: s32(p, 60) ? 'cw' : 'ccw', stripIndexFormat: prim === 1 || prim === 3 ? 'uint32' : undefined }, depthStencil: ds, multisample: { count: MS(s32(p, 80)), alphaToCoverageEnabled: !!m[q + 89] && MS(s32(p, 80)) > 1 } }), gs: L.gs });
    },
    SDL_ReleaseGPUGraphicsPipeline: (d, h) => del(h),
    SDL_CreateGPUComputePipeline: (d, p) => { if (r32(p, 24) !== 64) return fail('gfx on the web takes WGSL shaders (format 64)'); const s = blob(r64(p, 8), r64(p, 0)); if (!s || !s.wgsl) return fail('a compute shader with no WGSL'); const L = layout([s]); return nh({ g: dev.createComputePipeline({ layout: L.pl, compute: { module: dev.createShaderModule({ code: cw(s.wgsl) }), entryPoint: 'main' } }), gs: L.gs }); },
    SDL_ReleaseGPUComputePipeline: (d, h) => del(h),
    SDL_BeginGPURenderPass: (c, ct, n, dt) => {
      const C = g(c), ca = [], rs = []; let w = 0, h = 0, ds;
      for (let i = 0; i < n; i++) { const p = N(ct) + 64 * i, t = g(r64(p, 0)), mip = r32(p, 8), lay = r32(p, 12), ld = s32(p, 32), so = s32(p, 36), rt = r64(p, 40); w = Math.max(1, t.w >> mip); h = Math.max(1, t.h >> mip); const sr = rt && t.g.sampleCount === 1; if (sr) rs.push([t, mip, lay, g(rt), r32(p, 48), r32(p, 52)]); ca.push({ view: att(t, mip, lay), depthSlice: t.d3 ? lay : undefined, loadOp: ld === 0 ? 'load' : 'clear', clearValue: [rf(p, 16), rf(p, 20), rf(p, 24), rf(p, 28)], storeOp: !sr && (so === 1 || so === 2) ? 'discard' : 'store', resolveTarget: rt && !sr ? att(g(rt), r32(p, 48), r32(p, 52)) : undefined }); }
      if (dt) { const p = N(dt), t = g(r64(p, 0)), m = u8(), mip = m[p + 30]; w = Math.max(1, t.w >> mip); h = Math.max(1, t.h >> mip); ds = { view: att(t, mip, m[p + 31]), depthClearValue: rf(p, 8), depthLoadOp: s32(p, 12) === 0 ? 'load' : 'clear', depthStoreOp: s32(p, 16) === 1 ? 'discard' : 'store', ...(t.f.includes('stencil') ? { stencilLoadOp: s32(p, 20) === 0 ? 'load' : 'clear', stencilStoreOp: s32(p, 24) === 1 ? 'discard' : 'store', stencilClearValue: m[p + 29] } : {}) }; }
      return nh({ c: C, e: C.enc.beginRenderPass({ colorAttachments: ca, depthStencilAttachment: ds }), rs, w, h, bk: [], st: [0, 1, 2].map(() => ({ smp: [], stx: [], sbuf: [], rwt: [], rwb: [] })) });
    },
    SDL_EndGPURenderPass: p => { const P = g(p); P?.e.end(); for (const [a, am, al, b, bm, bl] of P?.rs || []) P.c.enc.copyTextureToTexture({ texture: a.g, mipLevel: am, origin: [0, 0, al] }, { texture: b.g, mipLevel: bm, origin: [0, 0, bl] }, [Math.max(1, a.w >> am), Math.max(1, a.h >> am), 1]); O.delete(N(p)); },
    SDL_BeginGPUComputePass: (c, tp, nt, bp, nb) => { const C = g(c), S = { smp: [], stx: [], sbuf: [], rwt: [], rwb: [] }; for (let i = 0; i < nt; i++) { const q = N(tp) + 24 * i, t = g(r64(q, 0)), mip = r32(q, 8), lay = r32(q, 12); S.rwt[i] = { id: `${t.id}.${mip}.${lay}`, v: dim => view(t, dim, mip, 1, dim === '2d' ? lay : 0) }; } for (let i = 0; i < nb; i++) S.rwb[i] = g(r64(bp, 16 * i)); return nh({ c: C, e: C.enc.beginComputePass(), bk: [], st: [S, S, S] }); },
    SDL_EndGPUComputePass: p => { g(p)?.e.end(); O.delete(N(p)); },
    SDL_BindGPUGraphicsPipeline: (p, h) => { const pa = g(p); pa.pipe = g(h); pa.e.setPipeline(pa.pipe.g); pa.bk = []; },
    SDL_BindGPUComputePipeline: (p, h) => { const pa = g(p); pa.pipe = g(h); pa.e.setPipeline(pa.pipe.g); pa.bk = []; },
    SDL_SetGPUViewport: (p, v) => { const pa = g(p); pa.e.setViewport(rf(v, 0), rf(v, 4), rf(v, 8), rf(v, 12), rf(v, 16), rf(v, 20)); },
    SDL_SetGPUScissor: (p, r) => { const pa = g(p), x = Math.min(Math.max(s32(r, 0), 0), pa.w), y = Math.min(Math.max(s32(r, 4), 0), pa.h); pa.e.setScissorRect(x, y, Math.max(0, Math.min(s32(r, 8) + Math.min(s32(r, 0), 0), pa.w - x)), Math.max(0, Math.min(s32(r, 12) + Math.min(s32(r, 4), 0), pa.h - y))); },
    SDL_BindGPUVertexBuffers: (p, s, b, n) => { const pa = g(p); for (let i = 0; i < n; i++) pa.e.setVertexBuffer(s + i, g(r64(b, 16 * i)).g, r32(b, 16 * i + 8)); },
    SDL_BindGPUIndexBuffer: (p, b, sz) => { g(p).e.setIndexBuffer(g(r64(b, 0)).g, sz ? 'uint32' : 'uint16', r32(b, 8)); },
    SDL_BindGPUVertexSamplers: (p, s, b, n) => bset(p, 0, 'smp', s, b, n), SDL_BindGPUFragmentSamplers: (p, s, b, n) => bset(p, 1, 'smp', s, b, n), SDL_BindGPUComputeSamplers: (p, s, b, n) => bset(p, 2, 'smp', s, b, n),
    SDL_BindGPUVertexStorageTextures: (p, s, b, n) => bset(p, 0, 'stx', s, b, n), SDL_BindGPUFragmentStorageTextures: (p, s, b, n) => bset(p, 1, 'stx', s, b, n), SDL_BindGPUComputeStorageTextures: (p, s, b, n) => bset(p, 2, 'stx', s, b, n),
    SDL_BindGPUVertexStorageBuffers: (p, s, b, n) => bset(p, 0, 'sbuf', s, b, n), SDL_BindGPUFragmentStorageBuffers: (p, s, b, n) => bset(p, 1, 'sbuf', s, b, n), SDL_BindGPUComputeStorageBuffers: (p, s, b, n) => bset(p, 2, 'sbuf', s, b, n),
    SDL_DrawGPUPrimitives: (p, nv, ni, fv, fi) => { const pa = g(p); if (bind(pa)) pa.e.draw(nv, ni, fv, fi); },
    SDL_DrawGPUIndexedPrimitives: (p, nx, ni, fx, vo, fi) => { const pa = g(p); if (bind(pa)) pa.e.drawIndexed(nx, ni, fx, vo, fi); },
    SDL_DrawGPUIndexedPrimitivesIndirect: (p, b, o, n) => { const pa = g(p), t = g(b); if (t && bind(pa)) for (let i = 0; i < n; i++) pa.e.drawIndexedIndirect(t.g, o + i * 20); },
    SDL_DispatchGPUCompute: (p, x, y, z) => { const pa = g(p); if (bind(pa)) pa.e.dispatchWorkgroups(x, y, z); },
    SDL_PushGPUVertexUniformData: (c, s, p, n) => upush(c, 0, s, p, n), SDL_PushGPUFragmentUniformData: (c, s, p, n) => upush(c, 1, s, p, n), SDL_PushGPUComputeUniformData: (c, s, p, n) => upush(c, 2, s, p, n),
    SDL_BlitGPUTexture: (c, b) => { const s = g(r64(b, 0)), d = g(r64(b, 32)); blit(g(c), s, r32(b, 8), r32(b, 12), r32(b, 16), r32(b, 20), r32(b, 24), r32(b, 28), d, r32(b, 40), r32(b, 44), r32(b, 48), r32(b, 52), r32(b, 56), r32(b, 60), s32(b, 88) === 1, s32(b, 84), s32(b, 64), [rf(b, 68), rf(b, 72), rf(b, 76), rf(b, 80)]); },
    SDL_GenerateMipmapsForGPUTexture: (c, h) => { const t = g(h), C = g(c); if (!t || t.d3 || t.f.includes('int') || t.f.startsWith('depth')) return; for (let l = 0; l < t.layers; l++) for (let m = 1; m < t.mips; m++) { const w = Math.max(1, t.w >> m), hh = Math.max(1, t.h >> m); blit(C, t, m - 1, l, 0, 0, Math.max(1, t.w >> m - 1), Math.max(1, t.h >> m - 1), t, m, l, 0, 0, w, hh, true, 0, 2, [0, 0, 0, 0]); } },
    SDL_CreateWindow: (t, w, h, f) => { f = N(f); const own = !R.canvas(), cv = R.canvas() || document.body.appendChild(Object.assign(document.createElement('canvas'), { style: `width:${w}px;height:${h}px;display:block` })); cv.tabIndex = cv.tabIndex < 0 ? 0 : cv.tabIndex; if (f & 8) cv.hidden = true; if (cs(t)) document.title = cs(t); const W = { cv, f, w: 0, h: 0, own }; focusW = W; listen(W); fit(W); evq.length = 0; return nh(W); },
    SDL_DestroyWindow: h => { const W = win(h); if (!W) return; W.off(); if (W.own) W.cv.remove(); if (focusW === W) focusW = null; O.delete(N(h)); },
    SDL_ClaimWindowForGPUDevice: (d, h) => { const W = win(h); if (!W || !dev) return fail('no canvas or no device', 0); W.ctx = W.cv.getContext('webgpu'); W.fmt = navigator.gpu.getPreferredCanvasFormat(); W.ctx.configure({ device: dev, format: W.fmt, alphaMode: 'opaque' }); W.tex = { sw: 1, views: new Map(), mips: 1, layers: 1, f: W.fmt, bs: 4, id: nid++ }; W.th = nh(W.tex); return 1; },
    SDL_ReleaseWindowFromGPUDevice: (d, h) => { win(h)?.ctx?.unconfigure(); },
    SDL_WindowSupportsGPUPresentMode: (d, w, m) => m === 0 ? 1 : 0, SDL_SetGPUSwapchainParameters: (d, w, c, m) => m === 0 && c === 0 ? 1 : 0,
    SDL_WaitAndAcquireGPUSwapchainTexture: (c, h, tp, wp, hp) => { const W = win(h), go = () => { fit(W); const T = W.tex; T.g = W.ctx.getCurrentTexture(); T.views.clear(); T.w = W.cv.width; T.h = W.cv.height; w64(tp, 0, W.th); w32(wp, 0, T.w); w32(hp, 0, T.h); return 1; }; if (!W?.ctx) return 0; return raf || !R.canWait() ? go() : nextFrame().then(go); },
    SDL_GetWindowSize: (h, a, b) => { const W = win(h); if (!W) return 0; w32(a, 0, W.w); w32(b, 0, W.h); return 1; },
    SDL_GetWindowSizeInPixels: (h, a, b) => { const W = win(h); if (!W) return 0; w32(a, 0, W.cv.width); w32(b, 0, W.cv.height); return 1; },
    SDL_GetWindowSafeArea: (h, r) => { const W = win(h); if (!W) return 0; w32(r, 0, 0); w32(r, 4, 0); w32(r, 8, W.w); w32(r, 12, W.h); return 1; },
    SDL_GetWindowPosition: (h, a, b) => { const W = win(h); if (!W) return 0; const r = W.cv.getBoundingClientRect(); w32(a, 0, Math.round(r.left)); w32(b, 0, Math.round(r.top)); return 1; },
    SDL_GetWindowFlags: h => { const W = win(h); return W ? BigInt(W.f & 8192 | (document.fullscreenElement ? 1 : 0) | (W.cv.hidden ? 8 : 0) | (document.hasFocus() ? 512 : 0) | (inside ? 1024 : 0)) : 0n; },
    SDL_GetWindowID: h => win(h) ? 1 : 0, SDL_SetWindowTitle: (h, t) => { document.title = cs(t); return 1; },
    SDL_SetWindowFullscreen: (h, on) => { const W = win(h); if (!W) return 0; (on ? W.cv.requestFullscreen?.() : document.fullscreenElement && document.exitFullscreen())?.catch?.(() => {}); return 1; },
    SDL_GetMouseFocus: () => inside && focusW ? BigInt([...O].find(([, v]) => v === focusW)?.[0] || 0) : 0n, SDL_GetCurrentVideoDriver: () => cstr(2048, 'browser'), SDL_GetPlatform: () => cstr(4096, matchMedia('(pointer: coarse)').matches ? 'WebTouch' : 'Web'), SDL_GetPrefPath: (o, a) => cstr(5120, `/pref/${cs(o)}/${cs(a)}/`), SDL_OpenAudioDeviceStream: (d, sp, cb, ud) => { if (!N(sp) || s32(sp, 0) !== 0x8120 || !globalThis.AudioContext) return 0n; const ch = s32(sp, 4), fr = s32(sp, 8); let ac; try { ac = new AudioContext({ sampleRate: fr }); } catch { return 0n; } const A = { ac, ch, fr, end: 0 }; addEventListener('pointerdown', () => ac.resume(), { once: true }); addEventListener('keydown', () => ac.resume(), { once: true }); return nh(A); }, SDL_ResumeAudioStreamDevice: s => { g(s)?.ac.resume().catch(() => {}); return 1; }, SDL_PutAudioStreamData: (s, p, n) => { const A = g(s); n = N(n); if (!A || n <= 0) return 1; const f = new Float32Array(u8().buffer.slice(N(p), N(p) + n)), fr = f.length / A.ch, b = A.ac.createBuffer(A.ch, fr, A.fr); for (let c = 0; c < A.ch; c++) { const o = b.getChannelData(c); for (let i = 0; i < fr; i++) o[i] = f[i * A.ch + c]; } const src = A.ac.createBufferSource(); src.buffer = b; src.connect(A.ac.destination); const t = Math.max(A.end, A.ac.currentTime + 0.02); src.start(t); A.end = t + fr / A.fr; return 1; }, SDL_GetAudioStreamQueued: s => { const A = g(s); return A ? Math.max(0, Math.round((A.end - A.ac.currentTime) * A.fr) * A.ch * 4) : 0; }, SDL_DestroyAudioStream: s => { g(s)?.ac.close().catch(() => {}); del(s); },
    SDL_GetGlobalMouseState: (x, y) => { wf(x, 0, gx); wf(y, 0, gy); return (gb & 1 ? 1 : 0) | (gb & 4 ? 2 : 0) | (gb & 2 ? 4 : 0); },
    SDL_ShowCursor: () => { if (focusW) focusW.cv.style.cursor = ''; return 1; }, SDL_HideCursor: () => { if (focusW) focusW.cv.style.cursor = 'none'; return 1; },
    SDL_SetWindowRelativeMouseMode: (h, on) => { const W = win(h); if (!W) return 0; try { on ? W.cv.requestPointerLock()?.catch?.(() => {}) : document.pointerLockElement && document.exitPointerLock(); } catch {} return 1; },
    SDL_FlushEvent: t => { for (let i = evq.length - 1; i >= 0; i--) if (new DataView(evq[i].buffer).getUint32(0, true) === t) evq.splice(i, 1); },
    SDL_PollEvent: p => { if (focusW) fit(focusW); const b = evq.shift(); if (!b) return 0; u8().set(b, N(p)); return 1; },
    SDL_PushEvent: p => { evq.push(u8().slice(N(p), N(p) + 128)); return 1; }, SDL_RegisterEvents: n => { const k = uev; uev += n; return k; },
    SDL_OpenGamepad: () => 0n, SDL_GetTicksNS: () => BigInt(Math.round(performance.now() * 1e6)),
    SDL_StartTextInput: () => { textOn = true; return 1; }, SDL_StopTextInput: () => { textOn = false; return 1; },
    SDL_StepUTF8: (pp, np) => { const p = r64(pp, 0), m = u8(), b = m[p]; if (!b) return 0; const n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4, cp = td.decode(m.subarray(p, p + n)).codePointAt(0) || 0xfffd; w64(pp, 0, p + n); return cp; },
    SDL_GetScancodeFromName: p => { const s = cs(p).toLowerCase(), i = SC.findIndex(x => x && x.toLowerCase() === s); return i < 0 ? 0 : i; },
    SDL_GetScancodeName: sc => cstr(3072, SC[sc] || ''), SDL_GetKeyFromScancode: sc => keyOf(sc),
    SDL_GetClipboardText: () => cstr(16384, clip, 49152), SDL_SetClipboardText: t => { clip = cs(t); navigator.clipboard?.writeText(clip).catch(() => {}); return 1; },
    SDL_CreateSurfaceFrom: (w, h, f, px, pitch) => nh({ w, h, f, px: N(px), pitch }),
    SDL_SavePNG: (s, p) => { const S = g(s); if (!S || (S.f !== 376840196 && S.f !== 372645892)) return fail('SDL_SavePNG on the web: an RGBA8 or BGRA8 surface', 0); const px = new Uint8Array(S.w * S.h * 4), m = u8(); for (let y = 0; y < S.h; y++) px.set(m.subarray(S.px + y * S.pitch, S.px + y * S.pitch + S.w * 4), y * S.w * 4); if (S.f === 372645892) for (let i = 0; i < px.length; i += 4) [px[i], px[i + 2]] = [px[i + 2], px[i]]; files.set(cs(p), png(S.w, S.h, px)); R.saved?.(cs(p)); return 1; },
    SDL_LoadPNG: () => fail('SDL_LoadPNG: load images on the web with codec_png'), SDL_LoadBMP: () => fail('SDL_LoadBMP is not available on the web'), SDL_ConvertSurface: () => 0n, SDL_DestroySurface: s => { O.delete(N(s)); }
  };
  return {
    env,
    waiting: ['SDL_WaitForGPUFences', 'SDL_WaitForGPUIdle', 'SDL_WaitAndAcquireGPUSwapchainTexture'],
    init: async () => { try { const hp = { powerPreference: 'high-performance' }; let ad = await navigator.gpu?.requestAdapter(hp), fb = !ad; if (fb) ad = await navigator.gpu?.requestAdapter({ ...hp, featureLevel: 'compatibility' }).catch(() => null); if (!ad) { GL = R.webgl !== false && sdlgl({ R, nh, g, O, N, r32, s32, rf, r64, w32, w64, u8, fail, F, VF, win, fit, nextFrame, al, blob, cstr, env, raf: () => raf }) || null; globalThis.heWebGL = !!GL; return; } CM = fb && !ad.features.has('core-features-and-limits'); globalThis.heCompat = CM; if (CM && !ad.features.has('float32-filterable')) { F[30] = ['r16float', 2]; F[31] = ['rg16float', 4]; F[32] = ['rgba16float', 8]; } const L = {}; for (const k in ad.limits) if (typeof ad.limits[k] === 'number') L[k] = ad.limits[k]; dev = await ad.requestDevice({ requiredFeatures: ['core-features-and-limits', 'texture-compression-bc', 'float32-filterable', 'float32-blendable', 'rg11b10ufloat-renderable', 'depth32float-stencil8'].filter(f => ad.features.has(f)), requiredLimits: L }); info = ad.info; dev.onuncapturederror = e => { nfail++; if (nfail <= 7) console.error('webgpu:', e.error.message); }; } catch (e) { err = String(e && e.message || e); } },
    raf: on => { raf = on; }, close: () => { for (const o of O.values()) o?.off?.(); dev?.destroy(); dev = null; GL?.close(); }, stats: () => GL ? GL.stats() : ({ errors: nfail, gpu: info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : '' }), idle: () => dev ? dev.queue.onSubmittedWorkDone() : Promise.resolve()
  };
  function bset(p, st, k, s, b, n) { const S = g(p).st[st]; for (let i = 0; i < n; i++) S[k][s + i] = k === 'smp' ? { t: g(r64(b, 16 * i)), s: g(r64(b, 16 * i + 8)) } : g(r64(b, 8 * i)); }
  function upush(c, st, slot, p, n) { const C = g(c); if (!C.cur || C.off + n > RING) { C.cur = chunk(); C.cur.used = 0; C.ub.push(C.cur); C.off = 0; } C.cur.cpu.set(u8().subarray(N(p), N(p) + n), C.off); C.push[st][slot] = { k: C.cur, off: C.off }; C.cur.used = C.off + n; C.off = al(C.off + n, 256); }
}
function sdlgl(H) {
  const { R, nh, g, O, N, r32, s32, rf, r64, w32, w64, u8, fail, F, VF, win, fit, nextFrame, al, blob, cstr, env } = H;
  const cv = R.canvas() || document.createElement('canvas'), gl = cv.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
  const X = n => gl.getExtension(n), FL = X('OES_texture_float_linear'), CC = X('EXT_clip_control'), DI = X('OES_draw_buffers_indexed'), AN = X('EXT_texture_filter_anisotropic'); X('EXT_float_blend');
  if (CC) CC.clipControlEXT(CC.LOWER_LEFT_EXT, CC.ZERO_TO_ONE_EXT);
  const T = {}, FBC = new Map(), UB = [], usz = [], US = new Uint8Array(65536), PB = gl.createBuffer(), VAO = gl.createVertexArray(); let id = 1, EN = 0, nfail = 0;
  '2 R8 RED UNSIGNED_BYTE 0,3 RG8 RG UNSIGNED_BYTE 0,4 RGBA8 RGBA UNSIGNED_BYTE 0,8 RGB10_A2 RGBA UNSIGNED_INT_2_10_10_10_REV 0,12 RGBA8 RGBA UNSIGNED_BYTE 0,21 R8_SNORM RED BYTE 0,22 RG8_SNORM RG BYTE 0,23 RGBA8_SNORM RGBA BYTE 0,27 R16F RED HALF_FLOAT 0,28 RG16F RG HALF_FLOAT 0,29 RGBA16F RGBA HALF_FLOAT 0,30 R32F RED FLOAT 4,31 RG32F RG FLOAT 4,32 RGBA32F RGBA FLOAT 4,33 R11F_G11F_B10F RGB UNSIGNED_INT_10F_11F_11F_REV 0,34 R8UI RED_INTEGER UNSIGNED_BYTE 1,35 RG8UI RG_INTEGER UNSIGNED_BYTE 1,36 RGBA8UI RGBA_INTEGER UNSIGNED_BYTE 1,37 R16UI RED_INTEGER UNSIGNED_SHORT 1,38 RG16UI RG_INTEGER UNSIGNED_SHORT 1,39 RGBA16UI RGBA_INTEGER UNSIGNED_SHORT 1,40 R32UI RED_INTEGER UNSIGNED_INT 1,41 RG32UI RG_INTEGER UNSIGNED_INT 1,42 RGBA32UI RGBA_INTEGER UNSIGNED_INT 1,43 R8I RED_INTEGER BYTE 2,44 RG8I RG_INTEGER BYTE 2,45 RGBA8I RGBA_INTEGER BYTE 2,46 R16I RED_INTEGER SHORT 2,47 RG16I RG_INTEGER SHORT 2,48 RGBA16I RGBA_INTEGER SHORT 2,49 R32I RED_INTEGER INT 2,50 RG32I RG_INTEGER INT 2,51 RGBA32I RGBA_INTEGER INT 2,52 SRGB8_ALPHA8 RGBA UNSIGNED_BYTE 0,53 SRGB8_ALPHA8 RGBA UNSIGNED_BYTE 0,58 DEPTH_COMPONENT16 DEPTH_COMPONENT UNSIGNED_SHORT 3,59 DEPTH_COMPONENT24 DEPTH_COMPONENT UNSIGNED_INT 3,60 DEPTH_COMPONENT32F DEPTH_COMPONENT FLOAT 3,61 DEPTH24_STENCIL8 DEPTH_STENCIL UNSIGNED_INT_24_8 3,62 DEPTH32F_STENCIL8 DEPTH_STENCIL FLOAT_32_UNSIGNED_INT_24_8_REV 3'.split(',').forEach(s => { const [k, i, f, t, c] = s.split(' '); T[k] = [gl[i], gl[f], gl[t], FL && c === '4' ? 0 : +c]; });
  const BFG = [, 'ZERO', 'ONE', 'SRC_COLOR', 'ONE_MINUS_SRC_COLOR', 'DST_COLOR', 'ONE_MINUS_DST_COLOR', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'DST_ALPHA', 'ONE_MINUS_DST_ALPHA', 'CONSTANT_COLOR', 'ONE_MINUS_CONSTANT_COLOR', 'SRC_ALPHA_SATURATE'].map(k => gl[k]), BOG = [, 'FUNC_ADD', 'FUNC_SUBTRACT', 'FUNC_REVERSE_SUBTRACT', 'MIN', 'MAX'].map(k => gl[k]), MODE = [gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.LINES, gl.LINE_STRIP, gl.POINTS], WR = [gl.REPEAT, gl.MIRRORED_REPEAT, gl.CLAMP_TO_EDGE];
  const af = v => { const m = /^(sint|uint|float|snorm|unorm)(8|16|32)(?:x(\d))?$/.exec(v), k = m[1], b = +m[2]; return [+(m[3] || 1), gl[k === 'float' ? (b === 16 ? 'HALF_FLOAT' : 'FLOAT') : (k[0] === 'u' ? 'UNSIGNED_' : '') + ['BYTE', 'SHORT', 'INT'][b >> 4]], k.endsWith('norm'), k.endsWith('int')]; };
  const ats = (a, [t, m, l]) => t.tg === gl.TEXTURE_2D ? gl.framebufferTexture2D(gl.FRAMEBUFFER, a, gl.TEXTURE_2D, t.t, m) : t.tg === gl.TEXTURE_CUBE_MAP ? gl.framebufferTexture2D(gl.FRAMEBUFFER, a, gl.TEXTURE_CUBE_MAP_POSITIVE_X + l, t.t, m) : gl.framebufferTextureLayer(gl.FRAMEBUFFER, a, t.t, m, l);
  const fbo = (cs, ds) => { const k = cs.map(([t, m, l]) => t.id + '.' + m + '.' + l).join() + '|' + (ds ? ds[0].id + '.' + ds[1] + '.' + ds[2] : ''); let f = FBC.get(k); if (f) return f; f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); cs.forEach((c, i) => ats(gl.COLOR_ATTACHMENT0 + i, c)); if (ds) ats(ds[0].q[1] === gl.DEPTH_STENCIL ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT, ds); gl.drawBuffers(cs.length ? cs.map((c, i) => gl.COLOR_ATTACHMENT0 + i) : [gl.NONE]); if (!cs.length) gl.readBuffer(gl.NONE); FBC.set(k, f); return f; };
  const drop = t => { for (const [k, f] of FBC) if (k.split(/[,|]/).some(s => s.startsWith(t.id + '.'))) { gl.deleteFramebuffer(f); FBC.delete(k); } };
  const copy = (a, b, w, h, x = [0, 0, w, h], y = [0, 0, w, h], lin = false, clr = null) => { const r = fbo([a], null), d = fbo([b], null); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, r); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d); gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); if (clr) gl.clearBufferfv(gl.COLOR, 0, clr); gl.blitFramebuffer(...x, ...y, gl.COLOR_BUFFER_BIT, lin ? gl.LINEAR : gl.NEAREST); };
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
  const prog = (vs, fs) => {
    const fl = new Set([...fs.gl.matchAll(/flat in \w+ (he_v\d+);/g)].map(x => x[1])), vt = vs.gl.replace(/(?:flat )?out (\w+) (he_v\d+);/g, (x, t, n) => (fl.has(n) || /^[iu]|^bool/.test(t) ? 'flat ' : '') + 'out ' + t + ' ' + n + ';').replace('\n', CC ? '\n' : '\n#define HE_ZR\n');
    const P = gl.createProgram(), a = sh(gl.VERTEX_SHADER, vt), b = sh(gl.FRAGMENT_SHADER, fs.gl); gl.attachShader(P, a); gl.attachShader(P, b); gl.linkProgram(P);
    if (!gl.getProgramParameter(P, gl.LINK_STATUS)) { const e = (gl.getShaderInfoLog(a) || '') + (gl.getShaderInfoLog(b) || '') + (gl.getProgramInfoLog(P) || ''); if (++nfail <= 7) console.error('webgl:', e.slice(0, 1500)); return fail('a WebGL2 program failed to link: ' + e.slice(0, 300), null); }
    gl.useProgram(P); const u = { smp: [], n: [], ec: {}, bv: gl.getUniformLocation(P, 'he_bv'), bi: gl.getUniformLocation(P, 'he_bi') }; let un = 0;
    for (let i = 0, k = gl.getProgramParameter(P, gl.ACTIVE_UNIFORMS); i < k; i++) { const A = gl.getActiveUniform(P, i), m = /^he_([tb])(\d+)_(\d+)(?:_(\d))?$/.exec(A.name), mn = /^he_n(\d+)_(\d+)$/.exec(A.name); if (m) { gl.uniform1i(gl.getUniformLocation(P, A.name), un); u.smp.push([un++, m[1], +m[2], +m[3], +m[4] || 0, A.type === gl.SAMPLER_2D_SHADOW || A.type === gl.SAMPLER_CUBE_SHADOW || A.type === gl.SAMPLER_2D_ARRAY_SHADOW]); if (m[4]) u.ec[m[2] + '_' + m[3]] = +m[4]; } else if (mn) u.n.push([gl.getUniformLocation(P, A.name), +mn[1], +mn[2]]); }
    for (let i = 0, k = gl.getProgramParameter(P, gl.ACTIVE_UNIFORM_BLOCKS); i < k; i++) { const m = /^he_u(\d+)_(\d+)$/.exec(gl.getActiveUniformBlockName(P, i)); if (!m) continue; const x = (+m[1] === 3 ? 4 : 0) + +m[2]; gl.uniformBlockBinding(P, i, x); usz[x] = Math.max(usz[x] || 0, gl.getActiveUniformBlockParameter(P, i, gl.UNIFORM_BLOCK_DATA_SIZE)); }
    gl.deleteShader(a); gl.deleteShader(b); return { P, u };
  };
  const smp = (S, near, shd) => { const k = (near ? 1 : 0) | (shd ? 2 : 0); if (S.v[k]) return S.v[k]; const [mi, ma, mm, a, b, c, l0, l1, cmp, an] = S.d, s = S.v[k] = gl.createSampler(), P = (n, x) => gl.samplerParameteri(s, n, x); P(gl.TEXTURE_MIN_FILTER, near ? gl.NEAREST : [[gl.NEAREST_MIPMAP_NEAREST, gl.NEAREST_MIPMAP_LINEAR], [gl.LINEAR_MIPMAP_NEAREST, gl.LINEAR_MIPMAP_LINEAR]][mi][mm]); P(gl.TEXTURE_MAG_FILTER, near || !ma ? gl.NEAREST : gl.LINEAR); P(gl.TEXTURE_WRAP_S, WR[a]); P(gl.TEXTURE_WRAP_T, WR[b]); P(gl.TEXTURE_WRAP_R, WR[c]); gl.samplerParameterf(s, gl.TEXTURE_MIN_LOD, l0); gl.samplerParameterf(s, gl.TEXTURE_MAX_LOD, l1); if (shd && cmp) { P(gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); P(gl.TEXTURE_COMPARE_FUNC, 0x1ff + cmp); } if (AN && an > 1 && !near) gl.samplerParameterf(s, AN.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, an)); return s; };
  const btex = (B, c) => { const ne = Math.max(1, Math.floor(B.n / (4 * c))), W = Math.min(ne, 4096), Hh = Math.ceil(ne / 4096); let x = B.tx[c]; if (x && x.ver === B.ver) return x.t; if (!x) { x = B.tx[c] = { t: gl.createTexture(), ver: -1 }; gl.bindTexture(gl.TEXTURE_2D, x.t); gl.texStorage2D(gl.TEXTURE_2D, 1, [, gl.R32UI, gl.RG32UI, , gl.RGBA32UI][c], W, Hh); } else gl.bindTexture(gl.TEXTURE_2D, x.t); const need = W * Hh * c * 4; if (B.cpu.length < need) { const z = new Uint8Array(need); z.set(B.cpu); B.cpu = z; } gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, Hh, [, gl.RED_INTEGER, gl.RG_INTEGER, , gl.RGBA_INTEGER][c], gl.UNSIGNED_INT, new Uint32Array(B.cpu.buffer, 0, W * Hh * c)); x.ver = B.ver; return x.t; };
  const bind = P => {
    const pi = P.pipe; if (!pi?.pr) return false; const u = pi.pr.u, sb = (set, b) => { const st = set === 0 ? 0 : 1, nn = (st ? pi.fs : pi.vs).n; return P.st[st].sbuf[b - nn[0] - nn[1]]; };
    for (const [un, k, set, b, c, shd] of u.smp) { gl.activeTexture(gl.TEXTURE0 + un); if (k === 't') { const e = P.st[set === 0 ? 0 : 1].smp[b]; if (!e?.t?.t) return !!fail('a draw reads a sampler that is not bound', 0); const q = e.t.q[3]; gl.bindTexture(e.t.tg, e.t.t); gl.bindSampler(un, smp(e.s, q === 1 || q === 2 || q === 4 || q === 3 && !shd, shd)); } else { const B = sb(set, b); if (!B?.cpu) return !!fail('a draw reads a storage buffer that is not bound', 0); gl.bindTexture(gl.TEXTURE_2D, btex(B, c)); gl.bindSampler(un, null); } }
    for (const [loc, set, b] of u.n) { const B = sb(set, b); gl.uniform1i(loc, B ? Math.floor(B.n / (4 * (u.ec[set + '_' + b] || 4))) : 0); }
    return true;
  };
  const attrs = (P, bv, bi) => { const pi = P.pipe; let m = 0; gl.bindVertexArray(VAO); for (const [loc, slot, [n, ty, nm, it], off] of pi.at) { const v = P.vb[slot], d = pi.bufs[slot]; if (!v?.[0]?.b || !d) continue; gl.bindBuffer(gl.ARRAY_BUFFER, v[0].b); gl.enableVertexAttribArray(loc); const o = v[1] + off + (d[1] ? bi : bv) * d[0]; it ? gl.vertexAttribIPointer(loc, n, ty, d[0], o) : gl.vertexAttribPointer(loc, n, ty, nm, d[0], o); gl.vertexAttribDivisor(loc, d[1] ? 1 : 0); m |= 1 << loc; } for (let l = 0; l < 16; l++) if (!(m & 1 << l) && EN & 1 << l) gl.disableVertexAttribArray(l); EN = m; };
  const upush = (st, slot, p, n) => { const x = (st ? 4 : 0) + slot, b = UB[x] ||= gl.createBuffer(), sz = Math.min(US.length, Math.max(al(n, 16), usz[x] || 0)); US.set(u8().subarray(N(p), N(p) + Math.min(n, sz))); US.fill(0, n, sz); gl.bindBuffer(gl.UNIFORM_BUFFER, b); gl.bufferData(gl.UNIFORM_BUFFER, US.subarray(0, sz), gl.DYNAMIC_DRAW); gl.bindBufferBase(gl.UNIFORM_BUFFER, x, b); };
  const PV = prog({ gl: '#version 300 es\nout vec2 u;\nvoid main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); u = vec2(p.x, 1.0 - p.y); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }' }, { gl: '#version 300 es\nprecision highp float;\nuniform sampler2D he_t2_0;\nin vec2 u;\nout vec4 o;\nvoid main() { o = texture(he_t2_0, u); }' }), PVAO = gl.createVertexArray();
  const present = C => { const W = C?.sw; if (!W?.tex.t || !PV) return; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W.tex.w, W.tex.h); for (const k of [gl.SCISSOR_TEST, gl.DEPTH_TEST, gl.BLEND, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL]) gl.disable(k); gl.colorMask(true, true, true, true); gl.useProgram(PV.P); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, W.tex.t); gl.bindSampler(0, null); gl.bindVertexArray(PVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(VAO); globalThis.heFrames = (globalThis.heFrames || 0) + 1; if (W.c2) W.c2.drawImage(gl.canvas, 0, 0); };
  const draw = (P, mode, a) => { const u = P.pipe.pr.u; if (u.bv) gl.uniform1i(u.bv, a[0]); if (u.bi) gl.uniform1i(u.bi, a[1]); attrs(P, a[0], a[1]); mode(); };
  gl.bindVertexArray(VAO);
  Object.assign(env, {
    SDL_CreateGPUDevice: () => nh({ gl }), SDL_GetGPUDeviceDriver: () => cstr(1024, 'webgl2'), SDL_DestroyGPUDevice: h => { O.delete(N(h)); },
    SDL_GPUTextureSupportsFormat: (d, f, t, u) => T[f] && (!(u & 2) || f < 21 || f > 23) && (!(u & 4) || T[f][3] === 3) && (!(u & 120) || /^(rgba8(unorm|snorm|uint|sint)|(rgba16|rgba32|r32|rg32)(float|uint|sint))$/.test(F[f][0])) ? 1 : 0,
    SDL_CreateGPUTexture: (d, p) => { const u = r32(p, 8), f = s32(p, 4), ty = s32(p, 0), w = r32(p, 12), h = r32(p, 16), l = r32(p, 20), m = r32(p, 24), q = T[f]; if (!q) return fail(`texture format ${f} has no WebGL2 match`); const t = gl.createTexture(), tg = ty === 2 ? gl.TEXTURE_3D : ty === 3 || ty === 4 ? gl.TEXTURE_CUBE_MAP : ty === 1 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D; gl.bindTexture(tg, t); tg === gl.TEXTURE_3D || tg === gl.TEXTURE_2D_ARRAY ? gl.texStorage3D(tg, m, q[0], w, h, l) : gl.texStorage2D(tg, m, q[0], w, h); return nh({ t, tg, q, f, u, bs: F[f][1], w, h, layers: ty === 2 ? 1 : ty === 3 || ty === 4 ? 6 : l, mips: m, d3: ty === 2, id: id++ }); },
    SDL_ReleaseGPUTexture: (d, h) => { const t = g(h); if (t && !t.sw) { drop(t); gl.deleteTexture(t.t); O.delete(N(h)); } },
    SDL_CreateGPUSampler: (d, p) => nh({ d: [s32(p, 0), s32(p, 4), s32(p, 8), s32(p, 12), s32(p, 16), s32(p, 20), rf(p, 36), rf(p, 40), u8()[N(p) + 45] ? s32(p, 32) : 0, u8()[N(p) + 44] ? rf(p, 28) : 1], v: [] }),
    SDL_ReleaseGPUSampler: (d, h) => { g(h)?.v.forEach(x => x && gl.deleteSampler(x)); O.delete(N(h)); },
    SDL_CreateGPUBuffer: (d, p) => { const u = r32(p, 0), n = r32(p, 4), B = { n, u, cpu: u & 60 ? new Uint8Array(al(n, 16)) : null, ver: 0, tx: {}, id: id++ }; if (u & 3) { B.b = gl.createBuffer(); B.tg = u & 2 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER; gl.bindBuffer(B.tg, B.b); gl.bufferData(B.tg, al(n, 4), gl.DYNAMIC_DRAW); } return nh(B); },
    SDL_ReleaseGPUBuffer: (d, h) => { const b = g(h); if (b) { if (b.b) gl.deleteBuffer(b.b); Object.values(b.tx).forEach(x => gl.deleteTexture(x.t)); } O.delete(N(h)); },
    SDL_AcquireGPUCommandBuffer: () => nh({ sw: null }), SDL_SubmitGPUCommandBuffer: c => { present(g(c)); O.delete(N(c)); return 1; }, SDL_SubmitGPUCommandBufferAndAcquireFence: c => { present(g(c)); O.delete(N(c)); return nh({ done: true }); }, SDL_CancelGPUCommandBuffer: c => { O.delete(N(c)); return 1; },
    SDL_WaitForGPUFences: () => 1, SDL_ReleaseGPUFence: (d, f) => { O.delete(N(f)); }, SDL_WaitForGPUIdle: () => 1,
    SDL_UploadToGPUBuffer: (cp, s, d) => { const t = g(r64(s, 0)), b = g(r64(d, 0)), o = r32(d, 8), n = r32(d, 12), a = t.ptr + r32(s, 8), src = u8().subarray(a, a + n); if (b.cpu) { b.cpu.set(src, o); b.ver++; } if (b.b) { gl.bindBuffer(gl.COPY_WRITE_BUFFER, b.b); gl.bufferSubData(gl.COPY_WRITE_BUFFER, o, src); } },
    SDL_DownloadFromGPUBuffer: (cp, s, d) => { const b = g(r64(s, 0)), t = g(r64(d, 0)), o = r32(s, 8), n = r32(s, 12), a = t.ptr + r32(d, 8), dst = u8().subarray(a, a + n); if (b.cpu) dst.set(b.cpu.subarray(o, o + n)); else if (b.b) { gl.bindBuffer(gl.COPY_READ_BUFFER, b.b); gl.getBufferSubData(gl.COPY_READ_BUFFER, o, dst); } },
    SDL_UploadToGPUTexture: (cp, s, d) => { const t = g(r64(s, 0)), x = g(r64(d, 0)), w = r32(d, 28), h = r32(d, 32), dp = r32(d, 36), ppr = r32(s, 12) || w, rpl = r32(s, 16) || h, mip = r32(d, 8), lay = r32(d, 12), a = t.ptr + r32(s, 8), fs = ppr * rpl * x.bs; gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, PB); gl.bufferData(gl.PIXEL_UNPACK_BUFFER, u8().subarray(a, a + fs * (dp - 1) + ppr * x.bs * (h - 1) + w * x.bs), gl.STREAM_DRAW); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, ppr); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, rpl); gl.bindTexture(x.tg, x.t); if (x.tg === gl.TEXTURE_3D || x.tg === gl.TEXTURE_2D_ARRAY) gl.texSubImage3D(x.tg, mip, r32(d, 16), r32(d, 20), x.d3 ? r32(d, 24) : lay, w, h, dp, x.q[1], x.q[2], 0); else for (let k = 0; k < dp; k++) gl.texSubImage2D(x.tg === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + lay + k : x.tg, mip, r32(d, 16), r32(d, 20), w, h, x.q[1], x.q[2], k * fs); gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0); },
    SDL_DownloadFromGPUTexture: (cp, s, d) => { const x = g(r64(s, 0)), t = g(r64(d, 0)), w = r32(s, 28), h = r32(s, 32), a = t.ptr + r32(d, 8), pr = (r32(d, 12) || w) * x.bs; gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo([[x, r32(s, 8), r32(s, 12)]], null)); gl.pixelStorei(gl.PACK_ALIGNMENT, 1); gl.pixelStorei(gl.PACK_ROW_LENGTH, r32(d, 12) || w); gl.readPixels(r32(s, 16), r32(s, 20), w, h, x.q[1], x.q[2], u8().subarray(a, a + pr * (h - 1) + w * x.bs)); gl.pixelStorei(gl.PACK_ROW_LENGTH, 0); },
    SDL_CreateGPUShader: (d, p) => { const s = blob(r64(p, 8), r64(p, 0)); if (!s) return fail('not a version 2 shader blob'); if (!s.gl) return fail('this shader has no GLSL ES (hc --gles on it names the reason)'); return nh(s); },
    SDL_CreateGPUGraphicsPipeline: (d, p) => {
      const vs = g(r64(p, 0)), fs = g(r64(p, 8)), m = u8(), q = N(p), bufs = [], at = [], tg = [], pr = prog(vs, fs); if (!pr) return 0n;
      for (let i = 0; i < r32(p, 24); i++) { const b = r64(p, 16) + 16 * i; bufs[r32(b, 0)] = [r32(b, 4), s32(b, 8)]; }
      for (let i = 0; i < r32(p, 40); i++) { const a = r64(p, 32) + 16 * i; at.push([r32(a, 0), r32(a, 4), af(VF[s32(a, 8)]), r32(a, 12)]); }
      for (let i = 0; i < r32(p, 144); i++) { const c = r64(p, 136) + 36 * i; tg.push([m[c + 29], [4, 8, 12, 16, 20, 24].map(o => s32(c, o)), m[c + 30] ? m[c + 28] : 15]); }
      const has = m[q + 152], te = m[q + 130], tw = m[q + 131];
      return nh({ pr, vs, fs, bufs, at, tg, prim: s32(p, 48), cull: s32(p, 56), ff: s32(p, 60), db: m[q + 76] ? [rf(p, 64), rf(p, 72)] : null, dt: has && (te || tw) ? [te ? 0x1ff + s32(p, 92) : gl.ALWAYS, !!tw] : null });
    },
    SDL_ReleaseGPUGraphicsPipeline: (d, h) => { const p = g(h); if (p?.pr) gl.deleteProgram(p.pr.P); O.delete(N(h)); },
    SDL_CreateGPUComputePipeline: () => nh({ dummy: 1 }), SDL_ReleaseGPUComputePipeline: (d, h) => { O.delete(N(h)); },
    SDL_BeginGPURenderPass: (c, ct, n, dt) => {
      const cs = [], rs = [], cl = []; let w = 0, h = 0, ds = null, dc = null;
      for (let i = 0; i < n; i++) { const p = N(ct) + 64 * i, t = g(r64(p, 0)), mip = r32(p, 8), lay = r32(p, 12), rt = r64(p, 40); w = Math.max(1, t.w >> mip); h = Math.max(1, t.h >> mip); cs.push([t, mip, lay]); if (rt) rs.push([i, g(rt), r32(p, 48), r32(p, 52)]); if (s32(p, 32) !== 0) cl.push([i, t.q[3], [rf(p, 16), rf(p, 20), rf(p, 24), rf(p, 28)]]); }
      if (dt) { const p = N(dt), t = g(r64(p, 0)), mm = u8(), mip = mm[p + 30]; w = Math.max(1, t.w >> mip); h = Math.max(1, t.h >> mip); ds = [t, mip, mm[p + 31]]; if (s32(p, 12) !== 0) dc = [rf(p, 8), mm[p + 29], t.q[1] === gl.DEPTH_STENCIL]; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo(cs, ds)); gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); if (DI) for (let i = 0; i < n; i++) DI.colorMaskiOES(i, true, true, true, true);
      for (const [i, k, v] of cl) k === 1 ? gl.clearBufferuiv(gl.COLOR, i, v.map(x => x >>> 0)) : k === 2 ? gl.clearBufferiv(gl.COLOR, i, v.map(Math.trunc)) : gl.clearBufferfv(gl.COLOR, i, v);
      if (dc) { gl.depthMask(true); dc[2] ? gl.clearBufferfi(gl.DEPTH_STENCIL, 0, dc[0], dc[1]) : gl.clearBufferfv(gl.DEPTH, 0, [dc[0]]); }
      gl.viewport(0, 0, w, h); gl.depthRange(0, 1);
      return nh({ rs, cs, w, h, vb: [], ib: null, st: [0, 1, 2].map(() => ({ smp: [], stx: [], sbuf: [], rwt: [], rwb: [] })) });
    },
    SDL_EndGPURenderPass: p => { const P = g(p); for (const [i, b, bm, bl] of P?.rs || []) { const [t, mm, l] = P.cs[i]; copy([t, mm, l], [b, bm, bl], Math.max(1, t.w >> mm), Math.max(1, t.h >> mm)); } O.delete(N(p)); },
    SDL_BeginGPUComputePass: () => nh({ st: [0, 1, 2].map(() => ({ smp: [], stx: [], sbuf: [], rwt: [], rwb: [] })) }), SDL_EndGPUComputePass: p => { O.delete(N(p)); }, SDL_BindGPUComputePipeline: () => {}, SDL_DispatchGPUCompute: () => {}, SDL_PushGPUComputeUniformData: () => {},
    SDL_BindGPUGraphicsPipeline: (p, h) => {
      const P = g(p), pi = P.pipe = g(h); if (!pi?.pr) return; gl.useProgram(pi.pr.P);
      if (pi.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(pi.cull === 1 ? gl.FRONT : gl.BACK); } else gl.disable(gl.CULL_FACE); gl.frontFace(pi.ff ? gl.CCW : gl.CW);
      if (pi.db) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(pi.db[1], pi.db[0]); } else gl.disable(gl.POLYGON_OFFSET_FILL);
      if (pi.dt) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(pi.dt[0]); gl.depthMask(pi.dt[1]); } else { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); }
      pi.tg.forEach(([eb, f, wm], i) => { const cm = [!!(wm & 1), !!(wm & 2), !!(wm & 4), !!(wm & 8)]; if (DI) { if (eb) { DI.enableiOES(gl.BLEND, i); DI.blendFuncSeparateiOES(i, BFG[f[0]], BFG[f[1]], BFG[f[3]], BFG[f[4]]); DI.blendEquationSeparateiOES(i, BOG[f[2]], BOG[f[5]]); } else DI.disableiOES(gl.BLEND, i); DI.colorMaskiOES(i, ...cm); } else if (!i) { if (eb) { gl.enable(gl.BLEND); gl.blendFuncSeparate(BFG[f[0]], BFG[f[1]], BFG[f[3]], BFG[f[4]]); gl.blendEquationSeparate(BOG[f[2]], BOG[f[5]]); } else gl.disable(gl.BLEND); gl.colorMask(...cm); } });
    },
    SDL_SetGPUViewport: (p, v) => { gl.viewport(rf(v, 0), rf(v, 4), rf(v, 8), rf(v, 12)); gl.depthRange(rf(v, 16), rf(v, 20)); },
    SDL_SetGPUScissor: (p, r) => { gl.enable(gl.SCISSOR_TEST); gl.scissor(s32(r, 0), s32(r, 4), Math.max(0, s32(r, 8)), Math.max(0, s32(r, 12))); },
    SDL_BindGPUVertexBuffers: (p, s, b, n) => { const P = g(p); for (let i = 0; i < n; i++) P.vb[s + i] = [g(r64(b, 16 * i)), r32(b, 16 * i + 8)]; },
    SDL_BindGPUIndexBuffer: (p, b, sz) => { g(p).ib = [g(r64(b, 0)), r32(b, 8), sz ? 4 : 2]; },
    SDL_DrawGPUPrimitives: (p, nv, ni, fv, fi) => { const P = g(p); if (bind(P)) draw(P, () => gl.drawArraysInstanced(MODE[P.pipe.prim], fv, nv, ni), [0, fi]); },
    SDL_DrawGPUIndexedPrimitives: (p, nx, ni, fx, vo, fi) => { const P = g(p), I = P.ib; if (I?.[0]?.b && bind(P)) draw(P, () => { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, I[0].b); gl.drawElementsInstanced(MODE[P.pipe.prim], nx, I[2] === 4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, I[1] + fx * I[2], ni); }, [vo, fi]); },
    SDL_DrawGPUIndexedPrimitivesIndirect: (p, b, o, n) => { const B = g(b); if (!B?.cpu) return; const q = new DataView(B.cpu.buffer); for (let i = 0; i < n; i++) { const k = o + i * 20, c = q.getUint32(k, true), ni = q.getUint32(k + 4, true); if (c && ni) env.SDL_DrawGPUIndexedPrimitives(p, c, ni, q.getUint32(k + 8, true), q.getInt32(k + 12, true), q.getUint32(k + 16, true)); } },
    SDL_PushGPUVertexUniformData: (c, s, p, n) => upush(0, s, p, n), SDL_PushGPUFragmentUniformData: (c, s, p, n) => upush(1, s, p, n),
    SDL_BlitGPUTexture: (c, b) => { const s = g(r64(b, 0)), d = g(r64(b, 32)), sx = r32(b, 16), sy = r32(b, 20), sw = r32(b, 24), sh0 = r32(b, 28), dx = r32(b, 48), dy = r32(b, 52), fl = s32(b, 84); copy([s, r32(b, 8), r32(b, 12)], [d, r32(b, 40), r32(b, 44)], 0, 0, [fl & 1 ? sx + sw : sx, fl & 2 ? sy + sh0 : sy, fl & 1 ? sx : sx + sw, fl & 2 ? sy : sy + sh0], [dx, dy, dx + r32(b, 56), dy + r32(b, 60)], s32(b, 88) === 1 && !s.q[3], s32(b, 64) === 1 ? [rf(b, 68), rf(b, 72), rf(b, 76), rf(b, 80)] : null); },
    SDL_GenerateMipmapsForGPUTexture: (c, h) => { const t = g(h); if (!t || t.q[3] || t.mips < 2 || t.f >= 21 && t.f <= 23) return; gl.bindTexture(t.tg, t.t); gl.generateMipmap(t.tg); },
    SDL_ClaimWindowForGPUDevice: (d, h) => { const W = win(h); if (!W) return fail('no canvas', 0); W.gl = 1; W.tex = { sw: 1, q: T[4], f: 4, bs: 4, mips: 1, layers: 1, tg: gl.TEXTURE_2D, id: id++, w: 0, h: 0 }; W.th = nh(W.tex); if (W.cv !== gl.canvas) W.c2 = W.cv.getContext('2d'); return 1; },
    SDL_ReleaseWindowFromGPUDevice: () => {},
    SDL_WaitAndAcquireGPUSwapchainTexture: (c, h, tp, wp, hp) => { const W = win(h), C = g(c), go = () => { fit(W); const T0 = W.tex, w = W.cv.width, hh = W.cv.height; if (T0.w !== w || T0.h !== hh) { if (T0.t) { drop(T0); gl.deleteTexture(T0.t); } T0.t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, T0.t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, hh); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); T0.w = w; T0.h = hh; T0.id = id++; if (W.c2) { gl.canvas.width = w; gl.canvas.height = hh; } } C.sw = W; w64(tp, 0, W.th); w32(wp, 0, w); w32(hp, 0, hh); return 1; }; if (!W?.gl) return 0; return H.raf() || !R.canWait() ? go() : nextFrame().then(go); }
  });
  return { stats: () => ({ errors: nfail, gpu: 'webgl2 ' + gl.getParameter(gl.RENDERER) }), close: () => X('WEBGL_lose_context')?.loseContext() };
}
