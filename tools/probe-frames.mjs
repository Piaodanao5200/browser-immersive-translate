/**
 * 逐帧探针：看某个页面的译文落在哪些 frame 里、哪些 frame 一个字都没翻
 *   node tools/probe-frames.mjs https://example.com/page
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '..');
const PORT = 9600 + Math.floor(Math.random() * 300);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_TARGET = process.argv[2];
if (!URL_TARGET) {
  console.error('用法: node tools/probe-frames.mjs <url>');
  process.exit(1);
}

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  };
  return {
    ws,
    on: (fn) => listeners.push(fn),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      })
  };
}

async function evalOn(c, expr, ctxId, ms = 20000) {
  const params = { expression: expr, awaitPromise: true, returnByValue: true };
  if (ctxId) params.contextId = ctxId;
  const r = await Promise.race([
    c.send('Runtime.evaluate', params),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), ms))
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(fn, timeout = 30000, label = '') {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error('等待超时: ' + label + (lastErr ? ' — ' + lastErr.message : ''));
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-probe-'));
const browser = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--disable-sync',
    '--disable-features=msEdgeIdentityFeature,msSyncConsent',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

const FRAME_STATE = `(() => {
  const trs = [...document.querySelectorAll('[data-st-tr]')];
  const bodyText = (document.body && document.body.innerText) || '';
  const cjk = (bodyText.match(/[\\u4e00-\\u9fa5]/g) || []).length;
  const latin = (bodyText.match(/[A-Za-z]/g) || []).length;
  return {
    href: location.href.slice(0, 120),
    loaded: !!window.__ST_CONTENT_LOADED__,
    shadowHosts: [...document.querySelectorAll('*')].filter(e => e.shadowRoot).length,
    bodyLen: bodyText.length,
    cjk, latin,
    tr: trs.length,
    iframes: document.querySelectorAll('iframe').length,
    iframeSrcs: [...document.querySelectorAll('iframe')].map(f => (f.src || '(no src)').slice(0, 100)).slice(0, 8)
  };
})()`;

try {
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).ok,
    40000,
    'browser'
  );
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browserCdp = await cdp(ver.webSocketDebuggerUrl);

  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'), 20000, 'page');
  const page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  // 记录所有 frame 的默认执行上下文
  const contexts = new Map();
  page.on((m) => {
    if (m.method === 'Runtime.executionContextCreated') {
      const c = m.params.context;
      if (c.auxData && c.auxData.frameId && c.auxData.isDefault) contexts.set(c.auxData.frameId, c.id);
    }
  });

  const extT = await waitFor(
    async () => (await targets()).find((t) => t.url.startsWith('chrome-extension://') && t.url.includes('/src/background.js')),
    30000,
    '扩展'
  );
  const extId = new URL(extT.url).host;

  const created = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  const ctrlT = await waitFor(async () => (await targets()).find((t) => t.id === created.targetId), 20000, 'ctrl');
  const ctrl = await cdp(ctrlT.webSocketDebuggerUrl);
  await ctrl.send('Runtime.enable');
  const ctrlEval = (expr, ms = 25000) => evalOn(ctrl, expr, null, ms);

  await waitFor(async () => {
    try {
      return await ctrlEval(`!!(window.chrome && chrome.storage && chrome.tabs)`, 5000);
    } catch (e) {
      return null;
    }
  }, 15000, '控制端就绪');
  await ctrlEval(`(async () => { await chrome.storage.sync.set({ engine: 'microsoft', autoSites: [] }); return 1; })()`);

  console.log('打开', URL_TARGET);
  await page.send('Page.navigate', { url: URL_TARGET });
  await sleep(5000);

  const tab = await waitFor(
    async () =>
      ctrlEval(`(async () => {
        const t = await chrome.tabs.query({});
        const p = t.find((x) => (x.url || '').startsWith('http'));
        return p ? { id: p.id, url: p.url } : null;
      })()`),
    20000,
    '标签'
  );
  console.log('标签:', tab.url);

  await waitFor(
    async () =>
      ctrlEval(`(async () => { try { return !!(await chrome.tabs.sendMessage(${tab.id}, { type: 'state' })); } catch (e) { return false; } })()`),
    25000,
    '内容脚本'
  );

  await ctrlEval(`(async () => {
    try { await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: false }); } catch (e) {}
    await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: true });
  })()`);

  // 滚一遍，把评论区（懒加载）唤出来
  await evalOn(
    page,
    `(async () => {
      const step = Math.round(innerHeight * 0.7);
      const h = document.body.scrollHeight;
      for (let y = 0; y < h; y += step) { scrollTo(0, y); await new Promise(r => setTimeout(r, 260)); }
      await new Promise(r => setTimeout(r, 1200));
      scrollTo(0, 0);
      return h;
    })()`,
    null,
    60000
  );
  await sleep(6000);

  const tree = await page.send('Page.getFrameTree');
  const frames = [];
  const walk = (n, depth = 0) => {
    frames.push({ id: n.frame.id, url: (n.frame.url || '').slice(0, 130), depth });
    for (const ch of n.childFrames || []) walk(ch, depth + 1);
  };
  walk(tree.frameTree);

  console.log('\n主 target 帧树（%d 个）：', frames.length);
  for (const f of frames) {
    let info = null;
    const ctxId = contexts.get(f.id);
    if (ctxId) {
      try {
        info = await evalOn(page, FRAME_STATE, ctxId);
      } catch (e) {
        info = { err: e.message.slice(0, 60) };
      }
    }
    if (info && process.env.EVAL && f.depth === 0) {
      info.eval = await evalOn(page, process.env.EVAL, ctxId).catch((e) => ({ err: e.message.slice(0, 80) }));
    }
    console.log(`${'  '.repeat(f.depth)}- ${f.url}\n${'  '.repeat(f.depth)}  ${info ? JSON.stringify(info) : '(无执行上下文)'}`);
  }

  // 跨进程 iframe（OOPIF）不在上面这棵树里，各自是独立 target，单独连进去看
  const iframeTargets = (await targets()).filter((t) => t.type === 'iframe' || t.type === 'webview');
  console.log('\n独立 iframe target（%d 个）：', iframeTargets.length);
  for (const t of iframeTargets) {
    if (!t.webSocketDebuggerUrl) {
      console.log('  - (无 ws) ' + (t.url || '').slice(0, 110));
      continue;
    }
    let info = null;
    try {
      const fc = await cdp(t.webSocketDebuggerUrl);
      await fc.send('Runtime.enable');
      const extra = process.env.EVAL
        ? await evalOn(fc, process.env.EVAL).catch((e) => ({ err: e.message.slice(0, 120) }))
        : null;
      info = await evalOn(fc, `(() => {
        const st = ${FRAME_STATE.replace(/\n/g, '\n')};
        return st;
      })()`);
      if (extra) info.eval = extra;
      fc.ws.close();
    } catch (e) {
      info = { err: e.message.slice(0, 80) };
    }
    console.log(`  - ${(t.url || '').slice(0, 110)}\n    ${JSON.stringify(info)}`);
  }

  // 滚到评论区再截图，肉眼看译文有没有落到 iframe 里
  try {
    await evalOn(page, `(() => {
      const f = [...document.querySelectorAll('iframe')].find(x => /tolstoy|comment|disqus/i.test(x.src || ''));
      if (!f) return false;
      f.scrollIntoView({ block: 'start' });
      scrollBy(0, ${Number(process.env.SHOT_OFFSET || 0)});
      return true;
    })()`, null, 8000);
    await sleep(2500);
  } catch (e) {}

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(EXT, 'test', 'probe-frames.png'), Buffer.from(shot.data, 'base64'));
  console.log('\n截图: test/probe-frames.png');
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  browser.ws?.close?.();
  spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(500);
}
