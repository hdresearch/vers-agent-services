// ─── Fleet Command Dashboard ───
// Real-time overview of the entire fleet: agents, feed, board, actions.

const API = '/ui/api';

// ─── Helpers ───

function api(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  }).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
}

function $(id) { return document.getElementById(id); }
function fmt(n) { return n == null ? '—' : n.toLocaleString(); }
function fmtCost(n) { return n == null ? '—' : `$${n.toFixed(2)}`; }
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}
function ago(ts) {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}
function timeStr(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function elapsed(startTs) {
  const d = Date.now() - new Date(startTs).getTime();
  const h = Math.floor(d / 3600000);
  const m = Math.floor((d % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'action-toast show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.className = 'action-toast', 3000);
}

// ─── Clock ───
function updateClock() {
  $('clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ─── State ───
let agents = [];       // from registry
let feedEvents = [];   // from feed
let boardTasks = [];   // from board

// ─── Vitals ───
async function refreshVitals() {
  try {
    const [registry, usage, board, feedStats] = await Promise.all([
      api('/registry/vms').catch(() => ({ vms: [] })),
      api('/usage/summary?range=1d').catch(() => ({})),
      api('/board/tasks').catch(() => ({ tasks: [] })),
      api('/feed/stats').catch(() => ({})),
    ]);

    const vms = registry.vms || registry || [];
    const vmCount = Array.isArray(vms) ? vms.length : 0;
    agents = Array.isArray(vms) ? vms : [];

    // Active = those with status running or role=worker
    const activeCount = agents.filter(a => a.status === 'running' || a.role === 'worker').length;

    $('v-vms').textContent = fmt(vmCount);
    $('v-agents').textContent = fmt(activeCount);

    // Usage
    $('v-sessions').textContent = fmt(usage.totalSessions || usage.sessions || 0);
    $('v-tokens').textContent = fmtTokens(usage.totalTokens || usage.tokens || 0);
    $('v-cost').textContent = fmtCost(usage.totalCost || usage.cost || 0);

    // Board
    const tasks = board.tasks || board || [];
    boardTasks = Array.isArray(tasks) ? tasks : [];
    const openTasks = boardTasks.filter(t => t.status !== 'done' && t.status !== 'archived').length;
    $('v-tasks').textContent = fmt(openTasks);

    // Feed
    $('v-events').textContent = fmt(feedStats.total || feedStats.count || 0);

    renderAgents();
    renderBoard();
  } catch (e) {
    console.error('vitals error:', e);
  }
}

// ─── Agents Panel ───
function agentStatus(vm) {
  if (vm.status === 'error' || vm.status === 'failed') return 'error';
  if (vm.status === 'done' || vm.status === 'completed' || vm.status === 'stopped') return 'done';
  if (vm.status === 'idle' || vm.status === 'registered') return 'idle';
  return 'working'; // running, active, etc.
}

function renderAgents() {
  const list = $('agent-list');
  $('agent-count').textContent = agents.length;

  if (agents.length === 0) {
    list.innerHTML = '<div style="padding:14px;color:var(--text-dim);font-size:11px;">No agents registered</div>';
    return;
  }

  // Sort: working first, then idle, then done, then error
  const order = { working: 0, idle: 1, error: 2, done: 3 };
  const sorted = [...agents].sort((a, b) => (order[agentStatus(a)] || 0) - (order[agentStatus(b)] || 0));

  list.innerHTML = sorted.map(a => {
    const s = agentStatus(a);
    const name = a.name || a.agent || a.id || 'unknown';
    const role = a.role || a.persona || '—';
    const task = a.task || a.currentTask || '';
    const registered = a.registeredAt || a.createdAt || a.lastHeartbeat || '';
    const vmId = a.vmId || a.id || '';

    return `
      <div class="agent-item" data-id="${escHtml(vmId)}" onclick="selectAgent('${escHtml(vmId)}')">
        <div class="agent-status-dot ${s}"></div>
        <div class="agent-info">
          <div class="agent-name">${escHtml(name)}</div>
          <div class="agent-role">${escHtml(role)}${vmId ? ` · ${escHtml(vmId.slice(0, 8))}` : ''}</div>
          ${task ? `<div class="agent-task">${escHtml(task)}</div>` : ''}
          <div class="agent-meta">${s}${registered ? ` · ${ago(registered)}` : ''}</div>
        </div>
      </div>`;
  }).join('');
}

function selectAgent(vmId) {
  document.querySelectorAll('.agent-item').forEach(el => el.classList.remove('selected'));
  const el = document.querySelector(`.agent-item[data-id="${vmId}"]`);
  if (el) el.classList.add('selected');
}

// ─── Live Feed (SSE) ───
let eventSource = null;
let feedFilterAgent = '';
let feedFilterType = '';

function connectFeed() {
  // Use SSE for real-time events
  try {
    eventSource = new EventSource(`${API}/feed/stream`);
    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        feedEvents.unshift(event);
        if (feedEvents.length > 500) feedEvents.length = 500;
        renderFeed();
      } catch {}
    };
    eventSource.onerror = () => {
      // SSE failed, fall back to polling
      eventSource.close();
      eventSource = null;
      $('live-dot').classList.remove('live');
      $('refresh-label').textContent = 'polling';
    };
    eventSource.onopen = () => {
      $('live-dot').classList.add('live');
      $('refresh-label').textContent = 'live';
    };
  } catch {
    // SSE not available
  }
}

async function loadFeedHistory() {
  try {
    const data = await api('/feed/events?limit=200');
    const events = data.events || data || [];
    if (Array.isArray(events)) {
      feedEvents = events.sort((a, b) => new Date(b.timestamp || b.createdAt) - new Date(a.timestamp || a.createdAt));
      renderFeed();
    }
  } catch (e) {
    console.error('feed load error:', e);
  }
}

function renderFeed() {
  const list = $('feed-list');
  let filtered = feedEvents;

  if (feedFilterAgent) {
    const q = feedFilterAgent.toLowerCase();
    filtered = filtered.filter(e => (e.agent || '').toLowerCase().includes(q));
  }
  if (feedFilterType) {
    filtered = filtered.filter(e => e.type === feedFilterType);
  }

  $('feed-count').textContent = filtered.length;

  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:14px;color:var(--text-dim);font-size:11px;">No events</div>';
    return;
  }

  list.innerHTML = filtered.slice(0, 200).map(e => {
    const ts = e.timestamp || e.createdAt || '';
    const type = e.type || 'info';
    const agent = e.agent || '?';
    const summary = e.summary || e.message || '';
    const typeClass = type.replace(/[^a-z_]/g, '');

    return `
      <div class="feed-item type-${typeClass}">
        <span class="feed-time">${ts ? timeStr(ts) : ''}</span>
        <span class="feed-agent" style="margin-left:8px;color:var(--accent);">${escHtml(agent)}</span>
        <span style="margin-left:6px;color:var(--text-dim);font-size:10px;">${escHtml(type)}</span>
        <div class="feed-summary">${escHtml(summary)}</div>
      </div>`;
  }).join('');
}

$('feed-filter-agent').addEventListener('input', (e) => {
  feedFilterAgent = e.target.value;
  renderFeed();
});
$('feed-filter-type').addEventListener('change', (e) => {
  feedFilterType = e.target.value;
  renderFeed();
});

// ─── Board Summary ───
function renderBoard() {
  const p0 = boardTasks.filter(t => t.priority === 'p0' || t.priority === 0).length;
  const p1 = boardTasks.filter(t => t.priority === 'p1' || t.priority === 1).length;
  const p2 = boardTasks.filter(t => t.priority === 'p2' || t.priority === 2).length;
  const blocked = boardTasks.filter(t => t.status === 'blocked');
  const done = boardTasks.filter(t => t.status === 'done' || t.status === 'archived');
  const recent = done.sort((a, b) => new Date(b.updatedAt || b.completedAt || 0) - new Date(a.updatedAt || a.completedAt || 0)).slice(0, 5);

  $('b-p0').textContent = p0;
  $('b-p1').textContent = p1;
  $('b-p2').textContent = p2;
  $('b-blocked').textContent = blocked.length;
  $('b-done').textContent = done.length;

  $('b-recent').innerHTML = recent.map(t =>
    `<span class="board-chip" title="${escHtml(t.title || t.summary || '')}">${escHtml((t.title || t.summary || '').slice(0, 30))}</span>`
  ).join('');

  $('b-blocked-list').innerHTML = blocked.slice(0, 5).map(t =>
    `<span class="board-chip blocked" title="${escHtml(t.title || t.summary || '')}">${escHtml((t.title || t.summary || '').slice(0, 30))}</span>`
  ).join('') || '<span style="color:var(--text-dim);font-size:10px;">none</span>';
}

// ─── Actions ───

// Fleet Chat
$('btn-chat').addEventListener('click', async () => {
  const channel = $('chat-channel').value || 'general';
  const message = $('chat-msg').value.trim();
  if (!message) return toast('Message required', true);

  try {
    await api(`/fleet-chat/channels/${channel}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: message, sender: 'bridge' }),
    });
    $('chat-msg').value = '';
    toast(`Sent to #${channel}`);
  } catch (e) {
    toast(`Chat error: ${e.message}`, true);
  }
});

// Deploy
$('btn-deploy').addEventListener('click', async () => {
  const branch = $('deploy-branch').value || 'main';
  if (!confirm(`Deploy branch "${branch}" to production?`)) return;

  try {
    const result = await api('/deploy/trigger', {
      method: 'POST',
      body: JSON.stringify({ branch, triggeredBy: 'bridge-ui' }),
    });
    toast(`Deploy triggered: ${result.trackingId || 'ok'}`);
  } catch (e) {
    toast(`Deploy error: ${e.message}`, true);
  }
});

// Reap Stale
$('btn-reap').addEventListener('click', async () => {
  try {
    const data = await api('/registry/stale');
    const stale = data.stale || data || [];
    toast(`${Array.isArray(stale) ? stale.length : 0} stale VMs found`);
  } catch (e) {
    toast(`Reap error: ${e.message}`, true);
  }
});

// Refresh Registry
$('btn-refresh-reg').addEventListener('click', async () => {
  await refreshVitals();
  toast('Registry refreshed');
});

// Magic Link
$('btn-magic').addEventListener('click', async () => {
  try {
    const data = await api('/auth/magic-link', { method: 'POST' });
    const url = data.url || data.link || '';
    $('magic-result').innerHTML = url
      ? `<a href="${escHtml(url)}" target="_blank" style="color:var(--accent);word-break:break-all;">${escHtml(url)}</a>`
      : 'Generated (check response)';
    toast('Magic link created');
  } catch (e) {
    toast(`Magic link error: ${e.message}`, true);
  }
});

// Publish Feed Event
$('btn-feed').addEventListener('click', async () => {
  const agent = $('feed-agent').value.trim() || 'bridge';
  const type = $('feed-type').value;
  const summary = $('feed-summary').value.trim();
  if (!summary) return toast('Summary required', true);

  try {
    await api('/feed/events', {
      method: 'POST',
      body: JSON.stringify({ agent, type, summary }),
    });
    $('feed-summary').value = '';
    toast('Event published');
  } catch (e) {
    toast(`Feed error: ${e.message}`, true);
  }
});

// ─── Init ───

async function init() {
  await Promise.all([
    refreshVitals(),
    loadFeedHistory(),
  ]);
  connectFeed();
}

// Auto-refresh every 10s
setInterval(refreshVitals, 10000);

// Go
init();
