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

/* ── tampermonkey script generator ─────────────────────── */
function generateScript(config) {
  const domains = (config.domains || []);
  const matchLines = domains.flatMap((d) => [
    `// @match        https://${d}/*`,
    `// @match        https://*.${d}/*`,
  ]).join('\n');

  return `// ==UserScript==
// @name         Brand Chat – ${config.brand_name}
// @namespace    https://github.com/bwb1066/brand-chat-config-ui
// @version      1.0.0
// @description  ${config.brand_name} AI Concierge widget
// @author       Brand Chat Config
${matchLines}
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const script = document.createElement('script');
  script.type = 'module';
  script.src = '${WIDGET_BASE}brand-concierge.js';
  script.dataset.siteKey = '${config.site_key}';
  script.dataset.supabaseUrl = '${supabaseUrl}';
  script.dataset.supabaseAnonKey = '${anonKey}';
  script.dataset.showTrigger = 'true';
  script.dataset.triggerStyle = 'tab';
  document.head.appendChild(script);
}());
`;
}

function downloadScript(config) {
  const text = generateScript(config);
  const blob = new Blob([text], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `brand-chat-${config.site_key}.user.js`;
  a.click();
  URL.revokeObjectURL(url);
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
function renderConfigs(configs) {
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

    card.innerHTML = `
      <div class="card-checkbox"></div>
      <div class="config-card-name">${c.brand_name}</div>
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
    const configs = await fetchConfigs();
    renderConfigs(configs);
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

/* ── kick off ───────────────────────────────────────────── */
init();
