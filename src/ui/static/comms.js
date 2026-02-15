// ─── Comms Tab: Fleet Chat + Gossip ───
(function () {
  const API = '/ui/api';
  let activeChannel = null;
  let channelSSE = null;
  let commsRefreshTimer = null;
  let activeCommsSubview = 'fleet-chat';

  // ─── Helpers (mirror app.js) ───

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

  async function fapi(path, opts = {}) {
    const timeout = opts.timeout || 8000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${API}${path}`, {
        signal: ctrl.signal,
        method: opts.method || 'GET',
        headers: opts.headers || (opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // ─── Fleet Chat: Channels ───

  async function loadChannels() {
    const el = document.getElementById('comms-channel-list');
    try {
      const data = await fapi('/fleet-chat/channels');
      const channels = data.channels || [];
      if (!channels.length) {
        el.innerHTML = '<div class="empty">No channels yet</div>';
        return;
      }
      let html = '';
      for (const ch of channels) {
        const active = activeChannel === ch.id ? ' comms-ch-active' : '';
        const statusCls = ch.status === 'active' ? 'comms-ch-ok' : 'comms-ch-dim';
        html += `<div class="comms-ch-item${active}" data-id="${esc(ch.id)}">
          <div class="comms-ch-name">${esc(ch.remoteFleet?.name || ch.id)}</div>
          <div class="comms-ch-meta">
            <span class="${statusCls}">${esc(ch.status)}</span>
            <span>${timeAgo(ch.createdAt)}</span>
          </div>
        </div>`;
      }
      el.innerHTML = html;
      el.querySelectorAll('.comms-ch-item').forEach(item => {
        item.addEventListener('click', () => selectChannel(item.dataset.id));
      });
    } catch (e) {
      el.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
    }
  }

  function selectChannel(id) {
    activeChannel = id;
    document.querySelectorAll('.comms-ch-item').forEach(el => {
      el.classList.toggle('comms-ch-active', el.dataset.id === id);
    });
    document.getElementById('comms-compose').style.display = 'flex';
    loadMessages(id);
    startChannelSSE(id);
  }

  // ─── Fleet Chat: Messages ───

  async function loadMessages(channelId) {
    const el = document.getElementById('comms-messages');
    const header = document.getElementById('comms-thread-header');
    try {
      const data = await fapi(`/fleet-chat/channels/${channelId}/messages?limit=100`);
      const msgs = data.messages || [];

      // Update header
      try {
        const ch = await fapi(`/fleet-chat/channels/${channelId}`);
        header.innerHTML = `<span class="comms-thread-title">${esc(ch.remoteFleet?.name || channelId)}</span>
          <span class="comms-thread-meta">${esc(ch.status)} · ${msgs.length} messages</span>`;
      } catch {
        header.innerHTML = `<span class="comms-thread-title">${esc(channelId)}</span>`;
      }

      renderMessages(el, msgs);
    } catch (e) {
      el.innerHTML = `<div class="empty">Error loading messages: ${esc(e.message)}</div>`;
    }
  }

  function renderMessages(el, msgs) {
    if (!msgs.length) {
      el.innerHTML = '<div class="comms-empty-state"><div>No messages in this channel yet</div></div>';
      return;
    }
    let html = '';
    for (const m of msgs) {
      const dir = m.direction === 'outbound' ? 'comms-msg-out' : 'comms-msg-in';
      const fromName = m.from?.name || m.from || 'unknown';
      html += `<div class="comms-msg ${dir}">
        <div class="comms-msg-header">
          <span class="comms-msg-from">${esc(fromName)}</span>
          <span class="comms-msg-type">${esc(m.type)}</span>
          <span class="comms-msg-time">${timeAgo(m.timestamp)}</span>
        </div>
        <div class="comms-msg-body">${esc(m.content)}</div>
      </div>`;
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

  function appendMessage(msg) {
    const el = document.getElementById('comms-messages');
    // Remove empty state if present
    const empty = el.querySelector('.comms-empty-state');
    if (empty) empty.remove();

    const dir = msg.direction === 'outbound' ? 'comms-msg-out' : 'comms-msg-in';
    const fromName = msg.from?.name || msg.from || 'unknown';
    const div = document.createElement('div');
    div.className = `comms-msg ${dir}`;
    div.innerHTML = `<div class="comms-msg-header">
      <span class="comms-msg-from">${esc(fromName)}</span>
      <span class="comms-msg-type">${esc(msg.type)}</span>
      <span class="comms-msg-time">just now</span>
    </div>
    <div class="comms-msg-body">${esc(msg.content)}</div>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ─── Fleet Chat: SSE ───

  function startChannelSSE(channelId) {
    stopChannelSSE();
    try {
      channelSSE = new EventSource(`${API}/fleet-chat/inbox/stream`);
      channelSSE.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.channelId === channelId) {
            appendMessage(msg);
          }
          // Refresh quarantine badge in case of new quarantined items
          loadQuarantine();
        } catch {}
      });
      channelSSE.onerror = () => {
        // Will auto-reconnect via EventSource
      };
    } catch {}
  }

  function stopChannelSSE() {
    if (channelSSE) {
      try { channelSSE.close(); } catch {}
      channelSSE = null;
    }
  }

  // ─── Fleet Chat: Send message ───

  async function sendFleetMessage() {
    if (!activeChannel) return;
    const input = document.getElementById('comms-msg-input');
    const typeEl = document.getElementById('comms-msg-type');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    try {
      await fapi(`/fleet-chat/channels/${activeChannel}/messages`, {
        method: 'POST',
        body: { content, type: typeEl.value },
      });
      // SSE or manual reload will show it
      loadMessages(activeChannel);
    } catch (e) {
      input.value = content;
      console.error('Send failed:', e);
    }
  }

  // ─── Fleet Chat: Quarantine ───

  async function loadQuarantine() {
    const el = document.getElementById('comms-quarantine-list');
    const badge = document.getElementById('comms-quarantine-count');
    try {
      const data = await fapi('/fleet-chat/quarantine');
      const items = data.quarantine || [];
      badge.textContent = items.length;
      badge.style.display = items.length ? 'inline' : 'none';
      if (!items.length) {
        el.innerHTML = '<div class="empty" style="padding:6px 8px;font-size:11px">Clean</div>';
        return;
      }
      let html = '';
      for (const q of items) {
        const from = q.rawMessage?.from?.name || 'unknown';
        html += `<div class="comms-q-item" data-id="${esc(q.id)}">
          <div class="comms-q-from">${esc(from)}</div>
          <div class="comms-q-reason">${esc(q.reason)}</div>
          <div class="comms-q-preview">${esc((q.rawMessage?.content || '').slice(0, 80))}</div>
          <div class="comms-q-actions">
            <button class="comms-q-approve" data-id="${esc(q.id)}">✓</button>
            <button class="comms-q-reject" data-id="${esc(q.id)}">✗</button>
          </div>
        </div>`;
      }
      el.innerHTML = html;
      el.querySelectorAll('.comms-q-approve').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await fapi(`/fleet-chat/quarantine/${btn.dataset.id}/approve`, { method: 'POST' });
            loadQuarantine();
            if (activeChannel) loadMessages(activeChannel);
          } catch (e) { console.error('Approve failed:', e); }
        });
      });
      el.querySelectorAll('.comms-q-reject').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await fapi(`/fleet-chat/quarantine/${btn.dataset.id}/reject`, { method: 'POST' });
            loadQuarantine();
          } catch (e) { console.error('Reject failed:', e); }
        });
      });
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ─── Fleet Chat: Trusted Endpoints ───

  async function loadTrusted() {
    const el = document.getElementById('comms-trusted-list');
    try {
      const data = await fapi('/fleet-chat/trusted');
      const endpoints = data.endpoints || [];
      if (!endpoints.length) {
        el.innerHTML = '<div class="empty" style="padding:6px 8px;font-size:11px">None</div>';
        return;
      }
      let html = '';
      for (const ep of endpoints) {
        const endpoint = typeof ep === 'string' ? ep : (ep.endpoint || ep.url || JSON.stringify(ep));
        html += `<div class="comms-trusted-item">
          <span class="comms-trusted-url">${esc(endpoint)}</span>
        </div>`;
      }
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ─── Fleet Chat: New Channel ───

  function promptNewChannel() {
    const name = prompt('Remote fleet name:');
    if (!name) return;
    const endpoint = prompt('Remote fleet endpoint (URL):');
    if (!endpoint) return;
    fapi('/fleet-chat/channels', {
      method: 'POST',
      body: { remoteFleet: { name, endpoint } },
    }).then(() => loadChannels()).catch(e => alert('Error: ' + e.message));
  }

  // ─── Fleet Chat: Add Trusted ───

  function promptAddTrusted() {
    const endpoint = prompt('Trusted endpoint URL:');
    if (!endpoint) return;
    const name = prompt('Name (optional):') || undefined;
    fapi('/fleet-chat/trusted', {
      method: 'POST',
      body: { endpoint, name },
    }).then(() => loadTrusted()).catch(e => alert('Error: ' + e.message));
  }

  // ─── Gossip: Load Feed ───

  async function loadGossipFeed() {
    const el = document.getElementById('comms-gossip-feed');
    const to = document.getElementById('gossip-to-filter').value.trim();
    if (!to) {
      el.innerHTML = '<div class="empty">Enter an agent name above</div>';
      return;
    }
    const unread = document.getElementById('gossip-unread-only').checked;
    try {
      let path = `/gossip/messages?to=${encodeURIComponent(to)}&limit=100`;
      if (unread) path += '&unread=true';
      const data = await fapi(path);
      const msgs = data.messages || [];
      if (!msgs.length) {
        el.innerHTML = '<div class="empty">No messages</div>';
        return;
      }
      let html = '';
      for (const m of msgs) {
        const priorityCls = m.priority === 'urgent' ? 'comms-g-urgent'
          : m.priority === 'high' ? 'comms-g-high' : '';
        const readCls = m.read ? 'comms-g-read' : 'comms-g-unread';
        html += `<div class="comms-g-msg ${priorityCls} ${readCls}">
          <div class="comms-g-header">
            <span class="comms-g-from">${esc(m.from)}</span>
            <span class="comms-g-arrow">→</span>
            <span class="comms-g-to">${esc(m.to)}</span>
            <span class="comms-g-type">${esc(m.type)}</span>
            ${m.priority && m.priority !== 'normal' ? `<span class="comms-g-priority">${esc(m.priority)}</span>` : ''}
            <span class="comms-g-time">${timeAgo(m.timestamp)}</span>
          </div>
          <div class="comms-g-subject">${esc(m.subject)}</div>
          <div class="comms-g-body">${esc(m.body)}</div>
        </div>`;
      }
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
    }
  }

  // ─── Gossip: Send ───

  async function sendGossip() {
    const from = document.getElementById('gossip-from').value.trim();
    const to = document.getElementById('gossip-to').value.trim();
    const type = document.getElementById('gossip-type').value;
    const priority = document.getElementById('gossip-priority').value;
    const subject = document.getElementById('gossip-subject').value.trim();
    const body = document.getElementById('gossip-body').value.trim();
    if (!from || !to || !subject || !body) {
      alert('All fields required: from, to, subject, body');
      return;
    }
    try {
      await fapi('/gossip/messages', {
        method: 'POST',
        body: { from, to, type, priority, subject, body },
      });
      document.getElementById('gossip-subject').value = '';
      document.getElementById('gossip-body').value = '';
      loadGossipFeed();
    } catch (e) {
      alert('Send failed: ' + e.message);
    }
  }

  // ─── Sub-tab switching ───

  function switchCommsSubview(name) {
    activeCommsSubview = name;
    document.querySelectorAll('.comms-subtab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.comms-subtab[data-comms="${name}"]`)?.classList.add('active');
    document.querySelectorAll('.comms-subview').forEach(v => v.classList.remove('active'));
    document.getElementById(`comms-${name}`)?.classList.add('active');
  }

  // ─── Lifecycle ───

  function commsInit() {
    loadChannels();
    loadQuarantine();
    loadTrusted();
    if (activeCommsSubview === 'gossip') loadGossipFeed();
    commsRefreshTimer = setInterval(() => {
      if (activeCommsSubview === 'fleet-chat') {
        loadChannels();
        loadQuarantine();
        loadTrusted();
        if (activeChannel) loadMessages(activeChannel);
      } else {
        loadGossipFeed();
      }
    }, 30000);
  }

  function commsDestroy() {
    stopChannelSSE();
    if (commsRefreshTimer) {
      clearInterval(commsRefreshTimer);
      commsRefreshTimer = null;
    }
  }

  // ─── Wire up DOM ───

  document.addEventListener('DOMContentLoaded', () => {
    // Sub-tabs
    document.querySelectorAll('.comms-subtab').forEach(tab => {
      tab.addEventListener('click', () => {
        switchCommsSubview(tab.dataset.comms);
        if (tab.dataset.comms === 'gossip') loadGossipFeed();
      });
    });

    // Fleet chat send
    document.getElementById('comms-send-btn')?.addEventListener('click', sendFleetMessage);
    document.getElementById('comms-msg-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendFleetMessage();
    });

    // New channel / add trusted
    document.getElementById('comms-new-channel')?.addEventListener('click', promptNewChannel);
    document.getElementById('comms-add-trusted')?.addEventListener('click', promptAddTrusted);

    // Gossip
    document.getElementById('gossip-send-btn')?.addEventListener('click', sendGossip);
    document.getElementById('gossip-body')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendGossip();
    });
    document.getElementById('gossip-refresh-btn')?.addEventListener('click', loadGossipFeed);
    document.getElementById('gossip-to-filter')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadGossipFeed();
    });
  });

  // Expose lifecycle for app.js
  window._commsInit = commsInit;
  window._commsDestroy = commsDestroy;
})();
