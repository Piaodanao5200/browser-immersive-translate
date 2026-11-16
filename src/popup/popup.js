/* 字幕译 - 弹窗逻辑 */
(() => {
  const ST = window.ST;
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let tab = null;
  let enabled = false;
  let supported = true;

  function fillSelect(select, items) {
    select.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
  }

  function flash(text) {
    const hint = $('hint');
    hint.textContent = text;
    hint.hidden = !text;
  }

  function render() {
    const btn = $('toggle');
    btn.textContent = enabled ? '还原原文' : '翻译此页';
    btn.classList.toggle('on', enabled);
    if (!supported) {
      btn.textContent = '刷新页面后可用';
      flash('当前页面不支持内容脚本（浏览器内部页 / 扩展商店页），请切换到普通网页再试。');
    }
  }

  async function sendToTab(msg) {
    if (!tab || typeof tab.id !== 'number') throw new Error('no tab');
    // 只问主 frame：iframe 的状态由主 frame 的开关同步过去，问它只会拿到过时值
    return chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
  }

  async function refreshState() {
    try {
      const res = await sendToTab({ type: 'state' });
      enabled = !!(res && res.enabled);
      supported = true;
      flash('');
    } catch (e) {
      enabled = false;
      supported = false;
    }
    render();
  }

  async function tryInject() {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content/content.css'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/shared.js', 'src/content/content.js']
      });
      await refreshState();
    } catch (e) {
      flash('无法在此页面启用，请刷新页面或换一个网页。');
    }
  }

  async function retranslate() {
    if (!enabled || !supported) return;
    try {
      await sendToTab({ type: 'set-enabled', enabled: false });
      await new Promise((r) => setTimeout(r, 120));
      await sendToTab({ type: 'set-enabled', enabled: true });
    } catch (e) {
      /* ignore */
    }
  }

  async function init() {
    fillSelect($('engine'), ST.ENGINES);
    fillSelect($('lang'), ST.LANGS);

    settings = await ST.getSettings();
    $('engine').value = settings.engine;
    $('lang').value = settings.targetLang;
    $('selection').checked = settings.selectionTranslate !== false;

    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;

    if (tab && tab.url) {
      let host = tab.url;
      try {
        host = new URL(tab.url).hostname || tab.url;
      } catch (e) {
        /* chrome:// 等 */
      }
      $('host').textContent = host;
      $('host').title = tab.url;
      try {
        $('autoSite').checked = ST.isAutoSite(new URL(tab.url).hostname, settings.autoSites);
      } catch (e) {
        $('autoSite').checked = false;
      }
    }

    await refreshState();
  }

  $('toggle').addEventListener('click', async () => {
    if (!supported) {
      await tryInject();
      return;
    }
    const next = !enabled;
    try {
      await sendToTab({ type: 'set-enabled', enabled: next });
      enabled = next;
      render();
    } catch (e) {
      await tryInject();
    }
  });

  $('engine').addEventListener('change', async (e) => {
    settings.engine = e.target.value;
    await ST.saveSettings({ engine: settings.engine });
    if (settings.engine === 'llm' && !settings.llm.apiKey) {
      flash('AI 引擎需要在“更多设置”里填写 API Key 才能使用。');
    } else {
      flash('');
    }
    retranslate();
  });

  $('lang').addEventListener('change', async (e) => {
    settings.targetLang = e.target.value;
    await ST.saveSettings({ targetLang: settings.targetLang });
    retranslate();
  });

  $('selection').addEventListener('change', async (e) => {
    settings.selectionTranslate = e.target.checked;
    await ST.saveSettings({ selectionTranslate: settings.selectionTranslate });
  });

  $('autoSite').addEventListener('change', async (e) => {
    if (!tab || !tab.url) return;
    let host;
    try {
      host = new URL(tab.url).hostname;
    } catch (err) {
      return;
    }
    if (!host) return;
    const list = (settings.autoSites || []).slice();
    const idx = list.indexOf(host);
    if (e.target.checked && idx < 0) list.push(host);
    if (!e.target.checked && idx >= 0) list.splice(idx, 1);
    settings.autoSites = list;
    await ST.saveSettings({ autoSites: list });
  });

  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  init();
})();
