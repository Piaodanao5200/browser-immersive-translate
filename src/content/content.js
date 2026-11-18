/* 字幕译 - 内容脚本：段落收集、译文插入、划词翻译、快捷键开关 */
(() => {
  'use strict';

  if (window.__ST_CONTENT_LOADED__) return;
  window.__ST_CONTENT_LOADED__ = true;

  // 自己是不是内嵌 frame（评论区、嵌入文档常在同源/跨域 iframe 里）
  const IN_FRAME = (() => {
    try {
      return window.top !== window;
    } catch (e) {
      return true; // 跨域访问 top 会抛错，抛了就是子 frame
    }
  })();

  // 播放器 / 验证码 / 广告 / 统计这类 frame 里没有可读正文，进去只会白耗性能
  function skipThisFrame() {
    if (!IN_FRAME) return false;
    const h = location.hostname;
    const p = location.pathname;
    if (/^(www\.)?youtube(-nocookie)?\.com$/i.test(h) && /^\/(embed|live_embed)/i.test(p)) return true;
    if (/(^|\.)player\.vimeo\.com$/i.test(h)) return true;
    if (
      /(^|\.)(recaptcha\.net|gstatic\.com|google\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|hotjar\.com|facebook\.com|stripe\.com|paypal\.com)$/i.test(
        h
      )
    ) {
      return true;
    }
    return false;
  }

  if (skipThisFrame()) return;

  const ST = window.ST;
  const { TR_ATTR, UNIT_ATTR } = { TR_ATTR: 'data-st-tr', UNIT_ATTR: 'data-st-unit' };

  const MAX_UNITS = 1200;
  const MAX_VISIT = 25000;
  const MAX_TEXT = 20000;
  const CHUNK_ITEMS = 24;
  const CONCURRENCY = 3;

  let settings = null;
  let enabled = false;
  let runId = 0;
  let observer = null;
  let obsTimer = null;

  let pending = [];
  let activeChunks = 0;
  let stat = { total: 0, done: 0, failed: 0 };
  let walkStats = { visited: 0, units: 0, hitLimit: false, hitVisit: false };
  let failedSamples = [];
  /* 没翻出来的单元：全部跑完后自动再试几轮，仍然不行才提示 */
  let failedUnits = new Set();
  let autoRetryRound = 0;
  let lastRetryAt = 0;
  let forceNext = false;
  const AUTO_RETRY_MAX = 4;
  const AUTO_RETRY_DELAY = [700, 2200, 6000, 14000];
  let fallbackNoticed = false;
  let lastCollect = {};

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

  /* 按钮类控件：正文遍历跳过，改由 collectControls 走「内联小字」通道 */
  const CONTROL_SELECTOR = [
    'button',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="switch"]',
    'summary'
  ].join(',');

  const MAX_CONTROLS = 600;
  const CONTROL_MAX_TEXT = 120; // 按钮文字太长（整段导航）就不内联
  const ATTR_MAX_TEXT = 80; // 占位符 / 选项值上限

  function isControl(el) {
    return !!(el && el.matches && el.matches(CONTROL_SELECTOR));
  }

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

  /**
   * 站点常给整页（html / body / 布局容器）挂 `translate="no"` 或 `.notranslate`，
   * 目的是挡浏览器「自动翻译」——因为那种会原地改写文本节点，Safari 上的 React 站点更容易崩。
   * 我们只是往后面追加译文节点、不动原文，所以不该被这种整页级别的标记拦住：
   * 一旦拦住，正文通道整棵子树被跳过（属性通道不受影响），表现就是
   * 「占位符、下拉选项翻出来了，正文一个字没翻」。
   * 只尊重「局部」标记（单个代码片段、品牌名、邮箱这类）。
   */
  function respectsNoTranslate(el) {
    const T = el.tagName;
    if (T === 'HTML' || T === 'BODY' || T === 'MAIN' || T === 'ARTICLE') return false;
    if (el.getAttribute('role') === 'main') return false;
    // 标记的容器里装着大段正文/多个段落 → 站点是在挡整个翻译工具，不是在保护某一段文本
    if (el.querySelector('h1,h2,h3,h4,p,article,main,li,blockquote,[role="main"]')) return false;
    return true;
  }

  /** 返回跳过原因（字符串），可翻译则返回 null。诊断与正式流程共用一套判断。 */
  function skipReason(el) {
    if (el.nodeType !== 1) return 'not-element';
    if (SKIP_TAGS.has(el.tagName)) return 'skip-tag:' + el.tagName.toLowerCase();
    if (isControl(el)) return 'control'; // 由 collectControls 单独处理
    if (el.hasAttribute(TR_ATTR) || el.hasAttribute(UNIT_ATTR)) return 'already-unit';
    if (el.getAttribute('translate') === 'no' && respectsNoTranslate(el)) return 'translate-no';
    if (el.classList && el.classList.contains('st-tr')) return 'notranslate';
    if (el.classList && el.classList.contains('notranslate') && respectsNoTranslate(el)) return 'notranslate';
    if (el.isContentEditable) return 'editable';
    if (el.closest('[contenteditable="true"],[contenteditable=""]')) return 'editable-parent';
    if (el.closest('[' + TR_ATTR + ']')) return 'inside-tr';

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return 'style-error';
    }
    if (!cs) return 'style-error';
    if (cs.display === 'none') return 'display-none';
    // visibility:hidden 不跳过：轮播的非当前页、淡入前的图层都属于这类，
    // 它们在页面里已经排好版，跳过之后等用户真的看到时又不会补翻。
    if (cs.whiteSpace === 'pre') return 'ws-pre';
    return null;
  }

  function shouldSkip(el) {
    return !!skipReason(el);
  }

  /**
   * 外层容器只包着一个按钮/链接时（`<div><button>Newsletter</button></div>`），
   * 块级通道会把这段文字再翻一遍，页面上就出现第二行重复译文。
   * 控件通道已经管它了，这里直接让位。
   */
  function controlDominant(el, text) {
    let ctl;
    try {
      ctl = el.querySelector(CONTROL_SELECTOR);
    } catch (e) {
      return false;
    }
    if (!ctl) return false;
    // 把控件整棵子树摘掉，看还剩多少自己的文字；几乎不剩说明这层只是「套壳」
    const clone = el.cloneNode(true);
    clone.querySelectorAll(CONTROL_SELECTOR).forEach((n) => n.remove());
    const rest = normalize(clone.textContent || '');
    // 只剩一两个符号（箭头、分隔点）也算「只是套壳」；但带真实文字（如 "Tools … hide"）还是要翻
    return rest.length < 3;
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
    const stats = { visited: 0, units: 0, hitLimit: false, hitVisit: false };
    walkStats = stats;
    if (!root) return units;
    let visited = 0;

    const walk = (el) => {
      for (const child of el.children) {
        if (units.length >= MAX_UNITS || visited > MAX_VISIT) {
          if (units.length >= MAX_UNITS) stats.hitLimit = true;
          if (visited > MAX_VISIT) stats.hitVisit = true;
          return;
        }
        visited++;
        stats.visited = visited;
        if (shouldSkip(child)) continue;
        if (isLeafBlock(child)) {
          const text = extractText(child);
          if (text && looksTranslatable(text) && !controlDominant(child, text)) {
            units.push({ el: child, text });
          }
        } else {
          walk(child);
        }
      }
    };

    walk(root);
    stats.units = units.length;
    return units;
  }

  const EDGE_JUNK = new Set(' \t\r\n\u00a0-–—·•|\\/<>‹›«»„“”"\'`~!@#$%^&*+=_,.;:?！？。，、；：…（）()[]{}【】');

  /**
   * 按钮里常带文字图标（‹› + − ⋯ → 等），innerText 会把它们一起读出来，
   * 发给引擎后译文里又带回来，看着像重复。翻译前把首尾的纯符号削掉。
   */
  function cleanControlText(text) {
    const s = String(text || '');
    let i = 0;
    let j = s.length;
    while (i < j && EDGE_JUNK.has(s[i])) i++;
    while (j > i && EDGE_JUNK.has(s[j - 1])) j--;
    return s.slice(i, j).trim();
  }

  function shouldSkipControl(el) {
    if (!el.isConnected) return true;
    if (el.hasAttribute(UNIT_ATTR) || el.hasAttribute(TR_ATTR)) return true;
    if (el.closest('[' + TR_ATTR + ']')) return true;
    if (el.closest('[data-st-ui]')) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return true;
    }
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return true;
    return false;
  }

  /** 按钮类控件：译文以「内联小字」追加在原文后面，原文不动 */
  function collectControls(root) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
      if (out.length >= MAX_CONTROLS) break;
      if (shouldSkipControl(el)) continue;
      const text = cleanControlText(normalize(el.innerText || el.textContent || ''));
      if (!text || text.length > CONTROL_MAX_TEXT) continue;
      if (!looksTranslatable(text)) continue;
      out.push({ el, text, kind: 'inline' });
    }
    return out;
  }

  /** 表单控件：占位符、提交按钮文字、下拉选项，结果写成「原文 · 译文」 */
  function collectAttrUnits(root) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    const add = (el, attr, text, limit) => {
      if (out.length >= MAX_CONTROLS) return;
      if (!el.isConnected) return;
      if (el.hasAttribute(UNIT_ATTR) || el.hasAttribute('data-st-attr')) return;
      if (!text || text.length > limit) return;
      if (!looksTranslatable(text)) return;
      out.push({ el, text, kind: 'attr', attr, orig: text });
    };

    root.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((el) => {
      add(el, 'placeholder', normalize(el.getAttribute('placeholder') || ''), ATTR_MAX_TEXT);
    });
    root.querySelectorAll('input[type="submit"],input[type="button"],input[type="reset"]').forEach((el) => {
      add(el, 'value', normalize(el.getAttribute('value') || el.value || ''), 40);
    });
    root.querySelectorAll('select option').forEach((el) => {
      add(el, 'text', normalize(el.textContent || ''), 60);
    });
    return out;
  }

  /** 正文段落 + 按钮控件 + 表单控件，一次收齐 */
  function collectAll(root) {
    return collectUnits(root).concat(collectControls(root), collectAttrUnits(root));
  }

  /** 诊断：走一遍同样的规则，统计并采样「有文字却没被翻译」的元素，用于线上排查 */
  function diagnose() {
    const res = {
      blocks: 0, // 走到叶子块、有文字、需要翻译的块
      withUnit: 0, // 已建单元且有译文（或属性型已写回）
      dropped: 0, // 建了单元但译文被判为等价后撤掉
      reasons: {},
      samples: [],
      failed: failedSamples.slice(0, 12),
      run: Object.assign({}, lastCollect, {
        pending: pending.length,
        active: activeChunks,
        total: stat.total,
        done: stat.done,
        failed: stat.failed,
        loadingNodes: document.querySelectorAll('[' + TR_ATTR + '].st-loading').length
      })
    };
    const note = (reason, el, text) => {
      res.reasons[reason] = (res.reasons[reason] || 0) + 1;
      if (res.samples.length < 120) {
        res.samples.push({
          reason,
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 70),
          text: String(text || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)
        });
      }
    };
    const walk = (el) => {
      for (const child of el.children) {
        if (child.hasAttribute(TR_ATTR)) continue;
        if (child.hasAttribute(UNIT_ATTR)) {
          // 已处理过：确认它是否真的拿到了译文
          if (child.hasAttribute('data-st-attr') || child.querySelector('[' + TR_ATTR + ']')) res.withUnit++;
          else res.dropped++;
          continue;
        }
        const reason = skipReason(child);
        if (reason) {
          if (reason !== 'inside-tr' && reason !== 'already-unit') note(reason, child);
          continue;
        }
        if (isLeafBlock(child)) {
          res.blocks++;
          const text = extractText(child);
          if (!text) {
            note('empty', child, '');
            continue;
          }
          if (!looksTranslatable(text)) {
            note('lang', child, text);
            continue;
          }
          if (controlDominant(child, text)) {
            res.reasons['control-wrap'] = (res.reasons['control-wrap'] || 0) + 1;
            continue;
          }
          note('MISSED', child, text);
        } else {
          walk(child);
        }
      }
    };
    walk(document.body || document.documentElement);
    res.translatedNodes = document.querySelectorAll('[' + TR_ATTR + ']').length;
    return res;
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
      if (IN_FRAME) return; // 子 frame 里不弹提示，整页只需要一条
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
      if (IN_FRAME) return false; // 子 frame 里根本不建悬浮按钮
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
      // 还有没翻出来的段落时，按钮就是「重试」，别一点就把整页还原了
      if (failedUnits.size && !pending.length && !activeChunks) {
        autoRetryRound = 0;
        forceNext = true; // 用户亲手点的重试：别受后台熔断窗口限制
        const n = retryAllFailed();
        if (n) {
          toast.show('正在重试 ' + n + ' 段…', '', 0);
          setState('busy');
          return;
        }
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
      if (IN_FRAME) v = false; // 悬浮按钮只在主页面出现，iframe 里放一个会跟着框架乱飘
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
    if (unit.kind === 'attr') return null; // 属性型（占位符/选项/提交按钮）没有节点
    const node = document.createElement('span');
    node.className = (unit.kind === 'inline' ? 'st-tr-inline' : 'st-tr') + ' st-loading';
    node.setAttribute(TR_ATTR, '1');
    node.setAttribute('data-st-rid', String(runId));
    node.innerHTML = '<span class="st-dots"><i></i><i></i><i></i></span>';
    unit.el.appendChild(node);
    return node;
  }

  function addUnits(units) {
    const fresh = [];
    // 先翻用户此刻看得见的：长页面（问答站、文档目录）整页一轮要几十秒，
    // 让首屏先出译文，剩下的在后台继续补。
    if (units.length > 40) {
      const vh = window.innerHeight || 800;
      const rank = (u) => {
        try {
          const r = u.el.getBoundingClientRect();
          return r.bottom > -240 && r.top < vh + 480 ? 0 : 1;
        } catch (e) {
          return 1;
        }
      };
      const scored = units.map((u) => ({ u, k: rank(u) }));
      scored.sort((a, b) => a.k - b.k);
      units = scored.map((x) => x.u);
    }
    for (const u of units) {
      if (!u.el || !u.el.isConnected) continue;
      if (u.el.hasAttribute(UNIT_ATTR)) continue;
      if (u.el.closest('[' + TR_ATTR + ']')) continue;
      u.el.setAttribute(UNIT_ATTR, '1');
      if (u.kind === 'attr') {
        u.el.setAttribute('data-st-attr', u.attr);
        u.el.setAttribute('data-st-orig', u.orig);
      }
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
          activeChunks = Math.max(0, activeChunks - 1);
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
      sweepDuplicates();
      if (stat.total === 0) return;

      const bad = failedParts();
      const ok = stat.total - bad;

      // 还有没翻出来的：先自己再试几轮（限流、瞬时 5xx、网络抖一下都靠它自愈），
      // 页面上不出现任何红字，用户该看到的是译文而不是报错。
      if (bad && !contextDead && autoRetryRound < AUTO_RETRY_MAX) {
        const delay = AUTO_RETRY_DELAY[Math.min(autoRetryRound, AUTO_RETRY_DELAY.length - 1)];
        autoRetryRound++;
        toast.show('还有 ' + bad + ' 段没翻出来，正在自动重试…', '', 0);
        fab.setState('busy');
        setTimeout(() => {
          if (enabled && !pending.length && !activeChunks) retryAllFailed();
        }, delay);
        return;
      }

      if (bad && bad === stat.total) {
        fab.setState('error');
        toast.show('翻译失败：' + (lastError || '请检查网络或引擎配置'), 'err', 7000);
      } else if (bad) {
        fab.setState('error');
        toast.show('已翻译 ' + ok + ' 段 · ' + bad + ' 段没翻出来，点右侧按钮重试', 'err', 6000);
      } else {
        fab.setState('on');
        toast.show('已翻译 ' + ok + ' 段 · Alt+T 还原', 'ok', 2400);
      }
    }, 400);
  }

  /** 当前仍然失败的段数（按 part 计，和进度里的数字口径一致） */
  function failedParts() {
    let n = 0;
    for (const u of failedUnits) {
      for (const p of u.parts) if (p.state === 'error') n++;
    }
    return n;
  }

  let lastError = null;
  /** 扩展被重新加载过：内容脚本成了孤儿，只能刷新页面 */
  let contextDead = false;

  /**
   * 和后台通信。MV3 的 service worker 会休眠，刚唤醒那一下 sendMessage 偶尔直接失败
   * （"message port closed"）——以前一个分段失败就整组标红，整页前半截就这么废了。
   * 这里对这种瞬时失败补一次；扩展真的被重新加载过则记住，别再无谓重试。
   */
  async function askBackground(texts, force) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (contextDead) return { ok: false, error: '扩展已更新，请刷新页面（F5）后继续' };
      try {
        const res = await chrome.runtime.sendMessage({ type: 'translate', texts, settings: pickSettings(), force });
        if (res == null) {
          // 后台没给回应（SW 正在重启）：等一下再来一次
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 420));
            continue;
          }
          return { ok: false, error: '后台没有响应，稍后自动重试' };
        }
        return res;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/context invalidated|Extension context/i.test(msg)) {
          contextDead = true;
          return { ok: false, error: '扩展已更新，请刷新页面（F5）后继续' };
        }
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 420));
          continue;
        }
        return { ok: false, error: '无法连接后台服务，稍后自动重试' };
      }
    }
    return { ok: false, error: '翻译请求失败' };
  }

  async function runChunk(chunk) {
    const rid = runId;
    const texts = chunk.map((c) => c.part.text);
    const force = forceNext;
    forceNext = false;
    const res = await askBackground(texts, force);
    if (rid !== runId || !enabled) return;

    const ok = !!(res && res.ok);
    if (res && res.error) lastError = res.error;

    // 首选引擎挂了、已经自动换引擎：提示一次，别让用户以为「翻译坏了」
    if (res && res.fellBack && !fallbackNoticed) {
      fallbackNoticed = true;
      const from = engineName(settings.engine) || '首选引擎';
      const to = engineName(res.engine) || '备用引擎';
      toast.show(from + ' 不可用，已自动改用' + to + (res.chainNote ? '：' + res.chainNote : ''), 'err', 6500);
    }

    chunk.forEach((c, i) => {
      const value = ok && res.results ? String(res.results[i] || '') : '';
      if (value) {
        c.part.tr = value;
        c.part.state = 'done';
      } else {
        c.part.state = 'error';
        c.part.err = (res && res.error) || '空结果';
        if (failedSamples.length < 25) {
          failedSamples.push({
            text: String(c.part.text).replace(/\s+/g, ' ').slice(0, 70),
            len: c.part.text.length,
            err: c.part.err
          });
        }
      }
      stat.done++;
      if (!value) stat.failed++;
      updateUnit(c.unit);
    });
    updateToast();
  }

  /** 译文和原文一样（HTML→HTML、Web API→Web API）就别显示了，省得看着像复制两遍 */
  function worthShowing(tr, src) {
    const t = String(tr || '').trim();
    if (!t) return false;
    const target = (settings && settings.targetLang) || 'zh-Hans';
    if (/^zh/.test(target) && !/[\u3400-\u9fff]/.test(t)) return false;
    if (/^ja/.test(target) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(t)) return false;
    if (/^ko/.test(target) && !/[\uac00-\ud7af]/.test(t)) return false;
    const strip = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
    return strip(t) !== strip(src);
  }

  function updateUnit(unit) {
    const states = unit.parts.map((p) => p.state);
    if (states.indexOf('pending') >= 0) return;

    const okText = unit.parts
      .filter((p) => p.state === 'done')
      .map((p) => p.tr)
      .join(unit.sep);
    const failed = states.indexOf('error') >= 0;

    // 属性型：直接写回属性，没有节点可操作
    if (unit.kind === 'attr') {
      if (okText && worthShowing(okText, unit.orig)) {
        applyAttr(unit, okText);
        failedUnits.delete(unit);
      } else if (failed) {
        failedUnits.add(unit);
      }
      return;
    }

    if (failed) failedUnits.add(unit);
    if (!unit.node || !unit.node.isConnected) return;
    const base = unit.kind === 'inline' ? 'st-tr-inline' : 'st-tr';

    // 同一区域里已经有同样文字的内联译文（外层套壳 + 内层按钮各翻了一次），
    // 这一行就不出了，否则页面上会连着出现两遍同一句话
    if (!failed && unit.kind !== 'inline' && duplicatedInline(unit, okText)) {
      unit.node.remove();
      unit.node = null;
      return;
    }

    if (!failed && !worthShowing(okText, unit.text)) {
      // 引擎原样返回，直接撤掉占位节点
      unit.node.remove();
      unit.node = null;
      return;
    }

    if (failed) {
      // 失败时不往正文里塞「翻译失败」的大字：原文还在，用户照样能读。
      // 单元挂在 failedUnits 里，等自动重试轮次；重试成功再补上译文。
      failedUnits.add(unit);
      if (okText) {
        // 长段落只挂了其中一段：先把翻好的部分显示出来，剩下的重试补齐
        unit.node.className = base;
        unit.node.textContent = okText;
      } else {
        unit.node.className = base + ' st-error st-failed';
        unit.node.textContent = '';
      }
      unit.node.onclick = null;
      return;
    }

    failedUnits.delete(unit);
    unit.node.className = base;
    unit.node.textContent = okText;
    unit.node.onclick = null;
    clampIfClipped(unit);
  }

  /** 找出真把节点「从底部切掉」的祖先（overflow:hidden 且节点底部超出它） */
  function clipAncestor(node) {
    let p = node.parentElement;
    for (let i = 0; i < 6 && p && p !== document.body; i++) {
      const cs = getComputedStyle(p);
      const cut = cs.overflowY === 'hidden' || cs.overflow === 'hidden';
      if (cut) {
        const r = p.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        if (nr.bottom <= r.bottom + 4) return null; // 没被切，别往上找了
        if (nr.top >= r.top - 2) return p; // 从底部切掉一截
      }
      p = p.parentElement;
    }
    return null;
  }

  /**
   * 固定高度的盒子（小组件标题、聊天气泡）塞不下多出来的一行，
   * 硬插进去只会被裁成半个字，比不翻还难看。
   * 遇到这种就把块撤掉，把译文挂到原文的 title 上：版式不动，鼠标停上去能看全文。
   */
  function clampIfClipped(unit) {
    const node = unit.node;
    if (!node || !unit.el || !node.isConnected) return;
    if (unit.kind === 'inline' || unit.kind === 'attr') return;
    const box = clipAncestor(node);
    if (!box) return;
    const nr = node.getBoundingClientRect();
    const visible = box.getBoundingClientRect().bottom - nr.top;
    if (nr.height <= 0 || visible >= nr.height * 0.75) return;

    const tr = node.textContent || '';
    const el = unit.el;
    node.remove();
    unit.node = null;
    if (!tr || !el.setAttribute) return;
    if (!el.hasAttribute('data-st-tip-orig')) {
      el.setAttribute('data-st-tip-orig', el.getAttribute('title') || '');
    }
    el.setAttribute('data-st-tip', '1');
    el.setAttribute('title', tr);
  }

  /** 全部翻完后统一扫一遍：同一区域里块级译文和内联译文重复的，删掉块级那一行 */
  function sweepDuplicates() {
    document.querySelectorAll('.st-tr').forEach((n) => {
      const t = normalize(n.textContent || '');
      if (!t) return;
      const scope = n.parentElement && n.parentElement.parentElement;
      if (!scope) return;
      const dup = [...scope.querySelectorAll('.st-tr-inline')].some((x) => normalize(x.textContent || '') === t);
      if (dup) n.remove();
    });
  }

  function duplicatedInline(unit, text) {
    const scope = unit.el && unit.el.parentElement;
    if (!scope || !text) return false;
    const want = normalize(text);
    for (const n of scope.querySelectorAll('.st-tr-inline')) {
      if (normalize(n.textContent || '') === want) return true;
    }
    return false;
  }

  /** 把译文写回属性 / 选项文字，页面自己改过原文就不动 */
  function applyAttr(unit, tr) {
    const el = unit.el;
    if (!el || !el.isConnected || !tr) return;
    if (unit.attr === 'placeholder') {
      if (normalize(el.getAttribute('placeholder') || '') !== unit.orig) return;
      el.setAttribute('placeholder', unit.orig + ' · ' + tr);
    } else if (unit.attr === 'value') {
      const now = normalize(el.getAttribute('value') || el.value || '');
      if (now !== unit.orig) return;
      el.value = unit.orig + ' · ' + tr;
    } else if (unit.attr === 'text') {
      if (normalize(el.textContent || '') !== unit.orig) return;
      el.textContent = unit.orig + ' · ' + tr;
    }
  }

  /** 把所有失败的段重新排队（自动重试和「点按钮重试」共用） */
  function retryAllFailed() {
    if (!enabled) return 0;
    const again = [];
    for (const unit of [...failedUnits]) {
      if (!unit.el || !unit.el.isConnected) {
        failedUnits.delete(unit);
        continue;
      }
      let any = false;
      for (const p of unit.parts) {
        if (p.state === 'error') {
          p.state = 'pending';
          p.tr = '';
          p.err = null;
          again.push({ unit, part: p });
          any = true;
        }
      }
      if (!any) failedUnits.delete(unit);
      else if (unit.node) {
        const base = unit.kind === 'inline' ? 'st-tr-inline' : 'st-tr';
        unit.node.className = base + ' st-loading';
        unit.node.innerHTML = '<span class="st-dots"><i></i><i></i><i></i></span>';
        unit.node.onclick = null;
      }
    }
    if (!again.length) {
      stat.failed = 0;
      return 0;
    }
    pending = again.concat(pending);
    pump();
    return again.length;
  }

  function retryUnit(unit) {
    if (!enabled) return;
    const again = [];
    for (const p of unit.parts) {
      if (p.state === 'error') {
        p.state = 'pending';
        p.tr = '';
        p.err = null;
        again.push({ unit, part: p });
      }
    }
    if (!again.length) return;
    const base = unit.kind === 'inline' ? 'st-tr-inline' : 'st-tr';
    if (unit.node) {
      unit.node.className = base + ' st-loading';
      unit.node.innerHTML = '<span class="st-dots"><i></i><i></i><i></i></span>';
      unit.node.onclick = null;
    }
    stat.failed = Math.max(0, stat.failed - again.length);
    pending = again.concat(pending);
    pump();
  }

  function updateToast() {
    if (!enabled || !stat.total) return;
    stat.failed = failedParts();
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
    syncFrames();
    runId++;
    pending = [];
    activeChunks = 0;
    stat = { total: 0, done: 0, failed: 0 };
    lastError = null;
    failedSamples = [];
    failedUnits = new Set();
    autoRetryRound = 0;
    fallbackNoticed = false;

    document.documentElement.setAttribute('data-st-enabled', '1');
    applyStyleVars();
    startObserver();
    scheduleBootstrapRescans();
    fab.setState('busy');

    const units = (() => {
      try {
        return collectAll(document.body || document.documentElement);
      } catch (e) {
        lastCollect = { at: Date.now(), error: (e && e.message) || String(e) };
        return [];
      }
    })();
    lastCollect = Object.assign({ at: Date.now(), bodyNull: !document.body }, walkStats, {
      units: units.length,
      error: lastCollect.error
    });
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

  /** 把占位符 / 选项文字 / 提交按钮文字还原成原文 */
  function restoreAttrs() {
    document.querySelectorAll('[data-st-attr]').forEach((el) => {
      const attr = el.getAttribute('data-st-attr');
      const orig = el.getAttribute('data-st-orig') || '';
      try {
        if (attr === 'placeholder') el.setAttribute('placeholder', orig);
        else if (attr === 'value') {
          el.setAttribute('value', orig);
          el.value = orig;
        } else if (attr === 'text') el.textContent = orig;
      } catch (e) {
        /* ignore */
      }
      el.removeAttribute('data-st-attr');
      el.removeAttribute('data-st-orig');
    });
  }

  /** 还原被改成 title 提示的译文（固定高度盒子里那些） */
  function restoreTips() {
    document.querySelectorAll('[data-st-tip]').forEach((el) => {
      const orig = el.getAttribute('data-st-tip-orig') || '';
      if (orig) el.setAttribute('title', orig);
      else el.removeAttribute('title');
      el.removeAttribute('data-st-tip');
      el.removeAttribute('data-st-tip-orig');
    });
  }

  function disable() {
    enabled = false;
    syncFrames();
    runId++;
    pending = [];
    activeChunks = 0;
    stat = { total: 0, done: 0, failed: 0 };
    failedUnits = new Set();
    autoRetryRound = 0;
    document.documentElement.removeAttribute('data-st-enabled');
    stopObserver();
    document.querySelectorAll('[' + TR_ATTR + ']').forEach((n) => n.remove());
    restoreAttrs();
    document.querySelectorAll('[' + UNIT_ATTR + ']').forEach((n) => n.removeAttribute(UNIT_ATTR));
    restoreTips();
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

  /** 主 frame 把开关状态推给同页面的其它 iframe（评论区、嵌入文档都在里面） */
  function syncFrames() {
    if (IN_FRAME) return; // 只有主 frame 发，否则各个 frame 互相推会打转
    try {
      chrome.runtime.sendMessage({ type: 'sync-enabled', enabled }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* ignore */
    }
  }

  function reportState() {
    if (IN_FRAME) return; // 徽标只跟主 frame 的进度，别被 iframe 反复覆盖
    try {
      chrome.runtime.sendMessage({ type: 'page-state', enabled }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* ignore */
    }
  }

  /* ================================================================ */
  /* 动态内容跟进                                                      */
  /* ================================================================ */

  let rescanTimer = null;
  let scrollTimer = null;
  let lastRescan = 0;
  let bootstrapTimers = [];

  /** 增量补扫：内容变可见（display 切换）、懒加载、轮播切页都靠它兜底 */
  function scheduleRescan(delay) {
    if (!enabled) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescan, delay == null ? 600 : delay);
  }

  function rescan() {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastRescan < 250) {
      scheduleRescan(320);
      return;
    }
    lastRescan = now;

    // 之前失败过一批：用户回来滚动/切标签页时顺手再试一次（网络恢复多半就在这时候）
    if (failedUnits.size && !pending.length && !activeChunks && now - lastRetryAt > 15000) {
      lastRetryAt = now;
      if (retryAllFailed()) return;
    }

    let units = [];
    try {
      units = collectAll(document.body || document.documentElement);
    } catch (e) {
      return;
    }
    const added = addUnits(units);
    if (added) pump();
  }

  /** 我们自己插入的节点引起的变动不算页面更新，否则会自己触发自己 */
  function inOurNodes(n) {
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (!el || !el.closest) return false;
    if (el.hasAttribute && (el.hasAttribute(TR_ATTR) || el.closest('[data-st-ui]'))) return true;
    return !!el.closest('[' + TR_ATTR + ']');
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      let touched = false;
      for (const m of mutations) {
        if (m.type === 'characterData') {
          const t = m.target;
          const host = t && (t.nodeType === 3 ? t.parentElement : t);
          if (!host || inOurNodes(host)) continue;
          if (host.closest('input,textarea,[contenteditable=""],[contenteditable="true"]')) continue;
          if (String(t.nodeValue || '').trim().length < 2) continue;
          touched = true;
          break;
        }
        for (const n of m.addedNodes) {
          if (inOurNodes(n)) continue;
          touched = true;
          break;
        }
        if (touched) break;
      }
      if (!touched) return;
      scheduleRescan(600);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('click', onInteract, true);
    document.addEventListener('keydown', onInteract, true);
    document.addEventListener('visibilitychange', onVisibleChange);
    window.addEventListener('online', onOnline);
  }

  function onScroll() {
    if (!enabled) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => scheduleRescan(500), 320);
  }

  function onInteract() {
    // 点开菜单、切标签页、展开折叠：内容常常只是把 display 从 none 改回来，没有 DOM 新增
    if (!enabled) return;
    scheduleRescan(320);
  }

  function onVisibleChange() {
    if (!enabled) return;
    if (document.visibilityState === 'visible') scheduleRescan(600);
  }

  /** 断网恢复：之前没翻出来的立刻再试一次，不用等用户去点按钮 */
  function onOnline() {
    if (!enabled) return;
    if (!failedUnits.size || pending.length || activeChunks) return;
    forceNext = true;
    autoRetryRound = 0;
    lastRetryAt = Date.now();
    const n = retryAllFailed();
    if (n) toast.show('网络已恢复，重新翻译 ' + n + ' 段…', '', 0);
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(obsTimer);
    clearTimeout(rescanTimer);
    clearTimeout(scrollTimer);
    bootstrapTimers.forEach((id) => clearTimeout(id));
    bootstrapTimers = [];
    window.removeEventListener('scroll', onScroll, { passive: true });
    document.removeEventListener('click', onInteract, true);
    document.removeEventListener('keydown', onInteract, true);
    document.removeEventListener('visibilitychange', onVisibleChange);
    window.removeEventListener('online', onOnline);
  }

  /** 开翻之后的几次兜底补扫：异步渲染、轮播自动切页、懒加载都能收进来 */
  function scheduleBootstrapRescans() {
    bootstrapTimers.forEach((id) => clearTimeout(id));
    bootstrapTimers = [1800, 5000, 12000, 26000].map((ms) =>
      setTimeout(() => {
        if (enabled) rescan();
      }, ms)
    );
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
    if (msg.type === 'diag') {
      try {
        sendResponse({ ok: true, data: diagnose() });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
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

  /** SPA 换页（URL 变了但没整页刷新）：旧译文留在原地会串味，直接重来 */
  let lastHref = location.href;
  function checkSpaNav() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (!enabled) return;
    disable();
    setTimeout(() => {
      if (!enabled) enable();
    }, 350);
  }
  setInterval(checkSpaNav, 1200);

  (async () => {
    try {
      settings = await ST.getSettings();
    } catch (e) {
      settings = ST.mergeSettings({});
    }

    // 子 frame：不自己判断该不该翻，问后台「这个标签页现在开着吗」。
    // 评论框这类 iframe 往往在主页面开翻之后才加载，靠主 frame 广播会漏掉。
    if (IN_FRAME) {
      try {
        chrome.runtime.sendMessage({ type: 'frame-ready' }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.enabled && !enabled) enable();
        });
      } catch (e) {
        /* ignore */
      }
      return;
    }

    fab.setVisible(settings.showFab !== false);
    // 主动报一次状态：后台 service worker 可能已经休眠，这条消息能把它叫醒，
    // 弹窗/快捷键之后才能立刻接管。
    reportState();
    if (ST.isAutoSite(location.hostname, settings.autoSites)) {
      setTimeout(() => {
        if (!enabled) enable();
      }, 500);
    }
  })();
})();
