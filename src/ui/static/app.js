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

// ─── Init ───

async function init() {
  await Promise.all([loadBoard(), loadFeed(), loadRegistry()]);
  startSSE();

  // Poll board and registry every 10s
  setInterval(loadBoard, 10000);
  setInterval(loadRegistry, 10000);
}

init();
