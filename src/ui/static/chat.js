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

  // ─── Time formatting ───
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
    // Auto-scroll if within 100px of bottom
    autoScroll = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
  }

  function maybeScroll() {
    if (autoScroll) requestAnimationFrame(scrollToBottom);
  }

  // ─── Load initial data ───
  async function loadHistory() {
    const el = messagesEl();
    if (!el) return;

    // Clear welcome message
    const welcome = el.querySelector('.chat-welcome');

    try {
      // Load recent log entries and feed events in parallel
      const [logRes, feedRes] = await Promise.all([
        fetch(`${API}/log?limit=30`).then(r => r.json()),
        fetch(`${API}/feed/events?limit=30`).then(r => r.json()),
      ]);

      const items = [];

      // Log entries
      const logs = Array.isArray(logRes) ? logRes : (logRes.entries || []);
      for (const entry of logs) {
        items.push({
          time: entry.timestamp,
          agent: entry.agent || 'unknown',
          body: entry.text,
          cssClass: 'feed',
          typeLabel: 'log',
        });
      }

      // Feed events (skip token_update noise)
      const events = feedRes.events || [];
      for (const evt of events) {
        if (evt.type === 'token_update') continue;
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

      // Only show last 50
      const recent = items.slice(-50);
      for (const item of recent) {
        el.appendChild(renderMsg(item));
      }

      scrollToBottom();
    } catch (e) {
      console.error('Chat: failed to load history', e);
    }
  }

  // ─── SSE integration ───
  // Hook into app.js SSE by exposing a global callback
  window._chatOnFeedEvent = function (evt) {
    if (!initialized) return;
    if (evt.type === 'token_update') return;

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
        const res = await fetch(`${API}/board/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, createdBy: 'noah', tags: ['from-chat'] }),
        });
        const data = await res.json();

        el.appendChild(renderMsg({
          body: `✓ Task created: ${data.id}`,
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
    if (text === '/reports' || text.startsWith('/reports')) {
      el.appendChild(renderMsg({
        body: 'Loading recent reports…',
        cssClass: 'system',
      }));
      maybeScroll();

      try {
        const res = await fetch(`${API}/reports`);
        const data = await res.json();
        const reports = (data.reports || []).slice(0, 10);

        for (const r of reports) {
          el.appendChild(renderMsg({
            agent: r.author || 'unknown',
            body: r.title,
            time: r.createdAt,
            cssClass: 'feed',
            typeLabel: 'report',
          }));
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
    if (text === '/board' || text.startsWith('/board')) {
      el.appendChild(renderMsg({
        body: 'Loading board summary…',
        cssClass: 'system',
      }));
      maybeScroll();

      try {
        const res = await fetch(`${API}/board/tasks`);
        const data = await res.json();
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

        // Show top 5 open tasks by score
        const topOpen = tasks
          .filter(t => t.status === 'open')
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, 5);
        for (const t of topOpen) {
          el.appendChild(renderMsg({
            body: `[${t.score || 0}] ${t.title}`,
            cssClass: 'feed',
            typeLabel: 'open',
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

    // Default: post to work log
    el.appendChild(renderMsg({
      agent: 'noah',
      body: text,
      time: new Date().toISOString(),
      cssClass: 'self',
    }));
    maybeScroll();

    try {
      await fetch(`${API}/log`, {
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
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', sendMessage);
    }

    const msgs = messagesEl();
    if (msgs) {
      msgs.addEventListener('scroll', checkAutoScroll);
    }

    loadHistory();
  }

  // ─── Tab activation hook ───
  // Called by app.js when switching to chat tab
  window._chatInit = init;

  // Also init if chat tab is already visible
  if (document.querySelector('#view-chat.active')) {
    init();
  }
})();

