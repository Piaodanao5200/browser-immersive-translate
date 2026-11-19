/**
 * 连到「已经开着的」浏览器（带 --remote-debugging-port），对一个已登录页面做诊断。
 * 适合需要登录、脚本没法自己复现的页面（结算页、后台、会员页）。
 *
 *   node tools/diag-live.mjs                     # 列出所有标签
 *   node tools/diag-live.mjs x.ai                # 对 URL 含 x.ai 的标签做诊断
 *   node tools/diag-live.mjs x.ai --nav <url>    # 先打开这个地址再诊断
 *   node tools/diag-live.mjs x.ai --enable       # 先开翻译再诊断
 *   node tools/diag-live.mjs x.ai --shot         # 顺便截图到 test/live.png
 *
 * 环境变量 PORT（默认 9222）。
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.PORT || 9222;
const OUT = path.resolve(import.meta.dirname, '..', 'test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const needle = (process.argv[2] || '').toLowerCase();
const wantShot = process.argv.includes('--shot');
const wantEnable = process.argv.includes('--enable');
const navIdx = process.argv.indexOf('--nav');
const navUrl = navIdx > 0 ? process.argv[navIdx + 1] : null;

async function list() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws 连接失败: ' + wsUrl));
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

async function evalOn(c, expr, ms = 20000) {
  const r = await Promise.race([
    c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), ms))
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const PAGE_INFO = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const tn = q('[translate="no"]');
  const nt = q('.notranslate');
  const hosts = q('*').filter((e) => e.shadowRoot);
  const shadowText = hosts.map((h) => (h.shadowRoot.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120));
  const cs = (el) => { try { return getComputedStyle(el); } catch (e) { return null; } };
  const bodyCs = document.body ? cs(document.body) : null;
  return {
    url: location.href.slice(0, 200),
    html: {
      translate: document.documentElement.getAttribute('translate'),
      class: document.documentElement.className.slice(0, 120),
      lang: document.documentElement.lang
    },
    body: {
      translate: document.body ? document.body.getAttribute('translate') : null,
      class: document.body ? String(document.body.className).slice(0, 160) : null,
      whiteSpace: bodyCs ? bodyCs.whiteSpace : null,
      textLen: document.body ? txt(document.body).length : 0
    },
    counts: {
      tr: q('[data-st-tr]').length,
      unit: q('[data-st-unit]').length,
      attr: q('[data-st-attr]').length,
      tip: q('[data-st-tip]').length,
      translateNo: tn.length,
      notranslate: nt.length,
      shadowHosts: hosts.length,
      iframes: q('iframe').length
    },
    translateNoHits: tn.slice(0, 8).map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0, 60), len: txt(e).length })),
    notranslateHits: nt.slice(0, 8).map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className).slice(0, 60), len: txt(e).length })),
    shadowText: shadowText.slice(0, 6),
    shadowLens: hosts.map((h) => (h.shadowRoot.textContent || '').length).slice(0, 10),
    iframeSrcs: q('iframe').map((f) => (f.src || '(no src)').slice(0, 110)).slice(0, 10)
  };
})()`;

try {
  const all = await list();
  if (!needle) {
    console.log(`端口 ${PORT} 上的标签（${all.length}）：`);
    for (const t of all) console.log(`- [${t.type}] ${t.url.slice(0, 150)}`);
    process.exit(0);
  }
  let t = all.find((x) => x.type === 'page' && (x.url || '').toLowerCase().includes(needle));
  if (!t && navUrl) t = all.find((x) => x.type === 'page');
  if (!t) {
    console.error(`没找到 URL 含「${needle}」的标签。现有：`);
    for (const x of all) console.log(`- [${x.type}] ${x.url.slice(0, 150)}`);
    process.exit(1);
  }
  const page = await cdp(t.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  if (navUrl) {
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: navUrl });
    await sleep(7000);
  }
  const info = await evalOn(page, PAGE_INFO);
  console.log(JSON.stringify(info, null, 2));

  // 找扩展的控制端（设置页），借它给页面发 diag
  let extT = all.find((x) => (x.url || '').includes('/src/options/options.html'));
  if (!extT) {
    const bg = all.find((x) => (x.url || '').includes('/src/background.js'));
    if (bg) {
      const extId = new URL(bg.url).host;
      const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const bc = await cdp(ver.webSocketDebuggerUrl);
      await bc.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
      for (let i = 0; i < 20 && !extT; i++) {
        await sleep(400);
        extT = (await list()).find((x) => (x.url || '').includes('/src/options/options.html'));
      }
    }
  }
  if (extT) {
    const ctrl = await cdp(extT.webSocketDebuggerUrl);
    await ctrl.send('Runtime.enable');
    // 扩展页刚起来时 chrome.tabs 还没就绪，等一下再发消息
    for (let i = 0; i < 30; i++) {
      const ok = await evalOn(ctrl, `!!(window.chrome && chrome.tabs && chrome.tabs.query)`, 6000).catch(() => false);
      if (ok) break;
      await sleep(400);
    }
    const diag = await evalOn(
      ctrl,
      `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((x) => (x.url || '').includes(${JSON.stringify(needle)}));
        if (!tab) return { error: '扩展看不到这个标签', tabs: tabs.map(t => t.url.slice(0, 90)) };
        try {
          if (${wantEnable ? 'true' : 'false'}) {
            try { await chrome.tabs.sendMessage(tab.id, { type: 'set-enabled', enabled: false }); } catch (e) {}
            await chrome.tabs.sendMessage(tab.id, { type: 'set-enabled', enabled: true });
            await new Promise(r => setTimeout(r, 8000));
          }
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'diag' });
          return { tabId: tab.id, diag: r };
        } catch (e) { return { error: '内容脚本无回应: ' + e.message }; }
      })()`,
      60000
    );
    console.log('\n=== 内容脚本 diag ===');
    console.log(JSON.stringify(diag, null, 2));
    const after = await evalOn(page, PAGE_INFO);
    console.log('\n=== 开翻后的页面状态 ===');
    console.log(JSON.stringify(after, null, 2));
  } else {
    console.log('\n! 找不到扩展页面，跳过 diag');
  }

  if (wantShot) {
    fs.mkdirSync(OUT, { recursive: true });
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, 'live.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('\n截图:', p);
  }
  process.exit(0);
} catch (e) {
  console.error('失败:', e.message);
  if (/ECONNREFUSED|fetch failed/i.test(e.message)) {
    console.error(`端口 ${PORT} 没开。用带 --remote-debugging-port=${PORT} 的快捷方式启动浏览器。`);
  }
  process.exit(1);
}
