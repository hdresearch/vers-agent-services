// ─── Usage Dashboard — Cost Analytics & Agent Efficiency ───
// No dependencies. Pure CSS/SVG charts.

(function () {
  'use strict';

  const API = '/ui/api';
  let refreshTimer = null;
  let currentRange = '7d';

  // ─── State ───
  let summaryData = null;
  let sessionsData = null;
  let vmsData = null;
  let budgetData = null;

  // ─── Helpers ───

  function $(sel, parent) { return (parent || document).querySelector(sel); }
  function $$(sel, parent) { return (parent || document).querySelectorAll(sel); }

  function fmt$(n) {
    if (n == null) return '$0.00';
    if (n >= 100) return '$' + n.toFixed(0);
    if (n >= 10) return '$' + n.toFixed(1);
    return '$' + n.toFixed(2);
  }

  function fmtTokens(n) {
    if (n == null) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
    return Math.floor(ms / 86400000) + 'd ago';
  }

  // ─── API fetch (reuses session cookie via /ui/api proxy) ───

  async function apiFetch(path) {
    const res = await fetch(API + path);
    if (res.status === 401) { window.location.href = '/ui/login'; throw new Error('Session expired'); }
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return res.json();
  }

  // ─── Data Loading ───

  async function loadAll() {
    const root = $('#usage-root');
    if (!root) return;

    try {
      const [summary, sessions, vms, budget] = await Promise.allSettled([
        apiFetch('/usage/summary?range=' + currentRange),
        apiFetch('/usage/sessions?range=' + currentRange),
        apiFetch('/usage/vms?range=' + currentRange),
        apiFetch('/aegis/budget/status'),
      ]);

      summaryData = summary.status === 'fulfilled' ? summary.value : null;
      sessionsData = sessions.status === 'fulfilled' ? sessions.value : null;
      vmsData = vms.status === 'fulfilled' ? vms.value : null;
      budgetData = budget.status === 'fulfilled' ? budget.value : null;

      render();
    } catch (e) {
      root.innerHTML = `<div style="padding:20px;color:var(--red)">Error loading usage data: ${esc(String(e))}</div>`;
    }
  }

  // ─── Render ───

  function render() {
    const root = $('#usage-root');
    if (!root) return;

    root.innerHTML = `
      <div class="usage-toolbar">
        <div class="usage-title">💰 Cost & Usage Analytics</div>
        <div class="usage-range-btns">
          ${['1h', '24h', '7d', '30d'].map(r =>
            `<button class="usage-range-btn ${r === currentRange ? 'active' : ''}" data-range="${r}">${r}</button>`
          ).join('')}
        </div>
      </div>

      ${renderOverviewCards()}
      ${renderBudgetStatus()}

      <div class="usage-charts-grid">
        <div class="usage-chart-panel">
          <div class="usage-chart-title">Cost by Agent (Top 15)</div>
          <div id="usage-agent-bar"></div>
        </div>
        <div class="usage-chart-panel">
          <div class="usage-chart-title">Spend Timeline (Hourly)</div>
          <div id="usage-timeline"></div>
        </div>
      </div>

      <div class="usage-charts-grid">
        <div class="usage-chart-panel">
          <div class="usage-chart-title">Token Distribution</div>
          <div id="usage-pie"></div>
        </div>
        <div class="usage-chart-panel">
          <div class="usage-chart-title">Agent Efficiency</div>
          <div id="usage-efficiency"></div>
        </div>
      </div>

      <div class="usage-charts-grid">
        <div class="usage-chart-panel">
          <div class="usage-chart-title">VM Usage</div>
          <div id="usage-vms"></div>
        </div>
        <div class="usage-chart-panel">
          <div class="usage-chart-title">Recent Sessions</div>
          <div id="usage-sessions-table"></div>
        </div>
      </div>
    `;

    // Wire range buttons
    $$('.usage-range-btn', root).forEach(btn => {
      btn.addEventListener('click', () => {
        currentRange = btn.dataset.range;
        loadAll();
      });
    });

    // Render charts
    renderAgentBar();
    renderTimeline();
    renderPieChart();
    renderEfficiency();
    renderVMUsage();
    renderSessionsTable();
  }

  // ─── Overview Cards ───

  function renderOverviewCards() {
    const t = summaryData?.totals || {};
    const sessions = sessionsData?.sessions || [];

    // Compute today's spend
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let todaySpend = 0;
    let todayTokens = 0;
    sessions.forEach(s => {
      if (new Date(s.startedAt) >= todayStart) {
        todaySpend += s.cost?.total || 0;
        todayTokens += s.tokens?.total || 0;
      }
    });

    // This week (already in summary for 7d range)
    const weekSpend = t.cost || 0;
    const weekTokens = t.tokens || 0;

    // Input/output totals
    let totalInput = 0, totalOutput = 0;
    sessions.forEach(s => {
      totalInput += s.tokens?.input || 0;
      totalOutput += s.tokens?.output || 0;
    });

    return `
      <div class="usage-overview">
        <div class="usage-card">
          <div class="usage-card-label">Today</div>
          <div class="usage-card-value accent">${fmt$(todaySpend)}</div>
          <div class="usage-card-sub">${fmtTokens(todayTokens)} tokens</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">Period (${currentRange})</div>
          <div class="usage-card-value">${fmt$(weekSpend)}</div>
          <div class="usage-card-sub">${fmtTokens(weekTokens)} tokens</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">Sessions</div>
          <div class="usage-card-value blue">${t.sessions || 0}</div>
          <div class="usage-card-sub">${t.vms || 0} VMs used</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">Input Tokens</div>
          <div class="usage-card-value">${fmtTokens(totalInput)}</div>
          <div class="usage-card-sub">across all sessions</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">Output Tokens</div>
          <div class="usage-card-value yellow">${fmtTokens(totalOutput)}</div>
          <div class="usage-card-sub">across all sessions</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">Avg $/Session</div>
          <div class="usage-card-value purple">${fmt$(t.sessions ? weekSpend / t.sessions : 0)}</div>
          <div class="usage-card-sub">${t.sessions || 0} sessions</div>
        </div>
      </div>
    `;
  }

  // ─── Budget Status ───

  function renderBudgetStatus() {
    const b = budgetData?.status;
    if (!b) return '<div class="usage-budget-bar"><span class="dim">Budget endpoint not available</span></div>';

    const sessions = sessionsData?.sessions || [];
    // Compute burn rate: cost in last hour
    const hourAgo = Date.now() - 3600000;
    let lastHourSpend = 0;
    sessions.forEach(s => {
      if (new Date(s.startedAt).getTime() >= hourAgo) lastHourSpend += s.cost?.total || 0;
    });

    const burnRate = lastHourSpend;
    const todayCost = b.costTodayCents / 100;

    return `
      <div class="usage-budget-bar">
        <div class="usage-budget-item">
          <span class="dim">Today cost:</span>
          <span class="bright">${fmt$(todayCost)}</span>
        </div>
        <div class="usage-budget-item">
          <span class="dim">Tokens today:</span>
          <span class="bright">${fmtTokens(b.tokensToday)}</span>
        </div>
        <div class="usage-budget-item">
          <span class="dim">Burn rate:</span>
          <span class="${burnRate > 5 ? 'red' : 'accent'}">${fmt$(burnRate)}/hr</span>
        </div>
        <div class="usage-budget-item">
          <span class="dim">Status:</span>
          <span class="${b.blocked ? 'red' : 'accent'}">${b.blocked ? '⛔ BLOCKED' : '✓ Active'}</span>
        </div>
      </div>
    `;
  }

  // ─── Bar Chart: Cost by Agent ───

  function renderAgentBar() {
    const el = $('#usage-agent-bar');
    if (!el || !summaryData?.byAgent) return;

    const agents = Object.entries(summaryData.byAgent)
      .map(([name, d]) => ({ name, cost: d.cost, sessions: d.sessions, tokens: d.tokens }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 15);

    if (!agents.length) { el.innerHTML = '<span class="dim">No data</span>'; return; }

    const maxCost = agents[0].cost || 1;

    el.innerHTML = agents.map(a => {
      const pct = (a.cost / maxCost * 100).toFixed(1);
      const color = a.cost > maxCost * 0.7 ? 'var(--red)' :
                    a.cost > maxCost * 0.4 ? 'var(--yellow)' : 'var(--accent)';
      return `
        <div class="usage-bar-row">
          <div class="usage-bar-label" title="${esc(a.name)}">${esc(a.name.replace('agent-', ''))}</div>
          <div class="usage-bar-track">
            <div class="usage-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="usage-bar-value">${fmt$(a.cost)}</div>
        </div>
      `;
    }).join('');
  }

  // ─── Timeline: Spend over Time (SVG) ───

  function renderTimeline() {
    const el = $('#usage-timeline');
    if (!el) return;

    const sessions = sessionsData?.sessions || [];
    if (!sessions.length) { el.innerHTML = '<span class="dim">No session data</span>'; return; }

    // Bucket by hour
    const buckets = {};
    sessions.forEach(s => {
      const d = new Date(s.startedAt);
      const key = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      buckets[key] = (buckets[key] || 0) + (s.cost?.total || 0);
    });

    const sorted = Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0]));
    if (!sorted.length) { el.innerHTML = '<span class="dim">No data</span>'; return; }

    const maxVal = Math.max(...sorted.map(([, v]) => v), 0.01);
    const W = 500, H = 150, pad = 30;
    const barW = Math.max(4, Math.min(20, (W - pad * 2) / sorted.length - 2));

    let bars = '';
    sorted.forEach(([key, val], i) => {
      const x = pad + i * ((W - pad * 2) / sorted.length);
      const h = (val / maxVal) * (H - pad * 2);
      const y = H - pad - h;
      const color = val > maxVal * 0.7 ? '#f55' : val > maxVal * 0.4 ? '#fd0' : '#4f9';
      bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" rx="1">
        <title>${key.slice(5, 10)} ${key.slice(11)}:00 — ${fmt$(val)}</title>
      </rect>`;
    });

    // X axis labels (show a few)
    let labels = '';
    const step = Math.max(1, Math.floor(sorted.length / 6));
    for (let i = 0; i < sorted.length; i += step) {
      const x = pad + i * ((W - pad * 2) / sorted.length) + barW / 2;
      const key = sorted[i][0];
      labels += `<text x="${x}" y="${H - 5}" fill="#666" font-size="8" text-anchor="middle">${key.slice(5, 10)} ${key.slice(11)}h</text>`;
    }

    // Y axis
    labels += `<text x="2" y="${pad}" fill="#666" font-size="8">${fmt$(maxVal)}</text>`;
    labels += `<text x="2" y="${H - pad}" fill="#666" font-size="8">$0</text>`;
    labels += `<line x1="${pad}" y1="${H - pad}" x2="${W - 5}" y2="${H - pad}" stroke="#333" stroke-width="1"/>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${bars}${labels}</svg>`;
  }

  // ─── Pie Chart: Token Distribution (SVG) ───

  function renderPieChart() {
    const el = $('#usage-pie');
    if (!el) return;

    const sessions = sessionsData?.sessions || [];
    if (!sessions.length) { el.innerHTML = '<span class="dim">No data</span>'; return; }

    // Aggregate cost by type: input, output, cacheRead, cacheWrite
    let cats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    sessions.forEach(s => {
      cats.input += s.cost?.input || 0;
      cats.output += s.cost?.output || 0;
      cats.cacheRead += s.cost?.cacheRead || 0;
      cats.cacheWrite += s.cost?.cacheWrite || 0;
    });

    const entries = [
      { label: 'Output', value: cats.output, color: '#f55' },
      { label: 'Cache Read', value: cats.cacheRead, color: '#5af' },
      { label: 'Cache Write', value: cats.cacheWrite, color: '#fd0' },
      { label: 'Input', value: cats.input, color: '#4f9' },
    ].filter(e => e.value > 0);

    const total = entries.reduce((s, e) => s + e.value, 0);
    if (total === 0) { el.innerHTML = '<span class="dim">No cost data</span>'; return; }

    // SVG pie
    const cx = 80, cy = 80, r = 70;
    let angle = -Math.PI / 2;
    let paths = '';

    entries.forEach(e => {
      const pct = e.value / total;
      const endAngle = angle + pct * 2 * Math.PI;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const large = pct > 0.5 ? 1 : 0;
      paths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z" fill="${e.color}" stroke="#0a0a0a" stroke-width="1">
        <title>${e.label}: ${fmt$(e.value)} (${(pct * 100).toFixed(1)}%)</title>
      </path>`;
      angle = endAngle;
    });

    // Legend
    const legend = entries.map(e =>
      `<div class="usage-legend-item"><span class="usage-legend-dot" style="background:${e.color}"></span>${e.label}: ${fmt$(e.value)} (${(e.value / total * 100).toFixed(1)}%)</div>`
    ).join('');

    el.innerHTML = `
      <div class="usage-pie-wrap">
        <svg viewBox="0 0 160 160" style="width:160px;height:160px">${paths}</svg>
        <div class="usage-legend">${legend}</div>
      </div>
    `;
  }

  // ─── Agent Efficiency ───

  function renderEfficiency() {
    const el = $('#usage-efficiency');
    if (!el || !summaryData?.byAgent) return;

    const sessions = sessionsData?.sessions || [];

    // Count tasks per agent (turns as proxy for tasks)
    const agentTurns = {};
    sessions.forEach(s => {
      agentTurns[s.agent] = (agentTurns[s.agent] || 0) + (s.turns || 0);
    });

    const agents = Object.entries(summaryData.byAgent)
      .map(([name, d]) => ({
        name,
        cost: d.cost,
        sessions: d.sessions,
        turns: agentTurns[name] || 0,
        turnsPerDollar: d.cost > 0 ? (agentTurns[name] || 0) / d.cost : 0,
        costPerSession: d.sessions > 0 ? d.cost / d.sessions : 0,
      }))
      .filter(a => a.cost > 0.01)
      .sort((a, b) => b.turnsPerDollar - a.turnsPerDollar);

    if (!agents.length) { el.innerHTML = '<span class="dim">No data</span>'; return; }

    // Top 10 most efficient
    const top = agents.slice(0, 10);
    // Bottom 3 least efficient (most expensive per turn)
    const bottom = agents.slice(-3).reverse();

    el.innerHTML = `
      <div class="usage-efficiency-section">
        <div class="usage-eff-header accent">🏆 Most Efficient (turns/$)</div>
        <table class="usage-table">
          <thead><tr><th>Agent</th><th>Turns/$</th><th>$/Session</th><th>Total</th></tr></thead>
          <tbody>
            ${top.map(a => `<tr>
              <td>${esc(a.name.replace('agent-', ''))}</td>
              <td class="accent">${a.turnsPerDollar.toFixed(1)}</td>
              <td>${fmt$(a.costPerSession)}</td>
              <td>${fmt$(a.cost)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="usage-efficiency-section" style="margin-top:12px">
        <div class="usage-eff-header red">🔥 Biggest Spenders</div>
        <table class="usage-table">
          <thead><tr><th>Agent</th><th>Total Cost</th><th>Sessions</th><th>$/Session</th></tr></thead>
          <tbody>
            ${agents.sort((a, b) => b.cost - a.cost).slice(0, 5).map(a => `<tr>
              <td>${esc(a.name.replace('agent-', ''))}</td>
              <td class="red">${fmt$(a.cost)}</td>
              <td>${a.sessions}</td>
              <td>${fmt$(a.costPerSession)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ─── VM Usage ───

  function renderVMUsage() {
    const el = $('#usage-vms');
    if (!el) return;

    const vms = vmsData?.vms || [];
    if (!vms.length) { el.innerHTML = '<span class="dim">No VM data</span>'; return; }

    // Total VM count
    const totalVMs = vms.length;

    // VM-hours: sum (destroyedAt - createdAt) for each
    let totalHours = 0;
    vms.forEach(v => {
      const start = new Date(v.createdAt).getTime();
      const end = v.destroyedAt ? new Date(v.destroyedAt).getTime() : Date.now();
      totalHours += (end - start) / 3600000;
    });

    // Peak concurrent: scan lifecycle
    const events = [];
    vms.forEach(v => {
      events.push({ time: new Date(v.createdAt).getTime(), delta: 1 });
      if (v.destroyedAt) events.push({ time: new Date(v.destroyedAt).getTime(), delta: -1 });
    });
    events.sort((a, b) => a.time - b.time);
    let concurrent = 0, peak = 0;
    events.forEach(e => { concurrent += e.delta; peak = Math.max(peak, concurrent); });

    // VMs by role
    const byRole = {};
    vms.forEach(v => { byRole[v.role] = (byRole[v.role] || 0) + 1; });

    // VMs by agent (top 5)
    const byAgent = {};
    vms.forEach(v => { byAgent[v.agent] = (byAgent[v.agent] || 0) + 1; });
    const topAgents = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 5);

    el.innerHTML = `
      <div class="usage-vm-stats">
        <div class="usage-vm-stat">
          <span class="dim">Total VMs:</span> <span class="bright">${totalVMs}</span>
        </div>
        <div class="usage-vm-stat">
          <span class="dim">VM-hours:</span> <span class="bright">${totalHours.toFixed(1)}h</span>
        </div>
        <div class="usage-vm-stat">
          <span class="dim">Peak concurrent:</span> <span class="yellow">${peak}</span>
        </div>
      </div>
      <div class="usage-vm-grid">
        <div>
          <div class="usage-eff-header" style="margin-bottom:6px">By Role</div>
          ${Object.entries(byRole).map(([role, cnt]) =>
            `<div class="usage-vm-role"><span class="dim">${esc(role)}:</span> <span class="bright">${cnt}</span></div>`
          ).join('')}
        </div>
        <div>
          <div class="usage-eff-header" style="margin-bottom:6px">Top Agents</div>
          ${topAgents.map(([agent, cnt]) =>
            `<div class="usage-vm-role"><span class="dim">${esc(agent.replace('agent-', ''))}:</span> <span class="bright">${cnt} VMs</span></div>`
          ).join('')}
        </div>
      </div>
    `;
  }

  // ─── Sessions Table ───

  function renderSessionsTable() {
    const el = $('#usage-sessions-table');
    if (!el) return;

    const sessions = (sessionsData?.sessions || [])
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 20);

    if (!sessions.length) { el.innerHTML = '<span class="dim">No sessions</span>'; return; }

    el.innerHTML = `
      <table class="usage-table usage-table-full">
        <thead><tr><th>Agent</th><th>Model</th><th>Cost</th><th>Tokens</th><th>Turns</th><th>Started</th></tr></thead>
        <tbody>
          ${sessions.map(s => {
            const cost = s.cost?.total || 0;
            const costClass = cost > 2 ? 'red' : cost > 1 ? 'yellow' : '';
            return `<tr>
              <td>${esc(s.agent.replace('agent-', ''))}</td>
              <td class="dim">${esc((s.model || '').replace('claude-', ''))}</td>
              <td class="${costClass}">${fmt$(cost)}</td>
              <td>${fmtTokens(s.tokens?.total || 0)}</td>
              <td>${s.turns || 0}</td>
              <td class="dim">${timeAgo(s.startedAt)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  // ─── Init / Destroy (lifecycle hooks for tab switching) ───

  window._usageInit = function () {
    loadAll();
    refreshTimer = setInterval(loadAll, 30000); // refresh every 30s
  };

  window._usageDestroy = function () {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  };

})();
