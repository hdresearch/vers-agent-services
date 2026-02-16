// ─── Micro-UI Panel Framework ───
// Each panel is an independent Web Component with its own:
// - Fetch lifecycle (timeout, retry, abort)
// - Error boundary (panel fails alone, others keep working)
// - Loading skeleton
// - Configurable refresh interval
// - Collapse/expand with localStorage persistence

const API = '/ui/api';

// ─── Base Panel ───────────────────────────────────────────────

class MicroPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._loading = false;
    this._error = null;
    this._data = null;
    this._refreshTimer = null;
    this._abortController = null;
    this._retryCount = 0;
    this._maxRetries = 3;
    this._collapsed = false;
  }

  // Subclasses override these
  get panelTitle() { return 'Panel'; }
  get panelIcon() { return '▸'; }
  get refreshInterval() {
    return parseInt(this.getAttribute('data-refresh-interval') || '30000');
  }
  get fetchTimeout() { return 5000; }
  get endpoint() { return null; } // subclass returns API path

  async fetchData() {
    // Subclass can override for custom fetch logic
    if (!this.endpoint) return null;
    return this._guardedFetch(this.endpoint);
  }

  renderContent(data) {
    // Subclass overrides to return HTML string
    return '<div class="mp-empty">No data</div>';
  }

  connectedCallback() {
    this._collapsed = localStorage.getItem(`mp-collapsed-${this.panelTitle}`) === 'true';
    this._render();
    this._load();
    this._startRefresh();
  }

  disconnectedCallback() {
    this._stopRefresh();
    this._abort();
  }

  // ─── Guarded fetch with timeout + abort ───

  async _guardedFetch(path, opts = {}) {
    this._abort();
    this._abortController = new AbortController();
    const timeout = opts.timeout || this.fetchTimeout;
    const timer = setTimeout(() => this._abortController.abort(), timeout);

    try {
      const res = await fetch(`${API}${path}`, {
        signal: this._abortController.signal,
        ...opts,
      });
      clearTimeout(timer);
      if (res.status === 401) {
        window.location.href = '/ui/login';
        throw new Error('Session expired');
      }
      if (res.status === 304) return this._data; // ETag cache hit
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Timeout (${timeout}ms)`);
      throw e;
    }
  }

  _abort() {
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
      this._abortController = null;
    }
  }

  // ─── Load with retry + backoff ───

  async _load() {
    this._loading = true;
    this._error = null;
    this._updateState();

    try {
      this._data = await this.fetchData();
      this._retryCount = 0;
      this._loading = false;
      this._updateContent();
    } catch (e) {
      this._loading = false;
      this._error = e.message;
      this._retryCount++;
      this._updateState();

      // Auto-retry with backoff
      if (this._retryCount <= this._maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, this._retryCount - 1), 10000);
        setTimeout(() => this._load(), delay);
      }
    }
  }

  // ─── Refresh timer ───

  _startRefresh() {
    this._stopRefresh();
    const interval = this.refreshInterval;
    if (interval > 0) {
      this._refreshTimer = setInterval(() => {
        if (!this._collapsed && document.visibilityState !== 'hidden') {
          this._load();
        }
      }, interval);
    }
  }

  _stopRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // ─── Collapse/expand ───

  _toggleCollapse() {
    this._collapsed = !this._collapsed;
    localStorage.setItem(`mp-collapsed-${this.panelTitle}`, this._collapsed);
    this._render();
    if (!this._collapsed && !this._data) this._load();
    else this._updateContent();
  }

  // ─── Manual refresh ───

  _refresh() {
    this._retryCount = 0;
    this._load();
    const btn = this.shadowRoot.querySelector('.mp-refresh');
    if (btn) {
      btn.classList.add('spinning');
      setTimeout(() => btn.classList.remove('spinning'), 600);
    }
  }

  // ─── Render shell ───

  _render() {
    const collapsed = this._collapsed;
    this.shadowRoot.innerHTML = `
      <style>${MicroPanel.baseStyles}</style>
      <div class="mp-panel ${this._error ? 'mp-error-border' : ''} ${collapsed ? 'mp-collapsed' : ''}">
        <div class="mp-header" id="mp-header">
          <span class="mp-icon">${this.panelIcon}</span>
          <span class="mp-title">${this.panelTitle}</span>
          <span class="mp-spacer"></span>
          <span class="mp-status" id="mp-status"></span>
          <button class="mp-refresh" title="Refresh">↻</button>
          <button class="mp-collapse" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="mp-body" id="mp-body" style="${collapsed ? 'display:none' : ''}">
          <div class="mp-loading" id="mp-loading" style="display:none">
            <span class="mp-spinner">⟳</span> Loading…
          </div>
          <div class="mp-error" id="mp-error" style="display:none"></div>
          <div class="mp-content" id="mp-content"></div>
        </div>
      </div>
    `;

    this.shadowRoot.querySelector('.mp-refresh').addEventListener('click', (e) => {
      e.stopPropagation();
      this._refresh();
    });
    this.shadowRoot.querySelector('.mp-collapse').addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleCollapse();
    });

    this._updateState();
    if (!collapsed) this._updateContent();
  }

  // ─── Update loading/error state ───

  _updateState() {
    const loadingEl = this.shadowRoot?.querySelector('#mp-loading');
    const errorEl = this.shadowRoot?.querySelector('#mp-error');
    const contentEl = this.shadowRoot?.querySelector('#mp-content');
    const panel = this.shadowRoot?.querySelector('.mp-panel');
    const statusEl = this.shadowRoot?.querySelector('#mp-status');

    if (!loadingEl) return;

    if (this._loading && !this._data) {
      loadingEl.style.display = '';
      errorEl.style.display = 'none';
      contentEl.style.display = 'none';
    } else if (this._error && !this._data) {
      loadingEl.style.display = 'none';
      errorEl.style.display = '';
      errorEl.innerHTML = `<span class="mp-error-icon">⚠</span> ${this._esc(this._error)}`;
      contentEl.style.display = 'none';
      panel?.classList.add('mp-error-border');
    } else {
      loadingEl.style.display = 'none';
      errorEl.style.display = 'none';
      contentEl.style.display = '';
      panel?.classList.remove('mp-error-border');
    }

    // Inline status indicator
    if (statusEl) {
      if (this._loading) statusEl.textContent = '⟳';
      else if (this._error && this._data) statusEl.textContent = '⚠';
      else statusEl.textContent = '';
    }
  }

  // ─── Update content ───

  _updateContent() {
    const contentEl = this.shadowRoot?.querySelector('#mp-content');
    if (!contentEl || this._collapsed) return;
    if (this._data !== null && this._data !== undefined) {
      contentEl.innerHTML = this.renderContent(this._data);
      this._updateState();
      this.afterRender?.();
    }
  }

  _esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  _timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  // ─── Base styles (shared across all panels) ───

  static get baseStyles() {
    return `
      :host { display: block; }
      * { box-sizing: border-box; }

      .mp-panel {
        background: #1a1a2e;
        border: 1px solid #2a2a4a;
        border-radius: 8px;
        overflow: hidden;
        transition: border-color 0.3s;
      }
      .mp-panel.mp-error-border {
        border-color: #f55;
        box-shadow: 0 0 8px rgba(255,85,85,0.15);
      }
      .mp-panel.mp-collapsed {
        border-color: #222244;
      }

      .mp-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: #16162a;
        border-bottom: 1px solid #2a2a4a;
        cursor: default;
        user-select: none;
      }
      .mp-icon { color: #00ffd5; font-size: 14px; }
      .mp-title {
        color: #e0e0e0;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .mp-spacer { flex: 1; }
      .mp-status {
        font-size: 12px;
        color: #888;
        animation: mp-pulse 1s infinite;
      }
      @keyframes mp-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .mp-refresh, .mp-collapse {
        background: none;
        border: 1px solid transparent;
        color: #888;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 4px;
        transition: all 0.2s;
      }
      .mp-refresh:hover, .mp-collapse:hover {
        color: #00ffd5;
        border-color: #333;
        background: rgba(0,255,213,0.05);
      }
      .mp-refresh.spinning {
        animation: mp-spin 0.6s linear;
      }
      @keyframes mp-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      .mp-body {
        padding: 12px 14px;
        max-height: 500px;
        overflow-y: auto;
      }
      .mp-body::-webkit-scrollbar { width: 6px; }
      .mp-body::-webkit-scrollbar-track { background: transparent; }
      .mp-body::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

      .mp-loading {
        color: #888;
        font-size: 13px;
        padding: 20px 0;
        text-align: center;
      }
      .mp-spinner {
        display: inline-block;
        animation: mp-spin 1s linear infinite;
        margin-right: 6px;
      }

      .mp-error {
        color: #f88;
        font-size: 12px;
        padding: 16px;
        text-align: center;
        background: rgba(255,85,85,0.06);
        border-radius: 4px;
      }
      .mp-error-icon { margin-right: 6px; }

      .mp-empty {
        color: #555;
        font-size: 13px;
        text-align: center;
        padding: 20px 0;
      }

      /* Common content styles */
      .mp-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid #1e1e3a;
        font-size: 13px;
        color: #ccc;
      }
      .mp-row:last-child { border-bottom: none; }

      .mp-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 600;
      }
      .mp-badge-green { background: rgba(0,255,100,0.12); color: #4f9; }
      .mp-badge-yellow { background: rgba(255,220,0,0.12); color: #fd0; }
      .mp-badge-red { background: rgba(255,85,85,0.12); color: #f55; }
      .mp-badge-blue { background: rgba(0,150,255,0.12); color: #4af; }
      .mp-badge-purple { background: rgba(160,100,255,0.12); color: #a7f; }
      .mp-badge-dim { background: rgba(100,100,100,0.15); color: #666; }

      .mp-tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
        background: rgba(0,255,213,0.08);
        color: #00ffd5;
        margin: 0 2px;
      }

      .mp-link {
        color: #00ffd5;
        text-decoration: none;
        cursor: pointer;
      }
      .mp-link:hover { text-decoration: underline; }

      .mp-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
      }

      .mp-stat-card {
        background: #12122a;
        border-radius: 6px;
        padding: 12px;
        text-align: center;
      }
      .mp-stat-label {
        font-size: 10px;
        color: #666;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .mp-stat-val {
        font-size: 22px;
        font-weight: 700;
        color: #e0e0e0;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .mp-stat-val.green { color: #4f9; }
      .mp-stat-val.red { color: #f55; }
      .mp-stat-val.blue { color: #4af; }
      .mp-stat-val.yellow { color: #fd0; }
      .mp-stat-val.purple { color: #a7f; }

      .mp-btn {
        background: rgba(0,255,213,0.08);
        border: 1px solid rgba(0,255,213,0.2);
        color: #00ffd5;
        padding: 6px 14px;
        border-radius: 5px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      .mp-btn:hover {
        background: rgba(0,255,213,0.15);
        border-color: rgba(0,255,213,0.4);
      }
      .mp-btn.danger {
        background: rgba(255,85,85,0.08);
        border-color: rgba(255,85,85,0.2);
        color: #f55;
      }
      .mp-btn.danger:hover {
        background: rgba(255,85,85,0.15);
      }
    `;
  }
}


// ─── 1. Fleet Vitals ─────────────────────────────────────────

class FleetVitals extends MicroPanel {
  get panelTitle() { return 'Fleet Vitals'; }
  get panelIcon() { return '📊'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '10000'); }

  async fetchData() {
    const [registry, board, feed] = await Promise.allSettled([
      this._guardedFetch('/registry/vms'),
      this._guardedFetch('/board/tasks?compact=true'),
      this._guardedFetch('/feed/stats'),
    ]);

    const vms = registry.status === 'fulfilled' ? (registry.value.vms || []) : [];
    const tasks = board.status === 'fulfilled' ? (board.value.tasks || []) : [];
    const feedStats = feed.status === 'fulfilled' ? feed.value : {};

    return { vms, tasks, feedStats };
  }

  renderContent(data) {
    const { vms, tasks, feedStats } = data;
    const awake = vms.filter(v => v.status === 'active' || v.status === 'busy').length;
    const openTasks = tasks.filter(t => t.status === 'open' || t.status === 'in_progress').length;
    const blockedTasks = tasks.filter(t => t.status === 'blocked').length;
    const totalEvents = feedStats.total || 0;

    return `
      <div class="mp-grid">
        <div class="mp-stat-card">
          <div class="mp-stat-label">VMs</div>
          <div class="mp-stat-val">${vms.length}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Awake</div>
          <div class="mp-stat-val green">${awake}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Tasks Open</div>
          <div class="mp-stat-val blue">${openTasks}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Blocked</div>
          <div class="mp-stat-val red">${blockedTasks}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Events</div>
          <div class="mp-stat-val purple">${totalEvents}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Tasks Done</div>
          <div class="mp-stat-val">${tasks.filter(t => t.status === 'done').length}</div>
        </div>
      </div>
    `;
  }
}
customElements.define('fleet-vitals', FleetVitals);


// ─── 2. Agent List ───────────────────────────────────────────

class AgentList extends MicroPanel {
  get panelTitle() { return 'Agents'; }
  get panelIcon() { return '🤖'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '15000'); }
  get endpoint() { return '/registry/vms'; }

  renderContent(data) {
    const vms = data.vms || [];
    if (!vms.length) return '<div class="mp-empty">No agents registered</div>';

    const statusColor = {
      active: 'green', busy: 'yellow', idle: 'blue',
      error: 'red', hibernating: 'dim',
    };

    return vms.map(vm => {
      const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
      const stale = staleMs > 120000;
      const sc = statusColor[vm.status] || 'dim';
      return `
        <div class="mp-row" style="${stale ? 'opacity:0.5' : ''}">
          <span class="mp-badge mp-badge-${sc}">${this._esc(vm.status || '?')}</span>
          <span style="font-weight:600;color:#e0e0e0">${this._esc(vm.name || vm.id)}</span>
          <span style="color:#666;font-size:11px">${this._esc(vm.role || '')}</span>
          <span style="margin-left:auto;color:#555;font-size:11px">${this._timeAgo(vm.lastSeen || vm.registeredAt)}</span>
        </div>
      `;
    }).join('');
  }
}
customElements.define('agent-list', AgentList);


// ─── 3. Event Feed (SSE) ────────────────────────────────────

class EventFeed extends MicroPanel {
  get panelTitle() { return 'Event Feed'; }
  get panelIcon() { return '⚡'; }
  get refreshInterval() { return 0; } // SSE handles updates

  constructor() {
    super();
    this._events = [];
    this._maxEvents = 100;
    this._eventSource = null;
    this._fallbackTimer = null;
  }

  async fetchData() {
    const data = await this._guardedFetch('/feed/events?limit=50');
    const list = Array.isArray(data) ? data : (data.events || []);
    this._events = list.reverse().slice(0, this._maxEvents);
    return this._events;
  }

  connectedCallback() {
    super.connectedCallback();
    this._startSSE();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopSSE();
  }

  _startSSE() {
    this._stopSSE();
    try {
      this._eventSource = new EventSource(`${API}/feed/stream`);
      this._eventSource.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          this._events.unshift(evt);
          if (this._events.length > this._maxEvents) this._events.pop();
          this._data = this._events;
          this._updateContent();
        } catch {}
      };
      this._eventSource.onerror = () => {
        // Fall back to polling after repeated failures
        if (this._eventSource.readyState === EventSource.CLOSED) {
          this._stopSSE();
          this._startFallback();
        }
      };
    } catch {
      this._startFallback();
    }
  }

  _stopSSE() {
    if (this._eventSource) {
      try { this._eventSource.close(); } catch {}
      this._eventSource = null;
    }
    if (this._fallbackTimer) {
      clearInterval(this._fallbackTimer);
      this._fallbackTimer = null;
    }
  }

  _startFallback() {
    if (this._fallbackTimer) return;
    this._fallbackTimer = setInterval(() => this._load(), 15000);
    // Retry SSE in 60s
    setTimeout(() => {
      if (this._fallbackTimer) {
        clearInterval(this._fallbackTimer);
        this._fallbackTimer = null;
        this._startSSE();
      }
    }, 60000);
  }

  renderContent(data) {
    if (!data || !data.length) return '<div class="mp-empty">No events yet</div>';

    const typeColors = {
      task_started: 'blue', task_completed: 'green', task_failed: 'red',
      blocker_found: 'red', finding: 'yellow', agent_started: 'green',
      agent_stopped: 'dim', question: 'purple', custom: 'dim',
    };

    return data.slice(0, 30).map(evt => {
      const c = typeColors[evt.type] || 'dim';
      return `
        <div class="mp-row" style="align-items:flex-start">
          <span class="mp-badge mp-badge-${c}" style="flex-shrink:0;margin-top:2px">${this._esc(evt.type || 'log')}</span>
          <div style="min-width:0">
            <div style="font-size:12px">
              <span style="color:#00ffd5;font-weight:600">${this._esc(evt.agent)}</span>
              <span style="color:#555;margin-left:6px">${evt.timestamp ? this._timeAgo(evt.timestamp) : ''}</span>
            </div>
            <div style="color:#bbb;font-size:12px;margin-top:2px;word-break:break-word">${this._esc(evt.summary)}</div>
          </div>
        </div>
      `;
    }).join('');
  }
}
customElements.define('event-feed', EventFeed);


// ─── 4. Board Summary ───────────────────────────────────────

class BoardSummary extends MicroPanel {
  get panelTitle() { return 'Board'; }
  get panelIcon() { return '📋'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '30000'); }
  get endpoint() { return '/board/tasks?compact=true'; }

  renderContent(data) {
    const tasks = data.tasks || [];
    if (!tasks.length) return '<div class="mp-empty">No tasks</div>';

    const counts = { open: 0, in_progress: 0, blocked: 0, in_review: 0, done: 0 };
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

    const recent = tasks
      .filter(t => t.status !== 'done')
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .slice(0, 8);

    let html = `
      <div class="mp-grid" style="margin-bottom:12px">
        <div class="mp-stat-card">
          <div class="mp-stat-label">Open</div>
          <div class="mp-stat-val blue">${counts.open}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">In Progress</div>
          <div class="mp-stat-val yellow">${counts.in_progress}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Blocked</div>
          <div class="mp-stat-val red">${counts.blocked}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Review</div>
          <div class="mp-stat-val purple">${counts.in_review}</div>
        </div>
      </div>
    `;

    const statusColor = {
      open: 'blue', in_progress: 'yellow', blocked: 'red',
      in_review: 'purple', done: 'green',
    };

    html += recent.map(t => {
      const c = statusColor[t.status] || 'dim';
      const tags = (t.tags || []).map(tag => `<span class="mp-tag">${this._esc(tag)}</span>`).join('');
      return `
        <div class="mp-row" style="align-items:flex-start">
          <span class="mp-badge mp-badge-${c}" style="flex-shrink:0;margin-top:2px;font-size:10px">${this._esc(t.status.replace('_', ' '))}</span>
          <div style="min-width:0">
            <div style="color:#e0e0e0;font-size:12px;font-weight:500">${this._esc(t.title)}</div>
            <div style="margin-top:2px">
              ${t.assignee ? `<span style="color:#00ffd5;font-size:11px">@${this._esc(t.assignee)}</span>` : ''}
              ${tags}
              <span style="color:#555;font-size:11px;margin-left:4px">${this._timeAgo(t.updatedAt || t.createdAt)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    return html;
  }
}
customElements.define('board-summary', BoardSummary);


// ─── 5. Fleet Chat Panel ────────────────────────────────────

class FleetChatPanel extends MicroPanel {
  get panelTitle() { return 'Fleet Chat'; }
  get panelIcon() { return '💬'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '20000'); }
  get endpoint() { return '/chat/messages?limit=20'; }

  renderContent(data) {
    const messages = data.messages || [];
    if (!messages.length) return '<div class="mp-empty">No messages yet</div>';

    return messages.slice(-15).reverse().map(m => `
      <div class="mp-row" style="align-items:flex-start">
        <span style="color:#00ffd5;font-weight:600;font-size:12px;flex-shrink:0">${this._esc(m.from || m.author || '?')}</span>
        <div style="min-width:0;color:#bbb;font-size:12px;word-break:break-word">${this._esc(m.content || m.text || '')}</div>
        <span style="color:#555;font-size:10px;flex-shrink:0;margin-left:auto">${m.timestamp ? this._timeAgo(m.timestamp) : ''}</span>
      </div>
    `).join('');
  }
}
customElements.define('fleet-chat-panel', FleetChatPanel);


// ─── 6. KB Browser ──────────────────────────────────────────

class KbBrowser extends MicroPanel {
  get panelTitle() { return 'Knowledge Base'; }
  get panelIcon() { return '🧠'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '60000'); }

  async fetchData() {
    const [briefing, entries] = await Promise.allSettled([
      this._guardedFetch('/kb/briefing/session'),
      this._guardedFetch('/kb/entries'),
    ]);
    return {
      stats: briefing.status === 'fulfilled' ? briefing.value.stats : null,
      entries: entries.status === 'fulfilled' ? (entries.value.entries || []) : [],
    };
  }

  renderContent(data) {
    const { stats, entries } = data;
    let html = '';

    if (stats) {
      html += `
        <div class="mp-grid" style="margin-bottom:12px">
          <div class="mp-stat-card">
            <div class="mp-stat-label">Total</div>
            <div class="mp-stat-val">${stats.total || 0}</div>
          </div>
          <div class="mp-stat-card">
            <div class="mp-stat-label">Active</div>
            <div class="mp-stat-val green">${stats.active || 0}</div>
          </div>
          <div class="mp-stat-card">
            <div class="mp-stat-label">Expired</div>
            <div class="mp-stat-val red">${stats.expired || 0}</div>
          </div>
        </div>
      `;
    }

    const typeIcon = { warning: '⚠️', convention: '📐', lesson: '💡', context: '📋' };
    const recent = entries.slice(0, 10);
    if (!recent.length) {
      html += '<div class="mp-empty">No KB entries</div>';
    } else {
      html += recent.map(e => `
        <div class="mp-row" style="align-items:flex-start">
          <span style="flex-shrink:0">${typeIcon[e.type] || '📋'}</span>
          <div style="min-width:0;color:#bbb;font-size:12px;word-break:break-word">${this._esc(e.content)}</div>
        </div>
      `).join('');
    }
    return html;
  }
}
customElements.define('kb-browser', KbBrowser);


// ─── 7. Cryo List ───────────────────────────────────────────

class CryoList extends MicroPanel {
  get panelTitle() { return 'Cryochamber'; }
  get panelIcon() { return '🧊'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '30000'); }
  get endpoint() { return '/agents/cryo'; }

  renderContent(data) {
    const agents = data.agents || [];
    if (!agents.length) return '<div class="mp-empty">No agents in cryo</div>';

    const statusColor = { awake: 'green', hibernating: 'dim', retired: 'red' };

    return agents.slice(0, 15).map(a => {
      const c = statusColor[a.status] || 'dim';
      const tags = (a.tags || []).map(t => `<span class="mp-tag">${this._esc(t)}</span>`).join('');
      return `
        <div class="mp-row">
          <span class="mp-badge mp-badge-${c}">${this._esc(a.status || '?')}</span>
          <span style="font-weight:600;color:#e0e0e0">${this._esc(a.name)}</span>
          ${a.persona ? `<span style="color:#666;font-size:11px">${this._esc(a.persona)}</span>` : ''}
          ${tags}
        </div>
      `;
    }).join('');
  }
}
customElements.define('cryo-list', CryoList);


// ─── 8. Quick Actions ───────────────────────────────────────

class QuickActions extends MicroPanel {
  get panelTitle() { return 'Quick Actions'; }
  get panelIcon() { return '⚡'; }
  get refreshInterval() { return 0; } // Static panel

  async fetchData() { return {}; } // No fetch needed

  renderContent() {
    return `
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button class="mp-btn" id="qa-status">📊 Fleet Status</button>
        <button class="mp-btn" id="qa-board">📋 Board Summary</button>
        <button class="mp-btn" id="qa-snap">📸 Snapshot Infra</button>
        <button class="mp-btn" id="qa-chat">💬 Jump to Chat</button>
        <button class="mp-btn" id="qa-metrics">📈 Metrics</button>
        <button class="mp-btn danger" id="qa-reap">🗑 Reap Idle VMs</button>
      </div>
    `;
  }

  afterRender() {
    const root = this.shadowRoot;
    root.querySelector('#qa-status')?.addEventListener('click', () => {
      window.location.hash = '#fleet';
    });
    root.querySelector('#qa-board')?.addEventListener('click', () => {
      window.location.hash = '#board';
    });
    root.querySelector('#qa-chat')?.addEventListener('click', () => {
      window.location.hash = '#chat';
    });
    root.querySelector('#qa-metrics')?.addEventListener('click', () => {
      window.location.hash = '#metrics';
    });
    root.querySelector('#qa-snap')?.addEventListener('click', async () => {
      try {
        await fetch(`${API}/deploy/snapshot`, { method: 'POST' });
        alert('Snapshot triggered');
      } catch (e) {
        alert('Snapshot failed: ' + e.message);
      }
    });
    root.querySelector('#qa-reap')?.addEventListener('click', async () => {
      if (!confirm('Reap idle VMs? This will stop idle agents.')) return;
      try {
        await fetch(`${API}/registry/reap`, { method: 'POST' });
        alert('Reap triggered');
      } catch (e) {
        alert('Reap failed: ' + e.message);
      }
    });
  }
}
customElements.define('quick-actions', QuickActions);


// ─── 9. Notification Bell ───────────────────────────────────

class NotificationBell extends MicroPanel {
  get panelTitle() { return 'Notifications'; }
  get panelIcon() { return '🔔'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '10000'); }

  async fetchData() {
    // Pull from review queue + blocked tasks as notifications
    const [review, board] = await Promise.allSettled([
      this._guardedFetch('/board/review'),
      this._guardedFetch('/board/tasks?compact=true'),
    ]);

    const reviewTasks = review.status === 'fulfilled' ? (review.value.tasks || []) : [];
    const allTasks = board.status === 'fulfilled' ? (board.value.tasks || []) : [];
    const blocked = allTasks.filter(t => t.status === 'blocked');

    return { reviewTasks, blocked };
  }

  renderContent(data) {
    const { reviewTasks, blocked } = data;
    const total = reviewTasks.length + blocked.length;

    if (!total) return '<div class="mp-empty">All clear — no pending items</div>';

    let html = '';
    if (reviewTasks.length) {
      html += `<div style="margin-bottom:8px">
        <span class="mp-badge mp-badge-purple">${reviewTasks.length} pending review</span>
      </div>`;
      html += reviewTasks.slice(0, 5).map(t => `
        <div class="mp-row">
          <span style="color:#a7f">📝</span>
          <span style="color:#e0e0e0;font-size:12px">${this._esc(t.title)}</span>
          <span style="color:#555;font-size:11px;margin-left:auto">${this._timeAgo(t.updatedAt || t.createdAt)}</span>
        </div>
      `).join('');
    }

    if (blocked.length) {
      html += `<div style="margin-top:8px;margin-bottom:8px">
        <span class="mp-badge mp-badge-red">${blocked.length} blocked</span>
      </div>`;
      html += blocked.slice(0, 5).map(t => `
        <div class="mp-row">
          <span style="color:#f55">🚫</span>
          <span style="color:#e0e0e0;font-size:12px">${this._esc(t.title)}</span>
          <span style="color:#555;font-size:11px;margin-left:auto">${t.assignee ? '@' + this._esc(t.assignee) : ''}</span>
        </div>
      `).join('');
    }

    return html;
  }
}
customElements.define('notification-bell', NotificationBell);


// ─── 10. Blog Status ────────────────────────────────────────

class BlogStatus extends MicroPanel {
  get panelTitle() { return 'Blog'; }
  get panelIcon() { return '✍️'; }
  get refreshInterval() { return parseInt(this.getAttribute('data-refresh-interval') || '60000'); }
  get endpoint() { return '/docs/posts'; }

  renderContent(data) {
    const posts = data.posts || [];
    if (!posts.length) return '<div class="mp-empty">No blog posts</div>';

    const published = posts.filter(p => p.status === 'published');
    const drafts = posts.filter(p => p.status === 'draft');

    let html = `
      <div class="mp-grid" style="margin-bottom:12px">
        <div class="mp-stat-card">
          <div class="mp-stat-label">Published</div>
          <div class="mp-stat-val green">${published.length}</div>
        </div>
        <div class="mp-stat-card">
          <div class="mp-stat-label">Drafts</div>
          <div class="mp-stat-val yellow">${drafts.length}</div>
        </div>
      </div>
    `;

    html += posts.slice(0, 5).map(p => {
      const c = p.status === 'published' ? 'green' : 'yellow';
      return `
        <div class="mp-row">
          <span class="mp-badge mp-badge-${c}">${this._esc(p.status)}</span>
          <span style="color:#e0e0e0;font-size:12px">${this._esc(p.title)}</span>
          <span style="color:#555;font-size:11px;margin-left:auto">${p.createdAt ? this._timeAgo(p.createdAt) : ''}</span>
        </div>
      `;
    }).join('');

    return html;
  }
}
customElements.define('blog-status', BlogStatus);


// ─── Export for use ─────────────────────────────────────────
// All panels are registered as custom elements and ready to use in HTML.
// Just drop <fleet-vitals>, <agent-list>, etc. into any page.

window.MicroPanel = MicroPanel;
