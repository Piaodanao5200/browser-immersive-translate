/* 字幕译 - 共享配置与工具（background / content / popup / options 共用） */
(function (g) {
  'use strict';

  const DEFAULTS = {
    engine: 'microsoft', // microsoft | llm | google | mymemory
    targetLang: 'zh-Hans',
    sourceLang: 'auto',
    llm: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash', // deepseek-chat 已于 2026-07-24 弃用
      apiKey: ''
    },
    fontSize: 1.0, // 译文字号相对倍数（相对原文）
    textStyle: 'gray', // gray | inherit | blue
    showBorder: true,
    selectionTranslate: true,
    showFab: true, // 页面右侧的悬浮翻译按钮
    autoSites: []
  };

  const LANGS = [
    { value: 'zh-Hans', label: '简体中文' },
    { value: 'zh-Hant', label: '繁體中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'ru', label: 'Русский' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'es', label: 'Español' }
  ];

  const ENGINES = [
    { value: 'microsoft', label: '微软翻译（免费 · 无需配置）' },
    { value: 'llm', label: 'AI 模型（自备 API Key）' },
    { value: 'google', label: 'Google 翻译（免费 · 国内需代理）' },
    { value: 'mymemory', label: 'MyMemory（免费 · 限流备用）' }
  ];

  // 每种目标语言在各引擎下的语言代码
  const LANG_CODES = {
    'zh-Hans': { microsoft: 'zh-Hans', mymemory: 'zh-CN', google: 'zh-CN', llm: '简体中文' },
    'zh-Hant': { microsoft: 'zh-Hant', mymemory: 'zh-TW', google: 'zh-TW', llm: '繁體中文' },
    en: { microsoft: 'en', mymemory: 'en', google: 'en', llm: 'English' },
    ja: { microsoft: 'ja', mymemory: 'ja', google: 'ja', llm: '日本語' },
    ko: { microsoft: 'ko', mymemory: 'ko', google: 'ko', llm: '한국어' },
    ru: { microsoft: 'ru', mymemory: 'ru', google: 'ru', llm: 'Русский' },
    fr: { microsoft: 'fr', mymemory: 'fr', google: 'fr', llm: 'Français' },
    de: { microsoft: 'de', mymemory: 'de', google: 'de', llm: 'Deutsch' },
    es: { microsoft: 'es', mymemory: 'es', google: 'es', llm: 'Español' }
  };

  function langCode(to, engine) {
    const row = LANG_CODES[to] || LANG_CODES['zh-Hans'];
    return row[engine] || row.microsoft;
  }

  /** FNV-1a 32 位哈希，用于缓存键 */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + '_' + str.length.toString(36);
  }

  /** 合并默认设置 */
  function mergeSettings(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    s.llm = Object.assign({}, DEFAULTS.llm, (raw && raw.llm) || {});
    if (!Array.isArray(s.autoSites)) s.autoSites = [];
    return s;
  }

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (data) => resolve(mergeSettings(data)));
      } catch (e) {
        resolve(mergeSettings({}));
      }
    });
  }

  function saveSettings(patch) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set(patch, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  /** 站点匹配：支持 *.example.com / example.com */
  function matchSite(hostname, pattern) {
    if (!pattern) return false;
    const p = String(pattern).trim().toLowerCase();
    if (!p) return false;
    const host = hostname.toLowerCase();
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    return host === p || host.endsWith('.' + p);
  }

  function isAutoSite(hostname, autoSites) {
    return (autoSites || []).some((p) => matchSite(hostname, p));
  }

  g.ST = {
    DEFAULTS,
    LANGS,
    ENGINES,
    LANG_CODES,
    langCode,
    hash,
    mergeSettings,
    getSettings,
    saveSettings,
    matchSite,
    isAutoSite
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
