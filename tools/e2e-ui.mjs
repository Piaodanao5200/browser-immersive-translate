/**
 * 界面与引擎校验：快捷键注册、popup/options 渲染截图、多引擎连通性
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT_DIR = 'D:/浏览器翻译插件';
const PORT = 9444 + Math.floor(Math.random() * 100);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/浏览器翻译插件/test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 25000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {}
    await sleep(step);
  }
  throw new Error('等待超时');
}

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws'));
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

async function evalOn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
};

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ui-'));
const browser = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--disable-sync',
    '--disable-features=msEdgeIdentityFeature,msSyncConsent',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=900,1100',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

let page;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  // 只认我们自己的 target（内置扩展也是 chrome-extension://，认错会取到别人的 ID）
  const extT = await waitFor(async () => (await targets()).find((t) => t.url.includes('/src/background.js')), 40000);
  // 只从 target URL 里取扩展 ID；后续一律用扩展页面做控制端
  // （background service worker 会休眠，休眠后 CDP 直接失联）
  const extId = new URL(extT.url).host;
  console.log('扩展 ID:', extId);

  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'));
  page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/options/options.html` });
  await sleep(1800);

  // 快捷键注册
  const cmds = await evalOn(page, `(async () => (await chrome.commands.getAll()).map((c) => ({ name: c.name, key: c.shortcut })))()`);
  check('快捷键已注册', !!cmds.find((c) => c.name === 'toggle-page-translation' && c.key), JSON.stringify(cmds));

  const uiText = await evalOn(page, `({ sections: document.querySelectorAll('section').length, title: document.title })`);
  check('设置页正常渲染', uiText.sections >= 5, JSON.stringify(uiText));
  const shot1 = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, 'shot-options.png'), Buffer.from(shot1.data, 'base64'));

  const engines = ['microsoft', 'google', 'mymemory', 'llm'];
  for (const engine of engines) {
    const r = await evalOn(
      page,
      `(async () => await chrome.runtime.sendMessage({ type: 'test-engine', settings: ${JSON.stringify({
        engine,
        targetLang: 'zh-Hans',
        llm: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' }
      })} }))()`
    );
    const ok = !!(r && r.ok);
    // AI 引擎没填 Key 时不再整体失败，而是自动降级到免费引擎——这里验的就是降级是否生效
    const fellBackOk = ok && r.engine === 'microsoft' && /[\u4e00-\u9fff]/.test(r.text || '');
    check(
      `引擎 ${engine}`,
      engine === 'llm' ? fellBackOk : ok,
      ok
        ? r.engine + (r.engine !== engine ? '（无 Key，已降级）' : '') + ' → ' + r.text
        : (r && r.error) || 'no resp'
    );
  }

  // 弹窗页
  await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/popup/popup.html` });
  await sleep(1200);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 306, height: 420, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  const popupState = await evalOn(page, `({ engine: document.getElementById('engine').value, btn: document.getElementById('toggle').textContent, opts: document.querySelectorAll('#engine option').length })`);
  check('弹窗渲染并读取设置', popupState.opts > 3, JSON.stringify(popupState));
  const shot2 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shot-popup.png'), Buffer.from(shot2.data, 'base64'));
} catch (e) {
  check('流程未中断', false, e.message);
} finally {
  try {
    page && page.ws.close();
  } catch (e) {}
  spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(600);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
}
