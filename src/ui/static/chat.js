// ═══════════════════════════════════════════════════════════════════
// Orchestrator Chat — Web-based fleet command channel
// Persistent message store, agent sidebar, quick actions, markdown
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API = '/ui/api';

  // DOM refs (lazy)
  const el = (id) => document.getElementById(id);
  const messagesEl = () => el('chat-messages');
  const inputEl = () => el('chat-input');
  const sidebarEl = () => el('chat-sidebar-agents');

  let initialized = false;
  let autoScroll = true;
  let sseSource = null;
  let sseRetryCount = 0;
  let sseRetryTimer = null;
  let feedSSE = null;
  let agentRefreshTimer = null;
  let seenIds = new Set();

  // ─── Agent colors ───
  const COLORS = [
    '#4f9', '#5af', '#a7f', '#f93', '#fd0', '#f55',
    '#9cf', '#fc6', '#c9f', '#6fc', '#f6c', '#cf6',
  ];
  const colorCache = {};
  function agentColor(name) {
    if (!name) return '#666';
    const n = name.toLowerCase();
    if (n === 'noah' || n === 'you') return '#00ffd5';
    if (n === 'system') return '#666';
    if (colorCache[n]) return colorCache[n];
    let h = 0;
    for (let i = 0; i < n.length; i++) h = ((h << 5) - h + n.charCodeAt(i)) | 0;
    colorCache[n] = COLORS[Math.abs(h) % COLORS.length];
    return colorCache[n];
  }

  // ─── Escape + markdown ───
  // Delegate to shared utils (see utils.js) — single source of truth
  const esc = window._utils ? window._utils.esc : function (s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  };

  function renderMarkdown(text) {
    if (!text) return '';
    return esc(text)
      .replace(/```([\s\S]*?)```/g, '<pre class="chat-code">$1</pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/\n/g, '<br>');
  }

  function shortTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  // Delegate to shared utils
  const timeAgo = window._utils ? window._utils.timeAgo : function (iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  };

  // ─── Safe fetch ───
  async function safeFetch(url, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeout || 8000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      if (res.status === 401) {
        window.location.href = '/ui/login';
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  // ─── Scroll management ───
  function scrollToBottom() {
    const el = messagesEl();
    if (el) el.scrollTop = el.scrollHeight;
  }

  function checkAutoScroll() {
    const el = messagesEl();
    if (!el) return;
    autoScroll = (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
  }

  function maybeScroll() {
    if (autoScroll) requestAnimationFrame(scrollToBottom);
  }

  // ─── Render a message ───
  function renderMsg(msg) {
    const div = document.createElement('div');
    const roleClass = msg.role === 'system' ? 'system' : msg.role === 'agent' ? 'agent' : 'self';
    div.className = `oc-msg oc-msg-${roleClass}`;
    div.dataset.id = msg.id || '';

    const color = agentColor(msg.sender);
    const roleBadge = msg.role === 'agent' ? '<span class="oc-badge oc-badge-agent">agent</span>'
      : msg.role === 'system' ? '<span class="oc-badge oc-badge-system">sys</span>'
      : '';

    div.innerHTML = `
      <div class="oc-msg-header">
        <span class="oc-msg-sender" style="color:${color}">${esc(msg.sender || 'unknown')}</span>
        ${roleBadge}
        <span class="oc-msg-time">${shortTime(msg.timestamp)}</span>
      </div>
      <div class="oc-msg-body">${renderMarkdown(msg.content)}</div>
    `;
    return div;
  }

  function appendMsg(msg) {
    if (msg.id && seenIds.has(msg.id)) return;
    if (msg.id) seenIds.add(msg.id);
    // Cap dedup set
    if (seenIds.size > 3000) {
      const arr = [...seenIds];
      for (let i = 0; i < arr.length / 2; i++) seenIds.delete(arr[i]);
    }

    const el = messagesEl();
    if (!el) return;
    checkAutoScroll();
    el.appendChild(renderMsg(msg));
    maybeScroll();
  }

  function appendSystem(text) {
    appendMsg({ role: 'system', sender: 'system', content: text, timestamp: new Date().toISOString() });
  }

  // ─── Load message history ───
  async function loadHistory() {
    const el = messagesEl();
    if (!el) return;

    // Clear welcome
    const welcome = el.querySelector('.oc-welcome');
    if (welcome) welcome.remove();

    try {
      const data = await safeFetch(`${API}/chat/messages?limit=100`);
      const msgs = data.messages || [];
      el.innerHTML = '';

      if (msgs.length === 0) {
        el.innerHTML = `<div class="oc-welcome">
          <div class="oc-welcome-icon">▸</div>
          <div class="oc-welcome-text">Fleet Command</div>
          <div class="oc-welcome-hint">Orchestrate the fleet from here. Messages persist across sessions.<br>
          Use <code>/task</code>, <code>/status</code>, <code>/board</code>, or just type to chat.</div>
        </div>`;
      } else {
        for (const msg of msgs) {
          if (msg.id) seenIds.add(msg.id);
          el.appendChild(renderMsg(msg));
        }
      }
      scrollToBottom();
    } catch (e) {
      appendSystem(`⚠ Failed to load history: ${e.message}`);
    }
  }

  // ─── SSE for new messages ───
  function startSSE() {
    stopSSE();
    try {
      const evtSource = new EventSource(`${API}/chat/messages/stream`);
      sseSource = evtSource;

      const sseTimeout = setTimeout(() => {
        if (evtSource.readyState !== EventSource.OPEN) {
          evtSource.close();
          scheduleRetry();
        }
      }, 12000);

      evtSource.onopen = () => {
        clearTimeout(sseTimeout);
        sseRetryCount = 0;
        updateStatus(true);
      };

      evtSource.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          appendMsg(msg);
        } catch {}
      });

      evtSource.onerror = () => {
        clearTimeout(sseTimeout);
        updateStatus(false);
        evtSource.close();
        sseSource = null;
        scheduleRetry();
      };
    } catch {
      scheduleRetry();
    }
  }

  function stopSSE() {
    if (sseSource) { try { sseSource.close(); } catch {} sseSource = null; }
    if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  }

  function scheduleRetry() {
    sseRetryCount++;
    const delay = Math.min(2000 * Math.pow(2, sseRetryCount - 1), 30000);
    sseRetryTimer = setTimeout(startSSE, delay);
  }

  // Also listen to feed SSE for agent events
  function startFeedSSE() {
    if (feedSSE) return;
    try {
      const evtSource = new EventSource(`${API}/feed/stream`);
      feedSSE = evtSource;
      evtSource.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          // Inject notable feed events into chat as system messages
          if (['agent_started', 'agent_stopped', 'task_completed', 'task_failed', 'blocker_found'].includes(evt.type)) {
            appendMsg({
              id: 'feed-' + (evt.id || Date.now()),
              role: 'system',
              sender: evt.agent || 'fleet',
              content: `**[${evt.type}]** ${evt.summary || ''}`,
              timestamp: evt.timestamp || new Date().toISOString(),
            });
          }
        } catch {}
      };
      evtSource.onerror = () => {
        try { evtSource.close(); } catch {}
        feedSSE = null;
        // Retry after 30s
        setTimeout(startFeedSSE, 30000);
      };
    } catch {}
  }

  function updateStatus(connected) {
    const dot = el('oc-status-dot');
    const label = el('oc-status-label');
    if (dot) dot.className = `oc-dot ${connected ? 'oc-dot-on' : 'oc-dot-off'}`;
    if (label) label.textContent = connected ? 'live' : 'reconnecting…';
  }

  // ─── Agent sidebar ───
  async function loadAgents() {
    const sidebar = sidebarEl();
    if (!sidebar) return;

    try {
      // Load from registry + cryo in parallel
      const [regResult, cryoResult] = await Promise.allSettled([
        safeFetch(`${API}/registry/vms`),
        safeFetch(`${API}/cryo/agents`),
      ]);

      const agents = new Map(); // name → { status, role, lastSeen, source }

      // Registry VMs
      if (regResult.status === 'fulfilled') {
        const vms = regResult.value.vms || [];
        for (const vm of vms) {
          const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
          const isStale = staleMs > 300000; // 5 min
          agents.set(vm.name || vm.id, {
            name: vm.name || vm.id,
            status: isStale ? 'stale' : (vm.status || 'running'),
            role: vm.role || 'unknown',
            lastSeen: vm.lastSeen || vm.registeredAt,
            source: 'registry',
            id: vm.id,
          });
        }
      }

      // Cryo agents
      if (cryoResult.status === 'fulfilled') {
        const cryoAgents = cryoResult.value.agents || [];
        for (const a of cryoAgents) {
          if (!agents.has(a.name)) {
            agents.set(a.name, {
              name: a.name,
              status: a.status || 'hibernating',
              role: a.persona || 'agent',
              lastSeen: a.updatedAt || a.createdAt,
              source: 'cryo',
            });
          }
        }
      }

      if (agents.size === 0) {
        sidebar.innerHTML = '<div class="oc-sidebar-empty">No agents registered</div>';
        return;
      }

      // Sort: running first, then stale, then hibernating
      const order = { running: 0, awake: 0, stale: 1, paused: 2, hibernating: 3, stopped: 4, retired: 5 };
      const sorted = [...agents.values()].sort((a, b) =>
        (order[a.status] ?? 3) - (order[b.status] ?? 3)
      );

      let html = '';
      for (const a of sorted) {
        const dotColor = a.status === 'running' || a.status === 'awake' ? '#4f9'
          : a.status === 'stale' ? '#fd0'
          : a.status === 'hibernating' ? '#666'
          : a.status === 'stopped' || a.status === 'retired' ? '#f55'
          : '#888';
        html += `<div class="oc-agent" title="${esc(a.role)} — ${esc(a.status)} — seen ${timeAgo(a.lastSeen)}">
          <span class="oc-agent-dot" style="background:${dotColor}"></span>
          <span class="oc-agent-name">${esc(a.name)}</span>
          <span class="oc-agent-role">${esc(a.role)}</span>
        </div>`;
      }
      sidebar.innerHTML = html;
    } catch (e) {
      sidebar.innerHTML = `<div class="oc-sidebar-empty">Failed to load agents</div>`;
    }
  }

  // ─── Commands ───
  async function handleCommand(text) {
    if (text === '/help') {
      appendSystem(
        '**Commands:**\n' +
        '`/task <title>` — create a board task\n' +
        '`/status` — fleet status\n' +
        '`/board` — board summary\n' +
        '`/agents` — list agents\n' +
        '`/help` — this message'
      );
      return true;
    }

    if (text.startsWith('/task ')) {
      const title = text.slice(6).trim();
      if (!title) { appendSystem('Usage: `/task <title>`'); return true; }
      // Post as user message first
      await postMessage(text, 'user');
      try {
        const data = await safeFetch(`${API}/board/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, createdBy: 'noah', tags: ['from-chat'] }),
        });
        await postMessage(`✓ Task created: **${data.title || title}** (${data.id})`, 'system', 'system');
      } catch (e) {
        await postMessage(`✗ Failed: ${e.message}`, 'system', 'system');
      }
      return true;
    }

    if (text === '/status') {
      await postMessage('/status', 'user');
      const parts = [];
      try {
        const vmData = await safeFetch(`${API}/registry/vms`);
        const vms = vmData.vms || [];
        parts.push(`**VMs:** ${vms.length} registered`);
        for (const vm of vms.slice(0, 8)) {
          const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
          const stale = staleMs > 120000 ? ' ⚠' : '';
          parts.push(`  • ${vm.name || vm.id} [${vm.role}] ${vm.status}${stale}`);
        }
      } catch { parts.push('VMs: failed to fetch'); }
      try {
        const usage = await safeFetch(`${API}/usage/summary?range=24h`);
        const t = usage.totals || {};
        if (t.cost != null) parts.push(`**Cost (24h):** $${Number(t.cost).toFixed(4)}`);
        if (t.tokens != null) parts.push(`**Tokens (24h):** ${Number(t.tokens).toLocaleString()}`);
      } catch {}
      await postMessage(parts.join('\n') || 'No data available', 'system', 'system');
      return true;
    }

    if (text === '/board') {
      await postMessage('/board', 'user');
      try {
        const data = await safeFetch(`${API}/board/tasks`);
        const tasks = data.tasks || [];
        const counts = {};
        for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
        let msg = `**Board:** ${tasks.length} total — ${counts.open || 0} open, ${counts.in_progress || 0} in progress, ${counts.blocked || 0} blocked, ${counts.done || 0} done`;
        const top = tasks.filter(t => t.status !== 'done').sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
        if (top.length) {
          msg += '\n\n**Top tasks:**';
          for (const t of top) {
            msg += `\n• [${t.status}] ${t.title}${t.assignee ? ` → @${t.assignee}` : ''}`;
          }
        }
        await postMessage(msg, 'system', 'system');
      } catch (e) {
        await postMessage(`✗ ${e.message}`, 'system', 'system');
      }
      return true;
    }

    if (text === '/agents') {
      await postMessage('/agents', 'user');
      loadAgents();
      appendSystem('Agent sidebar refreshed.');
      return true;
    }

    return false;
  }

  // ─── Post message to backend ───
  async function postMessage(content, role = 'user', sender = 'noah') {
    try {
      await safeFetch(`${API}/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender, content, role }),
      });
      // SSE will deliver it back; no optimistic append needed
    } catch (e) {
      appendSystem(`✗ Failed to send: ${e.message}`);
    }
  }

  // ─── Send message ───
  async function sendMessage() {
    const input = inputEl();
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    if (text.startsWith('/')) {
      const handled = await handleCommand(text);
      if (handled) return;
    }

    await postMessage(text);
  }

  // ─── Quick actions ───
  function bindQuickActions() {
    el('oc-action-status')?.addEventListener('click', () => {
      const input = inputEl();
      if (input) { input.value = '/status'; sendMessage(); }
    });
    el('oc-action-board')?.addEventListener('click', () => {
      const input = inputEl();
      if (input) { input.value = '/board'; sendMessage(); }
    });
    el('oc-action-snapshot')?.addEventListener('click', async () => {
      await postMessage('/snapshot', 'user');
      await postMessage('Snapshot requested. Use vers commit to create a snapshot.', 'system', 'system');
    });
  }

  // ─── Init ───
  function init() {
    if (initialized) return;
    initialized = true;

    const input = inputEl();
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      setTimeout(() => input.focus(), 200);
    }

    el('chat-send')?.addEventListener('click', (e) => {
      e.preventDefault();
      sendMessage();
    });

    messagesEl()?.addEventListener('scroll', checkAutoScroll);

    bindQuickActions();
    loadHistory();
    loadAgents();
    startSSE();
    startFeedSSE();

    // Refresh agents every 30s
    agentRefreshTimer = setInterval(loadAgents, 30000);
  }

  // ─── Lifecycle hooks ───
  window._chatInit = function () {
    if (!initialized) {
      init();
    } else {
      if (!agentRefreshTimer) agentRefreshTimer = setInterval(loadAgents, 30000);
      if (!sseSource || sseSource.readyState === EventSource.CLOSED) startSSE();
      if (!feedSSE || feedSSE.readyState === EventSource.CLOSED) startFeedSSE();
      scrollToBottom();
      setTimeout(() => inputEl()?.focus(), 200);
    }
  };

  window._chatDestroy = function () {
    if (agentRefreshTimer) { clearInterval(agentRefreshTimer); agentRefreshTimer = null; }
    // Keep SSE alive — it's cheap and ensures no missed messages
  };

  // Also handle feed events from app.js SSE
  window._chatOnFeedEvent = function () {
    // No-op — we have our own feed SSE now
  };

  if (document.querySelector('#view-chat.active')) init();
})();
