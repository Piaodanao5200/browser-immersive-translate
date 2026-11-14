/* 字幕译 - 内容脚本：段落收集、译文插入、划词翻译、快捷键开关 */
(() => {
  'use strict';

  if (window.__ST_CONTENT_LOADED__) return;
  window.__ST_CONTENT_LOADED__ = true;

  const ST = window.ST;
  const { TR_ATTR, UNIT_ATTR } = { TR_ATTR: 'data-st-tr', UNIT_ATTR: 'data-st-unit' };

  const MAX_UNITS = 1200;
  const MAX_VISIT = 25000;
  const MAX_TEXT = 20000;
  const CHUNK_ITEMS = 6;
  const CONCURRENCY = 3;

  let settings = null;
  let enabled = false;
  let runId = 0;
  let observer = null;
  let obsTimer = null;

  let pending = [];
  let activeChunks = 0;
  let stat = { total: 0, done: 0, failed: 0 };

  /* ================================================================ */
  /* 工具                                                              */
  /* ================================================================ */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'TRACK', 'MAP', 'AREA',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'MATH',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'DATALIST',
    'HEAD', 'TITLE', 'META', 'LINK', 'BR', 'HR', 'WBR'
  ]);

  function markUiHost(host) {
    host.id = 'st-ui-root';
    host.setAttribute('data-st-ui', '1');
    return host;
  }

  function normalize(text) {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\f]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function hasTranslationDescendant(el) {
    return !!el.querySelector('[' + TR_ATTR + ']');
  }

  function extractText(el) {
    let raw;
    if (hasTranslationDescendant(el)) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[' + TR_ATTR + ']').forEach((n) => n.remove());
      raw = clone.textContent || '';
    } else {
      raw = el.innerText || el.textContent || '';
    }
    return normalize(raw);
  }

  function looksTranslatable(text) {
    if (!text || text.length < 2 || text.length > MAX_TEXT) return false;

    const latin = (text.match(/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f]/g) || []).length;
    const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;

    if (!latin && !han && !kana && !hangul) return false; // 纯数字 / 符号

    const target = (settings && settings.targetLang) || 'zh-Hans';
    const zhTarget = target === 'zh-Hans' || target === 'zh-Hant';

    if (zhTarget) {
      if (!latin && !kana && !hangul) return false; // 已经全是汉字
      if (han >= 2 && latin < han * 0.3 && kana === 0 && hangul === 0) return false; // 中文正文
    } else if (target === 'en') {
      if (latin >= 2 && han === 0 && kana === 0) return false; // 已经是英文
    }

    // 代码味道太重的内容跳过
    const codeMarks = (text.match(/[{}<>=;]/g) || []).length;
    if (codeMarks > text.length * 0.1) return false;

    return true;
  }

  function shouldSkip(el) {
    if (el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(TR_ATTR) || el.hasAttribute(UNIT_ATTR)) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList && (el.classList.contains('notranslate') || el.classList.contains('st-tr'))) return true;
    if (el.isContentEditable) return true;
    if (el.closest('[contenteditable="true"],[contenteditable=""]')) return true;
    if (el.closest('[' + TR_ATTR + ']')) return true;

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return true;
    }
    if (!cs) return true;
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (cs.whiteSpace === 'pre') return true;
    return false;
  }

  function isLeafBlock(el) {
    for (const child of el.children) {
      if (child.hasAttribute(TR_ATTR)) continue;
      let d;
      try {
        d = getComputedStyle(child).display;
      } catch (e) {
        continue;
      }
      if (!d || d === 'none' || d === 'contents') continue;
      if (!d.startsWith('inline')) return false;
    }
    return true;
  }

  function collectUnits(root) {
    const units = [];
    if (!root) return units;
    let visited = 0;

    const walk = (el) => {
      for (const child of el.children) {
        if (units.length >= MAX_UNITS || visited > MAX_VISIT) return;
        visited++;
        if (shouldSkip(child)) continue;
        if (isLeafBlock(child)) {
          const text = extractText(child);
          if (text && looksTranslatable(text)) units.push({ el: child, text });
        } else {
          walk(child);
        }
      }
    };

    walk(root);
    return units;
  }

  function splitText(text) {
    const LIMIT = 1200;
    if (text.length <= LIMIT) return [text];
    const sentences = text.match(/[^.!?。！？；;\n]+[.!?。！？；;\n]*\s*/g) || [text];
    const out = [];
    let cur = '';
    for (const s of sentences) {
      if (cur && cur.length + s.length > LIMIT) {
        out.push(cur);
        cur = '';
      }
      cur += s;
      if (cur.length > LIMIT * 2) {
        out.push(cur);
        cur = '';
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [text];
  }

  /* ================================================================ */
  /* 影子 DOM UI：进度提示                                              */
  /* ================================================================ */

  const toast = (() => {
    let host = null;
    let box = null;
    let hideTimer = null;

    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      markUiHost(host);
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' +
        '.t{position:fixed;right:20px;bottom:22px;max-width:280px;display:flex;align-items:center;gap:8px;' +
        'padding:9px 14px;border-radius:999px;background:rgba(23,26,33,.92);color:#fff;' +
        'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.28);backdrop-filter:blur(6px);opacity:0;transform:translateY(6px);' +
        'transition:opacity .18s ease,transform .18s ease;pointer-events:none;letter-spacing:.2px}' +
        '.t.on{opacity:1;transform:none}' +
        '.d{width:6px;height:6px;border-radius:50%;background:#60a5fa;flex:none;animation:st-p 1.1s infinite}' +
        '.t.ok .d{background:#34d399;animation:none}' +
        '.t.err .d{background:#f87171;animation:none}' +
        '@keyframes st-p{0%,100%{opacity:.3}50%{opacity:1}}' +
        '</style>' +
        '<div class="t"><span class="d"></span><span class="m"></span></div>';
      (document.body || document.documentElement).appendChild(host);
      box = root.querySelector('.t');
    }

    function show(text, kind, autoHideMs) {
      ensure();
      box.className = 't on' + (kind ? ' ' + kind : '');
      box.querySelector('.m').textContent = text;
      clearTimeout(hideTimer);
      if (autoHideMs) hideTimer = setTimeout(hide, autoHideMs);
    }

    function hide() {
      if (!box) return;
      box.classList.remove('on');
    }

    return { show, hide };
  })();

  /* ================================================================ */
  /* 影子 DOM UI：划词气泡                                              */
  /* ================================================================ */

  const bubble = (() => {
    let host = null;
    let wrap = null;
    let body = null;
    let foot = null;
    let copyBtn = null;
    let currentText = '';
    let token = 0;

    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      markUiHost(host);
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' +
        '.w{position:fixed;display:none;max-width:390px;min-width:150px}' +
        '.w.on{display:block}' +
        '.c{background:#fff;color:#1f2430;border:1px solid rgba(15,23,42,.1);border-radius:12px;' +
        'box-shadow:0 12px 40px rgba(15,23,42,.18);overflow:hidden;' +
        'font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
        '.b{padding:11px 14px;max-height:260px;overflow:auto;word-break:break-word;white-space:pre-wrap}' +
        '.f{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 10px 7px 14px;' +
        'border-top:1px solid rgba(15,23,42,.06);background:#f8fafc}' +
        '.e{font-size:11px;color:#94a3b8;letter-spacing:.3px}' +
        'button{all:unset;cursor:pointer;font-size:12px;color:#2563eb;padding:3px 8px;border-radius:6px}' +
        'button:hover{background:rgba(37,99,235,.1)}' +
        '.ld{display:inline-flex;gap:5px;align-items:center;height:20px}' +
        '.ld i{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:st-b 1.1s infinite}' +
        '.ld i:nth-child(2){animation-delay:.15s}.ld i:nth-child(3){animation-delay:.3s}' +
        '@keyframes st-b{0%,100%{opacity:.25}50%{opacity:1}}' +
        '.eg{color:#dc2626;font-size:13px}' +
        '@media (prefers-color-scheme:dark){.c{background:#1e232d;color:#e8ebf0;border-color:rgba(255,255,255,.09)}' +
        '.f{background:#222834;border-top-color:rgba(255,255,255,.07)}.e{color:#64748b}}' +
        '</style>' +
        '<div class="w"><div class="c"><div class="b"></div>' +
        '<div class="f"><span class="e"></span><button class="cp" type="button">复制</button></div></div></div>';
      (document.body || document.documentElement).appendChild(host);
      wrap = root.querySelector('.w');
      body = root.querySelector('.b');
      foot = root.querySelector('.e');
      copyBtn = root.querySelector('.cp');
      copyBtn.addEventListener('click', () => {
        if (!currentText) return;
        try {
          navigator.clipboard.writeText(currentText);
          copyBtn.textContent = '已复制';
          setTimeout(() => (copyBtn.textContent = '复制'), 1200);
        } catch (e) {
          /* ignore */
        }
      });
    }

    function place(rect) {
      const margin = 8;
      wrap.classList.add('on');
      const w = wrap.offsetWidth;
      const h = wrap.offsetHeight;
      let left = rect.left;
      let top = rect.bottom + margin;
      if (left + w > window.innerWidth - margin) left = window.innerWidth - w - margin;
      if (left < margin) left = margin;
      if (top + h > window.innerHeight - margin) {
        const above = rect.top - h - margin;
        top = above > margin ? above : Math.max(margin, window.innerHeight - h - margin);
      }
      wrap.style.left = Math.round(left) + 'px';
      wrap.style.top = Math.round(top) + 'px';
    }

    function hide() {
      token++;
      currentText = '';
      if (wrap) wrap.classList.remove('on');
    }

    function isVisible() {
      return !!wrap && wrap.classList.contains('on');
    }

    async function show(rect, text, engineLabel) {
      ensure();
      currentText = '';
      body.innerHTML = '<span class="ld"><i></i><i></i><i></i></span>';
      foot.textContent = engineLabel || '翻译中…';
      copyBtn.textContent = '复制';
      place(rect);

      const myToken = ++token;
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'translate', texts: [text], settings: pickSettings() });
      } catch (e) {
        res = { ok: false, error: (e && e.message) || '无法连接后台' };
      }
      if (myToken !== token || !isVisible()) return;

      const out = res && res.ok && res.results && res.results[0];
      if (out) {
        currentText = out;
        body.textContent = out;
        foot.textContent = engineName(res.engine);
      } else {
        body.innerHTML = '<span class="eg">' + escapeHtml((res && res.error) || '翻译失败') + '</span>';
        foot.textContent = '出错了';
      }
      place(rect);
    }

    return { show, hide, isVisible, host: () => host };
  })();

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function engineName(value) {
    const found = (ST.ENGINES || []).find((e) => e.value === value);
    return found ? found.label.replace(/（.*?）/g, '') : value || '';
  }

  /* ================================================================ */
  /* 影子 DOM UI：页面右侧悬浮按钮（本项目唯一的显式入口）                 */
  /* ================================================================ */

  const fab = (() => {
    let host = null;
    let wrap = null;
    let btn = null;
    let ico = null;
    let lbl = null;
    let state = 'idle'; // idle | busy | on | error
    let progress = '';
    let shown = true;
    let pos = null; // { right, top }，viewport 坐标
    let drag = null;
    let swallowClick = false;

    const CSS =
      '.wrap{position:fixed;right:16px;top:38%;z-index:2147483645;' +
      'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
      'transition:opacity .2s ease}' +
      '.wrap.out{opacity:0;pointer-events:none}' +
      '.btn{all:unset;display:flex;align-items:center;height:46px;box-sizing:border-box;padding:0 13px;' +
      'border-radius:999px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;cursor:pointer;' +
      'user-select:none;-webkit-user-select:none;touch-action:none;' +
      'box-shadow:0 6px 20px rgba(37,99,235,.34),0 1px 3px rgba(15,23,42,.18);' +
      'transition:transform .16s ease,box-shadow .16s ease,background .16s ease}' +
      '.btn:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(37,99,235,.42)}' +
      '.btn:active{transform:translateY(0)}' +
      '.ico{width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;' +
      'font-size:13px;font-weight:700;line-height:1}' +
      '.lbl{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;margin-left:0;' +
      'transition:max-width .24s ease,opacity .18s ease,margin-left .24s ease}' +
      '.wrap.open .lbl,.btn:hover .lbl{max-width:160px;opacity:1;margin-left:9px}' +
      '.wrap.on .btn{background:#fff;color:#2563eb;border:1px solid rgba(37,99,235,.26);padding:0 13px;' +
      'box-shadow:0 3px 12px rgba(37,99,235,.16),0 1px 3px rgba(15,23,42,.1)}' +
      '.wrap.on .btn:hover{background:#f5f9ff}' +
      '.wrap.err .btn{background:linear-gradient(135deg,#f87171,#dc2626);' +
      'box-shadow:0 4px 14px rgba(220,38,38,.26)}' +
      '.wrap.dragging .btn{cursor:grabbing;transform:none}' +
      '.dots{display:flex;gap:3px;align-items:center}' +
      '.dots i{width:4px;height:4px;border-radius:50%;background:currentColor;animation:stf 1s infinite}' +
      '.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}' +
      '@keyframes stf{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}' +
      '@media print{.wrap{display:none!important}}';

    function ensure() {
      if (host && host.isConnected) return true;
      if (!document.body && !document.documentElement) return false;
      host = document.createElement('div');
      host.id = 'st-fab-root';
      host.setAttribute('data-st-ui', '1');
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<style>' + CSS + '</style>' +
        '<div class="wrap' + (shown ? '' : ' out') + '"><button class="btn" type="button">' +
        '<span class="ico"></span><span class="lbl"></span></button></div>';
      (document.body || document.documentElement).appendChild(host);

      wrap = root.querySelector('.wrap');
      btn = root.querySelector('.btn');
      ico = root.querySelector('.ico');
      lbl = root.querySelector('.lbl');

      btn.addEventListener('click', onClick);
      btn.addEventListener('pointerdown', onPointerDown);
      btn.addEventListener('pointermove', onPointerMove);
      btn.addEventListener('pointerup', onPointerUp);
      btn.addEventListener('pointercancel', onPointerUp);
      // 别让页面自己的拖拽/选择逻辑接管
      for (const t of ['mousedown', 'mouseup', 'dblclick', 'contextmenu']) {
        btn.addEventListener(t, (e) => e.stopPropagation());
      }
      window.addEventListener('resize', place);

      readPos().then(() => {
        place();
        render();
      });
      render();
      return true;
    }

    async function readPos() {
      try {
        const data = await chrome.storage.local.get('fabPos');
        const p = data && data.fabPos;
        if (p && typeof p.right === 'number' && typeof p.top === 'number') pos = p;
      } catch (e) {
        /* 用默认位置 */
      }
    }

    function place() {
      if (!wrap) return;
      if (pos) {
        const right = Math.min(Math.max(4, pos.right), Math.max(4, window.innerWidth - 56));
        const top = Math.min(Math.max(4, pos.top), Math.max(4, window.innerHeight - 56));
        wrap.style.right = right + 'px';
        wrap.style.top = top + 'px';
      } else {
        wrap.style.right = '16px';
        wrap.style.top = '38%';
      }
    }

    function render() {
      if (!wrap) return;
      wrap.classList.toggle('on', state === 'on');
      wrap.classList.toggle('err', state === 'error');
      wrap.classList.toggle('open', state === 'busy');
      wrap.classList.toggle('out', !shown);

      if (state === 'busy') {
        ico.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        lbl.textContent = progress || '翻译中…';
      } else if (state === 'on') {
        ico.textContent = '原';
        lbl.textContent = '显示原文';
      } else if (state === 'error') {
        ico.textContent = '!';
        lbl.textContent = '重试';
      } else {
        ico.textContent = '译';
        lbl.textContent = '翻译此页';
      }
      btn.title =
        (state === 'on' ? '字幕译：还原原文' : '字幕译：翻译此页') + '（Alt+T，可拖动）';
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      if (swallowClick) {
        swallowClick = false;
        return;
      }
      toggle();
    }

    function onPointerDown(e) {
      if (e.button !== 0) return;
      const r = btn.getBoundingClientRect();
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        w: r.width,
        h: r.height,
        moved: false
      };
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.x) < 4 && Math.abs(e.clientY - drag.y) < 4) return;
        drag.moved = true;
        wrap.classList.add('dragging');
      }
      const left = Math.min(Math.max(4, e.clientX - drag.dx), window.innerWidth - drag.w - 4);
      const top = Math.min(Math.max(4, e.clientY - drag.dy), window.innerHeight - drag.h - 4);
      wrap.style.left = Math.round(left) + 'px';
      wrap.style.top = Math.round(top) + 'px';
      wrap.style.right = 'auto';
    }

    function onPointerUp() {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (!wrap) return;
      wrap.classList.remove('dragging');
      if (!moved) return;
      swallowClick = true;
      const r = btn.getBoundingClientRect();
      pos = {
        right: Math.round(window.innerWidth - r.right),
        top: Math.round(r.top)
      };
      wrap.style.left = 'auto';
      place();
      try {
        chrome.storage.local.set({ fabPos: pos });
      } catch (e) {
        /* ignore */
      }
    }

    function setState(next) {
      state = next;
      if (next !== 'busy') progress = '';
      if (ensure()) render();
    }

    function setProgress(text) {
      progress = text || '';
      if (state === 'busy' && wrap) {
        lbl.textContent = progress || '翻译中…';
      }
    }

    function setVisible(v) {
      shown = !!v;
      if (ensure()) render();
    }

    function destroy() {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      wrap = btn = ico = lbl = null;
    }

    return { ensure, setState, setProgress, setVisible, destroy };
  })();

  /* ================================================================ */
  /* 翻译主流程                                                        */
  /* ================================================================ */

  function pickSettings() {
    return {
      engine: settings.engine,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang,
      llm: settings.llm
    };
  }

  function applyStyleVars() {
    const html = document.documentElement;
    html.style.setProperty('--st-scale', String(settings.fontSize || 1));
    html.setAttribute('data-st-style', settings.textStyle || 'gray');
    html.setAttribute('data-st-border', settings.showBorder === false ? '0' : '1');
  }

  function createNode(unit) {
    const node = document.createElement('span');
    node.className = 'st-tr st-loading';
    node.setAttribute(TR_ATTR, '1');
    node.setAttribute('data-st-rid', String(runId));
    node.innerHTML = '<span class="st-dots"><i></i><i></i><i></i></span>';
    unit.el.appendChild(node);
    return node;
  }

  function addUnits(units) {
    const fresh = [];
    for (const u of units) {
      if (!u.el || !u.el.isConnected) continue;
      if (u.el.hasAttribute(UNIT_ATTR)) continue;
      if (u.el.closest('[' + TR_ATTR + ']')) continue;
      u.el.setAttribute(UNIT_ATTR, '1');
      u.rid = runId;
      const sep = /^zh|^ja|^ko/.test(settings.targetLang || '') ? '' : ' ';
      u.sep = sep;
      u.parts = splitText(u.text).map((t) => ({ text: t, tr: '', state: 'pending', err: null }));
      u.node = createNode(u);
      for (const p of u.parts) fresh.push({ unit: u, part: p });
    }
    if (!fresh.length) return 0;
    pending = pending.concat(fresh);
    stat.total += fresh.length;
    return fresh.length;
  }

  function pump() {
    if (!enabled) return;
    while (activeChunks < CONCURRENCY && pending.length) {
      const chunk = pending.splice(0, CHUNK_ITEMS);
      activeChunks++;
      runChunk(chunk)
        .catch(() => {})
        .finally(() => {
          activeChunks--;
          pump();
          maybeFinish();
        });
    }
    maybeFinish();
  }

  let finishTimer = null;
  function maybeFinish() {
    if (!enabled) return;
    if (pending.length || activeChunks) {
      updateToast();
      return;
    }
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      if (pending.length || activeChunks) return;
      const ok = stat.total - stat.failed;
      if (stat.total === 0) return;
      if (stat.failed && stat.failed === stat.total) {
        fab.setState('error');
        toast.show('翻译失败：' + (lastError || '请检查网络或引擎配置'), 'err', 6000);
      } else if (stat.failed) {
        fab.setState('on');
        toast.show('已翻译 ' + ok + ' 段，' + stat.failed + ' 段失败', 'err', 5000);
      } else {
        fab.setState('on');
        toast.show('已翻译 ' + ok + ' 段 · Alt+T 还原', 'ok', 2400);
      }
    }, 400);
  }

  let lastError = null;

  async function runChunk(chunk) {
    const rid = runId;
    const texts = chunk.map((c) => c.part.text);
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts, settings: pickSettings() });
    } catch (e) {
      res = { ok: false, error: '无法连接后台服务，请刷新页面重试' };
    }
    if (rid !== runId || !enabled) return;

    const ok = !!(res && res.ok);
    if (res && res.error) lastError = res.error;

    chunk.forEach((c, i) => {
      const value = ok && res.results ? String(res.results[i] || '') : '';
      if (value) {
        c.part.tr = value;
        c.part.state = 'done';
      } else {
        c.part.state = 'error';
        c.part.err = (res && res.error) || '空结果';
      }
      stat.done++;
      if (!value) stat.failed++;
      updateUnit(c.unit);
    });
    updateToast();
  }

  function updateUnit(unit) {
    if (!unit.node || !unit.node.isConnected) return;
    const states = unit.parts.map((p) => p.state);
    if (states.indexOf('pending') >= 0) return;

    if (states.indexOf('error') >= 0) {
      const okText = unit.parts
        .filter((p) => p.state === 'done')
        .map((p) => p.tr)
        .join(unit.sep);
      unit.node.className = 'st-tr st-error';
      unit.node.textContent = (okText ? okText + unit.sep : '') + '⚠ 部分内容翻译失败，点击重试';
      unit.node.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        retryUnit(unit);
      };
      return;
    }

    unit.node.className = 'st-tr';
    unit.node.textContent = unit.parts.map((p) => p.tr).join(unit.sep);
    unit.node.onclick = null;
  }

  function retryUnit(unit) {
    if (!enabled) return;
    const again = [];
    for (const p of unit.parts) {
      if (p.state === 'error') {
        p.state = 'pending';
        p.tr = '';
        again.push({ unit, part: p });
      }
    }
    if (!again.length) return;
    unit.node.className = 'st-tr st-loading';
    unit.node.innerHTML = '<span class="st-dots"><i></i><i></i><i></i></span>';
    unit.node.onclick = null;
    stat.failed = Math.max(0, stat.failed - again.length);
    pending = again.concat(pending);
    pump();
  }

  function updateToast() {
    if (!enabled || !stat.total) return;
    const left = stat.total - stat.done;
    if (left <= 0) return;
    toast.show('翻译中 ' + stat.done + ' / ' + stat.total, '', 0);
    fab.setProgress('翻译中 ' + stat.done + '/' + stat.total);
  }

  /* ================================================================ */
  /* 开关                                                              */
  /* ================================================================ */

  async function enable() {
    if (enabled) return;
    if (!settings) settings = await ST.getSettings();
    enabled = true;
    runId++;
    pending = [];
    activeChunks = 0;
    stat = { total: 0, done: 0, failed: 0 };
    lastError = null;

    document.documentElement.setAttribute('data-st-enabled', '1');
    applyStyleVars();
    startObserver();
    fab.setState('busy');

    const units = collectUnits(document.body || document.documentElement);
    if (!units.length) {
      toast.show('这个页面没有找到需要翻译的文字', 'ok', 3000);
      fab.setState('idle');
      reportState();
      return;
    }
    addUnits(units);
    toast.show('翻译中 0 / ' + stat.total, '', 0);
    pump();
    reportState();
  }

  function disable() {
    enabled = false;
    runId++;
    pending = [];
    activeChunks = 0;
    stat = { total: 0, done: 0, failed: 0 };
    document.documentElement.removeAttribute('data-st-enabled');
    stopObserver();
    document.querySelectorAll('[' + TR_ATTR + ']').forEach((n) => n.remove());
    document.querySelectorAll('[' + UNIT_ATTR + ']').forEach((n) => n.removeAttribute(UNIT_ATTR));
    toast.hide();
    bubble.hide();
    fab.setState('idle');
    reportState();
  }

  function toggle() {
    if (enabled) disable();
    else enable();
    return enabled;
  }

  function reportState() {
    try {
      chrome.runtime.sendMessage({ type: 'page-state', enabled }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* ignore */
    }
  }

  /* ================================================================ */
  /* 动态内容跟进                                                      */
  /* ================================================================ */

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      let touched = false;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute && n.hasAttribute(TR_ATTR)) continue;
          if (n.closest && n.closest('[' + TR_ATTR + ']')) continue;
          touched = true;
          break;
        }
        if (touched) break;
      }
      if (!touched) return;
      clearTimeout(obsTimer);
      obsTimer = setTimeout(() => {
        if (!enabled) return;
        const units = collectUnits(document.body || document.documentElement);
        const added = addUnits(units);
        if (added) pump();
      }, 550);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(obsTimer);
  }

  /* ================================================================ */
  /* 划词翻译                                                          */
  /* ================================================================ */

  function inOurUI(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.some((n) => n && n.getAttribute && n.getAttribute('data-st-ui') === '1');
  }

  function onMouseDown(e) {
    if (inOurUI(e)) return;
    if (bubble.isVisible()) bubble.hide();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && bubble.isVisible()) bubble.hide();
  }

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text || text.length > 1200) return null;
    return { text, range: sel.getRangeAt(0) };
  }

  function onMouseUp(e) {
    if (inOurUI(e)) return;
    if (!settings || settings.selectionTranslate === false) return;
    // 拖拽选择结束再处理，避免与点击冲突
    setTimeout(() => {
      const picked = selectionText();
      if (!picked) {
        bubble.hide();
        return;
      }
      const rect = picked.range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      bubble.show(rect, picked.text, '翻译中…');
    }, 20);
  }

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('scroll', () => bubble.hide(), true);

  /* ================================================================ */
  /* 消息与初始化                                                      */
  /* ================================================================ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'toggle') {
      toggle();
      sendResponse({ enabled, translating: !!(pending.length || activeChunks) });
      return true;
    }
    if (msg.type === 'set-enabled') {
      if (msg.enabled && !enabled) enable();
      else if (!msg.enabled && enabled) disable();
      sendResponse({ enabled, translating: !!(pending.length || activeChunks) });
      return true;
    }
    if (msg.type === 'state') {
      sendResponse({ enabled, translating: !!(pending.length || activeChunks), total: stat.total, done: stat.done });
      return true;
    }
    if (msg.type === 'translate-selection') {
      (async () => {
        if (!settings) settings = await ST.getSettings();
        const picked = selectionText();
        if (!picked) {
          sendResponse({ ok: false, error: '没有选中文字' });
          return;
        }
        const rect = picked.range.getBoundingClientRect();
        bubble.show(rect, picked.text, '翻译中…');
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (msg.type === 'fab') {
      fab.setVisible(!!msg.show);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const k of Object.keys(changes)) patch[k] = changes[k].newValue;
    settings = ST.mergeSettings(Object.assign({}, settings || {}, patch));
    if (enabled) applyStyleVars();
    fab.setVisible(settings.showFab !== false);
  });

  (async () => {
    try {
      settings = await ST.getSettings();
    } catch (e) {
      settings = ST.mergeSettings({});
    }
    if (settings.showFab !== false) fab.ensure();
    if (ST.isAutoSite(location.hostname, settings.autoSites)) {
      setTimeout(() => {
        if (!enabled) enable();
      }, 500);
    }
  })();
})();
