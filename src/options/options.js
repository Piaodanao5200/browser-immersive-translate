/* 字幕译 - 设置页逻辑 */
(() => {
  const ST = window.ST;
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let saveTimer = null;
  let savedTimer = null;

  function fillSelect(select, items) {
    select.innerHTML = '';
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
  }

  /**
   * 密钥格式体检：最常见的错误是把控制台里的「密钥 ID」或「脱敏值」当成密钥。
   * 返回一句人话提示，格式没问题返回空串。
   */
  function keyHint(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      return '这串是「密钥 ID」（UUID 格式），不是密钥本身。请复制列表里以 sk- 开头的那一列。';
    }
    if (/\*/.test(v)) {
      return '这串里有星号，是控制台脱敏显示的值。请点「显示 / 复制」取完整密钥，或重新创建一个。';
    }
    if (v.length < 20) {
      return '长度偏短（' + v.length + ' 位），密钥通常 30 位以上，确认没有复制漏掉。';
    }
    return '';
  }

  function checkKey() {
    const el = $('keyWarn');
    const msg = keyHint($('apiKey').value);
    el.textContent = msg;
    el.hidden = !msg;
  }

  function render() {
    $('engine').value = settings.engine;
    $('lang').value = settings.targetLang;
    $('baseUrl').value = settings.llm.baseUrl || '';
    $('model').value = settings.llm.model || '';
    $('apiKey').value = settings.llm.apiKey || '';
    $('fontSize').value = settings.fontSize || 1;
    $('fontSizeVal').textContent = Math.round((settings.fontSize || 1) * 100) + '%';
    $('textStyle').value = settings.textStyle || 'gray';
    $('showBorder').checked = settings.showBorder !== false;
    $('selectionTranslate').checked = settings.selectionTranslate !== false;
    $('autoSites').value = (settings.autoSites || []).join('\n');
    $('llmSection').style.opacity = settings.engine === 'llm' ? '1' : '0.7';
    checkKey();
  }

  function collect() {
    return {
      engine: $('engine').value,
      targetLang: $('lang').value,
      llm: {
        baseUrl: $('baseUrl').value.trim(),
        model: $('model').value.trim(),
        apiKey: $('apiKey').value.trim()
      },
      fontSize: parseFloat($('fontSize').value) || 1,
      textStyle: $('textStyle').value,
      showBorder: $('showBorder').checked,
      selectionTranslate: $('selectionTranslate').checked,
      autoSites: $('autoSites')
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    };
  }

  function flashSaved() {
    const el = $('saved');
    el.classList.add('on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('on'), 1400);
  }

  function scheduleSave() {
    settings = Object.assign({}, settings, collect());
    $('fontSizeVal').textContent = Math.round(settings.fontSize * 100) + '%';
    $('llmSection').style.opacity = settings.engine === 'llm' ? '1' : '0.7';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await ST.saveSettings(collect());
      flashSaved();
    }, 350);
  }

  async function refreshCache() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'cache-info' });
      $('cacheInfo').textContent = res && res.ok ? '已缓存 ' + res.size + ' 条' : '—';
    } catch (e) {
      $('cacheInfo').textContent = '—';
    }
  }

  async function testEngine() {
    const btn = $('test');
    const out = $('testResult');
    btn.disabled = true;
    btn.textContent = '测试中…';
    out.className = 'tip result';
    out.textContent = '';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'test-engine', settings: collect() });
      if (res && res.ok) {
        out.className = 'tip result ok';
        out.textContent = '成功（' + (res.engine || '') + '）：' + res.text;
      } else {
        out.className = 'tip result err';
        out.textContent = '失败：' + ((res && res.error) || '未知错误');
      }
    } catch (e) {
      out.className = 'tip result err';
      out.textContent = '失败：' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '测试当前引擎';
    }
  }

  async function init() {
    fillSelect($('engine'), ST.ENGINES);
    fillSelect($('lang'), ST.LANGS);
    settings = await ST.getSettings();
    render();
    refreshCache();

    const controls = ['engine', 'lang', 'baseUrl', 'model', 'apiKey', 'textStyle', 'autoSites'];
    for (const id of controls) {
      $(id).addEventListener('change', scheduleSave);
      $(id).addEventListener('input', scheduleSave);
    }
    $('fontSize').addEventListener('input', scheduleSave);
    $('apiKey').addEventListener('input', checkKey);
    $('apiKey').addEventListener('blur', checkKey);
    $('showBorder').addEventListener('change', scheduleSave);
    $('selectionTranslate').addEventListener('change', scheduleSave);

    $('test').addEventListener('click', testEngine);

    $('toggleKey').addEventListener('click', () => {
      const input = $('apiKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('toggleKey').textContent = show ? '隐藏' : '显示';
    });

    $('clearCache').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'clear-cache' });
      refreshCache();
      flashSaved();
    });
  }

  init();
})();
