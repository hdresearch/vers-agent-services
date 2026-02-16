// Config Tab — View/edit config values with secret masking
(function () {
  const API = '/ui/api';

  async function fapi(path, opts = {}) {
    const timeout = opts.timeout || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${API}${path}`, {
        signal: controller.signal,
        method: opts.method || 'GET',
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      clearTimeout(timer);
      if (res.status === 401) { window.location.href = '/ui/login'; throw new Error('Session expired'); }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `${res.status}`); }
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Timeout: ${path}`);
      throw e;
    }
  }

  // Delegate to shared utils (see utils.js)
  const esc = window._utils ? window._utils.esc : function (s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
  const timeAgo = window._utils ? window._utils.timeAgo : function (iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  let allEntries = [];
  let refreshTimer = null;
  let revealedKeys = new Set();

  // ─── Load entries ───
  async function loadEntries() {
    try {
      const data = await fapi('/config');
      allEntries = data.entries || [];
      renderEntries();
    } catch (e) {
      document.getElementById('config-list').innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderEntries() {
    const container = document.getElementById('config-list');
    const filter = (document.getElementById('config-filter')?.value || '').toLowerCase();
    const typeFilter = document.getElementById('config-type-filter').value;

    let entries = allEntries;
    if (filter) {
      entries = entries.filter(e => e.key.toLowerCase().includes(filter) || (e.value || '').toLowerCase().includes(filter));
    }
    if (typeFilter) {
      entries = entries.filter(e => e.type === typeFilter);
    }

    // Stats
    const secrets = allEntries.filter(e => e.type === 'secret').length;
    const configs = allEntries.filter(e => e.type === 'config').length;
    document.getElementById('config-stat-total').textContent = allEntries.length;
    document.getElementById('config-stat-secrets').textContent = secrets;
    document.getElementById('config-stat-configs').textContent = configs;

    if (!entries.length) {
      container.innerHTML = '<div class="empty">No config entries match</div>';
      return;
    }

    let html = '';
    for (const e of entries) {
      const isSecret = e.type === 'secret';
      const isMasked = (e.value || '').includes('***');
      const revealed = revealedKeys.has(e.key);
      const displayVal = revealed ? e._revealedValue || e.value : e.value;

      html += `<div class="config-entry ${isSecret ? 'config-secret' : 'config-plain'}">
        <div class="config-entry-header">
          <span class="config-key">${esc(e.key)}</span>
          <div class="config-entry-actions">
            <span class="config-type-badge config-type-${esc(e.type)}">${esc(e.type)}</span>
            ${isSecret && isMasked ? `<button class="config-btn config-reveal-btn" data-key="${esc(e.key)}" title="Reveal">${revealed ? '🙈 Hide' : '👁 Reveal'}</button>` : ''}
            <button class="config-btn config-edit-btn" data-key="${esc(e.key)}" title="Edit">✏️</button>
            <button class="config-btn config-delete-btn" data-key="${esc(e.key)}" title="Delete">🗑</button>
          </div>
        </div>
        <div class="config-value">${esc(displayVal || '(empty)')}</div>
        <div class="config-meta">Updated ${timeAgo(e.updatedAt)}</div>
      </div>`;
    }
    container.innerHTML = html;

    // Wire up actions
    container.querySelectorAll('.config-reveal-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleReveal(btn.dataset.key); });
    });
    container.querySelectorAll('.config-edit-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); openEditModal(btn.dataset.key); });
    });
    container.querySelectorAll('.config-delete-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); deleteEntry(btn.dataset.key); });
    });
  }

  // ─── Reveal secret ───
  async function toggleReveal(key) {
    if (revealedKeys.has(key)) {
      revealedKeys.delete(key);
      renderEntries();
      return;
    }
    try {
      const entry = await fapi(`/config/${encodeURIComponent(key)}?reveal=true`);
      // Store revealed value
      const existing = allEntries.find(e => e.key === key);
      if (existing) existing._revealedValue = entry.value;
      revealedKeys.add(key);
      renderEntries();
      // Auto-hide after 10s
      setTimeout(() => { revealedKeys.delete(key); renderEntries(); }, 10000);
    } catch (e) {
      alert('Reveal failed: ' + e.message);
    }
  }

  // ─── Edit modal ───
  function openEditModal(key) {
    const entry = allEntries.find(e => e.key === key);
    const modal = document.getElementById('config-modal');
    document.getElementById('config-modal-title').textContent = key ? `Edit: ${key}` : 'New Config Entry';
    document.getElementById('config-modal-key').value = key || '';
    document.getElementById('config-modal-key').disabled = !!key;
    document.getElementById('config-modal-value').value = entry?._revealedValue || (entry?.value?.includes('***') ? '' : entry?.value) || '';
    document.getElementById('config-modal-type').value = entry?.type || 'config';
    if (entry?.type === 'secret' && entry?.value?.includes('***')) {
      document.getElementById('config-modal-value').placeholder = 'Current value is masked. Enter new value or leave empty to keep.';
    } else {
      document.getElementById('config-modal-value').placeholder = 'Config value';
    }
    modal.style.display = 'flex';
  }

  async function saveEntry() {
    const key = document.getElementById('config-modal-key').value.trim();
    const value = document.getElementById('config-modal-value').value;
    const type = document.getElementById('config-modal-type').value;

    if (!key) { alert('Key is required'); return; }
    // If editing a secret and value is empty, skip (keep existing)
    const existing = allEntries.find(e => e.key === key);
    if (existing?.type === 'secret' && !value) {
      document.getElementById('config-modal').style.display = 'none';
      return;
    }

    try {
      await fapi(`/config/${encodeURIComponent(key)}`, { method: 'PUT', body: { value, type } });
      document.getElementById('config-modal').style.display = 'none';
      revealedKeys.delete(key);
      loadEntries();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }

  async function deleteEntry(key) {
    if (!confirm(`Delete config entry "${key}"? This cannot be undone.`)) return;
    try {
      await fapi(`/config/${encodeURIComponent(key)}`, { method: 'DELETE' });
      revealedKeys.delete(key);
      loadEntries();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  // ─── Init ───
  function init() {
    const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
    document.getElementById('config-filter').addEventListener('input', debounce(renderEntries, 300));
    document.getElementById('config-type-filter').addEventListener('change', renderEntries);
    document.getElementById('config-add-btn').addEventListener('click', () => openEditModal(null));
    document.getElementById('config-refresh-btn').addEventListener('click', loadEntries);

    // Modal
    document.getElementById('config-modal-save').addEventListener('click', saveEntry);
    document.getElementById('config-modal-cancel').addEventListener('click', () => {
      document.getElementById('config-modal').style.display = 'none';
    });
    document.getElementById('config-modal-close').addEventListener('click', () => {
      document.getElementById('config-modal').style.display = 'none';
    });
    document.getElementById('config-modal').addEventListener('click', function (e) {
      if (e.target === this) this.style.display = 'none';
    });
  }

  window._configInit = function () {
    loadEntries();
    refreshTimer = setInterval(loadEntries, 30000);
  };

  window._configDestroy = function () {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    revealedKeys.clear();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
