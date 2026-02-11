// Agent Services Dashboard

const API = '/ui/api';

// ─── Helpers ───

async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ─── Board ───

const STATUS_ORDER = ['open', 'in_progress', 'blocked', 'done'];

async function loadBoard() {
  try {
    const data = await api('/board/tasks');
    renderBoard(data.tasks || []);
  } catch (e) {
    document.getElementById('board').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderBoard(tasks) {
  const board = document.getElementById('board');
  const grouped = {};
  for (const s of STATUS_ORDER) grouped[s] = [];
  for (const t of tasks) {
    (grouped[t.status] || grouped['open']).push(t);
  }

  let html = '';
  for (const status of STATUS_ORDER) {
    const items = grouped[status];
    html += `<div class="status-group">
      <div class="status-label">${status.replace('_', ' ')} <span class="count">${items.length}</span></div>`;
    for (const t of items) {
      const tags = (t.tags || []).map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
      const assignee = t.assignee ? `<span class="assignee">@${esc(t.assignee)}</span>` : '';
      const notes = (t.notes || []).map(n =>
        `<div class="note"><span class="note-author">@${esc(n.author)}</span> <span class="note-type">${esc(n.type)}</span> ${esc(n.content)}</div>`
      ).join('');
      html += `<div class="task-card status-${status}" onclick="this.classList.toggle('expanded')" data-id="${t.id}">
        <div class="title">${esc(t.title)}</div>
        <div class="meta">
          ${assignee}
          ${tags}
          <span class="age">${timeAgo(t.createdAt)}</span>
        </div>
        ${notes ? `<div class="task-notes">${notes}</div>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  board.innerHTML = html || '<div class="empty">No tasks</div>';

  // Update stats
  document.getElementById('stat-total').textContent = tasks.length;
  document.getElementById('stat-open').textContent = grouped['open'].length;
  document.getElementById('stat-blocked').textContent = grouped['blocked'].length;
}

// ─── Feed ───

let eventCount = 0;
const feedEl = () => document.getElementById('feed');

function renderEvent(evt) {
  const el = document.createElement('div');
  el.className = 'event';
  const typeCls = `type-${evt.type || 'log'}`;
  el.innerHTML = `
    <div class="event-header">
      <span class="event-agent">${esc(evt.agent)}</span>
      <span class="event-type ${typeCls}">${esc(evt.type)}</span>
      <span class="event-time">${evt.timestamp ? timeAgo(evt.timestamp) : ''}</span>
    </div>
    <div class="event-summary">${esc(evt.summary)}</div>
  `;
  return el;
}

async function loadFeed() {
  try {
    const events = await api('/feed/events?limit=100');
    const feed = feedEl();
    feed.innerHTML = '';
    const list = Array.isArray(events) ? events : (events.events || []);
    list.reverse();
    eventCount = 0;
    for (const evt of list) {
      feed.appendChild(renderEvent(evt));
      eventCount++;
    }
    feed.scrollTop = 0;
    document.getElementById('stat-events').textContent = eventCount;
  } catch (e) {
    feedEl().innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function startSSE() {
  const evtSource = new EventSource(`${API}/feed/stream`);
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');

  evtSource.onopen = () => {
    dot.classList.add('connected');
    label.textContent = 'connected';
  };

  evtSource.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      const feed = feedEl();
      feed.prepend(renderEvent(evt));
      eventCount++;
      document.getElementById('stat-events').textContent = eventCount;
      // Auto-scroll if near top
      if (feed.scrollTop < 100) {
        feed.scrollTop = 0;
      }
    } catch {}
  };

  evtSource.onerror = () => {
    dot.classList.remove('connected');
    label.textContent = 'reconnecting';
  };
}

// ─── Registry ───

async function loadRegistry() {
  try {
    const data = await api('/registry/vms');
    renderRegistry(data.vms || []);
  } catch (e) {
    document.getElementById('registry').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderRegistry(vms) {
  const reg = document.getElementById('registry');
  if (!vms.length) {
    reg.innerHTML = '<div class="empty">No VMs registered</div>';
    document.getElementById('stat-vms').textContent = '0';
    return;
  }

  let html = '';
  for (const vm of vms) {
    const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
    const isStale = staleMs > 120000; // 2 min
    const statusCls = (vm.status || 'idle').toLowerCase();
    html += `<div class="vm-card ${isStale ? 'stale' : ''}">
      <div class="vm-name">${esc(vm.name || vm.id)}</div>
      <div class="vm-role">${esc(vm.role || 'unknown')}</div>
      <div class="vm-meta">
        <span class="vm-status ${statusCls}">${esc(vm.status || 'unknown')}</span>
        <span>seen ${timeAgo(vm.lastSeen || vm.registeredAt)}</span>
      </div>
    </div>`;
  }
  reg.innerHTML = html;
  document.getElementById('stat-vms').textContent = vms.length;
}

// ─── Reports ───

async function loadReports() {
  try {
    const data = await api('/reports');
    renderReports(data.reports || []);
  } catch (e) {
    document.getElementById('reports').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderReports(reports) {
  const el = document.getElementById('reports');
  if (!reports.length) {
    el.innerHTML = '<div class="empty">No reports</div>';
    document.getElementById('stat-reports').textContent = '0';
    return;
  }

  let html = '';
  for (const r of reports) {
    const tags = (r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
    html += `<a class="report-card" href="/ui/report/${r.id}">
      <div class="report-title">${esc(r.title)}</div>
      <div class="report-meta">
        <span class="report-author">@${esc(r.author)}</span>
        ${tags}
        <span>${timeAgo(r.createdAt)}</span>
      </div>
    </a>`;
  }
  el.innerHTML = html;
  document.getElementById('stat-reports').textContent = reports.length;
}

// ─── Log ───

let logRefreshTimer = null;

async function loadLog() {
  const range = document.getElementById('log-range').value;
  const agentFilter = document.getElementById('log-agent-filter').value.trim();
  const container = document.getElementById('log-entries');

  try {
    let path = `/log?last=${range}`;
    const data = await api(path);
    let entries = data.entries || [];

    // Client-side agent filter (API doesn't support ?agent= yet)
    if (agentFilter) {
      const q = agentFilter.toLowerCase();
      entries = entries.filter(e => (e.agent || '').toLowerCase().includes(q));
    }

    // Reverse for newest-first display
    entries.reverse();

    if (!entries.length) {
      container.innerHTML = '<div class="empty">No log entries for this time range</div>';
      document.getElementById('log-count').textContent = '0';
      return;
    }

    let html = '';
    for (const entry of entries) {
      const agent = entry.agent ? esc(entry.agent) : '<span style="color:var(--text-dim)">—</span>';
      html += `<div class="log-entry">
        <span class="log-time">${timeAgo(entry.timestamp)}</span>
        <span class="log-agent">${agent}</span>
        <span class="log-text">${esc(entry.text)}</span>
      </div>`;
    }
    container.innerHTML = html;
    document.getElementById('log-count').textContent = entries.length;
  } catch (e) {
    container.innerHTML = `<div class="empty">Failed to load log: ${esc(e.message)}</div>`;
  }
}

function startLogRefresh() {
  if (logRefreshTimer) return;
  loadLog();
  logRefreshTimer = setInterval(loadLog, 30000);
}

function stopLogRefresh() {
  if (logRefreshTimer) {
    clearInterval(logRefreshTimer);
    logRefreshTimer = null;
  }
}

// ─── Journal ───

let journalRefreshTimer = null;

async function loadJournal() {
  const range = document.getElementById('journal-range').value;
  const authorFilter = document.getElementById('journal-author-filter').value.trim();
  const tagFilter = document.getElementById('journal-tag-filter').value.trim();
  const container = document.getElementById('journal-entries');

  try {
    let path = `/journal?last=${range}`;
    if (authorFilter) path += `&author=${encodeURIComponent(authorFilter)}`;
    if (tagFilter) path += `&tag=${encodeURIComponent(tagFilter)}`;
    const data = await api(path);
    let entries = data.entries || [];

    // Reverse for newest-first display
    entries.reverse();

    if (!entries.length) {
      container.innerHTML = '<div class="empty">No journal entries for this time range</div>';
      document.getElementById('journal-count').textContent = '0';
      return;
    }

    let html = '';
    for (const entry of entries) {
      const author = entry.author ? `<span class="log-agent">${esc(entry.author)}</span>` : '';
      const mood = entry.mood ? `<span class="journal-mood">${esc(entry.mood)}</span>` : '';
      const tags = (entry.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
      const tagsHtml = tags ? `<span class="journal-tags">${tags}</span>` : '';
      html += `<div class="log-entry">
        <span class="log-time">${timeAgo(entry.timestamp)}</span>
        ${author}
        ${mood}
        ${tagsHtml}
        <span class="log-text">${esc(entry.text)}</span>
      </div>`;
    }
    container.innerHTML = html;
    document.getElementById('journal-count').textContent = entries.length;
  } catch (e) {
    container.innerHTML = `<div class="empty">Failed to load journal: ${esc(e.message)}</div>`;
  }
}

function startJournalRefresh() {
  if (journalRefreshTimer) return;
  loadJournal();
  journalRefreshTimer = setInterval(loadJournal, 30000);
}

function stopJournalRefresh() {
  if (journalRefreshTimer) {
    clearInterval(journalRefreshTimer);
    journalRefreshTimer = null;
  }
}

// ─── Tabs ───

function switchView(viewName) {
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-view="${viewName}"]`)?.classList.add('active');

  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`)?.classList.add('active');

  // Start/stop polling based on view
  if (viewName === 'log') {
    startLogRefresh();
  } else {
    stopLogRefresh();
  }
  if (viewName === 'journal') {
    startJournalRefresh();
  } else {
    stopJournalRefresh();
  }
}

// ─── Init ───

async function init() {
  await Promise.all([loadBoard(), loadFeed(), loadRegistry(), loadReports()]);
  startSSE();

  // Poll board, registry, reports every 10s
  setInterval(loadBoard, 10000);
  setInterval(loadRegistry, 10000);
  setInterval(loadReports, 10000);

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // Log filter controls
  document.getElementById('log-range').addEventListener('change', loadLog);
  document.getElementById('log-agent-filter').addEventListener('input', () => {
    clearTimeout(window._logFilterTimeout);
    window._logFilterTimeout = setTimeout(loadLog, 300);
  });

  // Journal filter controls
  document.getElementById('journal-range').addEventListener('change', loadJournal);
  document.getElementById('journal-author-filter').addEventListener('input', () => {
    clearTimeout(window._journalAuthorTimeout);
    window._journalAuthorTimeout = setTimeout(loadJournal, 300);
  });
  document.getElementById('journal-tag-filter').addEventListener('input', () => {
    clearTimeout(window._journalTagTimeout);
    window._journalTagTimeout = setTimeout(loadJournal, 300);
  });
}

init();
