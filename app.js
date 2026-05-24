/* ── connection state ───────────────────────────────────── */
const WIDGET_BASE = 'https://bwb1066.github.io/brand-chat-config-ui/widget/';

// Public read-only credentials — safe to hardcode (anon key, no RLS write access)
const DEFAULT_URL = 'https://cyjquwhkmzyedkwuaffc.supabase.co';
const DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5anF1d2hrbXp5ZWRrd3VhZmZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNjY4MjcsImV4cCI6MjA5MDY0MjgyN30.GkMBLXBZr9u34m4uI6ZR-2ZniLZD3RkjropjQw058k4';

let supabaseUrl = '';
let anonKey = '';
let adminPassword = '';

function loadConnection() {
  supabaseUrl = localStorage.getItem('bc_supabase_url') || DEFAULT_URL;
  anonKey = localStorage.getItem('bc_anon_key') || DEFAULT_KEY;
  // Password is never persisted — must be re-entered each session
  adminPassword = '';
}

function saveConnection(url, key, pwd) {
  supabaseUrl = url;
  anonKey = key;
  adminPassword = pwd;
  localStorage.setItem('bc_supabase_url', url);
  localStorage.setItem('bc_anon_key', key);
  // Password intentionally not persisted to localStorage
}

/* ── auth modal ─────────────────────────────────────────── */
let pendingAuthResolve = null;

function requireAuth() {
  // Already authenticated this session — proceed immediately
  if (adminPassword) return Promise.resolve(true);

  return new Promise((resolve) => {
    pendingAuthResolve = resolve;
    const needsConnection = !supabaseUrl || !anonKey;
    el('auth-connection-fields').classList.toggle('hidden', !needsConnection);
    if (supabaseUrl) el('auth-url').value = supabaseUrl;
    if (anonKey) el('auth-anon-key').value = anonKey;
    el('auth-password').value = '';
    hide('auth-error');
    show('modal-auth');
    setTimeout(() => el('auth-password').focus(), 50);
  });
}

function resolveAuth(ok) {
  hide('modal-auth');
  if (pendingAuthResolve) {
    const resolve = pendingAuthResolve;
    pendingAuthResolve = null;
    resolve(ok);
  }
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

// Strip protocol/path from a domain entry so @match lines are always valid.
function sanitizeDomain(d) {
  const s = d.trim();
  try {
    return new URL(s.includes('://') ? s : `https://${s}`).hostname;
  } catch {
    return s.replace(/^https?:\/\//i, '').split('/')[0].trim();
  }
}

function tmMatchLines(config) {
  return (config.domains || []).flatMap((d) => {
    const h = sanitizeDomain(d);
    return [`// @match        https://${h}/*`, `// @match        https://*.${h}/*`];
  }).join('\n');
}

function tmHeader(config, matchLines, tmVersion, grants) {
  const grantLines = grants.map((g) => `// @grant        ${g}`).join('\n');
  return `// ==UserScript==
// @name         Brand Chat – ${config.brand_name}
// @namespace    https://github.com/bwb1066/brand-chat-config-ui
// @version      ${tmVersion}
// @description  ${config.brand_name} AI Concierge widget
// @author       Brand Chat Config
${matchLines}
${grantLines}
// @run-at       document-idle
// ==/UserScript==`;
}

// Template 1 — script tag injection (simplest, @grant none).
// Works on sites with no script-src CSP restrictions.
function tmScriptTagTemplate(config, matchLines, tmVersion) {
  return `${tmHeader(config, matchLines, tmVersion, ['none'])}

(function () {
  'use strict';
  console.log('[BrandChat] injecting script tag for ${config.site_key}');
  const s = document.createElement('script');
  s.type = 'module';
  s.src = '${WIDGET_BASE}brand-concierge.js';
  s.dataset.siteKey = '${config.site_key}';
  s.dataset.supabaseUrl = '${supabaseUrl}';
  s.dataset.supabaseAnonKey = '${anonKey}';
  s.dataset.showTrigger = 'true';
  s.dataset.triggerStyle = 'tab';
  document.head.appendChild(s);
}());
`;
}

// Template 2 — GM_addElement script injection.
// Bypasses script-src CSP; the loaded module still runs in page context.
function tmGmElementTemplate(config, matchLines, tmVersion) {
  return `${tmHeader(config, matchLines, tmVersion, ['GM_addElement'])}

(function () {
  'use strict';
  console.log('[BrandChat] injecting via GM_addElement for ${config.site_key}');
  GM_addElement(document.head, 'script', {
    type: 'module',
    src: '${WIDGET_BASE}brand-concierge.js',
    'data-site-key': '${config.site_key}',
    'data-supabase-url': '${supabaseUrl}',
    'data-supabase-anon-key': '${anonKey}',
    'data-show-trigger': 'true',
    'data-trigger-style': 'tab',
  });
}());
`;
}

// Template 3 — fully inlined (widget JS + CSS baked in at generation time).
// Works on sites with Trusted Types or the most restrictive CSP because nothing
// is injected at runtime — the widget runs directly in TM's isolated world.
async function tmInlineTemplate(config, matchLines, tmVersion, scriptVersion) {
  const [cssResp, jsResp] = await Promise.all([
    fetch(WIDGET_BASE + 'brand-concierge.css'),
    fetch(WIDGET_BASE + 'brand-concierge.js'),
  ]);
  const cssText = await cssResp.text();
  const jsText = await jsResp.text();

  const versionMatch = jsText.match(/^const WIDGET_VERSION = ['"]([^'"]+)['"]/m);
  const widgetVersion = versionMatch ? versionMatch[1] : 'unknown';

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

  const text = `${tmHeader(config, matchLines, tmVersion, ['GM_addElement'])}

(function () {
  'use strict';

  var BC_CFG = ${initConfig};
  console.log('[BrandChat] script starting', { siteKey: BC_CFG.siteKey, url: location.href, widgetVersion: '${widgetVersion}', scriptVersion: ${scriptVersion} });

  try {
    GM_addElement(document.head, 'style', { textContent: ${JSON.stringify(cssText)} });
    console.log('[BrandChat] CSS injected via GM_addElement');
  } catch (e) {
    console.error('[BrandChat] CSS injection failed:', e);
  }

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

  try {
    console.log('[BrandChat] calling init()');
    init(BC_CFG);
    console.log('[BrandChat] init() returned — readyState:', document.readyState);
  } catch (e) {
    console.error('[BrandChat] init() threw:', e, e && e.stack);
  }

  var _n = 0;
  var _t = setInterval(function () {
    _n++;
    var trigger = document.getElementById('bc-trigger');
    if (trigger) { console.log('[BrandChat] #bc-trigger found after', _n * 250, 'ms'); clearInterval(_t); }
    else if (_n >= 20) { console.warn('[BrandChat] #bc-trigger NOT found after 5s'); clearInterval(_t); }
  }, 250);

}());
`;
  return { widgetVersion, text };
}

async function generateScript(config, scriptVersion, templateId = 'script-tag') {
  const matchLines = tmMatchLines(config);
  const sv = scriptVersion || 1;
  const tmVersion = `${sv}.0.0`;

  if (templateId === 'gm-element') {
    return { widgetVersion: 'external', templateId, text: tmGmElementTemplate(config, matchLines, tmVersion) };
  }

  if (templateId === 'inline') {
    const { widgetVersion, text } = await tmInlineTemplate(config, matchLines, tmVersion, sv);
    return { widgetVersion, templateId, text };
  }

  // default: script-tag
  return { widgetVersion: 'external', templateId: 'script-tag', text: tmScriptTagTemplate(config, matchLines, tmVersion) };
}

let templateModalConfig = null;

function openTemplateModal(config) {
  templateModalConfig = config;
  el('template-modal-title').textContent = `TM script — ${config.brand_name}`;
  const radios = document.querySelectorAll('input[name="tm-template"]');
  radios.forEach((r) => { r.checked = r.value === 'script-tag'; });
  show('modal-template');
}

async function downloadScript(config, templateId = 'script-tag') {
  try {
    let nextVersion = 1;
    try {
      const existing = await fetchSiteScriptVersions(config.site_key);
      if (existing.length > 0) nextVersion = existing[0].version + 1;
    } catch { /* use 1 */ }

    const { text, widgetVersion, templateId: usedTemplate } = await generateScript(config, nextVersion, templateId);
    const blob = new Blob([text], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `brand-chat-${config.site_key}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
    saveScriptVersion(config.site_key, text, widgetVersion, `template:${usedTemplate}`)
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
      openTemplateModal(c);
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
  el('settings-delete-password').value = '';
  show('modal-settings');
}

/* ── main flow ──────────────────────────────────────────── */
async function loadAndRender() {
  if (!supabaseUrl || !anonKey) return;
  try {
    const [configs, vmap] = await Promise.all([fetchConfigs(), fetchAllScriptVersions()]);
    renderConfigs(configs, vmap);
  } catch {
    alert('Failed to load configurations. Check connection settings (gear icon).');
  }
}

function init() {
  loadConnection();
  show('screen-list');
  loadAndRender();
}

/* ── event wiring ───────────────────────────────────────── */

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
  if (!await requireAuth()) return;
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
  if (!await requireAuth()) return;
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
  saveConnection(url, key, pwd || adminPassword);
  hide('modal-settings');
  loadAndRender();
});

// Auth modal
el('auth-cancel').addEventListener('click', () => resolveAuth(false));
el('modal-auth').addEventListener('click', (e) => { if (e.target === el('modal-auth')) resolveAuth(false); });

el('auth-confirm').addEventListener('click', () => {
  const needsConnection = !supabaseUrl || !anonKey;
  if (needsConnection) {
    const url = el('auth-url').value.trim();
    const key = el('auth-anon-key').value.trim();
    if (!url || !key) {
      el('auth-error').textContent = 'Supabase URL and anon key are required.';
      show('auth-error');
      return;
    }
    supabaseUrl = url;
    anonKey = key;
    localStorage.setItem('bc_supabase_url', url);
    localStorage.setItem('bc_anon_key', key);
    loadAndRender();
  }
  const pwd = el('auth-password').value;
  if (!pwd) {
    el('auth-error').textContent = 'Admin password is required.';
    show('auth-error');
    return;
  }
  adminPassword = pwd;
  resolveAuth(true);
});

// Select mode
el('btn-select').addEventListener('click', async () => {
  if (!await requireAuth()) return;
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

// Template picker modal
el('template-close').addEventListener('click', () => hide('modal-template'));
el('template-cancel').addEventListener('click', () => hide('modal-template'));
el('modal-template').addEventListener('click', (e) => { if (e.target === el('modal-template')) hide('modal-template'); });
el('template-generate').addEventListener('click', () => {
  const selected = document.querySelector('input[name="tm-template"]:checked');
  const templateId = selected ? selected.value : 'script-tag';
  hide('modal-template');
  downloadScript(templateModalConfig, templateId);
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
