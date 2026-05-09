/* ── connection state ───────────────────────────────────── */
const WIDGET_BASE = 'https://bwb1066.github.io/brand-chat-config-ui/widget/';

let supabaseUrl = '';
let anonKey = '';
let deletePassword = '';

function loadConnection() {
  supabaseUrl = localStorage.getItem('bc_supabase_url') || '';
  anonKey = localStorage.getItem('bc_anon_key') || '';
  deletePassword = localStorage.getItem('bc_delete_password') || '';
}

function saveConnection(url, key, pwd) {
  supabaseUrl = url;
  anonKey = key;
  deletePassword = pwd;
  localStorage.setItem('bc_supabase_url', url);
  localStorage.setItem('bc_anon_key', key);
  localStorage.setItem('bc_delete_password', pwd);
}

function hdrs() {
  return {
    'Content-Type': 'application/json',
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

/* ── api ────────────────────────────────────────────────── */
async function fetchConfigs() {
  const r = await fetch(`${supabaseUrl}/functions/v1/brand-config`, { headers: hdrs() });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function upsertConfig(data) {
  const r = await fetch(`${supabaseUrl}/functions/v1/brand-config`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function deleteConfigs(siteKeys) {
  const batchSize = 50;
  for (let i = 0; i < siteKeys.length; i += batchSize) {
    const batch = siteKeys.slice(i, i + batchSize);
    const r = await fetch(`${supabaseUrl}/functions/v1/brand-config`, {
      method: 'DELETE',
      headers: hdrs(),
      body: JSON.stringify({ site_keys: batch }),
    });
    const body = await r.json().catch(() => ({}));
    console.log('[delete] status:', r.status, 'body:', body);
    if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`);
  }
}

async function deleteConfig(siteKey) {
  return deleteConfigs([siteKey]);
}

/* ── script version api ─────────────────────────────────── */
async function fetchAllScriptVersions() {
  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/brand-scripts`, { headers: hdrs() });
    if (!r.ok) return {};
    return r.json(); // map of site_key → latest version row (no content)
  } catch { return {}; }
}

async function fetchSiteScriptVersions(siteKey) {
  const r = await fetch(`${supabaseUrl}/functions/v1/brand-scripts?site_key=${encodeURIComponent(siteKey)}`, { headers: hdrs() });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json(); // array of versions (no content)
}

async function fetchScriptVersion(siteKey, version) {
  const r = await fetch(`${supabaseUrl}/functions/v1/brand-scripts?site_key=${encodeURIComponent(siteKey)}&version=${version}`, { headers: hdrs() });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json(); // full row including script_content
}

async function saveScriptVersion(siteKey, scriptContent, widgetVersion, notes) {
  const r = await fetch(`${supabaseUrl}/functions/v1/brand-scripts`, {
    method: 'POST',
    headers: hdrs(),
    body: JSON.stringify({ site_key: siteKey, script_content: scriptContent, widget_version: widgetVersion, notes }),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

/* ── tampermonkey script generator ─────────────────────── */
async function generateScript(config) {
  const domains = (config.domains || []);
  const matchLines = domains.flatMap((d) => [
    `// @match        https://${d}/*`,
    `// @match        https://*.${d}/*`,
  ]).join('\n');

  // Fetch widget assets at generation time so they can be inlined.
  // This avoids all runtime injection problems (eval, GM_addElement script,
  // Trusted Types CSP) — the widget just runs as plain TM script code.
  const [cssResp, jsResp] = await Promise.all([
    fetch(WIDGET_BASE + 'brand-concierge.css'),
    fetch(WIDGET_BASE + 'brand-concierge.js'),
  ]);
  const cssText = await cssResp.text();
  const jsText = await jsResp.text();

  // Extract the widget version constant so it can be stored alongside the saved script
  const versionMatch = jsText.match(/^const WIDGET_VERSION = ['"]([^'"]+)['"]/m);
  const widgetVersion = versionMatch ? versionMatch[1] : 'unknown';

  // Strip ES module syntax. Native fetch() works fine here: any @grant causes
  // TM to run in its isolated world (content script), which bypasses the page's
  // connect-src CSP natively since Chrome 83. No GM_xmlhttpRequest needed.
  const widgetCode = jsText
    .replace(/^export default async function/m, 'async function')
    .replace(/^export /gm, '');

  const initConfig = JSON.stringify({
    supabaseUrl,
    anonKey,
    siteKey: config.site_key,
    brandName: config.brand_name,
    showTrigger: true,
    triggerStyle: 'tab',
    widgetBase: WIDGET_BASE,
    noCssAutoLoad: true,
  });

  return { widgetVersion, text: `// ==UserScript==
// @name         Brand Chat – ${config.brand_name}
// @namespace    https://github.com/bwb1066/brand-chat-config-ui
// @version      ${widgetVersion}
// @description  ${config.brand_name} AI Concierge widget — widget v${widgetVersion}
// @author       Brand Chat Config
${matchLines}
// @grant        GM_addElement
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var BC_CFG = ${initConfig};
  console.log('[BrandChat] script starting', { siteKey: BC_CFG.siteKey, url: location.href, widgetVersion: '${widgetVersion}' });

  // Inject styles
  try {
    GM_addElement(document.head, 'style', { textContent: ${JSON.stringify(cssText)} });
    console.log('[BrandChat] CSS injected via GM_addElement');
  } catch (e) {
    console.error('[BrandChat] CSS injection failed:', e);
  }

  // Wrap fetch to log every network call and surface errors clearly
  var _nativeFetch = window.fetch.bind(window);
  window.fetch = function bcFetch(url, opts) {
    var method = (opts && opts.method) || 'GET';
    console.log('[BrandChat] fetch ->', method, typeof url === 'string' ? url.replace(/eyJ[^&"]+/g, '<JWT>') : url);
    return _nativeFetch(url, opts).then(function (r) {
      console.log('[BrandChat] fetch <-', r.status, typeof url === 'string' ? url.replace(/eyJ[^&"]+/g, '<JWT>') : url);
      if (!r.ok) console.warn('[BrandChat] fetch non-OK', r.status, url);
      return r;
    }, function (err) {
      console.error('[BrandChat] fetch error', url, err);
      throw err;
    });
  };

${widgetCode}

  // Call init and watch for the trigger element
  try {
    console.log('[BrandChat] calling init()');
    init(BC_CFG);
    console.log('[BrandChat] init() returned — readyState:', document.readyState);
  } catch (e) {
    console.error('[BrandChat] init() threw:', e, e && e.stack);
  }

  // Check whether the trigger tab appears in the DOM
  var _checkCount = 0;
  var _checkInterval = setInterval(function () {
    _checkCount++;
    var trigger = document.getElementById('bc-trigger');
    if (trigger) {
      console.log('[BrandChat] #bc-trigger found in DOM after', _checkCount * 250, 'ms', trigger);
      clearInterval(_checkInterval);
    } else if (_checkCount >= 20) {
      console.warn('[BrandChat] #bc-trigger NOT found after 5s — trigger may have been blocked or already existed');
      clearInterval(_checkInterval);
    }
  }, 250);

}());
` };
}

async function downloadScript(config) {
  try {
    const { text, widgetVersion } = await generateScript(config);
    const blob = new Blob([text], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `brand-chat-${config.site_key}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
    // Save to version history in the background
    saveScriptVersion(config.site_key, text, widgetVersion)
      .then(() => refreshVersionBadge(config.site_key))
      .catch((err) => console.warn('[versions] save failed:', err));
  } catch (e) {
    alert('Script generation failed: ' + e.message);
  }
}

/* ── site key derivation ─────────────────────────────────── */
function toSiteKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ── dom helpers ────────────────────────────────────────── */
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function el(id) { return document.getElementById(id); }

/* ── selection mode ─────────────────────────────────────── */
let selectMode = false;
const selected = new Set();

function updateSelectionUI() {
  el('selected-count').textContent = selected.size;
  el('btn-delete-selected').classList.toggle('hidden', selected.size === 0);
  document.querySelectorAll('.config-card').forEach((card) => {
    const key = card.dataset.siteKey;
    card.classList.toggle('selected', selected.has(key));
    const cb = card.querySelector('.card-checkbox');
    if (cb) cb.innerHTML = selected.has(key) ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : '';
  });
}

function enterSelectMode() {
  selectMode = true;
  selected.clear();
  el('config-grid').classList.add('select-mode');
  document.querySelectorAll('.config-card').forEach((card) => card.classList.add('selectable'));
  hide('btn-select');
  hide('btn-new');
  show('btn-select-all');
  show('btn-cancel-select');
  el('btn-delete-selected').classList.add('hidden');
}

function exitSelectMode() {
  selectMode = false;
  selected.clear();
  el('config-grid').classList.remove('select-mode');
  document.querySelectorAll('.config-card').forEach((card) => {
    card.classList.remove('selectable', 'selected');
  });
  show('btn-select');
  show('btn-new');
  hide('btn-select-all');
  hide('btn-cancel-select');
  hide('btn-delete-selected');
}

/* ── config list rendering ──────────────────────────────── */
let versionsMap = {}; // site_key → latest version row

function refreshVersionBadge(siteKey) {
  fetchAllScriptVersions().then((map) => {
    versionsMap = map;
    const card = document.querySelector(`.config-card[data-site-key="${siteKey}"]`);
    if (!card) return;
    const badge = card.querySelector('.version-badge');
    const v = map[siteKey];
    if (badge) badge.textContent = v ? `v${v.version}` : '';
    if (badge) badge.style.display = v ? '' : 'none';
  }).catch(() => {});
}

function renderConfigs(configs, vmap) {
  versionsMap = vmap || {};
  const grid = el('config-grid');
  const empty = el('list-empty');
  const count = el('config-count');

  grid.innerHTML = '';
  count.textContent = configs.length;

  if (configs.length === 0) {
    show('list-empty');
    return;
  }
  hide('list-empty');

  configs.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'config-card';
    card.dataset.siteKey = c.site_key;

    const domains = (c.domains || []).map((d) => `<span class="domain-tag">${d}</span>`).join('');
    const v = versionsMap[c.site_key];
    const vBadge = v ? `<span class="version-badge">v${v.version}</span>` : '<span class="version-badge" style="display:none"></span>';

    card.innerHTML = `
      <div class="card-checkbox"></div>
      <div class="config-card-name">${c.brand_name}${vBadge}</div>
      <div class="config-card-key">${c.site_key}</div>
      <div class="config-card-domains">${domains || '<span class="domain-tag" style="color:#868e96">no domains</span>'}</div>
      <div class="config-card-actions">
        <button class="btn-download btn-edit">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Edit
        </button>
        <button class="btn-download btn-script">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          TM script
        </button>
        <button class="btn-download btn-history">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          History
        </button>
      </div>`;

    card.querySelector('.btn-edit').addEventListener('click', (e) => {
      if (selectMode) return;
      e.stopPropagation();
      openEditModal(c);
    });
    card.querySelector('.btn-script').addEventListener('click', (e) => {
      if (selectMode) return;
      e.stopPropagation();
      downloadScript(c);
    });
    card.querySelector('.btn-history').addEventListener('click', (e) => {
      if (selectMode) return;
      e.stopPropagation();
      openVersionHistory(c.site_key, c.brand_name);
    });
    card.addEventListener('click', () => {
      if (selectMode) {
        if (selected.has(c.site_key)) selected.delete(c.site_key);
        else selected.add(c.site_key);
        updateSelectionUI();
      } else {
        openEditModal(c);
      }
    });

    grid.append(card);
  });
}

/* ── version history modal ──────────────────────────────── */
let versionHistorySiteKey = '';

async function openVersionHistory(siteKey, brandName) {
  versionHistorySiteKey = siteKey;
  el('versions-title').textContent = `Script versions — ${brandName}`;
  el('versions-list').innerHTML = '<p style="color:var(--gray-500);font-size:13px">Loading…</p>';
  show('modal-versions');
  try {
    const versions = await fetchSiteScriptVersions(siteKey);
    renderVersionList(versions);
  } catch (e) {
    el('versions-list').innerHTML = `<p style="color:var(--red);font-size:13px">Failed to load: ${e.message}</p>`;
  }
}

function renderVersionList(versions) {
  const list = el('versions-list');
  if (!versions.length) {
    list.innerHTML = '<p style="color:var(--gray-500);font-size:13px">No saved versions yet. Click <strong>TM script</strong> to generate and save the first one.</p>';
    return;
  }
  list.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'version-list';
  versions.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'version-item';
    const date = new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    row.innerHTML = `
      <span class="version-num">v${v.version}</span>
      <div class="version-meta">
        <span class="version-widget">widget ${v.widget_version}</span>
        <span class="version-date">${date}</span>
        ${v.notes ? `<span class="version-notes">${v.notes}</span>` : ''}
      </div>
      <div class="version-actions">
        <button class="btn-ghost btn-dl-version" data-version="${v.version}" style="font-size:12px;padding:4px 10px">Download</button>
      </div>`;
    wrap.append(row);
  });
  list.append(wrap);

  list.querySelectorAll('.btn-dl-version').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const full = await fetchScriptVersion(versionHistorySiteKey, btn.dataset.version);
        const blob = new Blob([full.script_content], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `brand-chat-${versionHistorySiteKey}-v${full.version}.user.js`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        alert('Download failed: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Download';
      }
    });
  });
}

/* ── upload old script modal ────────────────────────────── */
function openUploadScript(prefillSiteKey) {
  el('upload-site-key').value = prefillSiteKey || '';
  el('upload-notes').value = '';
  el('upload-script-content').value = '';
  el('upload-widget-version').value = '1.0.0';
  show('modal-upload-script');
}

/* ── config modal ───────────────────────────────────────── */
let editingKey = null;

function openNewModal() {
  editingKey = null;
  el('modal-title').textContent = 'New configuration';
  el('config-form').reset();
  hide('modal-delete');
  show('modal-config');
}

function openEditModal(config) {
  editingKey = config.site_key;
  el('modal-title').textContent = `Edit — ${config.brand_name}`;

  const form = el('config-form');
  form.reset();
  form.brand_name.value = config.brand_name || '';
  form.site_key.value = config.site_key || '';
  form.domains.value = (config.domains || []).join(', ');
  form.instructions.value = config.instructions || '';
  form.persona.value = config.persona || '';
  form.vector_store_id.value = config.vector_store_id || '';
  form.contact_url.value = config.contact_url || '';
  form.open_search_context.value = config.open_search_context || '';
  form.initial_prompt.value = config.initial_prompt || '';
  form.chat_title.value = config.chat_title || '';
  form.disable_citations.checked = config.disable_citations || false;

  show('modal-delete');
  show('modal-config');
}

function closeConfigModal() {
  hide('modal-config');
  editingKey = null;
}

function collectFormData() {
  const form = el('config-form');
  const brandName = form.brand_name.value.trim();
  const siteKey = form.site_key.value.trim() || toSiteKey(brandName);
  const domains = form.domains.value.split(',').map((d) => d.trim()).filter(Boolean);
  return {
    site_key: siteKey,
    brand_name: brandName,
    domains,
    instructions: form.instructions.value.trim() || '',
    persona: form.persona.value.trim() || null,
    vector_store_id: form.vector_store_id.value.trim() || null,
    contact_url: form.contact_url.value.trim() || null,
    open_search_context: form.open_search_context.value.trim() || null,
    initial_prompt: form.initial_prompt.value.trim() || null,
    chat_title: form.chat_title.value.trim() || null,
    disable_citations: form.disable_citations.checked,
  };
}

/* ── settings modal ─────────────────────────────────────── */
function openSettings() {
  el('settings-url').value = supabaseUrl;
  el('settings-anon-key').value = anonKey;
  el('settings-delete-password').value = deletePassword;
  show('modal-settings');
}

/* ── main flow ──────────────────────────────────────────── */
async function loadAndRender() {
  try {
    const [configs, vmap] = await Promise.all([fetchConfigs(), fetchAllScriptVersions()]);
    renderConfigs(configs, vmap);
  } catch {
    alert('Failed to load configurations. Check your connection settings.');
    openSettings();
  }
}

function init() {
  loadConnection();

  if (!supabaseUrl || !anonKey) {
    show('screen-setup');
    return;
  }

  show('screen-list');
  loadAndRender();
}

/* ── event wiring ───────────────────────────────────────── */

// Setup screen
el('btn-connect').addEventListener('click', async () => {
  const url = el('input-url').value.trim();
  const key = el('input-anon-key').value.trim();
  if (!url || !key) {
    el('setup-error').textContent = 'Both fields are required.';
    show('setup-error');
    return;
  }
  saveConnection(url, key);
  hide('screen-setup');
  show('screen-list');
  loadAndRender();
});

// Topbar
el('btn-new').addEventListener('click', openNewModal);
el('btn-settings').addEventListener('click', openSettings);

// Config modal
el('modal-close').addEventListener('click', closeConfigModal);
el('modal-cancel').addEventListener('click', closeConfigModal);
el('modal-config').addEventListener('click', (e) => { if (e.target === el('modal-config')) closeConfigModal(); });

el('modal-save').addEventListener('click', async () => {
  const data = collectFormData();
  if (!data.brand_name || !data.domains.length) {
    alert('Brand name and at least one domain are required.');
    return;
  }
  try {
    await upsertConfig(data);
    closeConfigModal();
    loadAndRender();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
});

el('modal-delete').addEventListener('click', async () => {
  if (!editingKey) return;
  if (!confirm(`Delete "${editingKey}"? This cannot be undone.`)) return;
  try {
    await deleteConfig(editingKey);
    closeConfigModal();
    loadAndRender();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
});

// Settings modal
el('settings-close').addEventListener('click', () => hide('modal-settings'));
el('settings-cancel').addEventListener('click', () => hide('modal-settings'));
el('modal-settings').addEventListener('click', (e) => { if (e.target === el('modal-settings')) hide('modal-settings'); });

el('settings-save').addEventListener('click', () => {
  const url = el('settings-url').value.trim();
  const key = el('settings-anon-key').value.trim();
  const pwd = el('settings-delete-password').value;
  if (!url || !key) return;
  saveConnection(url, key, pwd);
  hide('modal-settings');
  loadAndRender();
});

// Select mode
el('btn-select').addEventListener('click', () => {
  if (deletePassword) {
    const input = prompt('Enter delete password:');
    if (input !== deletePassword) {
      if (input !== null) alert('Incorrect password.');
      return;
    }
  }
  enterSelectMode();
});
el('btn-cancel-select').addEventListener('click', exitSelectMode);

el('btn-select-all').addEventListener('click', () => {
  const allKeys = [...document.querySelectorAll('.config-card')].map((c) => c.dataset.siteKey);
  const allSelected = allKeys.every((k) => selected.has(k));
  if (allSelected) {
    allKeys.forEach((k) => selected.delete(k));
    el('btn-select-all').textContent = 'Select all';
  } else {
    allKeys.forEach((k) => selected.add(k));
    el('btn-select-all').textContent = 'Deselect all';
  }
  updateSelectionUI();
});

el('btn-delete-selected').addEventListener('click', async () => {
  if (selected.size === 0) return;
  if (!confirm(`Delete ${selected.size} configuration${selected.size > 1 ? 's' : ''}? This cannot be undone.`)) return;
  try {
    await deleteConfigs([...selected]);
    exitSelectMode();
    loadAndRender();
  } catch (err) {
    console.error('[delete] failed:', err);
    alert(`Delete failed: ${err.message}\n\nCheck the browser console for details.`);
  }
});

// Auto-derive site key from brand name
el('config-form').brand_name.addEventListener('input', (e) => {
  const skField = el('config-form').site_key;
  if (!skField.dataset.manuallyEdited) {
    skField.value = toSiteKey(e.target.value);
  }
});
el('config-form').site_key.addEventListener('input', (e) => {
  e.target.dataset.manuallyEdited = e.target.value ? 'true' : '';
});

// Version history modal
el('versions-close').addEventListener('click', () => hide('modal-versions'));
el('versions-done').addEventListener('click', () => hide('modal-versions'));
el('modal-versions').addEventListener('click', (e) => { if (e.target === el('modal-versions')) hide('modal-versions'); });
el('versions-upload').addEventListener('click', () => {
  hide('modal-versions');
  openUploadScript(versionHistorySiteKey);
});

// Upload old script modal
el('upload-script-close').addEventListener('click', () => hide('modal-upload-script'));
el('upload-script-cancel').addEventListener('click', () => hide('modal-upload-script'));
el('modal-upload-script').addEventListener('click', (e) => { if (e.target === el('modal-upload-script')) hide('modal-upload-script'); });

el('upload-script-save').addEventListener('click', async () => {
  const siteKey = el('upload-site-key').value.trim();
  const content = el('upload-script-content').value.trim();
  if (!siteKey || !content) {
    alert('Site key and script content are required.');
    return;
  }
  const widgetVersion = el('upload-widget-version').value;
  const notes = el('upload-notes').value.trim() || null;
  try {
    el('upload-script-save').disabled = true;
    el('upload-script-save').textContent = 'Saving…';
    await saveScriptVersion(siteKey, content, widgetVersion, notes);
    hide('modal-upload-script');
    refreshVersionBadge(siteKey);
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    el('upload-script-save').disabled = false;
    el('upload-script-save').textContent = 'Save version';
  }
});

/* ── kick off ───────────────────────────────────────────── */
init();
