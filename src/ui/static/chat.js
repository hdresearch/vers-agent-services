// ═══════════════════════════════════════════════════════════════════
// Fleet Chat v2 — Robust SSE, dedup, auth, lazy load, agent colors
// Posts to work log, streams feed, commands: /task /board /reports /status /help
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API = '/ui/api';
  const messagesEl = () => document.getElementById('chat-messages');
  const inputEl = () => document.getElementById('chat-input');

  let initialized = false;
  let autoScroll = true;
  let refreshTimer = null;
  let sseSource = null;
  let sseRetryCount = 0;
  let sseRetryTimer = null;
  let historyLoaded = false;

  // ─── Dedup: content-based, bounded ───
  const seenHashes = new Set();
  const MAX_SEEN = 2000;

  function hashMsg(str) {
    // djb2 hash — fast, good enough for dedup
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function dedupKey(type, agent, text, ts) {
    return hashMsg(`${type}|${agent || ''}|${(text || '').slice(0, 120)}|${ts || ''}`);
  }

  function markSeen(key) {
    if (seenHashes.size > MAX_SEEN) {
      // Evict oldest half (Sets iterate in insertion order)
      const arr = [...seenHashes];
      for (let i = 0; i < arr.length / 2; i++) seenHashes.delete(arr[i]);
    }
    seenHashes.add(key);
  }

  // ─── Noise filter ───
  const NOISE_TYPES = new Set([
    'token_update', 'cost_update', 'heartbeat', 'ping',
    'agent_heartbeat', 'registry_heartbeat',
  ]);

  function isNoise(evt) {
    if (NOISE_TYPES.has(evt.type)) return true;
    if (!evt.summary && !evt.detail && !evt.text) return true;
    return false;
  }

  // ─── Agent identity: deterministic color per name ───
  const AGENT_COLORS = [
    '#4f9', '#5af', '#a7f', '#f93', '#fd0', '#f55',
    '#9cf', '#fc6', '#c9f', '#6fc', '#f6c', '#cf6',
  ];
  const agentColorCache = {};

  function agentColor(name) {
    if (!name) return '#666';
    const n = name.toLowerCase();
    if (n === 'you' || n === 'noah') return '#4f9';
    if (agentColorCache[n]) return agentColorCache[n];
    let h = 0;
    for (let i = 0; i < n.length; i++) h = ((h << 5) - h + n.charCodeAt(i)) | 0;
    agentColorCache[n] = AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
    return agentColorCache[n];
  }

  // ─── Time formatting ───
  function timeAgo(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'now';
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
    return `${Math.floor(ms / 86400000)}d`;
  }

  function shortTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return timeAgo(iso); }
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ─── Safe fetch with auth expiry → redirect ───
  async function safeFetch(url, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeout || 8000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        appendSystem('⚠ Session expired — redirecting to login…');
        setTimeout(() => { window.location.href = '/ui/login'; }, 1500);
        throw new Error('Session expired');
      }
      if (res.redirected && res.url.includes('/login')) {
        appendSystem('⚠ Session expired — redirecting to login…');
        setTimeout(() => { window.location.href = '/ui/login'; }, 1500);
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        // Could be HTML login page
        if (ct.includes('text/html')) {
          appendSystem('⚠ Session expired — redirecting to login…');
          setTimeout(() => { window.location.href = '/ui/login'; }, 1500);
          throw new Error('Session expired');
        }
        throw new Error('Unexpected response type');
      }
      return res.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw e;
    }
  }

  // ─── Render a message bubble ───
  function renderMsg(opts) {
    const div = document.createElement('div');
    div.className = `chat-msg ${opts.cssClass || 'feed'}`;

    const color = agentColor(opts.agent);
    const header = (opts.agent || opts.time) ? `<div class="chat-msg-header">
      <span class="chat-msg-agent" style="color:${color}">${esc(opts.agent || '')}</span>
      <span class="chat-msg-time">${opts.time ? shortTime(opts.time) : ''}</span>
    </div>` : '';

    const typeTag = opts.typeLabel
      ? `<span class="chat-msg-type">${esc(opts.typeLabel)}</span>`
      : '';

    div.innerHTML = `${header}<div class="chat-msg-body">${typeTag}${esc(opts.body)}</div>`;
    return div;
  }

  // ─── Quick helpers ───
  function appendSystem(text) {
    const el = messagesEl();
    if (!el) return;
    checkAutoScroll();
    el.appendChild(renderMsg({ body: text, cssClass: 'system' }));
    maybeScroll();
  }

  function appendSelf(text) {
    const el = messagesEl();
    if (!el) return;
    checkAutoScroll();
    el.appendChild(renderMsg({
      agent: 'noah', body: text,
      time: new Date().toISOString(), cssClass: 'self',
    }));
    maybeScroll();
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

  // ─── Load history: last 6h, lazy (non-blocking) ───
  async function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;

    const el = messagesEl();
    if (!el) return;

    // Show loading indicator
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'chat-msg system';
    loadingDiv.innerHTML = '<div class="chat-msg-body">Loading history…</div>';
    loadingDiv.id = 'chat-loading';
    const welcome = el.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    el.appendChild(loadingDiv);

    const items = [];

    // Load log and feed independently — one can fail without blocking the other
    const [logResult, feedResult] = await Promise.allSettled([
      safeFetch(`${API}/log?last=6h`),
      safeFetch(`${API}/feed/events?limit=50`),
    ]);

    // Process log entries
    if (logResult.status === 'fulfilled') {
      const logs = logResult.value.entries || [];
      for (const entry of logs) {
        const key = dedupKey('log', entry.agent, entry.text, entry.timestamp);
        markSeen(key);
        items.push({
          time: entry.timestamp,
          agent: entry.agent || 'unknown',
          body: entry.text || '',
          cssClass: 'feed',
          typeLabel: 'log',
        });
      }
    }

    // Process feed events (filter noise)
    if (feedResult.status === 'fulfilled') {
      const events = feedResult.value.events || [];
      for (const evt of events) {
        if (isNoise(evt)) continue;
        const key = evt.id || dedupKey(evt.type, evt.agent, evt.summary, evt.timestamp);
        markSeen(key);
        items.push({
          time: evt.timestamp,
          agent: evt.agent || 'unknown',
          body: evt.summary || evt.detail || '',
          cssClass: 'feed',
          typeLabel: evt.type,
        });
      }
    }

    // Remove loading indicator
    const loader = document.getElementById('chat-loading');
    if (loader) loader.remove();

    // Sort ascending, show last 80
    items.sort((a, b) => new Date(a.time) - new Date(b.time));
    const recent = items.slice(-80);

    if (recent.length === 0) {
      const bothFailed = logResult.status === 'rejected' && feedResult.status === 'rejected';
      if (bothFailed) {
        appendSystem('⚠ Failed to load history. Will stream new events.');
      } else {
        appendSystem('No recent activity. Send a message or use /help.');
      }
    } else {
      for (const item of recent) {
        el.appendChild(renderMsg(item));
      }
    }

    scrollToBottom();
  }

  // ─── SSE: own connection with reconnect + exponential backoff ───
  function startSSE() {
    stopSSE();

    try {
      const evtSource = new EventSource(`${API}/feed/stream`);
      sseSource = evtSource;

      // Connection timeout
      const sseTimeout = setTimeout(() => {
        if (evtSource.readyState !== EventSource.OPEN) {
          evtSource.close();
          scheduleSSERetry();
        }
      }, 12000);

      evtSource.onopen = () => {
        clearTimeout(sseTimeout);
        sseRetryCount = 0;
        updateConnDot(true);
      };

      evtSource.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          if (isNoise(evt)) return;

          const key = evt.id || dedupKey(evt.type, evt.agent, evt.summary, evt.timestamp);
          if (seenHashes.has(key)) return;
          markSeen(key);

          const el = messagesEl();
          if (!el) return;

          checkAutoScroll();
          el.appendChild(renderMsg({
            agent: evt.agent || 'unknown',
            body: evt.summary || evt.detail || '',
            time: evt.timestamp || new Date().toISOString(),
            cssClass: 'feed',
            typeLabel: evt.type,
          }));
          maybeScroll();
        } catch {}
      };

      evtSource.onerror = () => {
        clearTimeout(sseTimeout);
        updateConnDot(false);
        evtSource.close();
        sseSource = null;
        scheduleSSERetry();
      };
    } catch {
      scheduleSSERetry();
    }
  }

  function stopSSE() {
    if (sseSource) {
      try { sseSource.close(); } catch {}
      sseSource = null;
    }
    if (sseRetryTimer) {
      clearTimeout(sseRetryTimer);
      sseRetryTimer = null;
    }
  }

  function scheduleSSERetry() {
    sseRetryCount++;
    // Exponential backoff: 2s, 4s, 8s, 16s, cap at 30s
    const delay = Math.min(2000 * Math.pow(2, sseRetryCount - 1), 30000);
    sseRetryTimer = setTimeout(startSSE, delay);
  }

  function updateConnDot(connected) {
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-label');
    if (dot) {
      dot.classList.toggle('connected', connected);
      dot.classList.toggle('polling', !connected && sseRetryCount > 3);
    }
    if (label) {
      label.textContent = connected ? 'connected' : (sseRetryCount > 3 ? 'reconnecting…' : 'connecting');
    }
  }

  // ─── Also hook into app.js SSE for redundancy ───
  window._chatOnFeedEvent = function (evt) {
    if (!initialized) return;
    if (isNoise(evt)) return;
    const key = evt.id || dedupKey(evt.type, evt.agent, evt.summary, evt.timestamp);
    if (seenHashes.has(key)) return;
    markSeen(key);

    const el = messagesEl();
    if (!el) return;
    checkAutoScroll();
    el.appendChild(renderMsg({
      agent: evt.agent || 'unknown',
      body: evt.summary || evt.detail || '',
      time: evt.timestamp || new Date().toISOString(),
      cssClass: 'feed',
      typeLabel: evt.type,
    }));
    maybeScroll();
  };

  // ─── Poll for new log entries (SSE only covers feed events) ───
  async function pollNewLogs() {
    if (!initialized) return;
    try {
      const data = await safeFetch(`${API}/log?last=2m`);
      const entries = data.entries || [];
      const el = messagesEl();
      if (!el) return;

      let added = false;
      for (const entry of entries) {
        const key = dedupKey('log', entry.agent, entry.text, entry.timestamp);
        if (seenHashes.has(key)) continue;
        markSeen(key);

        // Skip own messages (rendered optimistically)
        if ((entry.agent || '').toLowerCase() === 'noah') continue;

        checkAutoScroll();
        el.appendChild(renderMsg({
          time: entry.timestamp,
          agent: entry.agent || 'unknown',
          body: entry.text || '',
          cssClass: 'feed',
          typeLabel: 'log',
        }));
        added = true;
      }
      if (added) maybeScroll();
    } catch {
      // Silent — don't spam errors on poll
    }
  }

  // ─── Commands ───

  async function handleCommand(text) {
    const el = messagesEl();
    if (!el) return true;

    // /help
    if (text === '/help') {
      appendSystem(
        'Commands:\n' +
        '  /task <title>  — create a board task\n' +
        '  /board         — board summary + top tasks\n' +
        '  /reports       — recent reports\n' +
        '  /status        — fleet status (VMs, SSE, agents)\n' +
        '  /help          — this message\n' +
        '\nAnything else posts to the work log.'
      );
      return true;
    }

    // /task <title>
    if (text.startsWith('/task ')) {
      const title = text.slice(6).trim();
      if (!title) { appendSystem('Usage: /task <title>'); return true; }

      appendSelf(`/task ${title}`);

      try {
        const data = await safeFetch(`${API}/board/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, createdBy: 'noah', tags: ['from-chat'] }),
        });
        appendSystem(`✓ Task created: ${data.id || data.title || 'ok'}`);
      } catch (e) {
        appendSystem(`✗ Failed to create task: ${e.message}`);
      }
      return true;
    }

    // /board
    if (text === '/board' || text === '/board ') {
      appendSelf('/board');
      try {
        const data = await safeFetch(`${API}/board/tasks`);
        const tasks = data.tasks || [];
        const counts = {};
        for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

        appendSystem(
          `Board: ${tasks.length} total — ` +
          `${counts.open || 0} open, ${counts.in_progress || 0} in progress, ` +
          `${counts.in_review || 0} in review, ${counts.blocked || 0} blocked, ` +
          `${counts.done || 0} done`
        );

        const top = tasks
          .filter(t => t.status !== 'done')
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, 5);

        for (const t of top) {
          checkAutoScroll();
          el.appendChild(renderMsg({
            body: `[${t.status}] ${t.title}${t.assignee ? ` → @${t.assignee}` : ''}`,
            agent: t.assignee || t.createdBy,
            cssClass: 'feed',
            typeLabel: t.status,
          }));
        }
        maybeScroll();
      } catch (e) {
        appendSystem(`✗ ${e.message}`);
      }
      return true;
    }

    // /reports
    if (text === '/reports' || text === '/reports ') {
      appendSelf('/reports');
      try {
        const data = await safeFetch(`${API}/reports`);
        const reports = (data.reports || []).slice(0, 10);
        if (reports.length === 0) {
          appendSystem('No reports found.');
        } else {
          for (const r of reports) {
            checkAutoScroll();
            el.appendChild(renderMsg({
              agent: r.author || 'unknown',
              body: r.title,
              time: r.createdAt,
              cssClass: 'feed',
              typeLabel: 'report',
            }));
          }
          maybeScroll();
        }
      } catch (e) {
        appendSystem(`✗ ${e.message}`);
      }
      return true;
    }

    // /status — fleet status
    if (text === '/status' || text === '/status ') {
      appendSelf('/status');
      const parts = [];

      // SSE status
      parts.push(`SSE: ${sseSource && sseSource.readyState === EventSource.OPEN ? '🟢 connected' : '🔴 disconnected'}`);
      parts.push(`Retries: ${sseRetryCount}`);
      parts.push(`Dedup cache: ${seenHashes.size} entries`);

      // VMs
      try {
        const vmData = await safeFetch(`${API}/registry/vms`);
        const vms = vmData.vms || [];
        parts.push(`VMs: ${vms.length} registered`);
        for (const vm of vms.slice(0, 5)) {
          const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
          const stale = staleMs > 120000 ? ' ⚠ stale' : '';
          parts.push(`  ${vm.name || vm.id} [${vm.role}] seen ${timeAgo(vm.lastSeen || vm.registeredAt)}${stale}`);
        }
      } catch {
        parts.push('VMs: failed to fetch');
      }

      // Usage — API returns { totals: { tokens, cost, sessions, vms }, byAgent }
      try {
        const usage = await safeFetch(`${API}/usage/summary?range=24h`);
        const totals = usage.totals || {};
        if (totals.cost != null) {
          parts.push(`Cost (24h): $${Number(totals.cost).toFixed(4)}`);
        }
        if (totals.tokens != null) {
          parts.push(`Tokens (24h): ${Number(totals.tokens).toLocaleString()}`);
        }
      } catch {}

      appendSystem(parts.join('\n'));
      return true;
    }

    return false; // not a command
  }

  // ─── Send message ───
  async function sendMessage() {
    const input = inputEl();
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    // Handle commands
    if (text.startsWith('/')) {
      const handled = await handleCommand(text);
      if (handled) return;
    }

    // Default: post to work log
    appendSelf(text);

    // Mark as seen so poll doesn't re-add
    const selfKey = dedupKey('log', 'noah', text, '');
    markSeen(selfKey);

    try {
      await safeFetch(`${API}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, agent: 'noah' }),
      });
    } catch (e) {
      appendSystem(`✗ Failed to post: ${e.message}`);
    }
  }

  // ─── Init: immediate, lazy history load ───
  function init() {
    if (initialized) return;
    initialized = true;

    const input = inputEl();
    const sendBtn = document.getElementById('chat-send');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      // Delay focus to avoid interfering with tab switch
      setTimeout(() => input.focus(), 200);
    }

    if (sendBtn) {
      // Use touchend for faster mobile response, with click fallback
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        sendMessage();
      });
    }

    const msgs = messagesEl();
    if (msgs) {
      msgs.addEventListener('scroll', checkAutoScroll);
    }

    // Lazy: load history without blocking UI
    loadHistory();

    // Start own SSE connection for feed events
    startSSE();

    // Poll for log entries every 12s (SSE only covers feed)
    refreshTimer = setInterval(pollNewLogs, 12000);
  }

  // ─── Cleanup when leaving tab ───
  window._chatDestroy = function () {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    // Keep SSE alive even when not on chat tab — it's cheap
    // and ensures we don't miss events
  };

  // ─── Tab activation hook ───
  window._chatInit = function () {
    if (!initialized) {
      init();
    } else {
      // Re-entering: restart poll if stopped
      if (!refreshTimer) {
        refreshTimer = setInterval(pollNewLogs, 12000);
      }
      // Reconnect SSE if dead
      if (!sseSource || sseSource.readyState === EventSource.CLOSED) {
        startSSE();
      }
      scrollToBottom();
      // Re-focus input
      setTimeout(() => {
        const input = inputEl();
        if (input) input.focus();
      }, 200);
    }
  };

  // Also init if chat tab is already visible
  if (document.querySelector('#view-chat.active')) {
    init();
  }
})();
