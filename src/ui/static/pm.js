// PM Tool — Project Management Interface
// Dispatching, task management, review queue

(function () {
  const API = '/ui/api';
  let allTasks = [];
  let personas = [];
  let activeTaskId = null;
  let refreshTimer = null;
  let recentDispatches = JSON.parse(localStorage.getItem('pm-dispatches') || '[]');
  let currentView = 'tasks';

  // ─── API helpers ───

  async function pmApi(path, opts = {}) {
    const timeout = opts.timeout || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${API}${path}`, {
        ...opts,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      if (res.status === 401) { window.location.href = '/ui/login'; return null; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  const STATUSES = ['open', 'in_progress', 'in_review', 'blocked', 'done'];
  const STATUS_NEXT = { open: 'in_progress', in_progress: 'done', in_review: 'done', blocked: 'open', done: 'open' };
  const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', in_review: 'In Review', blocked: 'Blocked', done: 'Done' };
  const PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };
  const PRIORITY_LABELS = { critical: '🔴 P0', high: '🟠 P1', normal: '🟡 P2', low: '⚪ P3' };

  // ─── Stats ───

  function updateStats() {
    const counts = { open: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 };
    let p0 = 0, p1 = 0;
    for (const t of allTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (t.priority === 'critical') p0++;
      if (t.priority === 'high') p1++;
    }
    setText('pm-s-open', counts.open);
    setText('pm-s-progress', counts.in_progress);
    setText('pm-s-done', counts.done);
    setText('pm-s-p0', p0);
    setText('pm-s-p1', p1);

    // Review badge
    const reviewCount = counts.in_review;
    const badge = document.getElementById('pm-review-badge');
    if (badge) {
      badge.textContent = reviewCount;
      badge.style.display = reviewCount > 0 ? 'inline-block' : 'none';
    }
  }

  async function loadAgentCount() {
    try {
      const data = await pmApi('/registry/vms');
      const vms = data?.vms || [];
      const active = vms.filter(v => {
        const ms = Date.now() - new Date(v.lastSeen || v.registeredAt).getTime();
        return ms < 120000;
      });
      setText('pm-s-agents', active.length);
    } catch { setText('pm-s-agents', '?'); }
  }

  // ─── Task List ───

  async function loadTasks() {
    try {
      const data = await pmApi('/board/tasks');
      allTasks = data?.tasks || [];
      renderTaskList();
      updateStats();
    } catch (e) {
      document.getElementById('pm-task-list').innerHTML =
        `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
    }
  }

  function getFiltered() {
    let tasks = [...allTasks];
    const status = document.getElementById('pm-f-status').value;
    const priority = document.getElementById('pm-f-priority').value;
    const assignee = document.getElementById('pm-f-assignee').value.trim().toLowerCase();
    const tag = document.getElementById('pm-f-tag').value.trim().toLowerCase();

    if (status) tasks = tasks.filter(t => t.status === status);
    if (priority) tasks = tasks.filter(t => (t.priority || 'normal') === priority);
    if (assignee) tasks = tasks.filter(t => (t.assignee || '').toLowerCase().includes(assignee));
    if (tag) tasks = tasks.filter(t => (t.tags || []).some(tg => tg.toLowerCase().includes(tag)));

    // Sort
    const sort = document.getElementById('pm-sort').value;
    if (sort === 'score') {
      tasks.sort((a, b) => (b.score || 0) - (a.score || 0));
    } else if (sort === 'date') {
      tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sort === 'date-asc') {
      tasks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else if (sort === 'priority') {
      tasks.sort((a, b) => (PRIORITY_ORDER[a.priority || 'normal'] || 2) - (PRIORITY_ORDER[b.priority || 'normal'] || 2));
    }

    return tasks;
  }

  function renderTaskList() {
    const container = document.getElementById('pm-task-list');
    const tasks = getFiltered();

    if (!tasks.length) {
      container.innerHTML = '<div class="empty">No tasks match filters</div>';
      return;
    }

    let html = '';
    for (const t of tasks) {
      const priority = t.priority || 'normal';
      const pLabel = PRIORITY_LABELS[priority] || priority;
      const pCls = priority === 'critical' ? 'p-critical' : priority === 'high' ? 'p-high' : priority === 'normal' ? 'p-normal' : 'p-low';
      const tags = (t.tags || []).map(tg => `<span class="t-tag">${esc(tg)}</span>`).join('');
      const assignee = t.assignee ? `<span class="t-assignee">@${esc(t.assignee)}</span>` : '';
      const score = (t.score || 0) > 0 ? `<span class="t-score">⬆${t.score}</span>` : '';
      const selected = t.id === activeTaskId ? ' selected' : '';

      html += `<div class="pm-task-item${selected}" data-id="${t.id}">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-meta">
          <span class="t-status st-${t.status}" data-id="${t.id}" data-status="${t.status}" title="Click to advance status">${STATUS_LABELS[t.status] || t.status}</span>
          <span class="t-priority ${pCls}">${pLabel}</span>
          ${assignee} ${tags} ${score}
          <span>${timeAgo(t.createdAt)}</span>
        </div>
      </div>`;
    }
    container.innerHTML = html;

    // Bind click handlers
    container.querySelectorAll('.pm-task-item').forEach(el => {
      el.addEventListener('click', (e) => {
        // Don't open detail if clicking status toggle
        if (e.target.classList.contains('t-status')) return;
        selectTask(el.dataset.id);
      });
    });

    // Bind status toggles
    container.querySelectorAll('.t-status').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleStatus(el.dataset.id, el.dataset.status);
      });
    });
  }

  async function cycleStatus(taskId, current) {
    const next = STATUS_NEXT[current] || 'open';
    try {
      await pmApi(`/board/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      await loadTasks();
      if (activeTaskId === taskId) loadDetail(taskId);
    } catch (e) {
      console.error('Status update failed:', e);
    }
  }

  function selectTask(id) {
    activeTaskId = id;
    renderTaskList();
    loadDetail(id);
  }

  // ─── Task Detail ───

  async function loadDetail(id) {
    const panel = document.getElementById('pm-detail');
    try {
      const data = await pmApi(`/board/tasks/${id}`);
      if (!data) return;
      renderDetail(data);
    } catch (e) {
      panel.innerHTML = `<div class="empty">Failed to load task: ${esc(e.message)}</div>`;
    }
  }

  function renderDetail(task) {
    const panel = document.getElementById('pm-detail');
    const priority = task.priority || 'normal';
    const notes = task.notes || [];
    const artifacts = task.artifacts || [];

    // Build notes HTML
    let notesHtml = '';
    for (const n of notes) {
      notesHtml += `<div class="pm-note">
        <div class="note-header">
          <span><span class="note-author">@${esc(n.author)}</span><span class="note-type">${esc(n.type || 'update')}</span></span>
          <span class="note-time">${timeAgo(n.timestamp || n.createdAt)}</span>
        </div>
        <div class="note-body">${esc(n.content)}</div>
      </div>`;
    }

    // Build artifacts HTML
    let artifactsHtml = '';
    for (const a of artifacts) {
      let icon = '🔗';
      if (a.type === 'branch') icon = '🌿';
      else if (a.type === 'report') icon = '📄';
      else if (a.type === 'deploy') icon = '🚀';
      else if (a.type === 'diff') icon = '📝';
      else if (a.type === 'file') icon = '📁';
      const href = a.type === 'report' && !a.url?.startsWith('/') ? `/ui/report/${a.url}` : esc(a.url || '#');
      artifactsHtml += `<a class="pm-artifact" href="${href}" target="_blank">${icon} ${esc(a.label || a.url)}</a>`;
    }

    // Build related reports links
    let reportsHtml = '';
    const reportArtifacts = artifacts.filter(a => a.type === 'report');
    for (const r of reportArtifacts) {
      const href = r.url?.startsWith('/') ? r.url : `/ui/report/${r.url}`;
      reportsHtml += `<a class="pm-report-link" href="${href}" target="_blank">📄 ${esc(r.label || 'Report')}</a>`;
    }

    // Status options
    let statusOpts = '';
    for (const s of STATUSES) {
      statusOpts += `<option value="${s}" ${task.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`;
    }

    // Priority options
    const priorities = ['critical', 'high', 'normal', 'low'];
    let priorityOpts = '';
    for (const p of priorities) {
      priorityOpts += `<option value="${p}" ${priority === p ? 'selected' : ''}>${PRIORITY_LABELS[p]}</option>`;
    }

    panel.innerHTML = `
      <div class="pm-detail-header">
        <div class="pm-detail-title">${esc(task.title)}</div>
        <div class="pm-detail-controls">
          <select id="pm-d-status">${statusOpts}</select>
          <select id="pm-d-pri">${priorityOpts}</select>
          <input type="text" id="pm-d-asgn" value="${esc(task.assignee || '')}" placeholder="Assignee…" style="width:140px">
          <button class="btn btn-accent" id="pm-d-save">Save</button>
        </div>
      </div>
      <div class="pm-detail-body">
        ${task.description ? `<div class="pm-detail-section">
          <h3>Description</h3>
          <div class="pm-detail-desc">${esc(task.description)}</div>
        </div>` : ''}
        <div class="pm-detail-section">
          <h3>Info</h3>
          <div style="font-size:11px;color:var(--text-dim);display:flex;gap:16px;flex-wrap:wrap;">
            <span>Created by <span style="color:var(--purple)">${esc(task.createdBy || '?')}</span></span>
            <span>Created ${timeAgo(task.createdAt)}</span>
            <span>Updated ${timeAgo(task.updatedAt)}</span>
            ${(task.tags || []).length ? '<span>Tags: ' + (task.tags || []).map(t => `<span style="color:var(--blue)">${esc(t)}</span>`).join(', ') + '</span>' : ''}
          </div>
        </div>
        ${artifactsHtml ? `<div class="pm-detail-section">
          <h3>Artifacts</h3>
          <div>${artifactsHtml}</div>
        </div>` : ''}
        ${reportsHtml ? `<div class="pm-detail-section">
          <h3>Related Reports</h3>
          <div>${reportsHtml}</div>
        </div>` : ''}
        <div class="pm-detail-section">
          <h3>Notes (${notes.length})</h3>
          ${notesHtml || '<div class="empty" style="padding:8px;">No notes yet</div>'}
          <div class="pm-add-note">
            <textarea id="pm-note-text" placeholder="Add a note…"></textarea>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <select id="pm-note-type" style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px;border-radius:3px;font-family:inherit;font-size:10px;">
                <option value="update">Update</option>
                <option value="finding">Finding</option>
                <option value="blocker">Blocker</option>
                <option value="question">Question</option>
              </select>
              <button class="btn btn-accent" id="pm-note-add" style="flex:1;">Add</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Bind save
    document.getElementById('pm-d-save').addEventListener('click', async () => {
      try {
        await pmApi(`/board/tasks/${task.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: document.getElementById('pm-d-status').value,
            priority: document.getElementById('pm-d-pri').value,
            assignee: document.getElementById('pm-d-asgn').value.trim() || undefined,
          }),
        });
        await loadTasks();
        loadDetail(task.id);
      } catch (e) { alert('Save failed: ' + e.message); }
    });

    // Bind add note
    document.getElementById('pm-note-add').addEventListener('click', async () => {
      const content = document.getElementById('pm-note-text').value.trim();
      if (!content) return;
      try {
        await pmApi(`/board/tasks/${task.id}/notes`, {
          method: 'POST',
          body: JSON.stringify({
            content,
            type: document.getElementById('pm-note-type').value,
            author: 'noah',
          }),
        });
        loadDetail(task.id);
      } catch (e) { alert('Add note failed: ' + e.message); }
    });
  }

  // ─── Personas ───

  async function loadPersonas() {
    try {
      const data = await pmApi('/personas');
      personas = data?.personas || [];
      const sel = document.getElementById('pm-d-persona');
      sel.innerHTML = '<option value="">— select persona —</option>';
      for (const p of personas) {
        sel.innerHTML += `<option value="${esc(p.name)}">${esc(p.name)}${p.description ? ' — ' + esc(p.description) : ''}</option>`;
      }
    } catch { /* personas optional */ }
  }

  // ─── Dispatch ───

  function renderRecentDispatches() {
    const container = document.getElementById('pm-recent-list');
    const recent = recentDispatches.slice(0, 10);
    if (!recent.length) {
      container.innerHTML = '<div class="empty">No recent dispatches</div>';
      return;
    }
    let html = '';
    for (const d of recent) {
      html += `<div class="pm-recent-item">
        <div class="r-title">${esc(d.title)}</div>
        <div class="r-meta">
          ${d.persona ? `<span class="r-persona">${esc(d.persona)}</span>` : ''}
          ${d.assignee ? `<span>→ ${esc(d.assignee)}</span>` : ''}
          <span>${timeAgo(d.time)}</span>
        </div>
      </div>`;
    }
    container.innerHTML = html;
  }

  async function dispatch() {
    const btn = document.getElementById('pm-dispatch-btn');
    const task = document.getElementById('pm-d-task').value.trim();
    if (!task) return;

    btn.disabled = true;
    btn.textContent = 'Dispatching…';

    try {
      const persona = document.getElementById('pm-d-persona').value;
      const assignee = document.getElementById('pm-d-assignee').value.trim();
      const priority = document.getElementById('pm-d-priority').value;
      const tagsRaw = document.getElementById('pm-d-tags').value.trim();
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

      // Create board task
      const data = await pmApi('/board/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: task.split('\n')[0].substring(0, 120),
          description: task,
          assignee: assignee || persona || undefined,
          tags: persona ? [...tags, `persona:${persona}`] : tags,
          priority,
          createdBy: 'noah',
        }),
      });

      // Post to feed as notification
      try {
        await pmApi('/feed/events', {
          method: 'POST',
          body: JSON.stringify({
            type: 'task_update',
            agent: 'noah',
            summary: `Dispatched task: ${task.split('\n')[0].substring(0, 80)}${assignee ? ' → ' + assignee : ''}`,
          }),
        });
      } catch { /* feed post optional */ }

      // Track dispatch locally
      recentDispatches.unshift({
        title: task.split('\n')[0].substring(0, 80),
        persona,
        assignee,
        taskId: data?.task?.id,
        time: new Date().toISOString(),
      });
      recentDispatches = recentDispatches.slice(0, 20);
      localStorage.setItem('pm-dispatches', JSON.stringify(recentDispatches));

      // Clear form
      document.getElementById('pm-d-task').value = '';
      document.getElementById('pm-d-assignee').value = '';
      document.getElementById('pm-d-tags').value = '';

      renderRecentDispatches();
      await loadTasks();
    } catch (e) {
      alert('Dispatch failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '▸ Dispatch';
    }
  }

  // ─── Review Queue ───

  async function loadReview() {
    const container = document.getElementById('pm-review-list');
    try {
      const data = await pmApi('/board/review');
      const tasks = data?.tasks || [];

      if (!tasks.length) {
        container.innerHTML = '<div class="empty">No tasks awaiting review 🎉</div>';
        return;
      }

      let html = '';
      for (const t of tasks) {
        const latestNote = t.notes?.length ? t.notes[t.notes.length - 1] : null;
        const artifacts = t.artifacts || [];

        let artifactsHtml = '';
        if (artifacts.length) {
          artifactsHtml = '<div class="pm-review-artifacts">';
          for (const a of artifacts) {
            let icon = '🔗';
            if (a.type === 'branch') icon = '🌿';
            else if (a.type === 'report') icon = '📄';
            else if (a.type === 'deploy') icon = '🚀';
            else if (a.type === 'diff') icon = '📝';
            const href = a.type === 'report' && !a.url?.startsWith('/') ? `/ui/report/${a.url}` : esc(a.url || '#');
            artifactsHtml += `<a class="pm-artifact" href="${href}" target="_blank">${icon} ${esc(a.label || a.url)}</a>`;
          }
          artifactsHtml += '</div>';
        }

        const submittedBy = latestNote ? latestNote.author : t.createdBy;

        html += `<div class="pm-review-card" data-id="${t.id}">
          <div class="pm-review-title">${esc(t.title)}</div>
          <div class="pm-review-meta">
            submitted by <span class="r-author">@${esc(submittedBy || '?')}</span>
            <span>${timeAgo(t.updatedAt)}</span>
            ${t.assignee ? `<span>assigned to <span class="r-author">@${esc(t.assignee)}</span></span>` : ''}
          </div>
          ${latestNote ? `<div class="pm-review-summary">${esc(latestNote.content)}</div>` : ''}
          ${t.description ? `<div class="pm-review-summary" style="border-top:none;padding-top:0;color:var(--text-dim);font-size:11px">${esc(t.description)}</div>` : ''}
          ${artifactsHtml}
          <div class="pm-review-actions">
            <button class="btn btn-approve" onclick="window._pmApprove('${t.id}')">✓ Approve → Done</button>
            <button class="btn btn-changes" onclick="window._pmRequestChanges('${t.id}')">↩ Request Changes</button>
          </div>
        </div>`;
      }
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
    }
  }

  window._pmApprove = async function (taskId) {
    try {
      await pmApi(`/board/tasks/${taskId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment: '', approvedBy: 'noah' }),
      });
      await loadTasks();
      loadReview();
    } catch (e) { alert('Approve failed: ' + e.message); }
  };

  let pendingReviewTaskId = null;

  window._pmRequestChanges = function (taskId) {
    pendingReviewTaskId = taskId;
    document.getElementById('pm-modal-title').textContent = 'Request Changes';
    document.getElementById('pm-modal-text').value = '';
    document.getElementById('pm-modal').style.display = 'flex';
    document.getElementById('pm-modal-text').focus();
  };

  // ─── View Switching ───

  function switchView(view) {
    currentView = view;
    document.querySelectorAll('.pm-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.pm-tab[data-view="${view}"]`)?.classList.add('active');
    document.querySelectorAll('.pm-view').forEach(v => v.classList.remove('active'));
    document.getElementById(`pm-view-${view}`)?.classList.add('active');

    if (view === 'review') loadReview();
  }

  // ─── Init ───

  function init() {
    // Tab switching
    document.querySelectorAll('.pm-tab').forEach(tab => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // Filters
    const filterEls = ['pm-f-status', 'pm-f-priority', 'pm-sort'];
    filterEls.forEach(id => {
      document.getElementById(id)?.addEventListener('change', renderTaskList);
    });
    ['pm-f-assignee', 'pm-f-tag'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => {
        clearTimeout(window._pmFilterTimeout);
        window._pmFilterTimeout = setTimeout(renderTaskList, 300);
      });
    });

    // Dispatch
    document.getElementById('pm-dispatch-btn').addEventListener('click', dispatch);
    document.getElementById('pm-d-task').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) dispatch();
    });

    // Modal
    document.getElementById('pm-modal-cancel').addEventListener('click', () => {
      document.getElementById('pm-modal').style.display = 'none';
    });
    document.getElementById('pm-modal-submit').addEventListener('click', async () => {
      const note = document.getElementById('pm-modal-text').value.trim();
      if (!note || !pendingReviewTaskId) return;
      try {
        // Add note
        await pmApi(`/board/tasks/${pendingReviewTaskId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ content: note, type: 'feedback', author: 'noah' }),
        });
        // Move back to in_progress
        await pmApi(`/board/tasks/${pendingReviewTaskId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'in_progress' }),
        });
        document.getElementById('pm-modal').style.display = 'none';
        pendingReviewTaskId = null;
        await loadTasks();
        loadReview();
      } catch (e) { alert('Failed: ' + e.message); }
    });

    // Close modal on overlay click
    document.getElementById('pm-modal').addEventListener('click', (e) => {
      if (e.target.id === 'pm-modal') {
        document.getElementById('pm-modal').style.display = 'none';
      }
    });

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('pm-modal').style.display = 'none';
      }
    });

    // Initial load
    loadTasks();
    loadPersonas();
    loadAgentCount();
    renderRecentDispatches();

    // Refresh every 15s
    refreshTimer = setInterval(() => {
      loadTasks();
      loadAgentCount();
      if (currentView === 'review') loadReview();
    }, 15000);
  }

  init();
})();
