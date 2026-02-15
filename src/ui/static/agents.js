// Agents Tab — Personas, Cryochamber, Fleet Loop
// Uses same fapi() pattern (via /ui/api proxy) as other tabs

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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `API ${path}: ${res.status}`);
      }
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Timeout: ${path}`);
      throw e;
    }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  // ──────────────────── Sub-tab switching ────────────────────

  let activeSection = 'personas';

  function switchSection(name) {
    activeSection = name;
    document.querySelectorAll('.agents-subtab').forEach(t => t.classList.toggle('active', t.dataset.section === name));
    document.querySelectorAll('.agents-section').forEach(s => s.classList.toggle('active', s.id === `agents-section-${name}`));
    if (name === 'personas') loadPersonas();
    if (name === 'cryo') loadCryo();
    if (name === 'loop') loadLoop();
  }

  // ──────────────────── PERSONAS ────────────────────

  let allPersonas = [];

  async function loadPersonas() {
    const grid = document.getElementById('persona-grid');
    try {
      const data = await fapi('/personas');
      allPersonas = data.personas || [];
      renderPersonas();
    } catch (e) {
      grid.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderPersonas() {
    const grid = document.getElementById('persona-grid');
    const filter = (document.getElementById('persona-filter')?.value || '').toLowerCase();
    let list = allPersonas;
    if (filter) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(filter) ||
        (p.description || '').toLowerCase().includes(filter) ||
        (p.tags || []).some(t => t.toLowerCase().includes(filter))
      );
    }

    if (!list.length) { grid.innerHTML = '<div class="empty">No personas found</div>'; return; }

    let html = '';
    for (const p of list) {
      const tags = (p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
      const promptPreview = (p.systemPrompt || '').substring(0, 120);
      const specBadge = p.specialization ? `<span class="persona-spec">${esc(p.specialization)}</span>` : '';
      const extBadge = p.extends ? `<span class="persona-extends">extends ${esc(p.extends)}</span>` : '';
      html += `<div class="persona-card" data-name="${esc(p.name)}">
        <div class="persona-card-header">
          <span class="persona-name">${esc(p.name)}</span>
          <span class="persona-version">v${p.version || 1}</span>
        </div>
        ${p.description ? `<div class="persona-desc">${esc(p.description)}</div>` : ''}
        <div class="persona-prompt-preview">${esc(promptPreview)}${(p.systemPrompt || '').length > 120 ? '…' : ''}</div>
        <div class="persona-meta">
          ${specBadge}
          ${extBadge}
          ${tags}
          ${p.author ? `<span class="persona-author">@${esc(p.author)}</span>` : ''}
        </div>
      </div>`;
    }
    grid.innerHTML = html;

    // Click to expand detail
    grid.querySelectorAll('.persona-card').forEach(card => {
      card.addEventListener('click', () => showPersonaDetail(card.dataset.name));
    });
  }

  function showPersonaDetail(name) {
    const p = allPersonas.find(x => x.name === name);
    if (!p) return;
    const modal = document.getElementById('persona-detail-modal');
    document.getElementById('persona-detail-name').textContent = p.name;
    const tags = (p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
    document.getElementById('persona-detail-body').innerHTML = `
      <div class="detail-row"><span class="detail-label">Description</span><span>${esc(p.description || '—')}</span></div>
      <div class="detail-row"><span class="detail-label">Specialization</span><span>${esc(p.specialization || '—')}</span></div>
      <div class="detail-row"><span class="detail-label">Extends</span><span>${esc(p.extends || '—')}</span></div>
      <div class="detail-row"><span class="detail-label">Author</span><span>${esc(p.author || '—')}</span></div>
      <div class="detail-row"><span class="detail-label">Version</span><span>v${p.version || 1}</span></div>
      <div class="detail-row"><span class="detail-label">Tags</span><span>${tags || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Updated</span><span>${timeAgo(p.updatedAt)}</span></div>
      <div class="detail-section">
        <div class="detail-label">System Prompt</div>
        <pre class="detail-prompt">${esc(p.systemPrompt || '(none)')}</pre>
      </div>
    `;
    modal.style.display = 'flex';
    // Wire edit button
    document.getElementById('persona-detail-edit').onclick = () => {
      modal.style.display = 'none';
      openPersonaForm(p);
    };
  }

  function openPersonaForm(existing) {
    const modal = document.getElementById('persona-modal');
    document.getElementById('persona-form-title').textContent = existing ? `Edit: ${existing.name}` : 'New Persona';
    document.getElementById('pf-editing').value = existing ? existing.name : '';
    document.getElementById('pf-name').value = existing?.name || '';
    document.getElementById('pf-name').disabled = !!existing;
    document.getElementById('pf-description').value = existing?.description || '';
    document.getElementById('pf-specialization').value = existing?.specialization || '';
    document.getElementById('pf-author').value = existing?.author || '';
    document.getElementById('pf-tags').value = (existing?.tags || []).join(', ');
    document.getElementById('pf-extends').value = existing?.extends || '';
    document.getElementById('pf-prompt').value = existing?.systemPrompt || '';
    modal.style.display = 'flex';
  }

  async function savePersona(e) {
    e.preventDefault();
    const editing = document.getElementById('pf-editing').value;
    const tagsRaw = document.getElementById('pf-tags').value;
    const body = {
      name: document.getElementById('pf-name').value.trim(),
      description: document.getElementById('pf-description').value.trim(),
      specialization: document.getElementById('pf-specialization').value.trim() || undefined,
      author: document.getElementById('pf-author').value.trim() || undefined,
      tags: tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
      extends: document.getElementById('pf-extends').value.trim() || undefined,
      systemPrompt: document.getElementById('pf-prompt').value,
    };

    try {
      if (editing) {
        await fapi(`/personas/${encodeURIComponent(editing)}`, { method: 'PATCH', body });
      } else {
        await fapi('/personas', { method: 'POST', body });
      }
      document.getElementById('persona-modal').style.display = 'none';
      loadPersonas();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  // ──────────────────── CRYOCHAMBER ────────────────────

  let allCryoAgents = [];

  async function loadCryo() {
    const list = document.getElementById('cryo-list');
    try {
      const statusFilter = document.getElementById('cryo-status-filter').value;
      const path = statusFilter ? `/cryo/agents?status=${statusFilter}` : '/cryo/agents';
      const data = await fapi(path);
      allCryoAgents = data.agents || [];
      renderCryo();
    } catch (e) {
      list.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderCryo() {
    const list = document.getElementById('cryo-list');
    if (!allCryoAgents.length) { list.innerHTML = '<div class="empty">No agents in cryochamber</div>'; return; }

    let html = '';
    for (const a of allCryoAgents) {
      const statusCls = `cryo-status-${a.status || 'unknown'}`;
      const tags = (a.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
      const commitId = a.latestCommitId ? `<span class="cryo-commit" title="${esc(a.latestCommitId)}">📦 ${esc(a.latestCommitId.substring(0, 8))}</span>` : '';
      const sessions = a.sessionCount != null ? `<span class="cryo-sessions">${a.sessionCount} sessions</span>` : '';
      const vmId = a.currentVmId ? `<span class="cryo-vm">VM: ${esc(a.currentVmId.substring(0, 8))}</span>` : '';

      html += `<div class="cryo-card">
        <div class="cryo-card-header">
          <div class="cryo-name-row">
            <span class="cryo-name">${esc(a.name)}</span>
            <span class="cryo-status ${statusCls}">${esc(a.status || 'unknown')}</span>
          </div>
          <div class="cryo-actions">
            ${a.status === 'hibernating' ? `<button class="btn btn-sm btn-accent" onclick="window._agentsWake('${esc(a.name)}')">⚡ Wake</button>` : ''}
            ${a.status === 'awake' ? `<button class="btn btn-sm btn-warn" onclick="window._agentsHibernate('${esc(a.name)}')">❄ Freeze</button>` : ''}
            ${a.status !== 'retired' ? `<button class="btn btn-sm btn-danger" onclick="window._agentsRetire('${esc(a.name)}')">☠ Retire</button>` : ''}
          </div>
        </div>
        <div class="cryo-meta">
          ${a.persona ? `<span class="cryo-persona">🎭 ${esc(a.persona)}</span>` : ''}
          ${commitId}
          ${vmId}
          ${sessions}
          ${tags}
          <span class="cryo-time">${timeAgo(a.lastActiveAt || a.updatedAt)}</span>
        </div>
      </div>`;
    }
    list.innerHTML = html;
  }

  window._agentsWake = async function (name) {
    try {
      await fapi(`/cryo/agents/${encodeURIComponent(name)}/wake`, { method: 'POST', body: {} });
      loadCryo();
    } catch (e) { alert('Wake failed: ' + e.message); }
  };

  window._agentsHibernate = async function (name) {
    try {
      await fapi(`/cryo/agents/${encodeURIComponent(name)}/hibernate`, { method: 'POST', body: {} });
      loadCryo();
    } catch (e) { alert('Freeze failed: ' + e.message); }
  };

  window._agentsRetire = async function (name) {
    if (!confirm(`Retire agent "${name}" permanently?`)) return;
    try {
      await fapi(`/cryo/agents/${encodeURIComponent(name)}/retire`, { method: 'POST', body: {} });
      loadCryo();
    } catch (e) { alert('Retire failed: ' + e.message); }
  };

  async function createCryoAgent(e) {
    e.preventDefault();
    const tagsRaw = document.getElementById('cf-tags').value;
    const body = {
      name: document.getElementById('cf-name').value.trim(),
      persona: document.getElementById('cf-persona').value.trim() || undefined,
      tags: tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
    };
    try {
      await fapi('/cryo/agents', { method: 'POST', body });
      document.getElementById('cryo-modal').style.display = 'none';
      loadCryo();
    } catch (err) { alert('Error: ' + err.message); }
  }

  // ──────────────────── FLEET LOOP ────────────────────

  async function loadLoop() {
    const container = document.getElementById('loop-roles');
    try {
      const status = await fapi('/loop/status');
      renderLoop(status);
    } catch (e) {
      container.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderLoop(status) {
    const container = document.getElementById('loop-roles');
    const dot = document.getElementById('loop-dot');
    const label = document.getElementById('loop-status-label');

    const running = status.running;
    dot.className = 'loop-dot ' + (running ? 'loop-running' : 'loop-stopped');
    label.textContent = running ? 'RUNNING' : 'STOPPED';

    document.getElementById('loop-start-btn').disabled = running;
    document.getElementById('loop-stop-btn').disabled = !running;

    const roles = status.roles || [];
    if (!roles.length) { container.innerHTML = '<div class="empty">No roles configured</div>'; return; }

    let html = '';
    for (const r of roles) {
      const enabledCls = r.enabled ? 'role-enabled' : 'role-disabled';
      const lastRun = r.lastRunAt ? timeAgo(r.lastRunAt) : 'never';
      const lastResult = r.lastResult || '—';
      const resultCls = lastResult === 'ok' ? 'result-ok' : (lastResult === 'error' ? 'result-error' : '');
      const intervalSec = r.intervalMs ? Math.round(r.intervalMs / 1000) : '—';

      html += `<div class="loop-role-card ${enabledCls}">
        <div class="loop-role-header">
          <div class="loop-role-name-row">
            <span class="loop-role-icon">${roleIcon(r.name)}</span>
            <span class="loop-role-name">${esc(r.name)}</span>
            <span class="loop-role-task">${esc(r.task || '')}</span>
          </div>
          <label class="loop-toggle">
            <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="window._agentsToggleRole('${esc(r.name)}', this.checked)">
            <span class="loop-toggle-slider"></span>
          </label>
        </div>
        ${r.description ? `<div class="loop-role-desc">${esc(r.description)}</div>` : ''}
        <div class="loop-role-stats">
          <div class="loop-stat"><span class="loop-stat-label">Runs</span><span class="loop-stat-val">${r.runCount || 0}</span></div>
          <div class="loop-stat"><span class="loop-stat-label">Last Run</span><span class="loop-stat-val">${lastRun}</span></div>
          <div class="loop-stat"><span class="loop-stat-label">Result</span><span class="loop-stat-val ${resultCls}">${esc(lastResult)}</span></div>
          <div class="loop-stat"><span class="loop-stat-label">Interval</span><span class="loop-stat-val">${intervalSec}s</span></div>
        </div>
      </div>`;
    }
    container.innerHTML = html;
  }

  function roleIcon(name) {
    const icons = { sentinel: '🛡', quartermaster: '📋', scribe: '📝', auditor: '🔍' };
    return icons[name?.toLowerCase()] || '⚙';
  }

  window._agentsToggleRole = async function (name, enabled) {
    try {
      await fapi(`/loop/config/${encodeURIComponent(name)}`, { method: 'PATCH', body: { enabled } });
      loadLoop();
    } catch (e) { alert('Toggle failed: ' + e.message); }
  };

  async function startLoop() {
    try { await fapi('/loop/start', { method: 'POST' }); loadLoop(); }
    catch (e) { alert('Start failed: ' + e.message); }
  }

  async function stopLoop() {
    try { await fapi('/loop/stop', { method: 'POST' }); loadLoop(); }
    catch (e) { alert('Stop failed: ' + e.message); }
  }

  // ──────────────────── INIT / LIFECYCLE ────────────────────

  let refreshTimer = null;

  function init() {
    // Sub-tab switching
    document.querySelectorAll('.agents-subtab').forEach(tab => {
      tab.addEventListener('click', () => switchSection(tab.dataset.section));
    });

    // Persona filter
    document.getElementById('persona-filter').addEventListener('input', () => {
      clearTimeout(window._pFilterTimeout);
      window._pFilterTimeout = setTimeout(renderPersonas, 300);
    });

    // Persona form
    document.getElementById('persona-add-btn').addEventListener('click', () => openPersonaForm(null));
    document.getElementById('persona-form').addEventListener('submit', savePersona);
    document.getElementById('persona-form-cancel').addEventListener('click', () => {
      document.getElementById('persona-modal').style.display = 'none';
    });
    document.getElementById('persona-modal-close').addEventListener('click', () => {
      document.getElementById('persona-modal').style.display = 'none';
    });
    document.getElementById('persona-detail-close').addEventListener('click', () => {
      document.getElementById('persona-detail-modal').style.display = 'none';
    });
    // Close modals on overlay click
    ['persona-modal', 'persona-detail-modal', 'cryo-modal'].forEach(id => {
      document.getElementById(id).addEventListener('click', function (e) {
        if (e.target === this) this.style.display = 'none';
      });
    });

    // Cryo
    document.getElementById('cryo-add-btn').addEventListener('click', () => {
      document.getElementById('cryo-modal').style.display = 'flex';
    });
    document.getElementById('cryo-modal-close').addEventListener('click', () => {
      document.getElementById('cryo-modal').style.display = 'none';
    });
    document.getElementById('cryo-form-cancel').addEventListener('click', () => {
      document.getElementById('cryo-modal').style.display = 'none';
    });
    document.getElementById('cryo-form').addEventListener('submit', createCryoAgent);
    document.getElementById('cryo-status-filter').addEventListener('change', loadCryo);

    // Loop
    document.getElementById('loop-start-btn').addEventListener('click', startLoop);
    document.getElementById('loop-stop-btn').addEventListener('click', stopLoop);
  }

  // Exposed for app.js tab lifecycle
  window._agentsInit = function () {
    loadPersonas();
    refreshTimer = setInterval(() => {
      if (activeSection === 'personas') loadPersonas();
      if (activeSection === 'cryo') loadCryo();
      if (activeSection === 'loop') loadLoop();
    }, 30000);
  };

  window._agentsDestroy = function () {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  };

  // Run init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
