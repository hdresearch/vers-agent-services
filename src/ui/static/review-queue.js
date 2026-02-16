// ─── Review Queue ───
// Dieter's unified review experience.
// "Good design is as little design as possible."

(function () {
  const API = '/ui/api';
  const STORAGE_KEY = 'rq-seen-ids';
  const REFRESH_INTERVAL = 15000;

  let items = [];
  let filteredItems = [];
  let selectedIndex = -1;
  let refreshTimer = null;
  let isActive = false;
  let lastItemCount = 0;

  // ─── Seen state (localStorage) ───

  function getSeenIds() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function markSeen(id) {
    const seen = new Set(getSeenIds());
    seen.add(id);
    // Keep only last 500 to avoid bloat
    const arr = [...seen].slice(-500);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  }

  function markAllSeen() {
    const seen = new Set(getSeenIds());
    for (const item of items) seen.add(item.id);
    const arr = [...seen].slice(-500);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    render();
  }

  // ─── Helpers ───

  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
    return `${Math.floor(ms / 86400000)}d`;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function priorityIcon(label) {
    switch (label) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'normal': return '🟡';
      case 'low': return '⚪';
      default: return '·';
    }
  }

  function typeIcon(type) {
    switch (type) {
      case 'task': return '📋';
      case 'report': return '📄';
      case 'notification': return '🔔';
      default: return '•';
    }
  }

  // ─── Fetch ───

  async function fetchQueue() {
    try {
      const seenIds = getSeenIds();
      const seenParam = seenIds.length > 0 ? `?seen=${encodeURIComponent(seenIds.join(','))}` : '';
      const res = await fetch(`${API}/review/unified${seenParam}`, { signal: AbortSignal.timeout(8000) });
      if (res.status === 401) { window.location.href = '/ui/login'; return; }
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      items = data.items || [];
      updateBadge(data.stats);
      applyFilters();
      render();
    } catch (e) {
      const el = document.getElementById('rq-list');
      if (el && !el.querySelector('.rq-item')) {
        el.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
      }
    }
  }

  // ─── Badge ───

  function updateBadge(stats) {
    if (!stats) return;
    const badge = document.getElementById('review-tab-badge');
    const rqBadge = document.getElementById('rq-badge');
    const count = stats.unseen || 0;

    if (badge) {
      badge.textContent = stats.total;
      badge.style.display = stats.total > 0 ? 'inline-block' : 'none';
      badge.className = 'tab-badge' + (count > 0 ? ' tab-badge-unseen' : '');
    }
    if (rqBadge) {
      rqBadge.textContent = count > 0 ? `${count} new` : stats.total;
    }

    // Stats line
    const statsEl = document.getElementById('rq-stats');
    if (statsEl) {
      const parts = [];
      if (stats.byType.task) parts.push(`${stats.byType.task} tasks`);
      if (stats.byType.report) parts.push(`${stats.byType.report} reports`);
      if (stats.byType.notification) parts.push(`${stats.byType.notification} notifs`);
      statsEl.textContent = parts.join(' · ');
    }
  }

  // ─── Filters ───

  function applyFilters() {
    const typeFilter = document.getElementById('rq-type-filter')?.value || '';
    const priorityFilter = document.getElementById('rq-priority-filter')?.value || '';
    const sourceFilter = (document.getElementById('rq-source-filter')?.value || '').toLowerCase().trim();

    filteredItems = items.filter(item => {
      if (typeFilter && item.type !== typeFilter) return false;
      if (priorityFilter && item.priorityLabel !== priorityFilter) return false;
      if (sourceFilter && !item.source.toLowerCase().includes(sourceFilter)) return false;
      return true;
    });
  }

  // ─── Render ───

  function render() {
    const el = document.getElementById('rq-list');
    if (!el) return;

    if (filteredItems.length === 0) {
      el.innerHTML = items.length === 0
        ? '<div class="rq-empty"><div class="rq-empty-icon">✓</div><div class="rq-empty-text">Nothing needs your attention</div><div class="rq-empty-sub">The queue is clear. Go outside.</div></div>'
        : '<div class="empty">No items match filters</div>';
      return;
    }

    const seenSet = new Set(getSeenIds());

    let html = '';
    for (let i = 0; i < filteredItems.length; i++) {
      const item = filteredItems[i];
      const isSeen = seenSet.has(item.id) || item.seen;
      const isSelected = i === selectedIndex;
      const expanded = isSelected;

      // Priority stripe color
      let stripeColor = 'var(--border)';
      if (item.priorityLabel === 'critical') stripeColor = 'var(--red)';
      else if (item.priorityLabel === 'high') stripeColor = 'var(--orange)';
      else if (item.priorityLabel === 'normal') stripeColor = 'var(--yellow)';

      const classes = [
        'rq-item',
        `rq-type-${item.type}`,
        `rq-priority-${item.priorityLabel}`,
        isSelected ? 'rq-selected' : '',
        expanded ? 'rq-expanded' : '',
        isSeen ? 'rq-seen' : 'rq-unseen',
      ].filter(Boolean).join(' ');

      // Artifacts
      let artifactsHtml = '';
      if (item.artifacts && item.artifacts.length > 0) {
        artifactsHtml = '<div class="rq-artifacts">';
        for (const a of item.artifacts) {
          let href = esc(a.url || '');
          let icon = '🔗';
          if (a.type === 'branch') icon = '🌿';
          else if (a.type === 'report') { icon = '📄'; href = a.url.startsWith('/') ? a.url : `/ui/report/${a.url}`; }
          else if (a.type === 'deploy') icon = '🚀';
          else if (a.type === 'diff') icon = '📝';
          else if (a.type === 'file') icon = '📁';
          artifactsHtml += `<a class="rq-artifact" href="${href}" target="_blank" onclick="event.stopPropagation()">${icon} ${esc(a.label || a.url)}</a>`;
        }
        artifactsHtml += '</div>';
      }

      // Tags
      const tagsHtml = (item.tags || []).map(t => `<span class="rq-tag">${esc(t)}</span>`).join('');

      // Summary (truncated when collapsed)
      const summaryText = item.summary || '';
      const summaryClass = expanded ? 'rq-summary rq-summary-expanded' : 'rq-summary';

      // Action buttons (visible on expand/hover)
      let actionsHtml = '';
      if (item.type === 'task') {
        actionsHtml = `
          <div class="rq-actions">
            <button class="btn btn-approve rq-action-btn" data-action="approve" data-id="${esc(item.id)}" onclick="event.stopPropagation(); window._rqAction('approve', '${esc(item.id)}')">✓ Approve</button>
            <button class="btn btn-changes rq-action-btn" data-action="feedback" data-id="${esc(item.id)}" onclick="event.stopPropagation(); window._rqAction('feedback', '${esc(item.id)}')">💬 Feedback</button>
            <button class="btn btn-reject rq-action-btn" data-action="reject" data-id="${esc(item.id)}" onclick="event.stopPropagation(); window._rqAction('reject', '${esc(item.id)}')">↩ Send back</button>
            <button class="btn rq-action-btn" data-action="dismiss" data-id="${esc(item.id)}" onclick="event.stopPropagation(); window._rqAction('dismiss', '${esc(item.id)}')">✕ Dismiss</button>
          </div>`;
      } else if (item.type === 'report') {
        const reportUrl = `/ui/report/${item.raw?.id || ''}`;
        actionsHtml = `
          <div class="rq-actions">
            <a class="btn btn-approve rq-action-btn" href="${reportUrl}" target="_blank" onclick="event.stopPropagation(); window._rqAction('seen', '${esc(item.id)}')">📄 Read report</a>
            <button class="btn rq-action-btn" data-action="dismiss" onclick="event.stopPropagation(); window._rqAction('dismiss', '${esc(item.id)}')">✕ Dismiss</button>
          </div>`;
      } else if (item.type === 'notification') {
        const notifUrl = item.url || '#';
        actionsHtml = `
          <div class="rq-actions">
            ${item.url ? `<a class="btn btn-approve rq-action-btn" href="${esc(notifUrl)}" target="_blank" onclick="event.stopPropagation(); window._rqAction('seen', '${esc(item.id)}')">🔗 Open</a>` : ''}
            <button class="btn rq-action-btn" data-action="dismiss" onclick="event.stopPropagation(); window._rqAction('dismiss', '${esc(item.id)}')">✕ Dismiss</button>
          </div>`;
      }

      html += `
        <div class="${classes}" data-index="${i}" data-id="${item.id}" onclick="window._rqSelect(${i})" style="border-left-color: ${stripeColor}">
          <div class="rq-item-header">
            <span class="rq-item-priority" title="Priority: ${item.priority}">${priorityIcon(item.priorityLabel)}</span>
            <span class="rq-item-type">${typeIcon(item.type)}</span>
            <span class="rq-item-title">${esc(item.title)}</span>
            ${!isSeen ? '<span class="rq-new-dot">●</span>' : ''}
          </div>
          <div class="rq-item-meta">
            <span class="rq-item-source">@${esc(item.source)}</span>
            ${tagsHtml}
            <span class="rq-item-age" title="${item.waitingSince}">⏱ ${timeAgo(item.waitingSince)} waiting</span>
          </div>
          ${summaryText ? `<div class="${summaryClass}">${esc(summaryText)}</div>` : ''}
          ${artifactsHtml}
          ${actionsHtml}
        </div>`;
    }

    el.innerHTML = html;

    // Scroll selected into view
    if (selectedIndex >= 0) {
      const selectedEl = el.querySelector('.rq-selected');
      if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ─── Actions ───

  async function handleAction(action, itemId) {
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    if (action === 'seen') {
      markSeen(itemId);
      render();
      return;
    }

    if (action === 'dismiss') {
      markSeen(itemId);
      if (item.type === 'notification') {
        const notifId = item.raw?.id;
        if (notifId) {
          await fetch(`${API}/notifications/${notifId}/dismiss`, { method: 'POST' }).catch(() => {});
        }
      }
      // Remove from local list
      items = items.filter(i => i.id !== itemId);
      applyFilters();
      render();
      return;
    }

    if (action === 'approve' && item.type === 'task') {
      const taskId = item.raw?.id;
      if (!taskId) return;
      showModal('Approve — optional comment', async (text) => {
        await fetch(`${API}/review/${taskId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvedBy: 'noah', note: text }),
        });
        markSeen(itemId);
        await fetchQueue();
      });
      return;
    }

    if (action === 'feedback' && item.type === 'task') {
      const taskId = item.raw?.id;
      if (!taskId) return;
      showModal('Leave feedback', async (text) => {
        if (!text) return;
        await fetch(`${API}/board/tasks/${taskId}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ author: 'noah', content: text, type: 'update' }),
        });
        markSeen(itemId);
        await fetchQueue();
      });
      return;
    }

    if (action === 'reject' && item.type === 'task') {
      const taskId = item.raw?.id;
      if (!taskId) return;
      showModal('Send back — describe what needs to change', async (text) => {
        if (!text) return;
        await fetch(`${API}/review/${taskId}/changes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestedBy: 'noah', note: text }),
        });
        markSeen(itemId);
        await fetchQueue();
      });
      return;
    }
  }

  // ─── Modal ───

  let modalCallback = null;

  function showModal(title, onSubmit) {
    const overlay = document.getElementById('rq-modal');
    const titleEl = document.getElementById('rq-modal-title');
    const textEl = document.getElementById('rq-modal-text');
    if (!overlay || !titleEl || !textEl) return;

    titleEl.textContent = title;
    textEl.value = '';
    overlay.style.display = 'flex';
    textEl.focus();
    modalCallback = onSubmit;
  }

  function hideModal() {
    const overlay = document.getElementById('rq-modal');
    if (overlay) overlay.style.display = 'none';
    modalCallback = null;
  }

  function submitModal() {
    const textEl = document.getElementById('rq-modal-text');
    const text = textEl?.value?.trim() || '';
    if (modalCallback) {
      modalCallback(text);
    }
    hideModal();
  }

  // ─── Selection / keyboard ───

  function select(index) {
    if (index < 0) index = 0;
    if (index >= filteredItems.length) index = filteredItems.length - 1;
    selectedIndex = index;

    // Mark as seen when selected
    if (filteredItems[index]) {
      markSeen(filteredItems[index].id);
    }

    render();
  }

  function toggleExpand() {
    // already handled by selection — clicking toggles
    const el = document.querySelector('.rq-selected');
    if (el) el.classList.toggle('rq-expanded');
  }

  function openArtifact() {
    const item = filteredItems[selectedIndex];
    if (!item) return;
    if (item.type === 'report' && item.raw?.id) {
      window.open(`/ui/report/${item.raw.id}`, '_blank');
      markSeen(item.id);
    } else if (item.url) {
      window.open(item.url, '_blank');
    } else if (item.artifacts?.length > 0) {
      const a = item.artifacts[0];
      const url = a.type === 'report' ? `/ui/report/${a.url}` : a.url;
      window.open(url, '_blank');
    }
  }

  // ─── Keyboard handler ───

  function handleKeyboard(e) {
    if (!isActive) return;

    // Don't intercept if in an input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      if (e.key === 'Escape') {
        e.target.blur();
        hideModal();
      }
      if (e.key === 'Enter' && e.target.id === 'rq-modal-text' && (e.metaKey || e.ctrlKey)) {
        submitModal();
      }
      return;
    }

    // Modal open — escape closes
    const modal = document.getElementById('rq-modal');
    const helpModal = document.getElementById('rq-help');
    if (modal?.style.display === 'flex') {
      if (e.key === 'Escape') hideModal();
      return;
    }
    if (helpModal?.style.display === 'flex') {
      if (e.key === 'Escape' || e.key === '?') helpModal.style.display = 'none';
      return;
    }

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        select(selectedIndex + 1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        select(selectedIndex - 1);
        break;
      case 'Enter':
      case 'o':
        if (selectedIndex >= 0) toggleExpand();
        break;
      case 'a':
        if (selectedIndex >= 0 && filteredItems[selectedIndex]?.type === 'task') {
          handleAction('approve', filteredItems[selectedIndex].id);
        }
        break;
      case 'f':
        if (selectedIndex >= 0 && filteredItems[selectedIndex]?.type === 'task') {
          handleAction('feedback', filteredItems[selectedIndex].id);
        }
        break;
      case 'r':
        if (selectedIndex >= 0 && filteredItems[selectedIndex]?.type === 'task') {
          handleAction('reject', filteredItems[selectedIndex].id);
        }
        break;
      case 'd':
        if (selectedIndex >= 0) {
          handleAction('dismiss', filteredItems[selectedIndex].id);
        }
        break;
      case 'v':
        if (selectedIndex >= 0) openArtifact();
        break;
      case '?':
        const help = document.getElementById('rq-help');
        if (help) help.style.display = help.style.display === 'flex' ? 'none' : 'flex';
        break;
      case 'Escape':
        selectedIndex = -1;
        render();
        break;
    }
  }

  // ─── Init / Destroy lifecycle ───

  function init() {
    if (isActive) return;
    isActive = true;
    fetchQueue();
    refreshTimer = setInterval(fetchQueue, REFRESH_INTERVAL);

    // Wire up filter controls
    const typeFilter = document.getElementById('rq-type-filter');
    const priorityFilter = document.getElementById('rq-priority-filter');
    const sourceFilter = document.getElementById('rq-source-filter');

    if (typeFilter) typeFilter.onchange = () => { applyFilters(); render(); };
    if (priorityFilter) priorityFilter.onchange = () => { applyFilters(); render(); };
    if (sourceFilter) sourceFilter.oninput = () => {
      clearTimeout(sourceFilter._debounce);
      sourceFilter._debounce = setTimeout(() => { applyFilters(); render(); }, 300);
    };

    // Wire up modal
    const cancelBtn = document.getElementById('rq-modal-cancel');
    const submitBtn = document.getElementById('rq-modal-submit');
    if (cancelBtn) cancelBtn.onclick = hideModal;
    if (submitBtn) submitBtn.onclick = submitModal;

    // Wire up mark all seen
    const markAllBtn = document.getElementById('rq-mark-all-seen');
    if (markAllBtn) markAllBtn.onclick = markAllSeen;

    // Keyboard
    document.addEventListener('keydown', handleKeyboard);
  }

  function destroy() {
    isActive = false;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    document.removeEventListener('keydown', handleKeyboard);
  }

  // ─── Background badge polling (runs even when tab not active) ───
  // Poll every 60s to keep the badge count fresh
  async function pollBadge() {
    if (isActive) return; // already refreshing more frequently
    try {
      const res = await fetch(`${API}/review/unified`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      updateBadge(data.stats);
    } catch {}
  }

  setInterval(pollBadge, 60000);
  // Initial badge fetch on page load
  setTimeout(pollBadge, 2000);

  // ─── Expose ───
  window._rqInit = init;
  window._rqDestroy = destroy;
  window._rqSelect = function(i) { select(i); };
  window._rqAction = function(action, id) { handleAction(action, id); };
})();
