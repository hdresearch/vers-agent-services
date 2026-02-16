// Daemon Tab — Status, action log, event cursor, start/stop
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
  function fmtDuration(seconds) {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  let refreshTimer = null;

  // ─── Load status ───
  async function loadStatus() {
    try {
      const status = await fapi('/daemon/status');
      renderStatus(status);
    } catch (e) {
      document.getElementById('daemon-status-panel').innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderStatus(status) {
    const running = status.running;
    const dot = document.getElementById('daemon-dot');
    const label = document.getElementById('daemon-status-label');
    dot.className = 'daemon-dot ' + (running ? 'daemon-running' : 'daemon-stopped');
    label.textContent = running ? 'RUNNING' : 'STOPPED';

    document.getElementById('daemon-start-btn').disabled = running;
    document.getElementById('daemon-stop-btn').disabled = !running;

    // Vitals
    document.getElementById('daemon-uptime').textContent = fmtDuration(status.uptime);
    document.getElementById('daemon-started').textContent = status.startedAt ? timeAgo(status.startedAt) : '—';
    document.getElementById('daemon-last-poll').textContent = status.lastPollAt ? timeAgo(status.lastPollAt) : 'never';
    document.getElementById('daemon-last-action').textContent = status.lastActionAt ? timeAgo(status.lastActionAt) : 'never';
    document.getElementById('daemon-cursor').textContent = status.lastEventCursor || 0;
    document.getElementById('daemon-total-actions').textContent = status.totalActions || 0;

    // Recent actions preview
    const recent = status.recentActions || [];
    const preview = document.getElementById('daemon-recent-preview');
    if (!recent.length) {
      preview.innerHTML = '<div class="empty">No recent actions</div>';
    } else {
      let html = '';
      for (const a of recent.slice(0, 5)) {
        const resultCls = a.result === 'success' ? 'daemon-result-ok' : 'daemon-result-error';
        html += `<div class="daemon-action-mini">
          <span class="daemon-action-type">${esc(a.actionType)}</span>
          <span class="daemon-action-trigger">${esc(a.trigger)}</span>
          <span class="${resultCls}">${esc(a.result)}</span>
          <span class="daemon-action-time">${timeAgo(a.timestamp)}</span>
        </div>`;
      }
      preview.innerHTML = html;
    }
  }

  // ─── Load full action log ───
  async function loadActions() {
    const container = document.getElementById('daemon-actions-list');
    const limit = parseInt(document.getElementById('daemon-actions-limit').value) || 50;
    try {
      const data = await fapi(`/daemon/actions?limit=${limit}`);
      renderActions(data.actions || [], data.total || 0);
    } catch (e) {
      container.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderActions(actions, total) {
    const container = document.getElementById('daemon-actions-list');
    document.getElementById('daemon-actions-count').textContent = `${actions.length} / ${total}`;

    if (!actions.length) {
      container.innerHTML = '<div class="empty">No actions recorded</div>';
      return;
    }

    let html = '';
    for (const a of actions) {
      const resultCls = a.result === 'success' ? 'daemon-result-ok' : 'daemon-result-error';
      const meta = a.metadata ? JSON.stringify(a.metadata, null, 2) : null;
      html += `<div class="daemon-action-card" onclick="this.classList.toggle('expanded')">
        <div class="daemon-action-header">
          <span class="daemon-action-type-badge">${esc(a.actionType)}</span>
          <span class="daemon-action-desc">${esc(a.description || '—')}</span>
          <span class="${resultCls}">${esc(a.result)}</span>
          <span class="daemon-action-time">${timeAgo(a.timestamp)}</span>
        </div>
        <div class="daemon-action-details">
          <div class="daemon-detail-row"><span class="daemon-detail-label">Trigger</span><span>${esc(a.trigger)}</span></div>
          <div class="daemon-detail-row"><span class="daemon-detail-label">Trigger Event</span><span>${esc(a.triggerEventId || '—')}</span></div>
          <div class="daemon-detail-row"><span class="daemon-detail-label">Result Detail</span><span>${esc(a.resultDetail || '—')}</span></div>
          ${meta ? `<div class="daemon-detail-row"><span class="daemon-detail-label">Metadata</span><pre class="daemon-meta-pre">${esc(meta)}</pre></div>` : ''}
        </div>
      </div>`;
    }
    container.innerHTML = html;
  }

  // ─── Controls ───
  async function startDaemon() {
    try {
      await fapi('/daemon/start', { method: 'POST' });
      loadStatus();
    } catch (e) { alert('Start failed: ' + e.message); }
  }

  async function stopDaemon() {
    if (!confirm('Stop the daemon? It will no longer process events automatically.')) return;
    try {
      await fapi('/daemon/stop', { method: 'POST' });
      loadStatus();
    } catch (e) { alert('Stop failed: ' + e.message); }
  }

  // ─── Init ───
  function init() {
    document.getElementById('daemon-start-btn').addEventListener('click', startDaemon);
    document.getElementById('daemon-stop-btn').addEventListener('click', stopDaemon);
    document.getElementById('daemon-actions-limit').addEventListener('change', loadActions);
    document.getElementById('daemon-refresh-btn').addEventListener('click', () => { loadStatus(); loadActions(); });
  }

  window._daemonInit = function () {
    loadStatus();
    loadActions();
    refreshTimer = setInterval(() => { loadStatus(); loadActions(); }, 15000);
  };

  window._daemonDestroy = function () {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
