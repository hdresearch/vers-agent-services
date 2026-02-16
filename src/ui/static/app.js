// Agent Services Dashboard — Reliability Edition
// Fixes: error boundaries, fetch timeouts, lazy tab loading,
// graceful SSE degradation, loading states, never-blank guarantee

const API = '/ui/api';

// ─── ETag cache for conditional requests ───
const etagCache = new Map(); // path → { etag, data }

// ─── Fetch with timeout + error boundary + conditional requests ───

async function api(path, opts = {}) {
  const timeout = opts.timeout || 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};

  // Send If-None-Match for conditional requests (polling optimization)
  const cached = etagCache.get(path);
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  try {
    const res = await fetch(`${API}${path}`, { signal: controller.signal, headers });
    clearTimeout(timer);
    if (res.status === 401) {
      window.location.href = '/ui/login';
      throw new Error('Session expired');
    }
    // 304 Not Modified — return cached data
    if (res.status === 304 && cached?.data) {
      return cached.data;
    }
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    const data = await res.json();

    // Cache ETag for next request
    const etag = res.headers.get('etag');
    if (etag) {
      etagCache.set(path, { etag, data });
    }

    return data;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`API ${path}: timeout after ${timeout}ms`);
    throw e;
  }
}

// ─── Helpers ───

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

// ─── Loading / Error UI helpers ───

function showLoading(el) {
  if (!el) return;
  el.innerHTML = '<div class="panel-loading"><span class="loading-spinner">⟳</span> Loading…</div>';
}

function showError(el, message, retryFn) {
  if (!el) return;
  const retryId = 'retry-' + Math.random().toString(36).slice(2, 8);
  el.innerHTML = `<div class="panel-error">
    <span class="error-icon">⚠</span> ${esc(message)}
    ${retryFn ? `<button class="error-retry" id="${retryId}">Retry</button>` : ''}
  </div>`;
  if (retryFn) {
    // Defer to next tick so the element exists in DOM
    setTimeout(() => {
      const btn = document.getElementById(retryId);
      if (btn) btn.onclick = retryFn;
    }, 0);
  }
}

// ─── Board ───

const STATUS_ORDER = ['open', 'in_progress', 'blocked', 'done'];
let lastBoardHash = '';

async function loadBoard() {
  const board = document.getElementById('board');
  try {
    const data = await api('/board/tasks?compact=true');
    renderBoard(data.tasks || []);
  } catch (e) {
    // Only show error if board is currently empty or showing error
    if (!board.querySelector('.task-card')) {
      showError(board, e.message, loadBoard);
    }
  }
}

function renderBoard(tasks) {
  const board = document.getElementById('board');
  const grouped = {};
  for (const s of STATUS_ORDER) grouped[s] = [];
  for (const t of tasks) {
    (grouped[t.status] || grouped['open']).push(t);
  }

  // Update stats
  setText('stat-total', tasks.length);
  setText('stat-open', grouped['open'].length);
  setText('stat-blocked', grouped['blocked'].length);

  // Hash check — skip DOM rebuild if unchanged
  const boardHash = JSON.stringify(tasks.map(t => t.id + ':' + t.status + ':' + (t.score || 0) + ':' + (t.notes || []).length));
  if (boardHash === lastBoardHash) return;
  lastBoardHash = boardHash;

  // Preserve expanded state
  const expandedIds = new Set();
  board.querySelectorAll('.task-card.expanded').forEach(el => {
    if (el.dataset.id) expandedIds.add(el.dataset.id);
  });

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
      const score = t.score || 0;
      const scoreBadge = score > 0
        ? `<span class="score-badge">${score}</span>`
        : `<span class="score-badge dim">0</span>`;
      const isExpanded = expandedIds.has(t.id) ? ' expanded' : '';
      html += `<div class="task-card status-${status}${isExpanded}" onclick="this.classList.toggle('expanded')" data-id="${t.id}">
        <div class="task-top">
          <div class="title">${esc(t.title)}</div>
          <button class="bump-btn" onclick="event.stopPropagation(); bumpTask('${t.id}')" title="Bump score">👆 ${scoreBadge}</button>
        </div>
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
}

async function bumpTask(taskId) {
  try {
    await fetch(`${API}/board/tasks/${taskId}/bump`, { method: 'POST' });
    loadBoard();
  } catch (e) {
    console.error('Bump failed:', e);
  }
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
  const feed = feedEl();
  try {
    const events = await api('/feed/events?limit=50');
    feed.innerHTML = '';
    const list = Array.isArray(events) ? events : (events.events || []);
    list.reverse();
    eventCount = 0;
    for (const evt of list) {
      feed.appendChild(renderEvent(evt));
      eventCount++;
    }
    feed.scrollTop = 0;
    setText('stat-events', eventCount);
  } catch (e) {
    if (!feed.querySelector('.event')) {
      showError(feed, e.message, loadFeed);
    }
  }
}

// ─── SSE — Non-blocking with graceful degradation ───

let sseSource = null;
let sseRetryCount = 0;
let sseFallbackTimer = null;

function startSSE() {
  if (sseSource) {
    try { sseSource.close(); } catch {}
  }

  // Clear any fallback polling
  if (sseFallbackTimer) {
    clearInterval(sseFallbackTimer);
    sseFallbackTimer = null;
  }

  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');

  try {
    const evtSource = new EventSource(`${API}/feed/stream`);
    sseSource = evtSource;

    // Timeout: if SSE doesn't connect within 10s, fall back to polling
    const sseTimeout = setTimeout(() => {
      if (evtSource.readyState !== EventSource.OPEN) {
        evtSource.close();
        startFallbackPolling();
      }
    }, 10000);

    evtSource.onopen = () => {
      clearTimeout(sseTimeout);
      dot.classList.add('connected');
      label.textContent = 'connected';
      sseRetryCount = 0;
    };

    evtSource.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (typeof window._speedometerOnFeedEvent === 'function') {
          window._speedometerOnFeedEvent(evt);
        }
        if (typeof window._chatOnFeedEvent === 'function') {
          window._chatOnFeedEvent(evt);
        }
        const feed = feedEl();
        if (feed) {
          feed.prepend(renderEvent(evt));
          eventCount++;
          setText('stat-events', eventCount);
          if (feed.scrollTop < 100) feed.scrollTop = 0;
        }
      } catch {}
    };

    evtSource.onerror = () => {
      clearTimeout(sseTimeout);
      dot.classList.remove('connected');
      sseRetryCount++;
      label.textContent = sseRetryCount > 3 ? 'polling' : 'reconnecting';
      if (sseRetryCount > 5) {
        evtSource.close();
        startFallbackPolling();
      }
    };
  } catch (e) {
    // SSE constructor itself can throw in some browsers
    startFallbackPolling();
  }
}

function startFallbackPolling() {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  dot.classList.remove('connected');
  dot.classList.add('polling');
  label.textContent = 'polling';

  if (sseFallbackTimer) return;
  sseFallbackTimer = setInterval(() => {
    if (activeView === 'dashboard') loadFeed();
  }, 15000);

  // Retry SSE every 60s
  setTimeout(() => {
    if (sseFallbackTimer) {
      clearInterval(sseFallbackTimer);
      sseFallbackTimer = null;
      sseRetryCount = 0;
      startSSE();
    }
  }, 60000);
}

// ─── Registry ───

let lastRegistryHash = '';

async function loadRegistry() {
  const reg = document.getElementById('registry');
  try {
    const data = await api('/registry/vms');
    renderRegistry(data.vms || []);
  } catch (e) {
    if (!reg.querySelector('.vm-card')) {
      showError(reg, e.message, loadRegistry);
    }
  }
}

function renderRegistry(vms) {
  const reg = document.getElementById('registry');
  setText('stat-vms', vms.length || '0');

  if (!vms.length) {
    reg.innerHTML = '<div class="empty">No VMs registered</div>';
    return;
  }

  const regHash = JSON.stringify(vms.map(v => v.id + ':' + (v.status || '') + ':' + (v.lastSeen || v.registeredAt)));
  if (regHash === lastRegistryHash) return;
  lastRegistryHash = regHash;

  let html = '';
  for (const vm of vms) {
    const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
    const isStale = staleMs > 120000;
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
}

// ─── Reports ───

let lastReportsHash = '';

async function loadReports() {
  const el = document.getElementById('reports');
  try {
    const data = await api('/reports');
    renderReports(data.reports || []);
  } catch (e) {
    if (!el.querySelector('.report-card')) {
      showError(el, e.message, loadReports);
    }
  }
}

function renderReports(reports) {
  const el = document.getElementById('reports');
  setText('stat-reports', reports.length || '0');

  if (!reports.length) {
    el.innerHTML = '<div class="empty">No reports</div>';
    return;
  }

  const repHash = JSON.stringify(reports.map(r => r.id + ':' + r.title));
  if (repHash === lastReportsHash) return;
  lastReportsHash = repHash;

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

    if (agentFilter) {
      const q = agentFilter.toLowerCase();
      entries = entries.filter(e => (e.agent || '').toLowerCase().includes(q));
    }

    entries.reverse();

    if (!entries.length) {
      container.innerHTML = '<div class="empty">No log entries for this time range</div>';
      setText('log-count', '0');
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
    setText('log-count', entries.length);
  } catch (e) {
    showError(container, e.message, loadLog);
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
    entries.reverse();

    if (!entries.length) {
      container.innerHTML = '<div class="empty">No journal entries for this time range</div>';
      setText('journal-count', '0');
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
    setText('journal-count', entries.length);
  } catch (e) {
    showError(container, e.message, loadJournal);
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

// ─── Review Queue ───

let reviewRefreshTimer = null;

async function loadReview() {
  const container = document.getElementById('review-list');
  try {
    const data = await api('/board/review');
    const tasks = data.tasks || [];
    setText('review-count', tasks.length);

    if (!tasks.length) {
      container.innerHTML = '<div class="empty">No tasks awaiting review</div>';
      return;
    }

    let html = '';
    for (const t of tasks) {
      const latestNote = t.notes && t.notes.length > 0 ? t.notes[t.notes.length - 1] : null;
      const artifacts = t.artifacts || [];

      let artifactsHtml = '';
      if (artifacts.length > 0) {
        artifactsHtml = '<div class="review-artifacts">';
        for (const a of artifacts) {
          let href = esc(a.url);
          let icon = '🔗';
          if (a.type === 'branch') { icon = '🌿'; }
          else if (a.type === 'report') { icon = '📄'; href = a.url.startsWith('/') ? a.url : `/ui/report/${a.url}`; }
          else if (a.type === 'deploy') { icon = '🚀'; }
          else if (a.type === 'diff') { icon = '📝'; }
          else if (a.type === 'file') { icon = '📁'; }
          artifactsHtml += `<a class="review-artifact" href="${href}" target="_blank" onclick="event.stopPropagation()">${icon} ${esc(a.label)}</a>`;
        }
        artifactsHtml += '</div>';
      }

      const submittedBy = latestNote ? latestNote.author : t.createdBy;
      const submittedAt = t.updatedAt;

      html += `<div class="review-card" data-id="${t.id}">
        <div class="review-card-header">
          <div class="review-title">${esc(t.title)}</div>
          <div class="review-meta">
            submitted by <span class="review-author">@${esc(submittedBy)}</span>
            <span class="review-time">${timeAgo(submittedAt)}</span>
          </div>
        </div>
        ${latestNote ? `<div class="review-summary">${esc(latestNote.content)}</div>` : ''}
        ${artifactsHtml}
        <div class="review-actions">
          <button class="btn btn-approve" onclick="approveTask('${t.id}')">✓ Approve</button>
          <button class="btn btn-reject" onclick="rejectTask('${t.id}')">✗ Reject</button>
        </div>
      </div>`;
    }
    container.innerHTML = html;
  } catch (e) {
    showError(container, e.message, loadReview);
  }
}

async function approveTask(taskId) {
  const comment = prompt('Approval comment (optional):');
  if (comment === null) return;
  try {
    await fetch(`${API}/board/tasks/${taskId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: comment || '', approvedBy: 'dashboard-user' }),
    });
    loadReview();
    loadBoard();
  } catch (e) {
    alert('Failed to approve: ' + e.message);
  }
}

async function rejectTask(taskId) {
  const reason = prompt('Rejection reason (required):');
  if (!reason) return;
  try {
    await fetch(`${API}/board/tasks/${taskId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, rejectedBy: 'dashboard-user' }),
    });
    loadReview();
    loadBoard();
  } catch (e) {
    alert('Failed to reject: ' + e.message);
  }
}

function startReviewRefresh() {
  if (reviewRefreshTimer) return;
  loadReview();
  reviewRefreshTimer = setInterval(loadReview, 30000);
}

function stopReviewRefresh() {
  if (reviewRefreshTimer) {
    clearInterval(reviewRefreshTimer);
    reviewRefreshTimer = null;
  }
}

// ─── Skills ───

let skillsRefreshTimer = null;
let allSkills = [];
let allExtensions = [];

async function loadSkills() {
  try {
    const data = await api('/skills/items');
    allSkills = data.skills || [];
    renderSkills();
  } catch (e) {
    document.getElementById('skills-list').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderSkills() {
  const filter = (document.getElementById('skills-filter')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('skills-status-filter')?.value || '';
  const container = document.getElementById('skills-list');

  let skills = allSkills;
  if (filter) {
    skills = skills.filter(s =>
      s.name.toLowerCase().includes(filter) ||
      (s.description || '').toLowerCase().includes(filter) ||
      (s.tags || []).some(t => t.toLowerCase().includes(filter))
    );
  }
  if (statusFilter === 'enabled') skills = skills.filter(s => s.enabled);
  if (statusFilter === 'disabled') skills = skills.filter(s => !s.enabled);

  setText('skills-count', skills.length);

  if (!skills.length) {
    container.innerHTML = '<div class="empty">No skills found</div>';
    return;
  }

  let html = '';
  for (const s of skills) {
    const tags = (s.tags || []).map(t => `<span class="skill-tag">${esc(t)}</span>`).join('');
    const statusCls = s.enabled ? 'skill-status-enabled' : 'skill-status-disabled';
    const statusLabel = s.enabled ? 'enabled' : 'disabled';
    const cardCls = s.enabled ? '' : ' disabled';
    html += `<div class="skill-card${cardCls}" onclick="this.classList.toggle('expanded')">
      <div class="skill-name">${esc(s.name)}</div>
      <div class="skill-desc">${esc(s.description)}</div>
      <div class="skill-meta">
        <span class="skill-version">v${s.version}</span>
        <span class="${statusCls}">${statusLabel}</span>
        <span class="skill-publisher">@${esc(s.publishedBy)}</span>
        ${tags}
        <span>${timeAgo(s.updatedAt)}</span>
      </div>
      <div class="skill-content"><pre>${esc(s.content)}</pre></div>
    </div>`;
  }
  container.innerHTML = html;
}

async function loadExtensions() {
  try {
    const data = await api('/skills/extensions');
    allExtensions = data.extensions || [];
    renderExtensions();
  } catch (e) {
    document.getElementById('extensions-list').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderExtensions() {
  const container = document.getElementById('extensions-list');
  setText('extensions-count', allExtensions.length);

  if (!allExtensions.length) {
    container.innerHTML = '<div class="empty">No extensions registered</div>';
    return;
  }

  let html = '';
  for (const e of allExtensions) {
    html += `<div class="ext-card" onclick="this.classList.toggle('expanded')">
      <div class="ext-name">${esc(e.name)}</div>
      <div class="ext-desc">${esc(e.description)}</div>
      <div class="ext-meta">
        <span class="ext-version">v${e.version}</span>
        <span class="ext-publisher">@${esc(e.publishedBy)}</span>
        <span>${timeAgo(e.updatedAt)}</span>
      </div>
      <div class="ext-content"><pre>${esc(e.content)}</pre></div>
    </div>`;
  }
  container.innerHTML = html;
}

async function loadAgents() {
  try {
    const data = await api('/skills/agents');
    renderAgents(data.agents || []);
  } catch (e) {
    document.getElementById('agents-list').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderAgents(agents) {
  const container = document.getElementById('agents-list');
  setText('agents-count', agents.length);

  if (!agents.length) {
    container.innerHTML = '<div class="empty">No agents have synced yet</div>';
    return;
  }

  let html = '<table class="agent-table"><thead><tr>';
  html += '<th>Agent</th><th>Skills</th><th>Extensions</th><th>Last Sync</th>';
  html += '</tr></thead><tbody>';
  for (const a of agents) {
    const skillsCount = (a.skills || []).length;
    const extCount = (a.extensions || []).length;
    const vm = a.vmId ? `<div class="agent-vm">${esc(a.vmId)}</div>` : '';
    html += `<tr>
      <td><span class="agent-name">${esc(a.agentId)}</span>${vm}</td>
      <td><span class="agent-skills-count">${skillsCount}</span></td>
      <td><span class="agent-ext-count">${extCount}</span></td>
      <td>${timeAgo(a.lastSync)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function startSkillsRefresh() {
  if (skillsRefreshTimer) return;
  loadSkills();
  loadExtensions();
  loadAgents();
  skillsRefreshTimer = setInterval(() => {
    loadSkills();
    loadExtensions();
    loadAgents();
  }, 30000);
}

function stopSkillsRefresh() {
  if (skillsRefreshTimer) {
    clearInterval(skillsRefreshTimer);
    skillsRefreshTimer = null;
  }
}

// ─── Knowledge Base ───

let kbRefreshTimer = null;
let allKbEntries = [];

async function loadKbBriefing() {
  const el = document.getElementById('kb-briefing');
  try {
    const data = await api('/kb/briefing/session');
    const md = data.briefing || '';
    el.innerHTML = renderMarkdown(md);
    // Update stats from briefing response
    if (data.stats) {
      setText('kb-stat-total', data.stats.total || 0);
      setText('kb-stat-active', data.stats.active || 0);
      setText('kb-stat-expired', data.stats.expired || 0);
      const byType = data.stats.byType || {};
      setText('kb-stat-warning', byType.warning || 0);
      setText('kb-stat-convention', byType.convention || 0);
      setText('kb-stat-lesson', byType.lesson || 0);
      setText('kb-stat-context', byType.context || 0);
    }
  } catch (e) {
    showError(el, e.message, loadKbBriefing);
  }
}

function renderMarkdown(md) {
  // Minimal markdown → HTML: headers, lists, bold, code, paragraphs
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, (match) => '<ul>' + match + '</ul>')
    .replace(/(?:^|\n)(<li>)/g, '$1')
    // Group consecutive <li> into <ul>
    .replace(/(<\/li>\n?)(?!<li>)/g, '$1</ul>')
    .replace(/(?<!<\/ul>)(<li>)/g, '<ul>$1')
    // Fix double wrapping
    .replace(/<ul><ul>/g, '<ul>')
    .replace(/<\/ul><\/ul>/g, '</ul>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '\n');
}

async function loadKbEntries() {
  const container = document.getElementById('kb-entries-list');
  try {
    const typeFilter = document.getElementById('kb-type-filter').value;
    const search = document.getElementById('kb-search').value.trim();
    let path = '/kb/entries';
    const params = [];
    if (typeFilter) params.push(`type=${typeFilter}`);
    if (search) params.push(`search=${encodeURIComponent(search)}`);
    if (params.length) path += '?' + params.join('&');

    const data = await api(path);
    allKbEntries = data.entries || [];
    renderKbEntries();
  } catch (e) {
    showError(container, e.message, loadKbEntries);
  }
}

function renderKbEntries() {
  const container = document.getElementById('kb-entries-list');
  const entries = allKbEntries;

  if (!entries.length) {
    container.innerHTML = '<div class="empty">No entries found</div>';
    return;
  }

  const now = Date.now();
  let html = '';
  for (const e of entries) {
    const reinforced = new Date(e.lastReinforced || e.createdAt).getTime();
    const expiresAt = reinforced + (e.decayDays || 60) * 86400000;
    const daysRemaining = Math.ceil((expiresAt - now) / 86400000);
    const isExpired = daysRemaining <= 0;

    const expiredCls = isExpired ? ' kb-expired' : '';
    let decayCls = '';
    let decayLabel = '';
    if (isExpired) {
      decayCls = 'kb-decay-expired';
      decayLabel = 'expired';
    } else if (daysRemaining <= 7) {
      decayCls = 'kb-decay-low';
      decayLabel = `${daysRemaining}d left`;
    } else {
      decayLabel = `${daysRemaining}d left`;
    }

    const typeIcon = { warning: '⚠️', convention: '📐', lesson: '💡', context: '📋' }[e.type] || '';
    const tags = (e.tags || []).map(t => `<span class="kb-entry-tag">${esc(t)}</span>`).join('');

    html += `<div class="kb-entry kb-type-${esc(e.type)}${expiredCls}">
      <div class="kb-entry-header">
        <span class="kb-entry-type t-${esc(e.type)}">${typeIcon} ${esc(e.type)}</span>
        <span class="kb-entry-decay ${decayCls}">${decayLabel}</span>
      </div>
      <div class="kb-entry-content">${esc(e.content)}</div>
      <div class="kb-entry-meta">
        ${e.source ? `<span class="kb-entry-source">${esc(e.source)}</span>` : ''}
        ${tags}
        <button class="kb-reinforce-btn" onclick="reinforceKbEntry('${e.id}')">🔄 Reinforce</button>
      </div>
    </div>`;
  }
  container.innerHTML = html;
}

async function reinforceKbEntry(id) {
  try {
    await fetch(`${API}/kb/entries/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reinforce: true }),
    });
    loadKbEntries();
    loadKbBriefing();
  } catch (e) {
    console.error('Reinforce failed:', e);
  }
}

async function addKbEntry() {
  const btn = document.getElementById('kb-submit-btn');
  const content = document.getElementById('kb-add-content').value.trim();
  if (!content) return;

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const tagsRaw = document.getElementById('kb-add-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    await fetch(`${API}/kb/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: document.getElementById('kb-add-type').value,
        content,
        source: document.getElementById('kb-add-source').value.trim() || 'dashboard',
        tags,
        decayDays: parseInt(document.getElementById('kb-add-decay').value) || 60,
      }),
    });

    // Clear form
    document.getElementById('kb-add-content').value = '';
    document.getElementById('kb-add-source').value = '';
    document.getElementById('kb-add-tags').value = '';
    document.getElementById('kb-add-form').style.display = 'none';

    loadKbEntries();
    loadKbBriefing();
  } catch (e) {
    alert('Failed to add entry: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Entry';
  }
}

function startKbRefresh() {
  if (kbRefreshTimer) return;
  loadKbBriefing();
  loadKbEntries();
  kbRefreshTimer = setInterval(() => {
    loadKbBriefing();
    loadKbEntries();
  }, 30000);
}

function stopKbRefresh() {
  if (kbRefreshTimer) {
    clearInterval(kbRefreshTimer);
    kbRefreshTimer = null;
  }
}

// ─── Tabs — Lazy loading ───

let activeView = 'dashboard';
const tabLoaded = new Set(); // track which tabs have loaded their initial data

function switchView(viewName) {
  const prevView = activeView;
  activeView = viewName;

  // Update tab buttons
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-view="${viewName}"]`)?.classList.add('active');

  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`)?.classList.add('active');

  // Dashboard — refresh on switch-back (conditional requests make this cheap if unchanged)
  if (viewName === 'dashboard') {
    loadBoard();
    loadRegistry();
    loadReports();
  }

  // Start/stop polling based on view
  if (viewName === 'review') {
    startReviewRefresh();
  } else {
    stopReviewRefresh();
  }
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
  if (viewName === 'skills') {
    startSkillsRefresh();
  } else {
    stopSkillsRefresh();
  }
  if (viewName === 'knowledge') {
    startKbRefresh();
  } else {
    stopKbRefresh();
  }

  // Chat: initialize on first visit, cleanup on leave
  if (viewName === 'chat') {
    if (typeof window._chatInit === 'function') window._chatInit();
  } else {
    if (typeof window._chatDestroy === 'function') window._chatDestroy();
  }

  // Metrics: pause/resume
  if (viewName === 'metrics') {
    activateMetricsSubview();
  } else if (prevView === 'metrics') {
    if (typeof window.metricsDestroy === 'function') window.metricsDestroy();
    if (typeof window.analyticsDestroy === 'function') window.analyticsDestroy();
  }

  // Fleet: init/destroy
  if (viewName === 'fleet') {
    if (typeof window._fleetInit === 'function') window._fleetInit();
  } else if (prevView === 'fleet') {
    if (typeof window._fleetDestroy === 'function') window._fleetDestroy();
  }

  // Couch: init/destroy
  if (viewName === 'couch') {
    if (typeof window._couchInit === 'function') window._couchInit();
  } else if (prevView === 'couch') {
    if (typeof window._couchDestroy === 'function') window._couchDestroy();
  }

  // Agents: init/destroy
  if (viewName === 'agents') {
    if (typeof window._agentsInit === 'function') window._agentsInit();
  } else if (prevView === 'agents') {
    if (typeof window._agentsDestroy === 'function') window._agentsDestroy();
  }

  // Comms: init/destroy
  if (viewName === 'comms') {
    if (typeof window._commsInit === 'function') window._commsInit();
  } else if (prevView === 'comms') {
    if (typeof window._commsDestroy === 'function') window._commsDestroy();
  }

  // Board Full: init/destroy
  if (viewName === 'board') {
    if (typeof window._boardFullInit === 'function') window._boardFullInit();
  } else if (prevView === 'board') {
    if (typeof window._boardFullDestroy === 'function') window._boardFullDestroy();
  }

  // Events: init/destroy
  if (viewName === 'events') {
    if (typeof window._eventsInit === 'function') window._eventsInit();
  } else if (prevView === 'events') {
    if (typeof window._eventsDestroy === 'function') window._eventsDestroy();
  }

  // Daemon: init/destroy
  if (viewName === 'daemon') {
    if (typeof window._daemonInit === 'function') window._daemonInit();
  } else if (prevView === 'daemon') {
    if (typeof window._daemonDestroy === 'function') window._daemonDestroy();
  }

  // Config: init/destroy
  if (viewName === 'config') {
    if (typeof window._configInit === 'function') window._configInit();
  } else if (prevView === 'config') {
    if (typeof window._configDestroy === 'function') window._configDestroy();
  }

  // Write: init/destroy
  if (viewName === 'write') {
    if (typeof window._writeInit === 'function') window._writeInit();
  } else if (prevView === 'write') {
    if (typeof window._writeDestroy === 'function') window._writeDestroy();
  }
}

// ─── Metrics Sub-tabs ───

function activateMetricsSubview() {
  const activeTab = document.querySelector('.metrics-subtab.active');
  const subview = activeTab ? activeTab.dataset.subview : 'tree';
  switchMetricsSubview(subview);
}

function switchMetricsSubview(name) {
  document.querySelectorAll('.metrics-subtab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.metrics-subtab[data-subview="${name}"]`)?.classList.add('active');
  document.querySelectorAll('.metrics-subview').forEach(v => v.classList.remove('active'));
  document.getElementById(`metrics-subview-${name}`)?.classList.add('active');

  if (name === 'tree') {
    if (typeof window.analyticsDestroy === 'function') window.analyticsDestroy();
    if (typeof window.metricsInit === 'function') window.metricsInit();
  } else if (name === 'analytics') {
    if (typeof window.metricsDestroy === 'function') window.metricsDestroy();
    if (typeof window.analyticsInit === 'function') window.analyticsInit();
  }
}

// ─── Utility ───

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ─── Init — Never blocks, never blank ───

async function init() {
  // Show loading states immediately
  showLoading(document.getElementById('board'));
  showLoading(document.getElementById('feed'));
  showLoading(document.getElementById('reports'));
  showLoading(document.getElementById('registry'));

  // Wire up tab switching immediately (before data loads)
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // Wire up all filter controls immediately
  document.getElementById('log-range').addEventListener('change', loadLog);
  document.getElementById('log-agent-filter').addEventListener('input', () => {
    clearTimeout(window._logFilterTimeout);
    window._logFilterTimeout = setTimeout(loadLog, 300);
  });
  document.getElementById('journal-range').addEventListener('change', loadJournal);
  document.getElementById('journal-author-filter').addEventListener('input', () => {
    clearTimeout(window._journalAuthorTimeout);
    window._journalAuthorTimeout = setTimeout(loadJournal, 300);
  });
  document.getElementById('journal-tag-filter').addEventListener('input', () => {
    clearTimeout(window._journalTagTimeout);
    window._journalTagTimeout = setTimeout(loadJournal, 300);
  });
  document.querySelectorAll('.metrics-subtab').forEach(tab => {
    tab.addEventListener('click', () => switchMetricsSubview(tab.dataset.subview));
  });
  document.getElementById('skills-filter').addEventListener('input', () => {
    clearTimeout(window._skillsFilterTimeout);
    window._skillsFilterTimeout = setTimeout(renderSkills, 300);
  });
  document.getElementById('skills-status-filter').addEventListener('change', renderSkills);

  // Knowledge Base controls
  document.getElementById('kb-type-filter').addEventListener('change', loadKbEntries);
  document.getElementById('kb-search').addEventListener('input', () => {
    clearTimeout(window._kbSearchTimeout);
    window._kbSearchTimeout = setTimeout(loadKbEntries, 300);
  });
  document.getElementById('kb-add-toggle').addEventListener('click', () => {
    const form = document.getElementById('kb-add-form');
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('kb-submit-btn').addEventListener('click', addKbEntry);

  // Load all dashboard panels independently — each succeeds or fails on its own
  // Use allSettled so one failure doesn't block others
  await Promise.allSettled([
    loadBoard(),
    loadFeed(),
    loadRegistry(),
    loadReports(),
  ]);

  // SSE starts non-blocking AFTER initial data is painted
  startSSE();

  // Poll only the active view — 30s interval (SSE handles real-time feed updates)
  setInterval(() => {
    if (activeView === 'dashboard') {
      loadBoard();
      loadRegistry();
      loadReports();
    }
  }, 30000);
}

// ─── Expose functions used by inline onclick handlers ───
// app.js is loaded as type="module", so all top-level declarations are
// module-scoped and invisible to HTML onclick attributes. Attach them
// to window so dynamically-generated onclick="" handlers can call them.
window.bumpTask = bumpTask;
window.approveTask = approveTask;
window.rejectTask = rejectTask;
window.reinforceKbEntry = reinforceKbEntry;
window.addKbEntry = addKbEntry;

init();



