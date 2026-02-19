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

let lastBoardHash = '';

function renderBoard(tasks) {
  const board = document.getElementById('board');
  const grouped = {};
  for (const s of STATUS_ORDER) grouped[s] = [];
  for (const t of tasks) {
    (grouped[t.status] || grouped['open']).push(t);
  }

  // Update stats (always safe — these are just text nodes)
  document.getElementById('stat-total').textContent = tasks.length;
  document.getElementById('stat-open').textContent = grouped['open'].length;
  document.getElementById('stat-blocked').textContent = grouped['blocked'].length;

  // Compute a hash to detect actual data changes — skip DOM rebuild if unchanged
  const boardHash = JSON.stringify(tasks.map(t => t.id + ':' + t.status + ':' + (t.score || 0) + ':' + (t.notes || []).length));
  if (boardHash === lastBoardHash) return;
  lastBoardHash = boardHash;

  // Preserve expanded state of task cards across re-render
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
      // Forward to speedometer for live tok/s gauge
      if (typeof window._speedometerOnFeedEvent === 'function') {
        window._speedometerOnFeedEvent(evt);
      }
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

let lastRegistryHash = '';

function renderRegistry(vms) {
  const reg = document.getElementById('registry');
  document.getElementById('stat-vms').textContent = vms.length || '0';

  if (!vms.length) {
    reg.innerHTML = '<div class="empty">No VMs registered</div>';
    return;
  }

  // Skip DOM rebuild if data unchanged
  const regHash = JSON.stringify(vms.map(v => v.id + ':' + (v.status || '') + ':' + (v.lastSeen || v.registeredAt)));
  if (regHash === lastRegistryHash) return;
  lastRegistryHash = regHash;

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

let lastReportsHash = '';

function renderReports(reports) {
  const el = document.getElementById('reports');
  document.getElementById('stat-reports').textContent = reports.length || '0';

  if (!reports.length) {
    el.innerHTML = '<div class="empty">No reports</div>';
    return;
  }

  // Skip DOM rebuild if data unchanged
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

// ─── Implementation Jobs Tracker ───

// Map of taskId -> { jobId, status, startedAt, prUrl, error, pollTimer }
const activeJobs = {};

function elapsedStr(startedAt) {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusIcon(status) {
  if (status === 'done') return '✅';
  if (status === 'failed') return '❌';
  return '🔄';
}

function renderJobStatus(taskId) {
  const job = activeJobs[taskId];
  if (!job) return '';
  const statusCls = job.status || 'starting';
  let inner = `<div class="job-status-header">
    <span class="rj-status">${statusIcon(job.status)}</span>
    <span class="job-status-label">Implementation: ${esc(job.status)}</span>
    <span class="job-elapsed">${elapsedStr(job.startedAt)}</span>
  </div>`;
  if (job.status === 'done' && job.prUrl) {
    inner += `<div class="job-actions"><a class="job-link" href="${esc(job.prUrl)}" target="_blank">🔗 View Pull Request</a></div>`;
  }
  if (job.status === 'failed' && job.error) {
    inner += `<div class="job-error">Error: ${esc(job.error)}</div>`;
  }
  inner += `<div class="job-actions"><a class="job-link" href="${API}/implement/jobs/${job.jobId}/output" target="_blank">View raw output</a></div>`;
  return `<div class="job-status ${statusCls}" id="job-status-${taskId}">${inner}</div>`;
}

function updateJobStatusInline(taskId) {
  const el = document.getElementById(`job-status-${taskId}`);
  const job = activeJobs[taskId];
  if (!el || !job) return;
  const statusCls = job.status || 'starting';
  el.className = `job-status ${statusCls}`;
  let inner = `<div class="job-status-header">
    <span class="rj-status">${statusIcon(job.status)}</span>
    <span class="job-status-label">Implementation: ${esc(job.status)}</span>
    <span class="job-elapsed">${elapsedStr(job.startedAt)}</span>
  </div>`;
  if (job.status === 'done' && job.prUrl) {
    inner += `<div class="job-actions"><a class="job-link" href="${esc(job.prUrl)}" target="_blank">🔗 View Pull Request</a></div>`;
  }
  if (job.status === 'failed' && job.error) {
    inner += `<div class="job-error">Error: ${esc(job.error)}</div>`;
  }
  inner += `<div class="job-actions"><a class="job-link" href="${API}/implement/jobs/${job.jobId}/output" target="_blank">View raw output</a></div>`;
  el.innerHTML = inner;
}

function startJobPolling(taskId, jobId) {
  if (activeJobs[taskId]?.pollTimer) clearInterval(activeJobs[taskId].pollTimer);

  const poll = async () => {
    try {
      const res = await fetch(`${API}/implement/jobs/${jobId}`);
      if (!res.ok) return;
      const data = await res.json();
      const job = activeJobs[taskId];
      if (!job) return;
      job.status = data.status;
      job.prUrl = data.prUrl || job.prUrl;
      job.error = data.error || job.error;
      job.startedAt = data.startedAt || job.startedAt;
      updateJobStatusInline(taskId);
      renderRunningJobs();
      if (data.status === 'done' || data.status === 'failed') {
        clearInterval(job.pollTimer);
        job.pollTimer = null;
      }
    } catch (e) {
      console.error('Job poll error:', e);
    }
  };

  activeJobs[taskId].pollTimer = setInterval(poll, 5000);
  // Immediate first poll
  poll();
}

function renderRunningJobs() {
  const container = document.getElementById('running-jobs');
  if (!container) return;
  const running = Object.entries(activeJobs).filter(([, j]) => j.status === 'starting' || j.status === 'running');
  if (!running.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  let chips = '';
  for (const [taskId, job] of running) {
    chips += `<div class="running-job-chip">
      <span class="rj-status">${statusIcon(job.status)}</span>
      <span>${esc(job.taskTitle || taskId.slice(0, 8))}</span>
      <span style="color:var(--text-dim)">${elapsedStr(job.startedAt)}</span>
    </div>`;
  }
  container.innerHTML = `<div class="running-jobs-title">🔄 Running Implementations</div><div class="running-jobs-list">${chips}</div>`;
}

// ─── Implement Task ───

let _implementResolve = null;
let _implementTaskId = null;

function implementTask(taskId) {
  _implementTaskId = taskId;
  const modal = document.getElementById('implement-modal');
  modal.style.display = 'flex';
}

function _initImplementModal() {
  document.getElementById('impl-confirm').addEventListener('click', async () => {
    const taskId = _implementTaskId;
    const commitId = document.getElementById('impl-commit-id').value.trim();
    const repo = document.getElementById('impl-repo').value.trim();
    const baseBranch = document.getElementById('impl-base-branch').value.trim();

    if (!commitId || !repo || !baseBranch) {
      alert('All fields are required');
      return;
    }

    document.getElementById('implement-modal').style.display = 'none';

    try {
      const res = await fetch(`${API}/board/tasks/${taskId}/implement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goldenCommitId: commitId, repoUrl: repo, baseBranch }),
      });
      if (!res.ok) {
        const text = await res.text();
        alert('Failed to start implementation: ' + text);
        return;
      }
      const data = await res.json();
      const jobId = data.jobId;

      // Get task title for display
      const card = document.querySelector(`.review-card[data-id="${taskId}"]`);
      const title = card ? card.querySelector('.review-title')?.textContent : '';

      activeJobs[taskId] = {
        jobId,
        status: data.status || 'starting',
        startedAt: new Date().toISOString(),
        prUrl: null,
        error: null,
        pollTimer: null,
        taskTitle: title,
      };

      // Insert job status into the review card
      if (card) {
        // Remove existing job status if any
        const existing = card.querySelector('.job-status');
        if (existing) existing.remove();
        card.insertAdjacentHTML('beforeend', renderJobStatus(taskId));
      }

      renderRunningJobs();
      startJobPolling(taskId, jobId);
    } catch (e) {
      alert('Implementation error: ' + e.message);
    }
  });

  document.getElementById('impl-cancel').addEventListener('click', () => {
    document.getElementById('implement-modal').style.display = 'none';
  });

  // Close on overlay click
  document.getElementById('implement-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.style.display = 'none';
    }
  });
}

// ─── Review Queue ───

let reviewRefreshTimer = null;

async function loadReview() {
  const container = document.getElementById('review-list');
  try {
    const data = await api('/board/review');
    const tasks = data.tasks || [];
    document.getElementById('review-count').textContent = tasks.length;

    if (!tasks.length) {
      container.innerHTML = '<div class="empty">No tasks awaiting review</div>';
      return;
    }

    let html = '';
    for (const t of tasks) {
      // Find the latest note (review summary)
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

      // Check if there's an active job for this task
      const jobStatusHtml = activeJobs[t.id] ? renderJobStatus(t.id) : '';

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
          <button class="btn btn-implement" onclick="implementTask('${t.id}')">🚀 Implement</button>
          <button class="btn btn-reject" onclick="rejectTask('${t.id}')">✗ Reject</button>
        </div>
        ${jobStatusHtml}
      </div>`;
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty">Failed to load review queue: ${esc(e.message)}</div>`;
  }
}

async function approveTask(taskId) {
  const comment = prompt('Approval comment (optional):');
  if (comment === null) return; // cancelled
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
  if (!reason) return; // cancelled or empty
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

  document.getElementById('skills-count').textContent = skills.length;

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
  document.getElementById('extensions-count').textContent = allExtensions.length;

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
  document.getElementById('agents-count').textContent = agents.length;

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

// ─── Tabs ───

function switchView(viewName) {
  activeView = viewName;

  // Update tab buttons
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-view="${viewName}"]`)?.classList.add('active');

  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`)?.classList.add('active');

  // Refresh board data when switching back to it
  if (viewName === 'board') {
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
  if (viewName === 'metrics') {
    activateMetricsSubview();
  } else {
    if (typeof window.metricsDestroy === 'function') window.metricsDestroy();
    if (typeof window.analyticsDestroy === 'function') window.analyticsDestroy();
  }
}

// ─── Metrics Sub-tabs ───

function activateMetricsSubview() {
  const activeTab = document.querySelector('.metrics-subtab.active');
  const subview = activeTab ? activeTab.dataset.subview : 'tree';
  switchMetricsSubview(subview);
}

function switchMetricsSubview(name) {
  // Update sub-tab buttons
  document.querySelectorAll('.metrics-subtab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.metrics-subtab[data-subview="${name}"]`)?.classList.add('active');

  // Update sub-views
  document.querySelectorAll('.metrics-subview').forEach(v => v.classList.remove('active'));
  document.getElementById(`metrics-subview-${name}`)?.classList.add('active');

  // Init/destroy the correct view
  if (name === 'tree') {
    if (typeof window.analyticsDestroy === 'function') window.analyticsDestroy();
    if (typeof window.metricsInit === 'function') window.metricsInit();
  } else if (name === 'analytics') {
    if (typeof window.metricsDestroy === 'function') window.metricsDestroy();
    if (typeof window.analyticsInit === 'function') window.analyticsInit();
  }
}

// ─── Active View Tracking ───

let activeView = 'board';

// ─── Init ───

async function restoreActiveJobs() {
  // On page load, check for any running implementation jobs
  try {
    const data = await api('/implement/jobs');
    const jobs = data.jobs || [];
    for (const job of jobs) {
      if (job.status === 'starting' || job.status === 'running') {
        activeJobs[job.taskId] = {
          jobId: job.id,
          status: job.status,
          startedAt: job.startedAt,
          prUrl: job.prUrl || null,
          error: job.error || null,
          pollTimer: null,
          taskTitle: job.taskId.slice(0, 8),
        };
        startJobPolling(job.taskId, job.id);
      }
    }
    renderRunningJobs();
  } catch (e) {
    // Jobs endpoint may not exist yet, that's fine
    console.debug('Could not restore active jobs:', e.message);
  }
}

async function init() {
  await Promise.all([loadBoard(), loadFeed(), loadRegistry(), loadReports()]);
  _initImplementModal();
  restoreActiveJobs();
  startSSE();

  // Poll board, registry, reports every 10s — but only refresh visible views
  setInterval(() => {
    if (activeView === 'board') loadBoard();
  }, 10000);
  setInterval(() => {
    if (activeView === 'board') loadRegistry();
  }, 10000);
  setInterval(() => {
    if (activeView === 'board') loadReports();
  }, 10000);

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

  // Metrics sub-tab switching
  document.querySelectorAll('.metrics-subtab').forEach(tab => {
    tab.addEventListener('click', () => switchMetricsSubview(tab.dataset.subview));
  });

  // Skills filter controls
  document.getElementById('skills-filter').addEventListener('input', () => {
    clearTimeout(window._skillsFilterTimeout);
    window._skillsFilterTimeout = setTimeout(renderSkills, 300);
  });
  document.getElementById('skills-status-filter').addEventListener('change', renderSkills);
}

init();
