/* 字幕译 - 后台 Service Worker：多引擎翻译调度 + 缓存 + 快捷键分发 */
importScripts('shared.js');

const { langCode, hash, mergeSettings } = self.ST;

/* ------------------------------------------------------------------ */
/* 缓存：内存 Map + 定期落盘 storage.local                             */
/* ------------------------------------------------------------------ */
const CACHE_KEY = 'tcache';
const CACHE_MAX = 4000;

let memCache = null;
let flushTimer = null;

/** 每个标签页的翻译开关状态；后加载的 iframe 靠它判断要不要跟着翻 */
const tabEnabled = new Map();
chrome.tabs.onRemoved.addListener((tabId) => tabEnabled.delete(tabId));

async function loadCache() {
  if (memCache) return memCache;
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    memCache = new Map(Object.entries(data[CACHE_KEY] || {}));
  } catch (e) {
    memCache = new Map();
  }
  return memCache;
}

function cacheSet(key, value) {
  if (!memCache) return;
  memCache.delete(key);
  memCache.set(key, value);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushCache();
  }, 3000);
}

async function flushCache() {
  if (!memCache) return;
  try {
    let entries = [...memCache.entries()];
    if (entries.length > CACHE_MAX) {
      entries = entries.slice(entries.length - CACHE_MAX);
      memCache = new Map(entries);
    }
    await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
  } catch (e) {
    /* 超出配额时静默失败，不影响翻译 */
  }
}

/* ------------------------------------------------------------------ */
/* 引擎实现                                                            */
/* ------------------------------------------------------------------ */

/** 带超时的 fetch：接口挂住时不能让整页一直转圈 */
async function tfetch(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** 微软 Edge 网页翻译免鉴权端点（2026 可用，需浏览器 UA） */
async function engineMicrosoft(texts, to) {
  const params = new URLSearchParams({ to: langCode(to, 'microsoft'), 'api-version': '3.0' });
  const url = 'https://edge.microsoft.com/translate/translatetext?' + params.toString();
  const res = await tfetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(texts)
  }, 20000);
  if (!res.ok) throw new Error('微软接口 HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('微软接口返回结构异常');
  return data.map((d) => {
    const t = d && d.translations && d.translations[0] && d.translations[0].text;
    return typeof t === 'string' ? t : '';
  });
}

/** Google 免费端点（国内通常不通，多作为备用） */
async function engineGoogle(texts, to) {
  const out = [];
  const tl = langCode(to, 'google');
  for (const text of texts) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(tl) +
      '&dt=t&q=' +
      encodeURIComponent(text);
    const res = await tfetch(url, null, 15000);
    if (!res.ok) throw new Error('Google 接口 HTTP ' + res.status);
    const data = await res.json();
    const seg = (data && data[0]) || [];
    out.push(seg.map((s) => (s && s[0]) || '').join(''));
  }
  return out;
}

/** 解码 HTML 实体（MyMemory 会返回 &#39; 之类的实体） */
function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** MyMemory 免费接口（限流严格，单次上限约 500 字符，仅作最后兜底） */
async function engineMyMemory(texts, to) {
  const out = [];
  const tl = langCode(to, 'mymemory');
  for (const text of texts) {
    const pieces = splitByLimit(text, 460);
    const translated = [];
    for (const piece of pieces) {
      const url =
        'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(piece) +
        '&langpair=' +
        encodeURIComponent('en|' + tl);
      const res = await tfetch(url, null, 15000);
      if (!res.ok) throw new Error('MyMemory 接口 HTTP ' + res.status);
      const data = await res.json();
      const t = data && data.responseData && data.responseData.translatedText;
      if (typeof t !== 'string') throw new Error('MyMemory 接口返回异常');
      translated.push(decodeEntities(t));
    }
    out.push(translated.join(' '));
  }
  return out;
}

/** OpenAI 兼容大模型接口，一次请求翻多段 */
async function engineLLM(texts, to, settings) {
  const llm = settings.llm || {};
  if (!llm.apiKey) throw new Error('未填写 AI 接口密钥，请到设置页配置');
  // 本地先拦一道：控制台里最容易复制错的就是「密钥 ID」那一列（UUID 格式）
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(llm.apiKey).trim())) {
    throw new Error('这是「密钥 ID」（UUID），不是密钥本身。请到控制台复制 sk- 开头的完整密钥。');
  }
  if (/\*/.test(llm.apiKey)) {
    throw new Error('密钥里有星号（脱敏显示值）。请点控制台的「显示 / 复制」取完整密钥，或新建一个。');
  }
  if (!llm.baseUrl) throw new Error('未填写 AI 接口地址');
  const target = langCode(to, 'llm');
  const system =
    '你是一名专业翻译引擎。用户会发来一个 JSON 字符串数组，请把每一项翻译成' +
    target +
    '。要求：\n' +
    '1. 只输出 JSON 字符串数组，长度与输入严格一致；不要输出任何解释、序号或 markdown 代码块；\n' +
    '2. 术语前后一致，专有名词保留原文或使用通行译名；\n' +
    '3. 保留原文的标点语气与换行，不要合并或拆分条目；\n' +
    '4. 若某项本身已经是' +
    target +
    '，原样返回。';

  const body = {
    model: llm.model || 'deepseek-flash',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(texts) }
    ],
    temperature: 0.2,
    stream: false
  };

  // DeepSeek V4 / 智谱 GLM-4.5+ 默认开思考模式，翻译场景只会更慢更贵，显式关掉。
  // 该字段只有这两家认，其它厂商传了可能 400，所以按域名判断。
  if (/deepseek\.com|bigmodel\.cn|z\.ai/i.test(llm.baseUrl)) {
    body.thinking = { type: 'disabled' };
  }

  const url = String(llm.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const res = await tfetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + llm.apiKey
    },
    body: JSON.stringify(body)
  }, 45000);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(describeLLMError(res.status, detail));
  }
  const data = await res.json();
  const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return parseLLMArray(content, texts.length);
}

/**
 * 把各家的报错翻译成人能看懂的一句话。
 */
function describeLLMError(status, detail) {
  const body = String(detail || '');
  if (status === 401) {
    return 'AI 接口 401：密钥无效。确认复制的是控制台里 sk- 开头的完整密钥（不是「密钥 ID」，也不带 ****），且该密钥未被删除或过期。';
  }
  if (status === 402) return 'AI 接口 402：账户余额不足，请先充值。';
  if (status === 403) return 'AI 接口 403：该密钥无权访问此模型或地区受限。';
  if (status === 404) return 'AI 接口 404：接口地址或模型名不对。地址要填到 /v1 结尾，模型名以控制台为准。';
  if (status === 429) return 'AI 接口 429：请求过于频繁或额度已用尽，稍后重试。';
  return 'AI 接口 HTTP ' + status + (body ? '：' + body.slice(0, 120) : '');
}

function parseLLMArray(content, expect) {
  let s = String(content).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.length === expect) return arr.map((x) => String(x == null ? '' : x));
  } catch (e) {
    /* 落到下面的退化解析 */
  }
  const lines = String(content)
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+\s*[.、)]|[-*])\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === expect) return lines;
  throw new Error('AI 返回内容无法解析为 JSON 数组');
}

/* ------------------------------------------------------------------ */
/* 调度：分片 + 缓存 + 失败降级                                        */
/* ------------------------------------------------------------------ */

function splitByLimit(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

function groupIndices(indices, texts, maxChars, maxItems) {
  const groups = [];
  let cur = [];
  let len = 0;
  for (const i of indices) {
    const l = texts[i].length;
    if (cur.length && (len + l > maxChars || cur.length >= maxItems)) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += l;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const AUTO_CHAIN = ['microsoft', 'google', 'mymemory'];

const FATAL_LLM = /40[123]|余额|密钥|api ?key|unauthorized|invalid.?(token|key)/i;

/** AI 引擎刚被证伪（Key 无效 / 余额不足）时，短时间内直接跳过它，别每个分段都先试一遍 */
let llmBlockedUntil = 0;

function buildChain(engine, opts) {
  // AI 引擎排第一，但必须留后路：Key 失效 / 余额不足 / 模型下线时，
  // 不能让整页一个字都翻不出来。
  if (engine === 'llm') {
    const skip = !!(opts && opts.skipLLM);
    return skip ? ['microsoft', 'google', 'mymemory'] : ['llm', 'microsoft', 'google', 'mymemory'];
  }
  const chain = [engine];
  for (const e of AUTO_CHAIN) if (e !== engine) chain.push(e);
  return chain;
}

async function callEngine(engine, texts, to, settings) {
  switch (engine) {
    case 'microsoft':
      return engineMicrosoft(texts, to);
    case 'google':
      return engineGoogle(texts, to);
    case 'mymemory':
      return engineMyMemory(texts, to);
    case 'llm':
      return engineLLM(texts, to, settings);
    default:
      throw new Error('未知翻译引擎：' + engine);
  }
}

/**
 * 同一个引擎先重试一次，仍然失败就把大包拆成两半分别再要。
 * 批量发包偶尔会被整包拒绝（限流 / 瞬时 5xx），拆开后基本都能成，
 * 不至于因为一个整包失败就掉到更慢的备用引擎。
 */
/** 最近失败记录：排查「为什么这些段没翻出来」用 */
const recentErrors = [];
function logError(engine, payload, err) {
  recentErrors.push({
    t: Date.now(),
    engine,
    n: payload.length,
    chars: payload.reduce((a, x) => a + x.length, 0),
    msg: String((err && err.message) || err).slice(0, 120)
  });
  if (recentErrors.length > 60) recentErrors.shift();
}

/** 被限流时全局退避一小段，别把后面的请求一起打挂 */
let cooldownUntil = 0;
function noteThrottle() {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + 800);
}
async function waitCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * 熔断：引擎整体连不上（断网、代理拦截、DNS 挂了）时，
 * 每个分段都老老实实重试 3 次再拆包，整页要转两分钟圈才出结果。
 * 这里统计网络类失败，短时间内攒够次数就先停一会儿，直接失败交给界面重试。
 */
const NET_ERR = /failed to fetch|network|abort|timeout|超时|ERR_|connection|econn/i;
let netFailAt = [];
let offlineUntil = 0;

function noteNetFail() {
  const now = Date.now();
  netFailAt = netFailAt.filter((t) => now - t < 60000);
  netFailAt.push(now);
  if (netFailAt.length >= 6) offlineUntil = now + 10000;
}
function noteNetOk() {
  netFailAt = [];
  offlineUntil = 0;
}

async function callWithRetry(engine, payload, to, settings, depth = 0) {
  if (Date.now() < offlineUntil) throw new Error('翻译引擎暂时连不上，稍后会自动重试');
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitCooldown();
    try {
      const out = await callEngine(engine, payload, to, settings);
      if (!Array.isArray(out) || out.length !== payload.length) throw new Error('引擎返回条数不匹配');
      // 返回了一堆空串＝这次其实没翻成（被限流、被拦、语言不支持都会这样）。
      // 以前这里当成成功，整组就这样空着，也不会去试下一个引擎。
      if (!out.some((x) => String(x == null ? '' : x).trim())) throw new Error('引擎返回空结果');
      noteNetOk();
      return out;
    } catch (err) {
      lastErr = err;
      logError(engine, payload, err);
      const msg = String((err && err.message) || '');
      // 认证/余额问题是确定的失败，重试和拆包都救不回来，立刻让位给备用引擎
      if (engine === 'llm' && FATAL_LLM.test(msg)) {
        llmBlockedUntil = Date.now() + 5 * 60 * 1000;
        throw err;
      }
      if (NET_ERR.test(msg)) noteNetFail();
      if (/429|5\d\d|too many|rate|abort|timeout|超时/i.test(msg)) noteThrottle();
    }
    await new Promise((r) => setTimeout(r, 240 * (attempt + 1) + Math.random() * 320));
  }
  if (payload.length > 1 && depth < 3) {
    const mid = Math.ceil(payload.length / 2);
    const left = await callWithRetry(engine, payload.slice(0, mid), to, settings, depth + 1);
    const right = await callWithRetry(engine, payload.slice(mid), to, settings, depth + 1);
    return left.concat(right);
  }
  throw lastErr || new Error('翻译失败');
}

async function translateTexts(texts, rawSettings) {
  const settings = mergeSettings(rawSettings);
  const to = settings.targetLang || 'zh-Hans';
  const engine = settings.engine || 'microsoft';
  const modelTag = engine === 'llm' ? '|' + (settings.llm.model || '') : '';

  const cache = await loadCache();
  const results = new Array(texts.length).fill('');
  const missing = [];

  texts.forEach((text, i) => {
    const key = engine + modelTag + '|' + to + '|' + hash(text);
    const hit = cache.get(key);
    if (typeof hit === 'string' && hit) {
      results[i] = hit;
      cache.delete(key);
      cache.set(key, hit);
    } else {
      missing.push(i);
    }
  });

  let usedEngine = engine;
  let lastError = null;

  if (missing.length) {
    // 免费端点单次能吃 30 段，批量发包能把整页耗时压到几秒；AI 引擎仍按小批，省 token 也更稳
    const isLLM = engine === 'llm';
    const groups = groupIndices(missing, texts, isLLM ? 1600 : 6000, isLLM ? 8 : 24);
    const chain = buildChain(engine, { skipLLM: Date.now() < llmBlockedUntil });
    let cursor = 0;

    const worker = async () => {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        const payload = group.map((i) => texts[i]);
        let ok = false;
        for (const candidate of chain) {
          try {
            const out = await callWithRetry(candidate, payload, to, settings);
            if (!Array.isArray(out) || out.length !== payload.length) throw new Error('引擎返回条数不匹配');

            // 整组里个别条目空着（常见于超长段或被单独限流）：单独再要一次，
            // 别让这几十个字拖累整组都显示成「没翻出来」。
            const blanks = [];
            out.forEach((v, k) => {
              if (!String(v == null ? '' : v).trim()) blanks.push(k);
            });
            if (blanks.length && blanks.length < out.length) {
              try {
                const again = await callWithRetry(
                  candidate,
                  blanks.map((k) => payload[k]),
                  to,
                  settings,
                  1
                );
                blanks.forEach((k, j) => {
                  const v = String(again[j] == null ? '' : again[j]);
                  if (v) out[k] = v;
                });
              } catch (e) {
                /* 补不回来就留空，内容脚本那边会再重试一轮 */
              }
            }

            group.forEach((idx, k) => {
              const value = String(out[k] == null ? '' : out[k]);
              results[idx] = value;
              if (value) {
                cacheSet(engine + modelTag + '|' + to + '|' + hash(texts[idx]), value);
              }
            });
            usedEngine = candidate;
            ok = true;
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (!ok) {
          // 该片全部引擎失败：留空，由内容脚本标记为重试
          group.forEach((idx) => {
            results[idx] = '';
          });
        }
      }
    };

    const parallel = Math.min(isLLM ? 2 : 4, groups.length);
    await Promise.all(Array.from({ length: parallel }, worker));
  }

  const failed = results.some((r) => !r);
  const fellBack = usedEngine !== engine;
  return {
    results,
    engine: usedEngine,
    error: failed && lastError ? String(lastError.message || lastError) : null,
    fellBack,
    // 降级时把首选引擎的失败原因带回去，界面上要说清楚为什么换了引擎
    chainNote: fellBack && lastError ? String(lastError.message || lastError) : null
  };
}

/* ------------------------------------------------------------------ */
/* 消息处理                                                            */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'translate': {
          // 用户手点的重试：清掉熔断和 AI 屏蔽窗口，立刻真打一次
          if (msg.force) {
            offlineUntil = 0;
            netFailAt = [];
            llmBlockedUntil = 0;
            cooldownUntil = 0;
          }
          const r = await translateTexts(msg.texts || [], msg.settings);
          sendResponse({
            ok: true,
            results: r.results,
            engine: r.engine,
            error: r.error,
            fellBack: r.fellBack,
            chainNote: r.chainNote
          });
          break;
        }
        case 'test-engine': {
          const r = await translateTexts(['Hello world, this is a translation test.'], msg.settings);
          sendResponse({
            ok: !!r.results[0],
            text: r.results[0] || '',
            engine: r.engine,
            error: r.error || (r.results[0] ? null : '引擎无返回内容')
          });
          break;
        }
        case 'engine-log': {
          sendResponse({ ok: true, list: recentErrors.slice(-40) });
          break;
        }
        case 'clear-cache': {
          memCache = new Map();
          await chrome.storage.local.remove(CACHE_KEY);
          sendResponse({ ok: true });
          break;
        }
        case 'cache-info': {
          const c = await loadCache();
          sendResponse({ ok: true, size: c.size });
          break;
        }
        case 'sync-enabled': {
          // 某个 frame 里点了开关（悬浮按钮 / 右键 / 快捷键落地在主页），
          // 把状态同步给同标签页的其它 frame，评论区这类 iframe 才不会留着译文。
          const tabId = sender.tab && sender.tab.id;
          if (typeof tabId === 'number') {
            try {
              await chrome.tabs.sendMessage(tabId, { type: 'set-enabled', enabled: !!msg.enabled });
            } catch (e) {
              /* 没有其它 frame，或标签页已关闭 */
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'frame-ready': {
          // 子 frame 刚注入：告诉它当前标签页是不是开着翻译
          const tabId = sender.tab && sender.tab.id;
          let on = typeof tabId === 'number' && tabEnabled.get(tabId) === true;
          if (typeof tabId === 'number' && !tabEnabled.has(tabId)) {
            // 后台重启过、状态表空了：直接问主 frame
            try {
              const st = await chrome.tabs.sendMessage(tabId, { type: 'state' }, { frameId: 0 });
              on = !!(st && st.enabled);
              tabEnabled.set(tabId, on);
            } catch (e) {
              /* 主 frame 还没就绪 */
            }
          }
          sendResponse({ ok: true, enabled: on });
          break;
        }
        case 'page-state': {
          // 内容脚本上报开关状态，用于在图标上显示角标
          const tabId = sender.tab && sender.tab.id;
          if (typeof tabId === 'number') {
            tabEnabled.set(tabId, !!msg.enabled);
            try {
              await chrome.action.setBadgeText({ tabId, text: msg.enabled ? 'ON' : '' });
              await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
            } catch (e) {
              /* 标签页已关闭 */
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'open-options': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});

/* ------------------------------------------------------------------ */
/* 快捷键 Alt+T：转发给内容脚本；页面未注入时兜底注入                    */
/* ------------------------------------------------------------------ */
async function ensureContentScript(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['src/content/content.css'] });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/shared.js', 'src/content/content.js']
  });
}

/* ------------------------------------------------------------------ */
/* 向标签页投递消息；内容脚本缺失时（安装前已打开的页面）先补注入          */
/* ------------------------------------------------------------------ */
async function deliver(tabId, msg, opts) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, opts);
  } catch (e) {
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, msg, opts);
  }
}

/* ------------------------------------------------------------------ */
/* 右键菜单：给「找不到按钮」的用户一个入口                              */
/* ------------------------------------------------------------------ */
function setupMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create(
        { id: 'st-toggle', title: '字幕译：翻译此页 / 还原原文', contexts: ['page', 'frame'] },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        { id: 'st-selection', title: '字幕译：翻译选中的文字', contexts: ['selection'] },
        () => void chrome.runtime.lastError
      );
    });
  } catch (e) {
    /* ignore */
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab && tab.id;
  if (typeof tabId !== 'number') return;
  try {
    if (info.menuItemId === 'st-selection') {
      // 在哪个 frame 里选的字就发给哪个 frame，跨域 iframe 里的正文也能划词翻
      await deliver(tabId, { type: 'translate-selection' }, typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined);
    } else if (info.menuItemId === 'st-toggle') {
      // 只让主 frame 翻一次，再由它把状态同步给其它 frame，避免每个 frame 各自翻转
      await deliver(tabId, { type: 'toggle' }, { frameId: 0 });
    }
  } catch (e) {
    /* chrome:// 等受限页面无法注入 */
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-page-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') return;

  try {
    // 主 frame 翻，再由它广播给 iframe（评论区、嵌入文档）
    await deliver(tab.id, { type: 'toggle' }, { frameId: 0 });
  } catch (e) {
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    } catch (_) {}
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  loadCache();
});

chrome.runtime.onStartup.addListener(() => setupMenus());

setupMenus();
loadCache();
