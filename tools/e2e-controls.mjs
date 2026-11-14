/**
 * 控件专项验证：按钮内联译文、占位符、下拉选项、提交按钮；关闭后完整还原
 * 用法：node tools/e2e-controls.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXT_DIR = 'D:/浏览器翻译插件';
const PORT = 9577;
const WEB = 8767;
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
};

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

const ZH = '1';
const PROBE = `(() => {
  const zh = (s) => /[\\u4e00-\\u9fff]/.test(s || '');
  const pick = (sel) => document.querySelector(sel);
  const one = (el) => {
    if (!el) return null;
    const nodes = el.querySelectorAll(':scope > .st-tr-inline');
    const tr = nodes[0] ? nodes[0].textContent.trim() : '';
    return {
      text: (el.innerText || el.textContent || '').trim(),
      n: nodes.length,
      tr: tr,
      zh: zh(tr),
      cls: nodes[0] ? nodes[0].className : ''
    };
  };
  const input = pick('input[type="text"]');
  const opt = pick('select option');
  const submit = pick('input[type="submit"]');
  const iconBtn = pick('.bar button[title="More options"]');
  const off = pick('.bar button[disabled]');
  return {
    addFile: one(pick('.bar button.small')),
    code: one(pick('.bar .green')),
    share: one(pick('.bar [role="button"]')),
    icon: { text: iconBtn ? iconBtn.innerText.trim() : '', n: iconBtn ? iconBtn.querySelectorAll('.st-tr-inline').length : -1 },
    disabledBtn: one(off),
    ph: input ? input.getAttribute('placeholder') : null,
    phZh: zh(input ? input.getAttribute('placeholder') : ''),
    optText: opt ? opt.textContent.trim() : null,
    optZh: zh(opt ? opt.textContent : ''),
    submitVal: submit ? submit.value : null,
    submitZh: zh(submit ? submit.value : ''),
    trCount: document.querySelectorAll('[data-st-tr]').length,
    units: document.querySelectorAll('[data-st-unit]').length,
    bodyText: document.body.innerText.slice(0, 200)
  };
})()`;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ctl-'));
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
let sw;
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok);
  const pageT = await waitFor(async () => (await targets()).find((t) => t.type === 'page'));
  page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: DEMO });
  await sleep(1200);

  const swT = await waitFor(async () =>
    (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('/src/background.js'))
  );
  sw = await cdp(swT.webSocketDebuggerUrl);

  // 打开翻译
  await evalOn(sw, `(async () => { const [t] = await chrome.tabs.query({active:true,currentWindow:true}); await chrome.tabs.sendMessage(t.id,{type:'toggle'}); })()`);
  await waitFor(async () => (await evalOn(page, PROBE)).addFile.n > 0, 20000);

  await waitFor(async () => {
    const x = await evalOn(page, PROBE);
    return x.addFile.zh && x.code.zh && x.share.zh && x.phZh && x.optZh && x.submitZh;
  }, 25000);
  const p = await evalOn(page, PROBE);

  check('按钮 Add file 内联中文译文', p.addFile.n === 1 && p.addFile.zh, `${p.addFile.tr} / 全文=${p.addFile.text}`);
  check('按钮原文未被替换', p.addFile.text.startsWith('Add file'), p.addFile.text);
  check('绿色 Code 按钮也内联译文', p.code.n === 1 && p.code.zh, `${p.code.tr} / ${p.code.text}`);
  check('div[role=button] Share 也翻译', p.share.n === 1 && p.share.zh, `${p.share.tr}`);
  check('图标按钮（无文字）不塞译文', p.icon.n === 0, p.icon.text);
  check('禁用按钮照样翻译', p.disabledBtn.n === 1 && p.disabledBtn.zh, p.disabledBtn.tr);
  check('占位符追加译文', p.phZh && p.ph.startsWith('Ask anything'), p.ph);
  check('下拉选项追加译文', p.optZh && p.optText.startsWith('English'), p.optText);
  check('提交按钮文字追加译文', p.submitZh && p.submitVal.startsWith('Send message'), p.submitVal);

  await sleep(1800);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1000, height: 820, scale: 2 } });
  fs.writeFileSync(path.join(OUT, 'shot-controls.png'), Buffer.from(shot.data, 'base64'));

  // 关闭还原
  await evalOn(sw, `(async () => { const [t] = await chrome.tabs.query({active:true,currentWindow:true}); await chrome.tabs.sendMessage(t.id,{type:'toggle'}); })()`);
  await waitFor(async () => (await evalOn(page, PROBE)).trCount === 0, 8000);
  const q = await evalOn(page, PROBE);
  check('关闭后内联译文全部移除', q.addFile.n === 0 && q.trCount === 0, `tr=${q.trCount}`);
  check('关闭后占位符还原', q.ph === 'Ask anything about this document', q.ph);
  check('关闭后选项文字还原', q.optText === 'English', q.optText);
  check('关闭后提交按钮文字还原', q.submitVal === 'Send message', q.submitVal);
  check('关闭后标记属性清空', q.units === 0, `units=${q.units}`);

  // 二次开启不应重复追加
  await evalOn(sw, `(async () => { const [t] = await chrome.tabs.query({active:true,currentWindow:true}); await chrome.tabs.sendMessage(t.id,{type:'toggle'}); })()`);
  await waitFor(async () => (await evalOn(page, PROBE)).addFile.zh, 25000);
  const r = await evalOn(page, PROBE);
  check('二次开启不重复追加译文', r.addFile.n === 1, `n=${r.addFile.n} / ${r.addFile.text}`);
} catch (e) {
  check('流程未中断', false, e.message);
} finally {
  try {
    page && page.ws.close();
    sw && sw.ws.close();
  } catch (e) {}
  browser.kill('SIGKILL');
  server.close();
  await sleep(500);
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n结果：${pass}/${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
}
