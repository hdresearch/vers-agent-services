// Board Full UI — Jira-like task management interface
// Uses /ui/api/ proxy pattern, no hardcoded auth

(function () {
  const API = '/ui/api';
  let allTasks = [];
  let selectedIds = new Set();
  let activeTaskId = null;
  let refreshTimer = null;
  let filters = { status: '', tag: '', assignee: '', search: '' };

  // ─── API helpers ───

  async function boardApi(path, opts = {}) {
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
      if (res.status === 401) { window.location.href = '/ui/login'; return; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // Delegate to shared utils (see utils.js)
  const esc = window._utils ? window._utils.esc : function (s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  };
  const timeAgo = window._utils ? window._utils.timeAgo : function (iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  };

  const STATUSES = ['open', 'in_progress', 'in_review', 'blocked', 'done'];
  const STATUS_COLORS = {
    open: '#5af', in_progress: '#fd0', in_review: '#a7f',
    blocked: '#f55', done: '#4f9',
  };
  const STATUS_LABELS = {
    open: 'Open', in_progress: 'In Progress', in_review: 'In Review',
    blocked: 'Blocked', done: 'Done',
  };
  const NOTE_TYPES = ['finding', 'blocker', 'question', 'update'];

  // ─── Data loading ───

  async function loadTasks() {
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.assignee) params.set('assignee', filters.assignee);
      const qs = params.toString();
      const data = await boardApi(`/board/tasks${qs ? '?' + qs : ''}`);
      allTasks = data.tasks || [];
      renderTaskList();
      updateStats();
    } catch (e) {
      const list = document.getElementById('bf-task-list');
      if (list) list.innerHTML = `<div class="bf-empty">Failed to load: ${esc(e.message)}</div>`;
    }
  }

  async function loadTaskDetail(id) {
    try {
      const task = await boardApi(`/board/tasks/${id}`);
      activeTaskId = id;
      renderDetail(task);
    } catch (e) {
      const detail = document.getElementById('bf-detail');
      if (detail) detail.innerHTML = `<div class="bf-empty">Failed to load task: ${esc(e.message)}</div>`;
    }
  }

  // ─── Filter logic ───

  function getFilteredTasks() {
    let tasks = allTasks;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      tasks = tasks.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.assignee || '').toLowerCase().includes(q) ||
        (t.tags || []).some(tag => tag.toLowerCase().includes(q))
      );
    }
    return tasks;
  }

  function updateStats() {
    const tasks = allTasks;
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

    setText('bf-stat-total', tasks.length);
    setText('bf-stat-open', byStatus.open || 0);
    setText('bf-stat-progress', byStatus.in_progress || 0);
    setText('bf-stat-review', byStatus.in_review || 0);
    setText('bf-stat-blocked', byStatus.blocked || 0);
    setText('bf-stat-done', byStatus.done || 0);
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  // ─── Render task list ───

  function renderTaskList() {
    const list = document.getElementById('bf-task-list');
    if (!list) return;
    const tasks = getFilteredTasks();

    if (!tasks.length) {
      list.innerHTML = '<div class="bf-empty">No tasks match filters</div>';
      return;
    }

    // Sort: blocked first, then open, in_progress, in_review, done; within status, by score desc
    const statusWeight = { blocked: 0, open: 1, in_progress: 2, in_review: 3, done: 4 };
    tasks.sort((a, b) => {
      const sw = (statusWeight[a.status] ?? 5) - (statusWeight[b.status] ?? 5);
      if (sw !== 0) return sw;
      return (b.score || 0) - (a.score || 0);
    });

    let html = '';
    for (const t of tasks) {
      const isSelected = selectedIds.has(t.id);
      const isActive = t.id === activeTaskId;
      const tags = (t.tags || []).map(tag => `<span class="bf-tag">${esc(tag)}</span>`).join('');
      const statusColor = STATUS_COLORS[t.status] || '#666';
      const score = t.score || 0;

      html += `<div class="bf-task-row${isActive ? ' active' : ''}${isSelected ? ' selected' : ''}" data-id="${t.id}">
        <label class="bf-checkbox-wrap" onclick="event.stopPropagation()">
          <input type="checkbox" class="bf-task-check" data-id="${t.id}" ${isSelected ? 'checked' : ''}>
        </label>
        <span class="bf-status-dot" style="background:${statusColor}" title="${esc(STATUS_LABELS[t.status])}"></span>
        <div class="bf-task-info" onclick="window._boardFullSelect('${t.id}')">
          <div class="bf-task-title">${esc(t.title)}</div>
          <div class="bf-task-meta">
            ${t.assignee ? `<span class="bf-assignee">@${esc(t.assignee)}</span>` : ''}
            ${tags}
            ${score > 0 ? `<span class="bf-score">▲${score}</span>` : ''}
            <span class="bf-age">${timeAgo(t.createdAt)}</span>
          </div>
        </div>
        <div class="bf-task-actions" onclick="event.stopPropagation()">
          <select class="bf-quick-status" data-id="${t.id}" title="Change status">
            ${STATUSES.map(s => `<option value="${s}"${t.status === s ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
          </select>
          <button class="bf-bump-btn" data-id="${t.id}" title="Bump priority">👆</button>
        </div>
      </div>`;
    }

    list.innerHTML = html;

    // Wire events
    list.querySelectorAll('.bf-task-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
        updateBulkBar();
        e.target.closest('.bf-task-row').classList.toggle('selected', e.target.checked);
      });
    });
    list.querySelectorAll('.bf-quick-status').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const id = e.target.dataset.id;
        await boardApi(`/board/tasks/${id}`, {
          method: 'PATCH', body: JSON.stringify({ status: e.target.value }),
        });
        loadTasks();
        if (activeTaskId === id) loadTaskDetail(id);
      });
    });
    list.querySelectorAll('.bf-bump-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await boardApi(`/board/tasks/${btn.dataset.id}/bump`, { method: 'POST' });
        loadTasks();
        if (activeTaskId === btn.dataset.id) loadTaskDetail(btn.dataset.id);
      });
    });
  }

  // ─── Render task detail ───

  function renderDetail(task) {
    const detail = document.getElementById('bf-detail');
    if (!detail) return;

    const tags = (task.tags || []).join(', ');
    const notes = task.notes || [];
    const artifacts = task.artifacts || [];

    let notesHtml = '';
    for (const n of notes) {
      const typeIcon = { finding: '🔍', blocker: '🚫', question: '❓', update: '📝' }[n.type] || '📝';
      notesHtml += `<div class="bf-note">
        <div class="bf-note-header">
          <span class="bf-note-type">${typeIcon} ${esc(n.type)}</span>
          <span class="bf-note-author">@${esc(n.author)}</span>
          <span class="bf-note-time">${timeAgo(n.createdAt)}</span>
        </div>
        <div class="bf-note-content">${esc(n.content)}</div>
      </div>`;
    }

    let artifactsHtml = '';
    for (const a of artifacts) {
      const icon = { branch: '🌿', report: '📄', deploy: '🚀', diff: '📝', file: '📁', url: '🔗' }[a.type] || '🔗';
      artifactsHtml += `<a class="bf-artifact" href="${esc(a.url)}" target="_blank">${icon} ${esc(a.label)}</a>`;
    }

    detail.innerHTML = `
      <div class="bf-detail-header">
        <div class="bf-detail-title-row">
          <h2 class="bf-detail-title" id="bf-detail-title" data-id="${task.id}">${esc(task.title)}</h2>
          <button class="bf-edit-btn" id="bf-edit-title-btn" title="Edit title">✏️</button>
          <button class="bf-close-detail" id="bf-close-detail" title="Close">✕</button>
        </div>
        <div class="bf-detail-id">${esc(task.id)}</div>
      </div>

      <div class="bf-detail-fields">
        <div class="bf-field">
          <label>Status</label>
          <select id="bf-detail-status" class="bf-field-select">
            ${STATUSES.map(s => `<option value="${s}"${task.status === s ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
          </select>
        </div>
        <div class="bf-field">
          <label>Assignee</label>
          <input type="text" id="bf-detail-assignee" class="bf-field-input" value="${esc(task.assignee || '')}" placeholder="unassigned">
        </div>
        <div class="bf-field">
          <label>Tags</label>
          <input type="text" id="bf-detail-tags" class="bf-field-input" value="${esc(tags)}" placeholder="comma-separated">
        </div>
        <div class="bf-field">
          <label>Score</label>
          <span class="bf-field-value">${task.score || 0} <button class="bf-bump-sm" id="bf-detail-bump">👆 Bump</button></span>
        </div>
        <div class="bf-field">
          <label>Created</label>
          <span class="bf-field-value">${timeAgo(task.createdAt)} by ${esc(task.createdBy || '—')}</span>
        </div>
        <button class="bf-save-fields-btn" id="bf-save-fields">Save Changes</button>
      </div>

      <div class="bf-detail-section">
        <div class="bf-section-header">Description</div>
        <div class="bf-description-wrap">
          <textarea id="bf-detail-desc" class="bf-desc-textarea" placeholder="No description">${esc(task.description || '')}</textarea>
          <button class="bf-save-desc-btn" id="bf-save-desc">Save Description</button>
        </div>
      </div>

      ${artifacts.length ? `<div class="bf-detail-section">
        <div class="bf-section-header">Artifacts</div>
        <div class="bf-artifacts">${artifactsHtml}</div>
      </div>` : ''}

      <div class="bf-detail-section">
        <div class="bf-section-header">Notes (${notes.length})</div>
        <div class="bf-notes-list">${notesHtml || '<div class="bf-empty-sm">No notes yet</div>'}</div>
        <div class="bf-add-note">
          <div class="bf-note-input-row">
            <select id="bf-note-type" class="bf-note-type-select">
              ${NOTE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}
            </select>
            <input type="text" id="bf-note-author" class="bf-note-author-input" placeholder="author" value="dashboard-user">
          </div>
          <textarea id="bf-note-content" class="bf-note-textarea" placeholder="Add a note…" rows="2"></textarea>
          <button class="bf-add-note-btn" id="bf-add-note-btn">Add Note</button>
        </div>
      </div>
    `;

    // Wire detail events
    document.getElementById('bf-close-detail').onclick = () => {
      activeTaskId = null;
      detail.innerHTML = '<div class="bf-detail-placeholder">Select a task to view details</div>';
      document.querySelectorAll('.bf-task-row.active').forEach(r => r.classList.remove('active'));
    };

    document.getElementById('bf-edit-title-btn').onclick = () => {
      const titleEl = document.getElementById('bf-detail-title');
      const current = task.title;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.className = 'bf-inline-edit-input';
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        if (input.value.trim() && input.value.trim() !== current) {
          await boardApi(`/board/tasks/${task.id}`, {
            method: 'PATCH', body: JSON.stringify({ title: input.value.trim() }),
          });
          loadTasks();
          loadTaskDetail(task.id);
        } else {
          loadTaskDetail(task.id);
        }
      };
      input.onblur = save;
      input.onkeydown = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') loadTaskDetail(task.id); };
    };

    document.getElementById('bf-save-fields').onclick = async () => {
      const status = document.getElementById('bf-detail-status').value;
      const assignee = document.getElementById('bf-detail-assignee').value.trim();
      const tagsRaw = document.getElementById('bf-detail-tags').value.trim();
      const tagsArr = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
      await boardApi(`/board/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, assignee: assignee || undefined, tags: tagsArr }),
      });
      loadTasks();
      loadTaskDetail(task.id);
    };

    document.getElementById('bf-save-desc').onclick = async () => {
      const desc = document.getElementById('bf-detail-desc').value.trim();
      await boardApi(`/board/tasks/${task.id}`, {
        method: 'PATCH', body: JSON.stringify({ description: desc }),
      });
      loadTaskDetail(task.id);
    };

    document.getElementById('bf-detail-bump').onclick = async () => {
      await boardApi(`/board/tasks/${task.id}/bump`, { method: 'POST' });
      loadTasks();
      loadTaskDetail(task.id);
    };

    document.getElementById('bf-add-note-btn').onclick = async () => {
      const content = document.getElementById('bf-note-content').value.trim();
      const author = document.getElementById('bf-note-author').value.trim() || 'dashboard-user';
      const type = document.getElementById('bf-note-type').value;
      if (!content) return;
      await boardApi(`/board/tasks/${task.id}/notes`, {
        method: 'POST', body: JSON.stringify({ content, author, type }),
      });
      loadTaskDetail(task.id);
    };
  }

  // ─── Create task modal ───

  function showCreateModal() {
    const overlay = document.getElementById('bf-create-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  function hideCreateModal() {
    const overlay = document.getElementById('bf-create-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function createTask() {
    const title = document.getElementById('bf-create-title').value.trim();
    if (!title) return;
    const description = document.getElementById('bf-create-desc').value.trim();
    const assignee = document.getElementById('bf-create-assignee').value.trim();
    const tagsRaw = document.getElementById('bf-create-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
    const createdBy = document.getElementById('bf-create-author').value.trim() || 'dashboard-user';

    await boardApi('/board/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, description, assignee: assignee || undefined, tags, createdBy }),
    });

    hideCreateModal();
    // Clear form
    document.getElementById('bf-create-title').value = '';
    document.getElementById('bf-create-desc').value = '';
    document.getElementById('bf-create-assignee').value = '';
    document.getElementById('bf-create-tags').value = '';
    loadTasks();
  }

  // ─── Bulk actions ───

  function updateBulkBar() {
    const bar = document.getElementById('bf-bulk-bar');
    const count = document.getElementById('bf-bulk-count');
    if (selectedIds.size > 0) {
      bar.style.display = 'flex';
      count.textContent = selectedIds.size;
    } else {
      bar.style.display = 'none';
    }
  }

  async function bulkAction(action) {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;

    if (action === 'close') {
      for (const id of ids) {
        await boardApi(`/board/tasks/${id}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'done' }),
        });
      }
    } else if (action === 'reopen') {
      for (const id of ids) {
        await boardApi(`/board/tasks/${id}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'open' }),
        });
      }
    } else if (action === 'retag') {
      const newTags = prompt('Enter new tags (comma-separated):');
      if (newTags === null) return;
      const tags = newTags.split(',').map(t => t.trim()).filter(Boolean);
      for (const id of ids) {
        await boardApi(`/board/tasks/${id}`, {
          method: 'PATCH', body: JSON.stringify({ tags }),
        });
      }
    } else if (action === 'assign') {
      const assignee = prompt('Enter assignee:');
      if (assignee === null) return;
      for (const id of ids) {
        await boardApi(`/board/tasks/${id}`, {
          method: 'PATCH', body: JSON.stringify({ assignee: assignee.trim() || undefined }),
        });
      }
    } else if (action === 'delete') {
      if (!confirm(`Delete ${ids.length} tasks? This cannot be undone.`)) return;
      for (const id of ids) {
        await boardApi(`/board/tasks/${id}`, { method: 'DELETE' });
      }
    }

    selectedIds.clear();
    updateBulkBar();
    loadTasks();
    if (activeTaskId && ids.includes(activeTaskId)) {
      const detail = document.getElementById('bf-detail');
      detail.innerHTML = '<div class="bf-detail-placeholder">Select a task to view details</div>';
      activeTaskId = null;
    }
  }

  // ─── Select all / none ───

  function selectAll() {
    const tasks = getFilteredTasks();
    tasks.forEach(t => selectedIds.add(t.id));
    renderTaskList();
    updateBulkBar();
  }

  function selectNone() {
    selectedIds.clear();
    renderTaskList();
    updateBulkBar();
  }

  // ─── Init / Destroy ───

  window._boardFullInit = function () {
    loadTasks();
    refreshTimer = setInterval(loadTasks, 30000);

    // Wire filter controls
    const statusFilter = document.getElementById('bf-filter-status');
    const tagFilter = document.getElementById('bf-filter-tag');
    const assigneeFilter = document.getElementById('bf-filter-assignee');
    const searchFilter = document.getElementById('bf-filter-search');

    if (statusFilter) statusFilter.onchange = () => { filters.status = statusFilter.value; loadTasks(); };
    if (tagFilter) tagFilter.oninput = () => {
      clearTimeout(window._bfTagTimeout);
      window._bfTagTimeout = setTimeout(() => { filters.tag = tagFilter.value.trim(); loadTasks(); }, 300);
    };
    if (assigneeFilter) assigneeFilter.oninput = () => {
      clearTimeout(window._bfAssigneeTimeout);
      window._bfAssigneeTimeout = setTimeout(() => { filters.assignee = assigneeFilter.value.trim(); loadTasks(); }, 300);
    };
    if (searchFilter) searchFilter.oninput = () => {
      clearTimeout(window._bfSearchTimeout);
      window._bfSearchTimeout = setTimeout(() => { filters.search = searchFilter.value.trim(); renderTaskList(); }, 200);
    };

    // Create task button
    document.getElementById('bf-create-btn')?.addEventListener('click', showCreateModal);
    document.getElementById('bf-create-cancel')?.addEventListener('click', hideCreateModal);
    document.getElementById('bf-create-submit')?.addEventListener('click', createTask);
    document.getElementById('bf-create-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'bf-create-overlay') hideCreateModal();
    });
    // Enter to submit in create modal
    document.getElementById('bf-create-title')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createTask();
    });

    // Bulk actions
    document.getElementById('bf-bulk-close')?.addEventListener('click', () => bulkAction('close'));
    document.getElementById('bf-bulk-reopen')?.addEventListener('click', () => bulkAction('reopen'));
    document.getElementById('bf-bulk-retag')?.addEventListener('click', () => bulkAction('retag'));
    document.getElementById('bf-bulk-assign')?.addEventListener('click', () => bulkAction('assign'));
    document.getElementById('bf-bulk-delete')?.addEventListener('click', () => bulkAction('delete'));
    document.getElementById('bf-select-all')?.addEventListener('click', selectAll);
    document.getElementById('bf-select-none')?.addEventListener('click', selectNone);
  };

  window._boardFullDestroy = function () {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  };

  window._boardFullSelect = function (id) {
    activeTaskId = id;
    renderTaskList();
    loadTaskDetail(id);
  };
})();
