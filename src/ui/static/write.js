// Write Tab — Report Writer UI
(function () {
  const API = '/ui/api';
  let refreshTimer = null;
  let allReports = [];
  let currentView = 'list'; // 'list' | 'editor' | 'reading'
  let editingId = null;

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

  // ─── List View ───

  async function loadReports() {
    const list = document.getElementById('write-report-list');
    if (!list) return;
    try {
      const data = await fapi('/reports');
      allReports = data.reports || [];
      renderList();
    } catch (e) {
      list.innerHTML = `<div class="empty">Failed to load reports: ${esc(e.message)}</div>`;
    }
  }

  function renderList() {
    const list = document.getElementById('write-report-list');
    if (!list) return;

    if (!allReports.length) {
      list.innerHTML = '<div class="write-empty">No reports yet. Click <strong>+ New Report</strong> to write one.</div>';
      return;
    }

    let html = '';
    for (const r of allReports) {
      const tags = (r.tags || []).map(t => `<span class="write-tag">${esc(t)}</span>`).join('');
      html += `<div class="write-report-row" data-id="${esc(r.id)}">
        <div class="write-report-row-main">
          <div class="write-report-title">${esc(r.title)}</div>
          <div class="write-report-meta">
            <span class="write-report-author">@${esc(r.author)}</span>
            ${tags}
            <span class="write-report-time">${timeAgo(r.createdAt)}</span>
          </div>
        </div>
        <div class="write-report-actions">
          <button class="write-btn-sm" data-action="view" data-id="${esc(r.id)}" title="View">👁</button>
          <button class="write-btn-sm" data-action="edit" data-id="${esc(r.id)}" title="Edit">✏️</button>
          <button class="write-btn-sm write-btn-danger-sm" data-action="delete" data-id="${esc(r.id)}" title="Delete">🗑</button>
        </div>
      </div>`;
    }
    list.innerHTML = html;

    // Wire up action buttons
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (action === 'view') viewReport(id);
        else if (action === 'edit') editReport(id);
        else if (action === 'delete') deleteReport(id);
      });
    });

    // Click row to view
    list.querySelectorAll('.write-report-row').forEach(row => {
      row.addEventListener('click', () => viewReport(row.dataset.id));
    });
  }

  // ─── Editor ───

  function showEditor(report) {
    editingId = report ? report.id : null;
    currentView = 'editor';

    const container = document.getElementById('write-content');
    container.innerHTML = `
      <div class="write-editor">
        <div class="write-editor-toolbar">
          <button class="write-btn" id="write-back-btn">← Back</button>
          <span class="write-editor-label">${editingId ? 'Edit Report' : 'New Report'}</span>
          <div class="write-editor-toolbar-right">
            <button class="write-btn write-btn-preview" id="write-preview-btn">Preview</button>
            <button class="write-btn write-btn-primary" id="write-save-btn">💾 Save</button>
          </div>
        </div>
        <div class="write-fields">
          <div class="write-field-row">
            <div class="write-field write-field-title">
              <input type="text" id="write-title" placeholder="Report title…" value="${esc(report?.title || '')}">
            </div>
          </div>
          <div class="write-field-row write-field-row-half">
            <div class="write-field">
              <label>Author</label>
              <input type="text" id="write-author" placeholder="Author" value="${esc(report?.author || 'noah')}">
            </div>
            <div class="write-field">
              <label>Tags</label>
              <input type="text" id="write-tags" placeholder="comma-separated tags" value="${esc((report?.tags || []).join(', '))}">
            </div>
          </div>
        </div>
        <div class="write-editor-body">
          <textarea id="write-content-area" placeholder="Write your report in markdown…">${esc(report?.content || '')}</textarea>
        </div>
        <div class="write-preview-pane" id="write-preview-pane" style="display:none"></div>
      </div>`;

    // Wire buttons
    document.getElementById('write-back-btn').addEventListener('click', showList);
    document.getElementById('write-save-btn').addEventListener('click', saveReport);
    document.getElementById('write-preview-btn').addEventListener('click', togglePreview);

    // Focus title for new reports, content for edits
    setTimeout(() => {
      const target = editingId ? document.getElementById('write-content-area') : document.getElementById('write-title');
      if (target) target.focus();
    }, 50);
  }

  function togglePreview() {
    const textarea = document.getElementById('write-content-area');
    const preview = document.getElementById('write-preview-pane');
    const btn = document.getElementById('write-preview-btn');

    if (preview.style.display === 'none') {
      preview.style.display = 'block';
      textarea.style.display = 'none';
      preview.innerHTML = renderMarkdown(textarea.value);
      btn.textContent = 'Edit';
      btn.classList.add('active');
    } else {
      preview.style.display = 'none';
      textarea.style.display = 'block';
      btn.textContent = 'Preview';
      btn.classList.remove('active');
    }
  }

  function renderMarkdown(md) {
    // Simple markdown rendering
    let html = esc(md);
    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    // Line breaks
    html = html.replace(/\n{2,}/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');
    return `<div class="write-rendered-md">${html}</div>`;
  }

  async function saveReport() {
    const title = document.getElementById('write-title').value.trim();
    const author = document.getElementById('write-author').value.trim() || 'noah';
    const tagsRaw = document.getElementById('write-tags').value.trim();
    const content = document.getElementById('write-content-area').value;
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (!title) {
      document.getElementById('write-title').classList.add('write-field-error');
      setTimeout(() => document.getElementById('write-title').classList.remove('write-field-error'), 1500);
      return;
    }

    const btn = document.getElementById('write-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      if (editingId) {
        await fapi(`/reports/${editingId}`, {
          method: 'PATCH',
          body: { title, content, author, tags },
        });
      } else {
        await fapi('/reports', {
          method: 'POST',
          body: { title, content, author, tags },
        });
      }
      await loadReports();
      showList();
    } catch (e) {
      alert('Failed to save: ' + e.message);
      btn.disabled = false;
      btn.textContent = '💾 Save';
    }
  }

  // ─── View Report ───

  async function viewReport(id) {
    currentView = 'reading';
    const container = document.getElementById('write-content');
    container.innerHTML = '<div class="write-loading">Loading report…</div>';

    try {
      const report = await fapi(`/reports/${id}`);
      container.innerHTML = `
        <div class="write-reader">
          <div class="write-editor-toolbar">
            <button class="write-btn" id="write-read-back">← Back</button>
            <span class="write-editor-label"></span>
            <div class="write-editor-toolbar-right">
              <button class="write-btn" id="write-read-edit">✏️ Edit</button>
              <a class="write-btn" href="/ui/report/${esc(report.id)}" target="_blank">↗ Open</a>
            </div>
          </div>
          <div class="write-reader-header">
            <h1 class="write-reader-title">${esc(report.title)}</h1>
            <div class="write-reader-meta">
              <span class="write-report-author">@${esc(report.author)}</span>
              ${(report.tags || []).map(t => `<span class="write-tag">${esc(t)}</span>`).join('')}
              <span class="write-report-time">${timeAgo(report.createdAt)}</span>
            </div>
          </div>
          <div class="write-reader-body">${renderMarkdown(report.content || '')}</div>
        </div>`;

      document.getElementById('write-read-back').addEventListener('click', showList);
      document.getElementById('write-read-edit').addEventListener('click', () => editReport(id));
    } catch (e) {
      container.innerHTML = `<div class="empty">Failed to load report: ${esc(e.message)}</div>`;
    }
  }

  async function editReport(id) {
    try {
      const report = await fapi(`/reports/${id}`);
      showEditor(report);
    } catch (e) {
      alert('Failed to load report: ' + e.message);
    }
  }

  async function deleteReport(id) {
    if (!confirm('Delete this report?')) return;
    try {
      await fapi(`/reports/${id}`, { method: 'DELETE' });
      await loadReports();
    } catch (e) {
      alert('Failed to delete: ' + e.message);
    }
  }

  // ─── List View ───

  function showList() {
    currentView = 'list';
    editingId = null;
    const container = document.getElementById('write-content');
    container.innerHTML = `
      <div class="write-list-view">
        <div class="write-list-toolbar">
          <span class="write-list-title">Reports</span>
          <span class="write-list-count" id="write-list-count">${allReports.length}</span>
          <div class="write-list-toolbar-right">
            <button class="write-btn write-btn-primary" id="write-new-btn">+ New Report</button>
          </div>
        </div>
        <div class="write-report-list" id="write-report-list">
          <div class="empty">Loading…</div>
        </div>
      </div>`;

    document.getElementById('write-new-btn').addEventListener('click', () => showEditor(null));
    renderList();
  }

  // ─── Init / Destroy ───

  function init() {
    showList();
    loadReports();
    refreshTimer = setInterval(loadReports, 30000);
  }

  function destroy() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  window._writeInit = init;
  window._writeDestroy = destroy;
})();
