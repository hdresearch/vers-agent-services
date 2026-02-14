// ═══════════════════════════════════════════════════════════════════
// Fleet Chat — Mobile-friendly interface for fleet interaction
// Posts to work log, creates board tasks with /task, streams feed
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API = '/ui/api';
  const messagesEl = () => document.getElementById('chat-messages');
  const inputEl = () => document.getElementById('chat-input');

  let initialized = false;
  let autoScroll = true;
  let lastEventId = null;
  let refreshTimer = null;

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

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ─── Safe fetch that handles auth redirects ───
  async function safeFetch(url, opts) {
    const res = await fetch(url, opts);
    if (res.redirected || res.status === 302 || res.status === 401) {
      throw new Error('Session expired — reload to re-authenticate');
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    // Check content-type to avoid parsing HTML as JSON
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('Unexpected response type: ' + ct);
    }
    return res.json();
  }

  // ─── Render a message bubble ───
  function renderMsg(opts) {
    // opts: { agent, body, time, type, cssClass, typeLabel }
    const div = document.createElement('div');
    div.className = `chat-msg ${opts.cssClass || 'feed'}`;

    const header = opts.agent || opts.time ? `<div class="chat-msg-header">
      <span class="chat-msg-agent">${esc(opts.agent || '')}</span>
      <span class="chat-msg-time">${opts.time ? timeAgo(opts.time) : ''}</span>
    </div>` : '';

    const typeTag = opts.typeLabel ? `<span class="chat-msg-type">${esc(opts.typeLabel)}</span>` : '';

    div.innerHTML = `${header}<div class="chat-msg-body">${typeTag}${esc(opts.body)}</div>`;
    return div;
  }

  // ─── Scroll management ───
  function scrollToBottom() {
    const el = messagesEl();
    if (el) el.scrollTop = el.scrollHeight;
  }

  function checkAutoScroll() {
    const el = messagesEl();
    if (!el) return;
    autoScroll = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
  }

  function maybeScroll() {
    if (autoScroll) requestAnimationFrame(scrollToBottom);
  }

  // ─── Dedup tracking ───
  const seenIds = new Set();

  // ─── Load initial data ───
  async function loadHistory() {
    const el = messagesEl();
    if (!el) return;

    // Clear welcome message
    const welcome = el.querySelector('.chat-welcome');

    try {
      // Load recent log entries (use ?last=6h for reasonable volume)
      // and feed events in parallel
      const [logData, feedData] = await Promise.all([
        safeFetch(`${API}/log?last=6h`),
        safeFetch(`${API}/feed/events?limit=50`),
      ]);

      const items = [];

      // Log entries
      const logs = logData.entries || [];
      for (const entry of logs) {
        const key = 'log:' + entry.timestamp + ':' + (entry.agent || '') + ':' + (entry.text || '').slice(0, 50);
        seenIds.add(key);
        items.push({
          time: entry.timestamp,
          agent: entry.agent || 'unknown',
          body: entry.text || '',
          cssClass: 'feed',
          typeLabel: 'log',
        });
      }

      // Feed events (skip noisy types)
      const events = feedData.events || [];
      for (const evt of events) {
        if (evt.type === 'token_update' || evt.type === 'cost_update') continue;
        seenIds.add(evt.id);
        items.push({
          time: evt.timestamp,
          agent: evt.agent || 'unknown',
          body: evt.summary || evt.detail || '',
          cssClass: 'feed',
          typeLabel: evt.type,
        });
        if (!lastEventId || evt.id > lastEventId) lastEventId = evt.id;
      }

      // Sort by time ascending
      items.sort((a, b) => new Date(a.time) - new Date(b.time));

      // Remove welcome, add items
      if (welcome) welcome.remove();

      // Only show last 60
      const recent = items.slice(-60);
      if (recent.length === 0) {
        el.appendChild(renderMsg({
          body: 'No recent activity. Send a message to get started!',
          cssClass: 'system',
        }));
      } else {
        for (const item of recent) {
          el.appendChild(renderMsg(item));
        }
      }

      scrollToBottom();
    } catch (e) {
      console.error('Chat: failed to load history', e);
      if (welcome) welcome.remove();
      el.appendChild(renderMsg({
        body: `⚠ Failed to load history: ${e.message}`,
        cssClass: 'system',
      }));
    }
  }

  // ─── SSE integration ───
  // Hook into app.js SSE by exposing a global callback
  window._chatOnFeedEvent = function (evt) {
    if (!initialized) return;
    if (evt.type === 'token_update' || evt.type === 'cost_update') return;
    if (evt.id && seenIds.has(evt.id)) return;
    if (evt.id) seenIds.add(evt.id);

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

  // ─── Send message ───
  async function sendMessage() {
    const input = inputEl();
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    const el = messagesEl();
    checkAutoScroll();

    // Handle /task command
    if (text.startsWith('/task ')) {
      const title = text.slice(6).trim();
      if (!title) return;

      el.appendChild(renderMsg({
        agent: 'you',
        body: `Creating task: ${title}`,
        time: new Date().toISOString(),
        cssClass: 'self',
      }));
      maybeScroll();

      try {
        const data = await safeFetch(`${API}/board/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, createdBy: 'noah', tags: ['from-chat'] }),
        });

        el.appendChild(renderMsg({
          body: `✓ Task created: ${data.id || 'ok'}`,
          cssClass: 'system',
        }));
      } catch (e) {
        el.appendChild(renderMsg({
          body: `✗ Failed to create task: ${e.message}`,
          cssClass: 'system',
        }));
      }
      maybeScroll();
      return;
    }

    // Handle /reports command
    if (text === '/reports' || text === '/reports ') {
      el.appendChild(renderMsg({
        body: 'Loading recent reports…',
        cssClass: 'system',
      }));
      maybeScroll();

      try {
        const data = await safeFetch(`${API}/reports`);
        const reports = (data.reports || []).slice(0, 10);

        if (reports.length === 0) {
          el.appendChild(renderMsg({
            body: 'No reports found.',
            cssClass: 'system',
          }));
        } else {
          for (const r of reports) {
            el.appendChild(renderMsg({
              agent: r.author || 'unknown',
              body: r.title,
              time: r.createdAt,
              cssClass: 'feed',
              typeLabel: 'report',
            }));
          }
        }
      } catch (e) {
        el.appendChild(renderMsg({
          body: `✗ Failed to load reports: ${e.message}`,
          cssClass: 'system',
        }));
      }
      maybeScroll();
      return;
    }

    // Handle /board command
    if (text === '/board' || text === '/board ') {
      el.appendChild(renderMsg({
        body: 'Loading board summary…',
        cssClass: 'system',
      }));
      maybeScroll();

      try {
        const data = await safeFetch(`${API}/board/tasks`);
        const tasks = data.tasks || [];
        const open = tasks.filter(t => t.status === 'open').length;
        const inProg = tasks.filter(t => t.status === 'in_progress').length;
        const review = tasks.filter(t => t.status === 'in_review').length;
        const blocked = tasks.filter(t => t.status === 'blocked').length;
        const done = tasks.filter(t => t.status === 'done').length;

        el.appendChild(renderMsg({
          body: `Board: ${tasks.length} total — ${open} open, ${inProg} in progress, ${review} in review, ${blocked} blocked, ${done} done`,
          cssClass: 'system',
        }));

        // Show top 5 non-done tasks by score
        const topOpen = tasks
          .filter(t => t.status !== 'done')
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, 5);
        for (const t of topOpen) {
          el.appendChild(renderMsg({
            body: `[${t.status}] ${t.title}`,
            cssClass: 'feed',
            typeLabel: t.status,
          }));
        }
      } catch (e) {
        el.appendChild(renderMsg({
          body: `✗ Failed: ${e.message}`,
          cssClass: 'system',
        }));
      }
      maybeScroll();
      return;
    }

    // Handle /help command
    if (text === '/help') {
      el.appendChild(renderMsg({
        body: 'Commands:\n/task <title> — create a board task\n/board — show board summary\n/reports — show recent reports\n/help — this message\n\nAnything else posts to the work log.',
        cssClass: 'system',
      }));
      maybeScroll();
      return;
    }

    // Default: post to work log
    el.appendChild(renderMsg({
      agent: 'noah',
      body: text,
      time: new Date().toISOString(),
      cssClass: 'self',
    }));
    maybeScroll();

    try {
      await safeFetch(`${API}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, agent: 'noah' }),
      });
    } catch (e) {
      el.appendChild(renderMsg({
        body: `✗ Failed to post: ${e.message}`,
        cssClass: 'system',
      }));
      maybeScroll();
    }
  }

  // ─── Periodic refresh for new log entries ───
  async function pollNewEntries() {
    if (!initialized) return;
    try {
      const data = await safeFetch(`${API}/log?last=2m`);
      const entries = data.entries || [];
      const el = messagesEl();
      if (!el) return;

      let added = false;
      for (const entry of entries) {
        const key = 'log:' + entry.timestamp + ':' + (entry.agent || '') + ':' + (entry.text || '').slice(0, 50);
        if (seenIds.has(key)) continue;
        seenIds.add(key);

        // Don't show our own messages (already rendered optimistically)
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
    } catch (e) {
      // Silent — don't spam errors on poll
    }
  }

  // ─── Init ───
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
      // Focus input on mobile for quick typing
      // (delay to avoid interfering with tab switch animation)
      setTimeout(() => input.focus(), 300);
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        sendMessage();
      });
    }

    const msgs = messagesEl();
    if (msgs) {
      msgs.addEventListener('scroll', checkAutoScroll);
    }

    loadHistory();

    // Poll for new log entries every 15s (feed events come via SSE)
    refreshTimer = setInterval(pollNewEntries, 15000);
  }

  // ─── Cleanup when leaving tab ───
  window._chatDestroy = function () {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  // ─── Tab activation hook ───
  window._chatInit = function () {
    if (!initialized) {
      init();
    } else {
      // Re-entering chat tab — restart polling
      if (!refreshTimer) {
        refreshTimer = setInterval(pollNewEntries, 15000);
      }
      // Scroll to bottom on re-entry
      scrollToBottom();
    }
  };

  // Also init if chat tab is already visible
  if (document.querySelector('#view-chat.active')) {
    init();
  }
})();
