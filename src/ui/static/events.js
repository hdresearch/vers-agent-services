// Events Tab — Full event log viewer with filters, stats, and SSE streaming
(function () {
  const API = '/ui/api';

  async function fapi(path, opts = {}) {
    const timeout = opts.timeout || 10000;
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
  function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ─── State ───
  let allEvents = [];
  let stats = null;
  let refreshTimer = null;
  let sseSource = null;
  let streaming = false;
  let lastEventId = 0;

  // ─── Load stats ───
  async function loadStats() {
    try {
      stats = await fapi('/events/stats');
      renderStats();
    } catch (e) {
      document.getElementById('events-stats-bar').innerHTML = `<span class="events-stat">Failed to load stats</span>`;
    }
  }

  function renderStats() {
    if (!stats) return;
    const bar = document.getElementById('events-stats-bar');
    // Top sources by count
    const sources = Object.entries(stats.bySource || {}).sort((a, b) => b[1] - a[1]);
    const topSources = sources.slice(0, 8);

    let html = `<div class="events-stat">Total <span class="events-stat-val">${stats.total.toLocaleString()}</span></div>`;
    html += `<div class="events-stat-sep"></div>`;
    for (const [src, count] of topSources) {
      html += `<div class="events-stat events-stat-clickable" data-source="${esc(src)}">
        ${esc(src)} <span class="events-stat-val">${count.toLocaleString()}</span>
      </div>`;
    }
    bar.innerHTML = html;

    // Click to filter by source
    bar.querySelectorAll('.events-stat-clickable').forEach(el => {
      el.addEventListener('click', () => {
        const src = el.dataset.source;
        const input = document.getElementById('events-source-filter');
        input.value = input.value === src ? '' : src;
        loadEvents();
      });
    });
  }

  // ─── Load events ───
  async function loadEvents() {
    const container = document.getElementById('events-list');
    const source = document.getElementById('events-source-filter').value.trim();
    const type = document.getElementById('events-type-filter').value.trim();
    const agent = document.getElementById('events-agent-filter').value.trim();
    const limit = parseInt(document.getElementById('events-limit').value) || 100;

    try {
      let path = `/events?limit=${limit}`;
      if (source) path += `&source=${encodeURIComponent(source)}`;
      if (type) path += `&type=${encodeURIComponent(type)}`;
      if (agent) path += `&agent=${encodeURIComponent(agent)}`;
      // Exclude noisy feed.event.published by default
      const excludeNoisy = document.getElementById('events-exclude-noise').checked;
      if (excludeNoisy) path += `&exclude=feed.event.published`;

      const data = await fapi(path);
      allEvents = data.events || [];
      // Track last event ID for SSE
      if (allEvents.length > 0) {
        lastEventId = Math.max(...allEvents.map(e => e.id || 0));
      }
      renderEvents();
      document.getElementById('events-count').textContent = `${allEvents.length} shown / ${(stats?.total || '?')} total`;
    } catch (e) {
      container.innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
    }
  }

  function renderEvents() {
    const container = document.getElementById('events-list');
    if (!allEvents.length) {
      container.innerHTML = '<div class="empty">No events match filters</div>';
      return;
    }

    // Reverse to show newest first
    const events = [...allEvents].reverse();
    let html = '';
    for (const evt of events) {
      const payload = evt.payload ? JSON.stringify(evt.payload, null, 2) : null;
      const payloadPreview = payload && payload.length > 120 ? payload.substring(0, 120) + '…' : payload;
      const typeParts = (evt.type || '').split('.');
      const typeColor = typeColorMap(typeParts[0]);

      html += `<div class="events-row" onclick="this.classList.toggle('expanded')">
        <div class="events-row-main">
          <span class="events-id">#${evt.id || '—'}</span>
          <span class="events-time">${fmtTime(evt.timestamp)}</span>
          <span class="events-source" style="color:${typeColor}">${esc(evt.source || '—')}</span>
          <span class="events-type">${esc(evt.type || '—')}</span>
          ${evt.agent ? `<span class="events-agent">@${esc(evt.agent)}</span>` : ''}
          <span class="events-age">${timeAgo(evt.timestamp)}</span>
        </div>
        ${payload ? `<div class="events-payload"><pre>${esc(payload)}</pre></div>` : ''}
      </div>`;
    }
    container.innerHTML = html;
  }

  function typeColorMap(source) {
    const colors = {
      board: '#4f9', feed: '#888', loop: '#fd0', commits: '#a7f',
      cryo: '#5bf', couch: '#f80', registry: '#4f9', personas: '#f5a',
      gossip: '#ff0', kb: '#0df', log: '#aaa', reports: '#8af',
      skills: '#5f5', 'fleet-chat': '#f5f', journal: '#fa0', webhook: '#f55',
    };
    return colors[source] || '#ccc';
  }

  // ─── SSE streaming ───
  function startStream() {
    if (sseSource) return;
    streaming = true;
    const dot = document.getElementById('events-stream-dot');
    const label = document.getElementById('events-stream-label');

    let path = `/events/stream`;
    if (lastEventId > 0) path += `?since_id=${lastEventId}`;

    sseSource = new EventSource(`${API}${path}`);
    sseSource.onopen = () => { dot.className = 'events-dot connected'; label.textContent = 'streaming'; };
    sseSource.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        // Add to top of list
        allEvents.push(evt);
        if (evt.id) lastEventId = Math.max(lastEventId, evt.id);
        // Append to DOM without full re-render
        prependEventRow(evt);
        // Update count
        const countEl = document.getElementById('events-count');
        countEl.textContent = `${allEvents.length} shown (live)`;
      } catch {}
    };
    sseSource.onerror = () => { dot.className = 'events-dot'; label.textContent = 'disconnected'; };
    document.getElementById('events-stream-btn').textContent = '■ Stop Stream';
  }

  function stopStream() {
    if (sseSource) { sseSource.close(); sseSource = null; }
    streaming = false;
    document.getElementById('events-stream-dot').className = 'events-dot';
    document.getElementById('events-stream-label').textContent = 'paused';
    document.getElementById('events-stream-btn').textContent = '▶ Stream';
  }

  function prependEventRow(evt) {
    const container = document.getElementById('events-list');
    const payload = evt.payload ? JSON.stringify(evt.payload, null, 2) : null;
    const typeParts = (evt.type || '').split('.');
    const typeColor = typeColorMap(typeParts[0]);

    const row = document.createElement('div');
    row.className = 'events-row events-row-new';
    row.onclick = function () { this.classList.toggle('expanded'); };
    row.innerHTML = `
      <div class="events-row-main">
        <span class="events-id">#${evt.id || '—'}</span>
        <span class="events-time">${fmtTime(evt.timestamp)}</span>
        <span class="events-source" style="color:${typeColor}">${esc(evt.source || '—')}</span>
        <span class="events-type">${esc(evt.type || '—')}</span>
        ${evt.agent ? `<span class="events-agent">@${esc(evt.agent)}</span>` : ''}
        <span class="events-age">${timeAgo(evt.timestamp)}</span>
      </div>
      ${payload ? `<div class="events-payload"><pre>${esc(payload)}</pre></div>` : ''}
    `;
    container.prepend(row);
    // Flash animation
    setTimeout(() => row.classList.remove('events-row-new'), 1000);
  }

  // ─── Type breakdown modal ───
  function showTypeBreakdown() {
    if (!stats) return;
    const modal = document.getElementById('events-breakdown-modal');
    const body = document.getElementById('events-breakdown-body');
    const types = Object.entries(stats.byType || {}).sort((a, b) => b[1] - a[1]);
    let html = '<table class="events-breakdown-table"><thead><tr><th>Event Type</th><th>Count</th></tr></thead><tbody>';
    for (const [type, count] of types) {
      html += `<tr class="events-breakdown-row" data-type="${esc(type)}">
        <td>${esc(type)}</td><td>${count.toLocaleString()}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    body.innerHTML = html;
    modal.style.display = 'flex';

    // Click to filter
    body.querySelectorAll('.events-breakdown-row').forEach(row => {
      row.addEventListener('click', () => {
        document.getElementById('events-type-filter').value = row.dataset.type;
        modal.style.display = 'none';
        loadEvents();
      });
    });
  }

  // ─── Init / Lifecycle ───
  function init() {
    // Filter controls
    const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
    document.getElementById('events-source-filter').addEventListener('input', debounce(loadEvents, 400));
    document.getElementById('events-type-filter').addEventListener('input', debounce(loadEvents, 400));
    document.getElementById('events-agent-filter').addEventListener('input', debounce(loadEvents, 400));
    document.getElementById('events-limit').addEventListener('change', loadEvents);
    document.getElementById('events-exclude-noise').addEventListener('change', loadEvents);
    document.getElementById('events-refresh-btn').addEventListener('click', () => { loadStats(); loadEvents(); });
    document.getElementById('events-breakdown-btn').addEventListener('click', showTypeBreakdown);
    document.getElementById('events-breakdown-close').addEventListener('click', () => {
      document.getElementById('events-breakdown-modal').style.display = 'none';
    });
    document.getElementById('events-breakdown-modal').addEventListener('click', function (e) {
      if (e.target === this) this.style.display = 'none';
    });
    document.getElementById('events-stream-btn').addEventListener('click', () => {
      if (streaming) stopStream(); else startStream();
    });
  }

  window._eventsInit = function () {
    loadStats();
    loadEvents();
    refreshTimer = setInterval(() => { if (!streaming) { loadStats(); loadEvents(); } }, 30000);
  };

  window._eventsDestroy = function () {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    stopStream();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
