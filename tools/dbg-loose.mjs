/**
 * 针对性诊断：node tools/dbg-blog.mjs <url>
 * 1) 翻译完成后，用「宽松启发式」找页面上仍然只有英文、且没有译文节点的可见块
 * 2) 打印 diag 里 empty / invisible 的样例，看是什么元素
 * 3) 在页面里动态插入三种内容（元素节点 / 文本节点 / 改已有文本节点），验证观察器是否跟进
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = path.resolve(import.meta.dirname, '..');
const PORT = 9557;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'https://blog.google/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('timeout');
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dbg-'));
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

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'));
  const page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url });
  await sleep(4000);

  const swT = await waitFor(async () =>
    (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'))
  );
  const sw = await cdp(swT.webSocketDebuggerUrl);
  const tab = await evalOn(sw, `(async () => {
    const t = await chrome.tabs.query({});
    const p = t.find((x) => (x.url || '').startsWith('http'));
    return p ? { id: p.id, url: p.url } : null;
  })()`);

  await waitFor(async () =>
    evalOn(sw, `(async () => { try { return !!(await chrome.tabs.sendMessage(${tab.id}, { type: 'state' })); } catch (e) { return false; } })()`)
  );
  await evalOn(sw, `(async () => { await chrome.tabs.sendMessage(${tab.id}, { type: 'set-enabled', enabled: true }); })()`);
  await sleep(9000);

  // 滚一遍
  await evalOn(
    page,
    `(async () => {
      const H = document.body.scrollHeight;
      for (let y = 0; y < Math.min(H, innerHeight * 8); y += Math.round(innerHeight * 0.8)) {
        scrollTo(0, y); await new Promise((r) => setTimeout(r, 250));
      }
      scrollTo(0, 0); return 1;
    })()`
  );
  await sleep(6000);

  const loose = await evalOn(
    page,
    `(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,p,li,td,th,span,div,a,button,figcaption,blockquote,dd,dt,label')) {
        if (el.closest('[data-st-ui]')) continue;
        if (el.hasAttribute('data-st-tr') || el.hasAttribute('data-st-unit')) continue;
        if (el.querySelector('[data-st-tr]')) continue;
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (t.length < 8) continue;
        const latin = (t.match(/[A-Za-z]/g) || []).length;
        const han = (t.match(/[\\u4e00-\\u9fff]/g) || []).length;
        if (latin < 6 || han > latin * 0.3) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom < 0 || r.top > innerHeight * 1.2) continue;
        const key = t.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), text: t.slice(0, 110), y: Math.round(r.top) });
        if (out.length > 25) break;
      }
      return out;
    })()`
  );
  console.log(`\n[${url}] 视口内仍为英文且无译文的块: ${loose.length}`);
  loose.forEach((x) => console.log(`  - ${x.tag}.${x.cls} @y${x.y} :: ${x.text}`));

  const diag = await evalOn(sw, `(async () => { const r = await chrome.tabs.sendMessage(${tab.id}, { type: 'diag' }); return r; })()`);
  const emptyS = (diag.data.samples || []).filter((s) => s.reason === 'empty').slice(0, 10);
  const invS = (diag.data.samples || []).filter((s) => s.reason === 'invisible' || s.reason === 'display-none').slice(0, 8);
  console.log('  diag run:', JSON.stringify(diag.data.run));
  console.log('  empty 样例:', emptyS.map((s) => `${s.tag}.${s.cls}「${s.text}」`).join(' | '));
  console.log('  隐藏样例:', invS.map((s) => `${s.tag}.${s.cls}`).join(' | '));

  // 动态插入实验：三种方式各插入一段英文
  await evalOn(
    page,
    `(() => {
      const box = document.createElement('div');
      box.id = 'st-probe';
      box.style.cssText = 'position:fixed;left:10px;bottom:10px;width:420px;background:#fff;z-index:99999;font:14px sans-serif';
      box.innerHTML = '<p id="probe-el">Probe element: the quick brown fox jumps over the lazy dog</p>' +
        '<p id="probe-tn"></p><p id="probe-tn2"></p>';
      document.body.appendChild(box);
      // 方式二：插入纯文本节点
      document.getElementById('probe-tn').appendChild(document.createTextNode('Probe textnode: a journey of a thousand miles begins beneath ones feet'));
      // 方式三：改写已有文本节点的 data
      const p2 = document.getElementById('probe-tn2');
      p2.appendChild(document.createTextNode('placeholder'));
      p2.firstChild.nodeValue = 'Probe nodedata: knowledge is a treasure but practice is the key to it';
      return 1;
    })()`
  );
  await sleep(9000);
  const probe = await evalOn(
    page,
    `(() => ['probe-el','probe-tn','probe-tn2'].map((id) => {
      const el = document.getElementById(id);
      const tr = el.querySelector('[data-st-tr]');
      return { id, unit: el.hasAttribute('data-st-unit'), tr: tr ? tr.textContent.slice(0, 40) : null };
    }))()`
  );
  console.log('  动态插入实验:', JSON.stringify(probe, null, 0));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(EXT, 'test', 'dbg-loose.png'), Buffer.from(shot.data, 'base64'));

  page.ws.close();
  sw.ws.close();
} catch (e) {
  console.log('失败:', e.message);
} finally {
  browser.kill('SIGKILL');
  await sleep(400);
}
