// ═══════════════════════════════════════════════════════════════
// Comms Tab — Fleet Chat, Quarantine, Gossip
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const TOKEN = 'fa2490f6cd1fa376b58bcb36ac66b2a0ec51b621cdb4e0e83c9a2c58342a082f';
  const BASE = '/fleet-chat';
  const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  let _refreshTimer = null;
  let _activeChannel = null;
  let _identity = null;
  let _activeSubtab = 'channels'; // channels | quarantine | gossip

  // ─── API helper ───

  async function commsApi(path) {
    const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function commsPost(path, body = {}) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  // ─── Helpers ───

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

  function $(id) { return document.getElementById(id); }

  // ─── Identity bar ───

  async function loadIdentity() {
    const bar = $('comms-identity-bar');
    if (!bar) return;
    try {
      const data = await commsApi('/identity');
      _identity = data;
      const trustedData = await commsApi('/trusted');
      const trusted = trustedData.trusted || trustedData.agents || [];
      const trustedCount = Array.isArray(trusted) ? trusted.length : 0;
      bar.innerHTML = `
        <span class="comms-id-label">Identity</span>
        <span class="comms-id-name">${esc(data.name || data.agentId || data.id || '—')}</span>
        <span class="comms-id-sep">│</span>
        <span class="comms-id-label">Role</span>
        <span class="comms-id-role">${esc(data.role || '—')}</span>
        <span class="comms-id-sep">│</span>
        <span class="comms-id-label">Trusted</span>
        <span class="comms-id-trusted">${trustedCount} agents</span>
      `;
    } catch (e) {
      bar.innerHTML = `<span class="comms-id-error">⚠ Identity unavailable: ${esc(e.message)}</span>`;
    }
  }

  // ─── Channel list ───

  async function loadChannels() {
    const list = $('comms-channel-list');
    if (!list) return;
    try {
      const data = await commsApi('/channels');
      const channels = data.channels || data || [];
      if (!channels.length) {
        list.innerHTML = '<div class="comms-empty">No channels</div>';
        return;
      }
      let html = '';
      for (const ch of channels) {
        const id = ch.id || ch.name;
        const active = _activeChannel === id ? ' active' : '';
        const unread = ch.unread ? `<span class="comms-ch-unread">${ch.unread}</span>` : '';
        const lastMsg = ch.lastMessage ? `<div class="comms-ch-preview">${esc(ch.lastMessage)}</div>` : '';
        const time = ch.lastActivity ? `<span class="comms-ch-time">${timeAgo(ch.lastActivity)}</span>` : '';
        html += `<div class="comms-channel${active}" data-channel="${esc(id)}" onclick="window._commsSelectChannel('${esc(id)}')">
          <div class="comms-ch-header">
            <span class="comms-ch-name"># ${esc(ch.name || id)}</span>
            ${time}
          </div>
          ${lastMsg}
          ${unread}
        </div>`;
      }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML = `<div class="comms-empty">⚠ ${esc(e.message)}</div>`;
    }
  }

  // ─── Messages ───

  async function loadMessages(channelId) {
    const msgArea = $('comms-messages');
    if (!msgArea) return;
    if (!channelId) {
      msgArea.innerHTML = '<div class="comms-empty">Select a channel</div>';
      return;
    }
    try {
      const data = await commsApi(`/channels/${encodeURIComponent(channelId)}/messages`);
      const messages = data.messages || data || [];
      if (!messages.length) {
        msgArea.innerHTML = '<div class="comms-empty">No messages yet</div>';
        return;
      }
      let html = '';
      for (const m of messages) {
        const isSelf = _identity && (m.from === _identity.name || m.from === _identity.agentId || m.from === _identity.id);
        const cls = isSelf ? 'comms-msg self' : 'comms-msg other';
        html += `<div class="${cls}">
          <div class="comms-msg-header">
            <span class="comms-msg-from">${esc(m.from || m.agent || m.author || '—')}</span>
            <span class="comms-msg-time">${timeAgo(m.timestamp || m.createdAt)}</span>
          </div>
          <div class="comms-msg-body">${esc(m.text || m.content || m.body || '')}</div>
        </div>`;
      }
      msgArea.innerHTML = html;
      msgArea.scrollTop = msgArea.scrollHeight;
    } catch (e) {
      msgArea.innerHTML = `<div class="comms-empty">⚠ ${esc(e.message)}</div>`;
    }
  }

  function selectChannel(channelId) {
    _activeChannel = channelId;
    // Highlight active in list
    document.querySelectorAll('.comms-channel').forEach(el => {
      el.classList.toggle('active', el.dataset.channel === channelId);
    });
    // Update header
    const hdr = $('comms-msg-channel-name');
    if (hdr) hdr.textContent = `# ${channelId}`;
    loadMessages(channelId);
  }

  // ─── Quarantine ───

  async function loadQuarantine() {
    const container = $('comms-quarantine-list');
    if (!container) return;
    try {
      const data = await commsApi('/quarantine');
      const items = data.quarantined || data.agents || data || [];
      if (!Array.isArray(items) || !items.length) {
        container.innerHTML = '<div class="comms-empty">No quarantined agents</div>';
        return;
      }
      let html = '';
      for (const item of items) {
        const id = item.id || item.agentId || item.name || '—';
        const reason = item.reason || 'No reason given';
        const since = item.quarantinedAt || item.since || item.timestamp;
        html += `<div class="comms-quarantine-card">
          <div class="comms-q-header">
            <span class="comms-q-name">${esc(id)}</span>
            <span class="comms-q-time">${since ? timeAgo(since) : ''}</span>
          </div>
          <div class="comms-q-reason">${esc(reason)}</div>
          <div class="comms-q-actions">
            <button class="comms-btn comms-btn-approve" onclick="window._commsApproveAgent('${esc(id)}')">✓ Approve</button>
            <button class="comms-btn comms-btn-reject" onclick="window._commsRejectAgent('${esc(id)}')">✗ Reject</button>
          </div>
        </div>`;
      }
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<div class="comms-empty">⚠ ${esc(e.message)}</div>`;
    }
  }

  async function approveAgent(agentId) {
    try {
      await commsPost(`/quarantine/${encodeURIComponent(agentId)}/approve`);
      loadQuarantine();
      loadIdentity(); // refresh trusted count
    } catch (e) {
      alert('Approve failed: ' + e.message);
    }
  }

  async function rejectAgent(agentId) {
    try {
      await commsPost(`/quarantine/${encodeURIComponent(agentId)}/reject`);
      loadQuarantine();
    } catch (e) {
      alert('Reject failed: ' + e.message);
    }
  }

  // ─── Gossip ───

  async function loadGossip() {
    const container = $('comms-gossip-list');
    const input = $('comms-gossip-agent');
    if (!container) return;
    const agentName = input ? input.value.trim() : '';
    if (!agentName) {
      container.innerHTML = '<div class="comms-empty">Enter an agent name to view gossip messages</div>';
      return;
    }
    try {
      const data = await commsApi(`/gossip/messages?to=${encodeURIComponent(agentName)}`);
      const messages = data.messages || data || [];
      if (!Array.isArray(messages) || !messages.length) {
        container.innerHTML = `<div class="comms-empty">No gossip messages for ${esc(agentName)}</div>`;
        return;
      }
      let html = '';
      for (const m of messages) {
        html += `<div class="comms-gossip-msg">
          <div class="comms-gossip-header">
            <span class="comms-gossip-from">${esc(m.from || m.agent || '—')}</span>
            <span class="comms-gossip-arrow">→</span>
            <span class="comms-gossip-to">${esc(m.to || agentName)}</span>
            <span class="comms-gossip-time">${timeAgo(m.timestamp || m.createdAt)}</span>
          </div>
          <div class="comms-gossip-body">${esc(m.text || m.content || m.body || '')}</div>
        </div>`;
      }
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<div class="comms-empty">⚠ ${esc(e.message)}</div>`;
    }
  }

  // ─── Sub-tab switching ───

  function switchSubtab(name) {
    _activeSubtab = name;
    document.querySelectorAll('.comms-subtab').forEach(t => t.classList.toggle('active', t.dataset.subview === name));
    document.querySelectorAll('.comms-subview').forEach(v => v.classList.toggle('active', v.id === `comms-subview-${name}`));
    if (name === 'channels') {
      loadChannels();
      if (_activeChannel) loadMessages(_activeChannel);
    } else if (name === 'quarantine') {
      loadQuarantine();
    } else if (name === 'gossip') {
      loadGossip();
    }
  }

  // ─── Lifecycle ───

  function init() {
    // Wire sub-tab clicks
    document.querySelectorAll('.comms-subtab').forEach(tab => {
      tab.addEventListener('click', () => switchSubtab(tab.dataset.subview));
    });

    // Wire gossip search
    const gossipInput = $('comms-gossip-agent');
    if (gossipInput) {
      gossipInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadGossip();
      });
      const gossipBtn = $('comms-gossip-search');
      if (gossipBtn) gossipBtn.addEventListener('click', loadGossip);
    }

    loadIdentity();
    loadChannels();

    _refreshTimer = setInterval(() => {
      if (_activeSubtab === 'channels') {
        loadChannels();
        if (_activeChannel) loadMessages(_activeChannel);
      } else if (_activeSubtab === 'quarantine') {
        loadQuarantine();
      }
    }, 15000);
  }

  function destroy() {
    if (_refreshTimer) {
      clearInterval(_refreshTimer);
      _refreshTimer = null;
    }
  }

  // ─── Expose ───

  window._commsInit = init;
  window._commsDestroy = destroy;
  window._commsSelectChannel = selectChannel;
  window._commsApproveAgent = approveAgent;
  window._commsRejectAgent = rejectAgent;
})();
