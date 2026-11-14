/**
 * 悬浮按钮专项验证：按钮存在、位置正确、真实鼠标点击可开关翻译、可拖动
 * 用法：node tools/e2e-fab.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXT_DIR = 'D:/浏览器翻译插件';
const PORT = 9555;
const WEB = 8766;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'D:/浏览器翻译插件/test';
const DEMO = `http://127.0.0.1:${WEB}/demo.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 25000, step = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  throw new Error('等待超时 ' + (last && last.message));
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws error'));
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
async function clickAt(c, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
};

/* 静态服务 */
const server = http.createServer((req, res) => {
  const p = path.join(OUT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const FAB_INFO = `(() => {
  const h = document.getElementById('st-fab-root');
  if (!h || !h.shadowRoot) return null;
  const b = h.shadowRoot.querySelector('.btn');
  const w = h.shadowRoot.querySelector('.wrap');
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  return {
    x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
    w: Math.round(r.width), h: Math.round(r.height),
    cls: w.className, label: h.shadowRoot.querySelector('.lbl').textContent,
    ico: h.shadowRoot.querySelector('.ico').textContent,
    bg: cs.backgroundImage.slice(0, 40), vw: innerWidth, vh: innerHeight,
    tr: document.querySelectorAll('[data-st-tr]').length
  };
})()`;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fab-'));
const browser = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1000,900',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

let page;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'));
  page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: DEMO });

  const fab = await waitFor(async () => evalOn(page, FAB_INFO), 15000);
  check('页面出现悬浮按钮', !!fab, JSON.stringify(fab && { x: fab.x, y: fab.y, label: fab.label }));
  check('按钮贴在右侧不越界', fab.right <= fab.vw && fab.left > fab.vw * 0.85, `right=${fab.right} vw=${fab.vw}`);
  check('初始状态为「翻译此页」', fab.label === '翻译此页' && fab.ico === '译', fab.label + '/' + fab.ico);
  check('按钮有蓝色渐变底', /gradient/.test(fab.bg), fab.bg);

  await clickAt(page, fab.x, fab.y);
  await waitFor(async () => (await evalOn(page, FAB_INFO)).tr > 0, 12000);
  await waitFor(async () => (await evalOn(page, FAB_INFO)).cls.includes('on'), 25000, 400);
  const on = await evalOn(page, FAB_INFO);
  check('点一下开始翻译，按钮进入「显示原文」态', on.cls.includes('on') && on.label === '显示原文', `tr=${on.tr}`);

  const shot1 = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'shot-fab-on.png'), Buffer.from(shot1.data, 'base64'));

  await clickAt(page, on.x, on.y);
  await waitFor(async () => (await evalOn(page, FAB_INFO)).tr === 0, 8000);
  const off = await evalOn(page, FAB_INFO);
  check('再点一下还原原文', off.tr === 0 && off.label === '翻译此页', `tr=${off.tr} label=${off.label}`);

  /* 拖动：按住移动到左上，松手后位置应持久化 */
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: off.x, y: off.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: off.x, y: off.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: off.x - (off.x - 120) * (i / 8),
      y: off.y - (off.y - 300) * (i / 8),
      button: 'left',
      buttons: 1
    });
    await sleep(30);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 120, y: 300, button: 'left', clickCount: 1 });
  await sleep(700);
  const moved = await evalOn(page, FAB_INFO);
  const swT = await waitFor(async () =>
    (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'))
  );
  const sw = await cdp(swT.webSocketDebuggerUrl);
  const pos = await evalOn(sw, `(async () => (await chrome.storage.local.get('fabPos')).fabPos || null)()`);
  sw.ws.close();
  check(
    '拖动后位置生效并落盘',
    moved.left < 250 && moved.top < 420 && !!pos,
    `left=${moved.left} top=${moved.top} pos=${JSON.stringify(pos)}`
  );
  check('拖动不应误触发翻译', moved.tr === 0, `tr=${moved.tr}`);

  const shot2 = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 320, height: 460, scale: 2 } });
  fs.writeFileSync(path.join(OUT, 'shot-fab-idle.png'), Buffer.from(shot2.data, 'base64'));
} catch (e) {
  check('流程未中断', false, e.message);
} finally {
  try {
    page && page.ws.close();
  } catch (e) {}
  browser.kill('SIGKILL');
  server.close();
  await sleep(500);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
}
