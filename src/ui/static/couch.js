// ─── Couch Tab — Host Control Panel for crash-on-my-couch ───

(function () {
  const API = '/ui/api';
  let couchRefreshTimer = null;
  let allGuests = [];
  let allInvites = [];

  // ─── Helpers ───

  function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'in ' + formatDuration(-ms);
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  function formatDuration(ms) {
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

  async function fapi(path, opts = {}) {
    const timeout = opts.timeout || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const fetchOpts = { signal: controller.signal };
      if (opts.method) fetchOpts.method = opts.method;
      if (opts.body) {
        fetchOpts.body = JSON.stringify(opts.body);
        fetchOpts.headers = { 'Content-Type': 'application/json' };
      }
      const res = await fetch(`${API}${path}`, fetchOpts);
      clearTimeout(timer);
      if (res.status === 401) { window.location.href = '/ui/login'; throw new Error('Session expired'); }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `API ${path}: ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Timeout: ${path}`);
      throw e;
    }
  }

  // ─── Data Loading ───

  async function loadGuests() {
    try {
      const data = await fapi('/couch/guests');
      allGuests = data.guests || [];
      renderGuests();
      renderResources();
    } catch (e) {
      const el = document.getElementById('couch-guests');
      if (el && !el.querySelector('.couch-guest-card')) {
        el.innerHTML = `<div class="couch-empty">⚠ ${esc(e.message)}</div>`;
      }
    }
  }

  async function loadInvites() {
    try {
      const data = await fapi('/couch/invites');
      allInvites = data.invites || [];
      renderInvites();
    } catch (e) {
      const el = document.getElementById('couch-invites-list');
      if (el && !el.querySelector('.couch-invite-card')) {
        el.innerHTML = `<div class="couch-empty">⚠ ${esc(e.message)}</div>`;
      }
    }
  }

  // ─── Render: Guests ───

  function statusDot(status) {
    const colors = { provisioning: 'var(--yellow)', running: 'var(--accent)', stopped: 'var(--text-dim)', expired: 'var(--orange)', revoked: 'var(--red)' };
    return `<span class="couch-dot" style="background:${colors[status] || 'var(--text-dim)'}"></span>`;
  }

  function usageBar(used, limit, label, unit) {
    if (!limit) return '';
    const pct = Math.min(100, (used / limit) * 100);
    const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--yellow)' : 'var(--accent)';
    return `<div class="couch-usage-row">
      <span class="couch-usage-label">${label}</span>
      <div class="couch-usage-bar"><div class="couch-usage-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="couch-usage-val">${typeof used === 'number' ? used.toFixed(1) : used}/${limit}${unit}</span>
    </div>`;
  }

  function renderGuests() {
    const el = document.getElementById('couch-guests');
    const countEl = document.getElementById('couch-guest-count');
    const active = allGuests.filter(g => g.status === 'running' || g.status === 'provisioning');
    if (countEl) countEl.textContent = active.length;

    if (!allGuests.length) {
      el.innerHTML = '<div class="couch-empty">No guests yet — generate an invite to get started</div>';
      return;
    }

    // Sort: running first, then provisioning, then stopped
    const order = { running: 0, provisioning: 1, stopped: 2, expired: 3, revoked: 4 };
    const sorted = [...allGuests].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));

    let html = '';
    for (const g of sorted) {
      const u = g.resourceUsage || {};
      const l = g.resourceLimits || {};
      const uptime = u.uptimeSeconds ? formatDuration(u.uptimeSeconds * 1000) : '—';
      const isActive = g.status === 'running' || g.status === 'provisioning';

      html += `<div class="couch-guest-card couch-status-${g.status}">
        <div class="couch-guest-header">
          <div class="couch-guest-name">${statusDot(g.status)} ${esc(g.name)}</div>
          <span class="couch-guest-status">${esc(g.status)}</span>
        </div>
        <div class="couch-guest-meta">
          ${g.vmId ? `<span class="couch-vm-id" title="${esc(g.vmId)}">VM: ${esc(g.vmId.slice(0, 8))}…</span>` : ''}
          ${g.agentEndpoint ? `<a class="couch-endpoint" href="${esc(g.agentEndpoint)}" target="_blank">${esc(g.agentEndpoint.replace('https://', ''))}</a>` : '<span class="couch-endpoint-pending">endpoint pending…</span>'}
          <span class="couch-uptime">⏱ ${uptime}</span>
        </div>
        <div class="couch-usage-block">
          ${usageBar(u.tokensUsed || 0, l.maxTokenBudget, 'Tokens', '')}
          ${usageBar(u.memoryPeakMB || 0, l.maxMemoryMB, 'Memory', 'MB')}
          ${usageBar(u.diskUsedGB || 0, l.maxDiskGB, 'Disk', 'GB')}
          ${usageBar(u.networkEgressGB || 0, l.maxNetworkEgressGB, 'Network', 'GB')}
        </div>
        ${isActive ? `<button class="couch-kill-btn" onclick="window._couchKillGuest('${g.id}', '${esc(g.name)}')">⚠ Kill Guest</button>` : `<span class="couch-stopped-at">stopped ${timeAgo(g.stoppedAt)}</span>`}
      </div>`;
    }
    el.innerHTML = html;
  }

  // ─── Render: Invites ───

  function renderInvites() {
    const el = document.getElementById('couch-invites-list');
    const countEl = document.getElementById('couch-invite-count');
    if (countEl) countEl.textContent = allInvites.length;

    if (!allInvites.length) {
      el.innerHTML = '<div class="couch-empty">No invites created yet</div>';
      return;
    }

    // Sort: active first, then by creation date desc
    const order = { active: 0, redeemed: 1, revoked: 2, expired: 3 };
    const sorted = [...allInvites].sort((a, b) => {
      const diff = (order[a.status] ?? 5) - (order[b.status] ?? 5);
      return diff !== 0 ? diff : new Date(b.createdAt) - new Date(a.createdAt);
    });

    let html = '';
    for (const inv of sorted) {
      const l = inv.resourceLimits || {};
      const limitsStr = `${l.maxTokenBudget || '—'} tokens · ${l.maxDurationHours || '—'}h · ${l.maxMemoryMB || '—'}MB`;
      const isActive = inv.status === 'active';

      html += `<div class="couch-invite-card couch-inv-${inv.status}">
        <div class="couch-invite-header">
          <span class="couch-invite-label">${esc(inv.label || 'Unlabeled')}</span>
          <span class="couch-invite-status couch-inv-status-${inv.status}">${inv.status}</span>
        </div>
        <div class="couch-invite-meta">
          <span>code: <code>${esc(inv.code)}</code></span>
          <span>created ${timeAgo(inv.createdAt)}</span>
          <span>expires ${timeAgo(inv.expiresAt)}</span>
        </div>
        <div class="couch-invite-limits">${limitsStr}</div>
        ${inv.redeemedBy ? `<div class="couch-invite-redeemed">redeemed by <strong>${esc(inv.redeemedBy)}</strong> ${timeAgo(inv.redeemedAt)}</div>` : ''}
        ${isActive ? `<button class="couch-revoke-btn" onclick="window._couchRevokeInvite('${inv.id}')">Revoke</button>` : ''}
      </div>`;
    }
    el.innerHTML = html;
  }

  // ─── Render: Resource Dashboard ───

  function renderResources() {
    const el = document.getElementById('couch-resources');
    const active = allGuests.filter(g => g.status === 'running' || g.status === 'provisioning');

    if (!active.length) {
      el.innerHTML = '<div class="couch-empty">No active guests — resources idle</div>';
      return;
    }

    // Aggregate usage + limits across all active guests
    let totalTokens = 0, maxTokens = 0;
    let totalMemory = 0, maxMemory = 0;
    let totalDisk = 0, maxDisk = 0;
    let totalNetwork = 0, maxNetwork = 0;

    for (const g of active) {
      const u = g.resourceUsage || {};
      const l = g.resourceLimits || {};
      totalTokens += u.tokensUsed || 0;
      maxTokens += l.maxTokenBudget || 0;
      totalMemory += u.memoryPeakMB || 0;
      maxMemory += l.maxMemoryMB || 0;
      totalDisk += u.diskUsedGB || 0;
      maxDisk += l.maxDiskGB || 0;
      totalNetwork += u.networkEgressGB || 0;
      maxNetwork += l.maxNetworkEgressGB || 0;
    }

    el.innerHTML = `
      <div class="couch-resource-summary">
        <div class="couch-resource-count">${active.length} active guest${active.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="couch-usage-block">
        ${usageBar(totalTokens, maxTokens || 1, 'Total Tokens', '')}
        ${usageBar(totalMemory, maxMemory || 1, 'Total Memory', 'MB')}
        ${usageBar(totalDisk, maxDisk || 1, 'Total Disk', 'GB')}
        ${usageBar(totalNetwork, maxNetwork || 1, 'Total Network', 'GB')}
      </div>
    `;
  }

  // ─── Actions ───

  window._couchKillGuest = async function (id, name) {
    if (!confirm(`Kill guest "${name}"? This will destroy their VM immediately.`)) return;
    try {
      await fapi(`/couch/guests/${id}`, { method: 'DELETE' });
      loadGuests();
    } catch (e) {
      alert('Kill failed: ' + e.message);
    }
  };

  window._couchRevokeInvite = async function (id) {
    if (!confirm('Revoke this invite?')) return;
    try {
      await fapi(`/couch/invites/${id}`, { method: 'DELETE' });
      loadInvites();
    } catch (e) {
      alert('Revoke failed: ' + e.message);
    }
  };

  window._couchCreateInvite = async function () {
    const label = document.getElementById('couch-inv-label').value.trim();
    const maxTokens = parseInt(document.getElementById('couch-inv-tokens').value) || 100000;
    const maxDuration = parseInt(document.getElementById('couch-inv-duration').value) || 24;
    const maxMemory = parseInt(document.getElementById('couch-inv-memory').value) || 4096;
    const maxDisk = parseInt(document.getElementById('couch-inv-disk').value) || 20;
    const maxNetwork = parseInt(document.getElementById('couch-inv-network').value) || 5;

    const btn = document.getElementById('couch-create-invite-btn');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    try {
      const invite = await fapi('/couch/invites', {
        method: 'POST',
        body: {
          label: label || 'Guest Invite',
          createdBy: 'dashboard',
          expiresInHours: maxDuration,
          resourceLimits: {
            maxTokenBudget: maxTokens,
            maxDurationHours: maxDuration,
            maxMemoryMB: maxMemory,
            maxDiskGB: maxDisk,
            maxNetworkEgressGB: maxNetwork,
            maxCpuCores: 4,
          },
          permissions: {
            canAccessInternet: true,
            canSpawnSubAgents: false,
            canAccessHostServices: false,
          },
        },
      });

      // Show the generated link
      const linkEl = document.getElementById('couch-generated-link');
      const host = window.location.origin;
      const curlCmd = `curl -sk -X POST ${host}/couch/redeem -H "Content-Type: application/json" -d '{"code":"${invite.code}","name":"YOUR_NAME"}'`;
      linkEl.innerHTML = `
        <div class="couch-link-success">
          <div class="couch-link-title">✓ Invite created!</div>
          <div class="couch-link-code">Code: <code>${esc(invite.code)}</code></div>
          <div class="couch-link-label">Send this to your guest:</div>
          <div class="couch-link-cmd" onclick="navigator.clipboard.writeText(this.textContent).then(() => { this.classList.add('copied'); setTimeout(() => this.classList.remove('copied'), 1500); })">${esc(curlCmd)}</div>
          <div class="couch-link-hint">click to copy</div>
        </div>
      `;

      loadInvites();
    } catch (e) {
      alert('Failed to create invite: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Invite';
    }
  };

  // ─── Lifecycle ───

  window._couchInit = function () {
    if (couchRefreshTimer) return;
    loadGuests();
    loadInvites();
    couchRefreshTimer = setInterval(() => {
      loadGuests();
      loadInvites();
    }, 15000);
  };

  window._couchDestroy = function () {
    if (couchRefreshTimer) {
      clearInterval(couchRefreshTimer);
      couchRefreshTimer = null;
    }
  };
})();
