/**
 * 端到端验证：用 Edge 真实加载扩展，通过 CDP 触发翻译并截图
 * 用法：node tools/e2e.mjs   （需先启动 http://127.0.0.1:8765 静态服务）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT_DIR = 'D:/浏览器翻译插件';
const PORT = 9333;
const DEMO = 'http://127.0.0.1:8765/test/demo.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/浏览器翻译插件/test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 25000, step = 250) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(step);
  }
  throw new Error('等待超时: ' + (lastErr && lastErr.message));
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('ws error'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, ws };
}

async function evalOn(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-'));
const browser = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1280,1000',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

let swClient;
let pageClient;

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  console.log('浏览器已启动');

  // 页面
  const pageTarget = await waitFor(async () => (await targets()).find((t) => t.type === 'page'));
  pageClient = await cdp(pageTarget.webSocketDebuggerUrl);
  await pageClient.send('Page.enable');
  await pageClient.send('Runtime.enable');
  await pageClient.send('Page.navigate', { url: DEMO });
  await sleep(2500);

  const pageInfo = await evalOn(pageClient, `({ title: document.title, url: location.href, p: document.querySelectorAll('p').length })`);
  console.log('当前页面:', JSON.stringify(pageInfo));

  // 扩展 Service Worker
  const swTarget = await waitFor(async () =>
    (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'))
  );
  console.log('扩展已加载:', swTarget.url);
  swClient = await cdp(swTarget.webSocketDebuggerUrl);

  const swReady = await evalOn(swClient, `(async () => {
    const tabs = await chrome.tabs.query({});
    return {
      perms: chrome.runtime.getManifest().permissions,
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }))
    };
  })()`);
  console.log('后台视角:', JSON.stringify(swReady));

  const tab = (swReady.tabs || []).find((t) => (t.url || '').includes('demo.html')) || (swReady.tabs || [])[0];
  check('后台可枚举到测试页标签', !!tab, JSON.stringify(tab));
  if (!tab) throw new Error('没有可用标签页');

  // 开启翻译（等价于点弹窗里的“翻译此页”）
  const t0 = Date.now();
  const on = await evalOn(
    swClient,
    `(async () => await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: true }))()`
  );
  check('内容脚本响应开关指令', !!(on && on.enabled), JSON.stringify(on));

  // 等待翻译完成（不再有 loading）
  await waitFor(async () => {
    const s = await evalOn(
      pageClient,
      `(() => ({ total: document.querySelectorAll('[data-st-tr]').length, loading: document.querySelectorAll('[data-st-tr].st-loading').length }))()`
    );
    return s.total > 0 && s.loading === 0 ? s : null;
  }, 30000, 500);
  const elapsed = Date.now() - t0;

  const stats = await evalOn(
    pageClient,
    `(() => {
      const all = [...document.querySelectorAll('[data-st-tr]')];
      const err = all.filter((n) => n.classList.contains('st-error'));
      const empty = all.filter((n) => !n.textContent.trim());
      const sample = all.slice(0, 3).map((n) => n.textContent.trim());
      return { count: all.length, errors: err.length, empty: empty.length, sample };
    })()`
  );
  check('译文节点已插入', stats.count >= 10, `共 ${stats.count} 段，耗时 ${elapsed}ms`);
  check('没有失败的段落', stats.errors === 0 && stats.empty === 0, `失败 ${stats.errors}，空白 ${stats.empty}`);
  check('译文内容是中文', /[\u4e00-\u9fff]/.test(stats.sample.join('')), JSON.stringify(stats.sample));

  // 原文是否保留
  const originalIntact = await evalOn(
    pageClient,
    `(() => {
      const h1 = document.querySelector('h1');
      const own = [...h1.childNodes].filter((n) => !(n.nodeType === 1 && n.hasAttribute('data-st-tr')));
      return {
        h1raw: own.map((n) => n.textContent).join('').trim(),
        h1HasTranslation: !!h1.querySelector('[data-st-tr]'),
        translationInside: h1.querySelector('[data-st-tr]') ? h1.querySelector('[data-st-tr]').textContent.trim() : ''
      };
    })()`
  );
  check(
    '原文文字未被替换',
    originalIntact.h1raw === 'Why Bilingual Reading Beats Translation Apps' && originalIntact.h1HasTranslation,
    originalIntact.h1raw + ' | 译文：' + originalIntact.translationInside
  );

  // 已是中文的段落应跳过
  const zhSkipped = await evalOn(
    pageClient,
    `(() => {
      const p = [...document.querySelectorAll('p')].find((el) => el.textContent.includes('这一段本来就是中文'));
      return p ? !!p.querySelector('[data-st-tr]') : 'not found';
    })()`
  );
  check('中文段落被正确跳过', zhSkipped === false, String(zhSkipped));

  // 代码块应跳过
  const codeSkipped = await evalOn(
    pageClient,
    `(() => {
      const pre = document.querySelector('pre');
      return { has: !!pre.querySelector('[data-st-tr]'), tagged: pre.hasAttribute('data-st-unit') };
    })()`
  );
  check('代码块未被翻译', codeSkipped.has === false && codeSkipped.tagged === false, JSON.stringify(codeSkipped));

  // 动态插入的段落
  const dynamicOk = await evalOn(
    pageClient,
    `(() => {
      const p = [...document.querySelectorAll('p')].find((el) => el.textContent.includes('did not exist when the page first loaded'));
      return p ? !!p.querySelector('[data-st-tr]') : 'not found';
    })()`
  );
  check('延迟插入的动态段落被增量翻译', dynamicOk === true, String(dynamicOk));

  await pageClient.send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
    fs.writeFileSync(path.join(OUT, 'shot-page.png'), Buffer.from(r.data, 'base64'));
  });

  // 划词翻译
  await evalOn(
    pageClient,
    `(() => {
      const p = [...document.querySelectorAll('p')].find((el) => el.textContent.includes('Reading a foreign language'));
      const range = document.createRange();
      range.selectNodeContents(p);
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, 120);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
      return true;
    })()`
  );
  await sleep(2500);
  const bubbleInfo = await evalOn(
    pageClient,
    `(() => {
      const hosts = [...document.querySelectorAll('[data-st-ui]')];
      for (const h of hosts) {
        const w = h.shadowRoot && h.shadowRoot.querySelector('.w');
        if (w && w.classList.contains('on')) {
          const r = w.getBoundingClientRect();
          return { on: true, text: h.shadowRoot.querySelector('.b').textContent.trim(), rect: { w: Math.round(r.width), h: Math.round(r.height) } };
        }
      }
      return { on: false };
    })()`
  );
  check('划词气泡弹出并给出译文', bubbleInfo.on && /[\u4e00-\u9fff]/.test(bubbleInfo.text || ''), JSON.stringify(bubbleInfo).slice(0, 160));

  await pageClient.send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
    fs.writeFileSync(path.join(OUT, 'shot-bubble.png'), Buffer.from(r.data, 'base64'));
  });

  const full = await pageClient.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'shot-full.png'), Buffer.from(full.data, 'base64'));

  // 关闭翻译
  await evalOn(swClient, `(async () => await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: false }))()`);
  await sleep(600);
  const afterOff = await evalOn(
    pageClient,
    `(() => ({
      tr: document.querySelectorAll('[data-st-tr]').length,
      unit: document.querySelectorAll('[data-st-unit]').length,
      text: document.querySelector('h1').textContent.trim(),
      html: document.documentElement.getAttribute('data-st-enabled')
    }))()`
  );
  check(
    '关闭后译文与标记全部清除',
    afterOff.tr === 0 && afterOff.unit === 0 && !afterOff.html,
    JSON.stringify(afterOff)
  );

  const cacheInfo = await evalOn(
    swClient,
    `(async () => {
      const data = await chrome.storage.local.get('tcache');
      const n = Object.keys(data.tcache || {}).length;
      return { size: n };
    })()`
  );
  check('翻译缓存已写入', !!(cacheInfo && cacheInfo.size > 0), JSON.stringify(cacheInfo));
} catch (e) {
  check('测试流程未中断', false, e.message);
} finally {
  try {
    if (pageClient) pageClient.ws.close();
    if (swClient) swClient.ws.close();
  } catch (e) {}
  browser.kill('SIGKILL');
  await sleep(800);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 项通过`);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length) console.log('未通过：' + failed.join('、'));
  process.exit(failed.length ? 1 : 0);
}
