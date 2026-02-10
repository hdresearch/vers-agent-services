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

// ─── Tabs ───

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// ─── Log ───

let logRange = '24h';
let logRawMode = false;
let logRefreshTimer = null;

async function loadLog() {
  const el = document.getElementById('log');
  try {
    if (logRawMode) {
      const params = logRange === 'all' ? '' : `?last=${logRange}`;
      const res = await fetch(`${API}/log/raw${params}`);
      if (!res.ok) throw new Error(`API /log/raw: ${res.status}`);
      const text = await res.text();
      el.innerHTML = text.trim()
        ? `<div class="log-raw">${esc(text)}</div>`
        : '<div class="empty">No log entries</div>';
    } else {
      const params = logRange === 'all' ? '' : `?last=${logRange}`;
      const data = await api(`/log${params}`);
      renderLog(data.entries || []);
    }
    // Scroll to bottom (newest at bottom, chronological)
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderLog(entries) {
  const el = document.getElementById('log');
  if (!entries.length) {
    el.innerHTML = '<div class="empty">No log entries</div>';
    return;
  }
  let html = '';
  for (const entry of entries) {
    const agent = entry.agent ? `<span class="log-agent">@${esc(entry.agent)}</span>` : '';
    html += `<div class="log-entry">
      <span class="log-ts">${esc(entry.timestamp)}</span>${agent}
      <div class="log-text">${esc(entry.text)}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function initLog() {
  // Range buttons
  document.querySelectorAll('.log-range').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.log-range').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      logRange = btn.dataset.range;
      loadLog();
    });
  });

  // Raw toggle
  document.getElementById('log-raw-toggle').addEventListener('change', (e) => {
    logRawMode = e.target.checked;
    loadLog();
  });

  // Auto-refresh every 30s
  logRefreshTimer = setInterval(loadLog, 30000);
}

// ─── Init ───

async function init() {
  initTabs();
  await Promise.all([loadBoard(), loadFeed(), loadRegistry(), loadLog()]);
  startSSE();
  initLog();

  // Poll board and registry every 10s
  setInterval(loadBoard, 10000);
  setInterval(loadRegistry, 10000);
}

init();
