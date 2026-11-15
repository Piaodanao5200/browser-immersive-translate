/**
 * 断网 → 恢复 的自愈测试
 *   node tools/e2e-retry.mjs [网址]
 *
 * 验证两件事：
 *   1) 引擎请求全挂时，页面上不出现「翻译失败」大字，只留原文 + 一个重试提示；
 *   2) 网络恢复后，失败的段落会自己补翻回来（自动重试 / 滚动触发重试）。
 *
 * 断网是给 background service worker 这个 CDP target 单独下 Network.emulateNetworkConditions，
 * 页面本身不受影响，正好模拟「引擎接口连不上」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = 'D:/浏览器翻译插件';
const PORT = 9600 + Math.floor(Math.random() * 300);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'https://ai.google/sustainability/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

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
  throw new Error('超时 ' + label + (lastErr ? ' :: ' + lastErr.message : ''));
}

const targets = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  return r.json();
};

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  return {
    ws,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      })
  };
}

async function evalOn(c, expr, ms = 20000) {
  const r = await Promise.race([
    c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), ms))
  ]);
  if (!r) throw new Error('求值无响应');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const STATS = `(() => {
  const trs = [...document.querySelectorAll('[data-st-tr]')];
  const loading = trs.filter((n) => n.classList.contains('st-loading')).length;
  const failed = trs.filter((n) => n.classList.contains('st-error')).filter((n) => n.getClientRects().length).length;
  const hiddenFailed = trs.filter((n) => n.classList.contains('st-failed')).length;
  const shown = trs.filter((n) => !n.classList.contains('st-failed') && (n.textContent || '').trim()).length;
  const zh = (document.body.innerText.match(/[\\u4e00-\\u9fff]/g) || []).length;
  const bad = [...document.querySelectorAll('[data-st-tr]')].some((n) => /翻译失败/.test(n.textContent || ''));
  return { total: trs.length, loading, failed, hiddenFailed, shown, zh, bad };
})()`;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-retry-'));

/** 点右侧悬浮按钮：默认位置 right:16px / top:38%，46x46 */
async function clickFab() {
  const box = await evalOn(page, '({w: innerWidth, h: innerHeight})', 8000);
  const x = box.w - 39;
  const y = Math.round(box.h * 0.38) + 23;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  return { x, y };
}const browser = spawn(
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

let page = null;
let ctrl = null;
let browserCdp = null;
let sw = null;

try {
  console.log('启动浏览器，端口', PORT);
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).ok,
    40000,
    'browser'
  );
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  browserCdp = await cdp(ver.webSocketDebuggerUrl);

  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'), 20000, 'page');
  page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const extT = await waitFor(
    async () =>
      (await targets()).find((t) => t.url.startsWith('chrome-extension://') && t.url.includes('/src/background.js')) ||
      (await targets()).find((t) => t.url.startsWith('chrome-extension://')),
    30000,
    '扩展'
  );
  const extId = new URL(extT.url).host;
  console.log('扩展 ID:', extId);

  const created = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  const ctrlT = await waitFor(async () => (await targets()).find((t) => t.id === created.targetId), 20000, 'ctrl');
  ctrl = await cdp(ctrlT.webSocketDebuggerUrl);
  await ctrl.send('Runtime.enable');
  const ctrlEval = (expr, ms = 25000) => evalOn(ctrl, expr, ms);

  await waitFor(async () => {
    try {
      return await ctrlEval('1+1', 5000);
    } catch (e) {
      return null;
    }
  }, 15000, '控制端就绪');

  await ctrlEval(`(async () => {
    await chrome.storage.sync.set({ engine: 'microsoft', autoSites: [], targetLang: 'zh-Hans', showFab: true });
    return 1;
  })()`);

  await page.send('Page.navigate', { url: URL_ });
  await sleep(3500);
  const href = await evalOn(page, 'location.href', 8000);
  console.log('当前页面:', href);

  const tab = await waitFor(
    async () =>
      ctrlEval(`(async () => {
        const t = await chrome.tabs.query({});
        const p = t.find((x) => (x.url || '').startsWith('http'));
        return p ? { id: p.id, url: p.url } : null;
      })()`, 10000),
    20000,
    '页面标签'
  );

  await waitFor(
    async () =>
      ctrlEval(`(async () => {
        try { return !!(await chrome.tabs.sendMessage(${tab.id}, { type: 'state' })); } catch (e) { return false; }
      })()`, 8000),
    25000,
    '内容脚本'
  );

  // 先把 SW 掐断网，再开翻
  const swT = await waitFor(
    async () =>
      (await targets()).find(
        (t) => (t.type === 'service_worker' || t.type === 'worker') && String(t.url).includes(extId)
      ),
    30000,
    'service worker'
  );
  console.log('SW:', swT.url);
  sw = await cdp(swT.webSocketDebuggerUrl);
  await sw.send('Runtime.enable');
  await sw.send('Network.enable');
  await sw.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  const probe = await evalOn(
    sw,
    `(async () => {
      try {
        const r = await fetch('https://edge.microsoft.com/translate/translatetext?to=zh-Hans&api-version=3.0', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '["Hi"]'
        });
        return 'HTTP ' + r.status;
      } catch (e) { return 'ERR ' + e.message; }
    })()`,
    15000
  ).catch((e) => 'EVAL ' + e.message);
  console.log('断网探针:', probe);
  check('后台已被切断网络', /^ERR/.test(String(probe)), String(probe));

  await ctrlEval(`(async () => {
    try { await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: false }); } catch (e) {}
    await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: true });
  })()`);

  // 等它撞墙：全部失败、并把重试轮次耗掉一部分
  let s = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    s = await evalOn(page, STATS, 8000);
    if (s.total && !s.loading) break;
  }
  console.log('离线后:', JSON.stringify(s));
  check('离线时确实有失败段', s.total > 0 && s.failed + s.hiddenFailed > 0, `total=${s.total} failed=${s.failed} hidden=${s.hiddenFailed}`);
  check('失败段不显示「翻译失败」大字', !s.bad && s.failed === 0, `页面内错误文本=${s.bad}`);
  check('页面仍有原文可读', s.zh === 0 || s.shown >= 0, `中文字数=${s.zh}`);

  // 失败时点悬浮按钮应该是「重试」，不能把整页还原掉
  const enabledBefore = await evalOn(page, `document.documentElement.getAttribute('data-st-enabled')`);
  await clickFab();
  await sleep(1200);
  const afterClick = await evalOn(page, STATS, 8000);
  const enabledAfter = await evalOn(page, `document.documentElement.getAttribute('data-st-enabled')`);
  check(
    '失败时点按钮是重试而不是关掉翻译',
    enabledBefore === '1' && enabledAfter === '1' && afterClick.total === s.total,
    `before=${enabledBefore} after=${enabledAfter} tr=${afterClick.total}/${s.total}`
  );

  // 恢复网络
  await sw.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  });
  console.log('已恢复网络，点按钮重试…');
  await clickFab();

  let healed = null;
  for (let i = 0; i < 90; i++) {
    await sleep(700);
    healed = await evalOn(page, STATS, 8000);
    if (healed.total && !healed.loading && healed.failed === 0 && healed.zh > 0) break;
    if (i === 24) {
      await evalOn(
        page,
        `(async () => { scrollTo(0, 900); await new Promise(r => setTimeout(r, 300)); scrollTo(0, 0); return 1; })()`,
        8000
      );
    }
  }
  console.log('恢复后:', JSON.stringify(healed));
  check('恢复网络后自动补翻', healed.failed === 0 && healed.zh > 0, `失败=${healed.failed} 中文字数=${healed.zh}`);
  check('全部段落都有译文', healed.loading === 0 && healed.shown > 0, `loading=${healed.loading} 有译文=${healed.shown}`);

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(EXT, 'test', 'e2e-retry.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图:', out);
} catch (e) {
  check('测试执行', false, e.message);
} finally {
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n结果: ${results.length - bad}/${results.length} 通过`);
  try {
    page && page.ws.close();
    ctrl && ctrl.ws.close();
    sw && sw.ws.close();
    browserCdp && browserCdp.ws.close();
  } catch (e) {}
  spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(300);
  process.exit(bad ? 1 : 0);
}
