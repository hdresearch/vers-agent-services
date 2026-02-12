// ═══════════════════════════════════════════════════════════════════════════
// Analytics Chat — Natural Language → Canvas Charts
// Pattern-matching query interpreter with animated visualizations
// ═══════════════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  const ANALYTICS_API = '/ui/api';

  // ─── Color Palette (matches metrics.js) ───
  const P = {
    bg:         '#0a0a0f',
    grid:       'rgba(0, 255, 213, 0.04)',
    cyan:       '#00ffd5',
    cyanRgb:    '0, 255, 213',
    purple:     '#b44aff',
    purpleRgb:  '180, 74, 255',
    amber:      '#ffaa00',
    amberRgb:   '255, 170, 0',
    red:        '#ff4466',
    redRgb:     '255, 68, 102',
    blue:       '#5599ff',
    blueRgb:    '85, 153, 255',
    green:      '#44ff88',
    greenRgb:   '68, 255, 136',
    pink:       '#ff66cc',
    pinkRgb:    '255, 102, 204',
    text:       '#c0c0c0',
    textBright: '#ffffff',
    textDim:    '#556',
    panelBg:    'rgba(12, 12, 20, 0.92)',
    panelBorder:'rgba(0, 255, 213, 0.12)',
  };

  const CHART_COLORS = [
    { hex: P.cyan,   rgb: P.cyanRgb },
    { hex: P.purple, rgb: P.purpleRgb },
    { hex: P.amber,  rgb: P.amberRgb },
    { hex: P.blue,   rgb: P.blueRgb },
    { hex: P.green,  rgb: P.greenRgb },
    { hex: P.red,    rgb: P.redRgb },
    { hex: P.pink,   rgb: P.pinkRgb },
  ];

  // ─── State ───
  let sessionsCache = null;
  let summaryCache = null;
  let canvas, ctx;
  let currentChart = null;
  let animProgress = 0;
  let animFrame = null;
  let hoverInfo = null;
  let mouseX = -1, mouseY = -1;
  let analyticsActive = false;
  let chartRegions = []; // hit-test regions for tooltips

  // ─── Data Fetching ───

  async function fetchData() {
    try {
      const [sessRes, sumRes] = await Promise.all([
        fetch(`${ANALYTICS_API}/usage/sessions?range=30d`).then(r => r.ok ? r.json() : null),
        fetch(`${ANALYTICS_API}/usage?range=30d`).then(r => r.ok ? r.json() : null),
      ]);
      sessionsCache = sessRes;
      summaryCache = sumRes;
    } catch (e) {
      console.error('Analytics fetch error:', e);
    }
  }

  // ─── Query Interpreter ───

  const PATTERNS = [
    {
      match: /token\s*burn\s*(by|per|over)\s*(day|date|time)/i,
      handler: () => tokenBurnByDay(),
      desc: 'Token burn by day',
    },
    {
      match: /tokens?\s*(over|by|per)\s*(time|day|date)/i,
      handler: () => tokenBurnByDay(),
      desc: 'Token burn over time',
    },
    {
      match: /daily\s*(token|burn|usage)/i,
      handler: () => tokenBurnByDay(),
      desc: 'Daily token burn',
    },
    {
      match: /(which|what|top)\s*agent.*(most|burned|highest|top)/i,
      handler: () => tokensByAgent(),
      desc: 'Top agents by tokens',
    },
    {
      match: /(token|usage|burn)\s*(by|per|breakdown)\s*agent/i,
      handler: () => tokensByAgent(),
      desc: 'Tokens by agent',
    },
    {
      match: /by\s*agent/i,
      handler: () => tokensByAgent(),
      desc: 'Usage by agent',
    },
    {
      match: /agent\s*(breakdown|ranking|comparison|usage)/i,
      handler: () => tokensByAgent(),
      desc: 'Agent breakdown',
    },
    {
      match: /cost\s*(over|by|per)\s*(time|day|date)/i,
      handler: () => costOverTime(),
      desc: 'Cost over time',
    },
    {
      match: /cost\s*(trend|history|daily)/i,
      handler: () => costOverTime(),
      desc: 'Cost trend',
    },
    {
      match: /spend(ing)?\s*(over|by|per)\s*(time|day)/i,
      handler: () => costOverTime(),
      desc: 'Spending over time',
    },
    {
      match: /cost\s*(by|per|breakdown)\s*agent/i,
      handler: () => costByAgent(),
      desc: 'Cost by agent',
    },
    {
      match: /(which|what|top)\s*agent.*(cost|expens|spend)/i,
      handler: () => costByAgent(),
      desc: 'Most expensive agents',
    },
    {
      match: /compare\s*(.+?)\s*vs\.?\s*(.+)/i,
      handler: (m) => compareAgents(m[1].trim(), m[2].trim()),
      desc: 'Compare agents',
    },
    {
      match: /compare\s*today\s*(vs\.?|versus|and)\s*yesterday/i,
      handler: () => compareDays('today', 'yesterday'),
      desc: 'Compare today vs yesterday',
    },
    {
      match: /today\s*(vs\.?|versus)\s*yesterday/i,
      handler: () => compareDays('today', 'yesterday'),
      desc: 'Today vs yesterday',
    },
    {
      match: /model\s*(breakdown|usage|split|distribution)/i,
      handler: () => modelBreakdown(),
      desc: 'Model breakdown',
    },
    {
      match: /(by|per|breakdown)\s*model/i,
      handler: () => modelBreakdown(),
      desc: 'Breakdown by model',
    },
    {
      match: /cost\s*(breakdown|split)/i,
      handler: () => costBreakdownDonut(),
      desc: 'Cost breakdown',
    },
    {
      match: /session(s)?\s*(over|by|per)\s*(time|day|date)/i,
      handler: () => sessionsOverTime(),
      desc: 'Sessions over time',
    },
    {
      match: /session(s)?\s*(count|history|trend|daily)/i,
      handler: () => sessionsOverTime(),
      desc: 'Session count trend',
    },
    {
      match: /^session(s)?$/i,
      handler: () => sessionsOverTime(),
      desc: 'Sessions',
    },
    {
      match: /input\s*vs\.?\s*output/i,
      handler: () => inputVsOutput(),
      desc: 'Input vs output tokens',
    },
    {
      match: /token\s*(split|breakdown|ratio)/i,
      handler: () => inputVsOutput(),
      desc: 'Token split',
    },
    {
      match: /turns?\s*(by|per)\s*agent/i,
      handler: () => turnsByAgent(),
      desc: 'Turns by agent',
    },
    {
      match: /efficiency|cost\s*per\s*token|token\s*per\s*turn/i,
      handler: () => efficiencyChart(),
      desc: 'Efficiency metrics',
    },
    {
      match: /overview|summary|dashboard/i,
      handler: () => overviewChart(),
      desc: 'Overview',
    },
    {
      match: /^help$/i,
      handler: () => null, // handled specially
      desc: 'Help',
    },
  ];

  function interpretQuery(query) {
    const q = query.trim();
    for (const pattern of PATTERNS) {
      const m = q.match(pattern.match);
      if (m) return { handler: pattern.handler, match: m, desc: pattern.desc };
    }
    return null;
  }

  // ─── Chart Data Builders ───

  function getSessions() {
    return sessionsCache?.sessions || [];
  }

  function groupByDay(sessions, valueKey) {
    const buckets = {};
    for (const s of sessions) {
      const day = s.startedAt.slice(0, 10);
      if (!buckets[day]) buckets[day] = 0;
      if (valueKey === 'tokens') buckets[day] += s.tokens?.total || 0;
      else if (valueKey === 'cost') buckets[day] += s.cost?.total || 0;
      else if (valueKey === 'sessions') buckets[day] += 1;
    }
    const sorted = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
    return { labels: sorted.map(([d]) => d), values: sorted.map(([, v]) => v) };
  }

  function groupByAgent(sessions, valueKey) {
    const buckets = {};
    for (const s of sessions) {
      const agent = s.agent || 'unknown';
      if (!buckets[agent]) buckets[agent] = 0;
      if (valueKey === 'tokens') buckets[agent] += s.tokens?.total || 0;
      else if (valueKey === 'cost') buckets[agent] += s.cost?.total || 0;
      else if (valueKey === 'sessions') buckets[agent] += 1;
      else if (valueKey === 'turns') buckets[agent] += s.turns || 0;
    }
    const sorted = Object.entries(buckets).sort(([, a], [, b]) => b - a);
    return { labels: sorted.map(([n]) => n), values: sorted.map(([, v]) => v) };
  }

  function tokenBurnByDay() {
    const data = groupByDay(getSessions(), 'tokens');
    if (data.labels.length === 0) return emptyChart('No session data available');
    return {
      type: 'bar',
      title: 'Token Burn by Day',
      labels: data.labels.map(d => formatDateLabel(d)),
      datasets: [{ label: 'Tokens', values: data.values, color: 0 }],
      formatValue: formatTokens,
    };
  }

  function tokensByAgent() {
    const data = groupByAgent(getSessions(), 'tokens');
    if (data.labels.length === 0) return emptyChart('No session data available');
    return {
      type: 'bar',
      title: 'Tokens by Agent',
      labels: data.labels.map(shortAgentName),
      datasets: [{ label: 'Tokens', values: data.values, color: 0 }],
      formatValue: formatTokens,
    };
  }

  function costOverTime() {
    const data = groupByDay(getSessions(), 'cost');
    if (data.labels.length === 0) return emptyChart('No session data available');
    return {
      type: 'line',
      title: 'Cost Over Time',
      labels: data.labels.map(d => formatDateLabel(d)),
      datasets: [{ label: 'Cost ($)', values: data.values, color: 1 }],
      formatValue: v => '$' + v.toFixed(2),
    };
  }

  function costByAgent() {
    const data = groupByAgent(getSessions(), 'cost');
    if (data.labels.length === 0) return emptyChart('No session data available');
    return {
      type: 'bar',
      title: 'Cost by Agent',
      labels: data.labels.map(shortAgentName),
      datasets: [{ label: 'Cost ($)', values: data.values, color: 2 }],
      formatValue: v => '$' + v.toFixed(2),
    };
  }

  function sessionsOverTime() {
    const data = groupByDay(getSessions(), 'sessions');
    if (data.labels.length === 0) return emptyChart('No session data available');
    return {
      type: 'bar',
      title: 'Sessions Over Time',
      labels: data.labels.map(d => formatDateLabel(d)),
      datasets: [{ label: 'Sessions', values: data.values, color: 3 }],
      formatValue: v => v.toString(),
    };
  }

  function modelBreakdown() {
    const sessions = getSessions();
    const buckets = {};
    for (const s of sessions) {
      const model = shortModelName(s.model || 'unknown');
      if (!buckets[model]) buckets[model] = { tokens: 0, cost: 0, sessions: 0 };
      buckets[model].tokens += s.tokens?.total || 0;
      buckets[model].cost += s.cost?.total || 0;
      buckets[model].sessions += 1;
    }
    const entries = Object.entries(buckets).sort(([, a], [, b]) => b.tokens - a.tokens);
    if (entries.length === 0) return emptyChart('No model data available');
    return {
      type: 'donut',
      title: 'Model Breakdown (by tokens)',
      labels: entries.map(([m]) => m),
      values: entries.map(([, d]) => d.tokens),
      formatValue: formatTokens,
    };
  }

  function costBreakdownDonut() {
    const data = groupByAgent(getSessions(), 'cost');
    if (data.labels.length === 0) return emptyChart('No cost data available');
    return {
      type: 'donut',
      title: 'Cost Breakdown by Agent',
      labels: data.labels.map(shortAgentName),
      values: data.values,
      formatValue: v => '$' + v.toFixed(2),
    };
  }

  function compareAgents(a, b) {
    const sessions = getSessions();
    // Try to fuzzy-match agent names
    const nameA = findAgent(sessions, a);
    const nameB = findAgent(sessions, b);

    if (!nameA && !nameB) return emptyChart(`Couldn't find agents matching "${a}" or "${b}"`);

    const agents = [nameA, nameB].filter(Boolean);
    const metrics = ['Tokens', 'Cost ($)', 'Sessions', 'Turns'];
    const datasets = [];

    for (let i = 0; i < agents.length; i++) {
      const agentSessions = sessions.filter(s => s.agent === agents[i]);
      const totTokens = agentSessions.reduce((s, x) => s + (x.tokens?.total || 0), 0);
      const totCost = agentSessions.reduce((s, x) => s + (x.cost?.total || 0), 0);
      const totSessions = agentSessions.length;
      const totTurns = agentSessions.reduce((s, x) => s + (x.turns || 0), 0);
      datasets.push({
        label: shortAgentName(agents[i]),
        values: [totTokens, totCost, totSessions, totTurns],
        color: i,
      });
    }

    return {
      type: 'grouped-bar',
      title: `Compare: ${agents.map(shortAgentName).join(' vs ')}`,
      labels: metrics,
      datasets,
      formatValue: (v, idx) => {
        if (idx === 0) return formatTokens(v);
        if (idx === 1) return '$' + v.toFixed(2);
        return v.toString();
      },
    };
  }

  function compareDays(dayA, dayB) {
    const sessions = getSessions();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const todaySess = sessions.filter(s => s.startedAt.slice(0, 10) === today);
    const yesterdaySess = sessions.filter(s => s.startedAt.slice(0, 10) === yesterday);

    const sum = (arr, key) => arr.reduce((s, x) => {
      if (key === 'tokens') return s + (x.tokens?.total || 0);
      if (key === 'cost') return s + (x.cost?.total || 0);
      if (key === 'sessions') return s + 1;
      if (key === 'turns') return s + (x.turns || 0);
      return s;
    }, 0);

    const metrics = ['Tokens', 'Cost ($)', 'Sessions', 'Turns'];
    return {
      type: 'grouped-bar',
      title: 'Today vs Yesterday',
      labels: metrics,
      datasets: [
        { label: 'Today', values: [sum(todaySess, 'tokens'), sum(todaySess, 'cost'), todaySess.length, sum(todaySess, 'turns')], color: 0 },
        { label: 'Yesterday', values: [sum(yesterdaySess, 'tokens'), sum(yesterdaySess, 'cost'), yesterdaySess.length, sum(yesterdaySess, 'turns')], color: 2 },
      ],
      formatValue: (v, idx) => {
        if (idx === 0) return formatTokens(v);
        if (idx === 1) return '$' + v.toFixed(2);
        return v.toString();
      },
    };
  }

  function inputVsOutput() {
    const data = {};
    for (const s of getSessions()) {
      const agent = s.agent || 'unknown';
      if (!data[agent]) data[agent] = { input: 0, output: 0 };
      data[agent].input += s.tokens?.input || 0;
      data[agent].output += s.tokens?.output || 0;
    }
    const entries = Object.entries(data).sort(([, a], [, b]) => (b.input + b.output) - (a.input + a.output));
    if (entries.length === 0) return emptyChart('No token data available');
    return {
      type: 'grouped-bar',
      title: 'Input vs Output Tokens by Agent',
      labels: entries.map(([n]) => shortAgentName(n)),
      datasets: [
        { label: 'Input', values: entries.map(([, d]) => d.input), color: 0 },
        { label: 'Output', values: entries.map(([, d]) => d.output), color: 1 },
      ],
      formatValue: formatTokens,
    };
  }

  function turnsByAgent() {
    const data = groupByAgent(getSessions(), 'turns');
    if (data.labels.length === 0) return emptyChart('No session data available');
    return {
      type: 'bar',
      title: 'Turns by Agent',
      labels: data.labels.map(shortAgentName),
      datasets: [{ label: 'Turns', values: data.values, color: 4 }],
      formatValue: v => v.toString(),
    };
  }

  function efficiencyChart() {
    const data = {};
    for (const s of getSessions()) {
      const agent = s.agent || 'unknown';
      if (!data[agent]) data[agent] = { tokens: 0, cost: 0, turns: 0 };
      data[agent].tokens += s.tokens?.total || 0;
      data[agent].cost += s.cost?.total || 0;
      data[agent].turns += s.turns || 0;
    }
    const entries = Object.entries(data).filter(([, d]) => d.turns > 0);
    if (entries.length === 0) return emptyChart('No efficiency data available');
    const sorted = entries.sort(([, a], [, b]) => (b.tokens / b.turns) - (a.tokens / a.turns));
    return {
      type: 'bar',
      title: 'Tokens per Turn (Efficiency)',
      labels: sorted.map(([n]) => shortAgentName(n)),
      datasets: [{ label: 'Tokens/Turn', values: sorted.map(([, d]) => Math.round(d.tokens / d.turns)), color: 5 }],
      formatValue: formatTokens,
    };
  }

  function overviewChart() {
    const sessions = getSessions();
    const agents = new Set(sessions.map(s => s.agent));
    const totalTokens = sessions.reduce((s, x) => s + (x.tokens?.total || 0), 0);
    const totalCost = sessions.reduce((s, x) => s + (x.cost?.total || 0), 0);
    return {
      type: 'bar',
      title: 'Fleet Overview',
      labels: ['Total Tokens', 'Cost ($)', 'Sessions', 'Agents'],
      datasets: [{
        label: 'Overview',
        values: [totalTokens, totalCost, sessions.length, agents.size],
        color: 0,
      }],
      formatValue: (v, idx) => {
        if (idx === 0) return formatTokens(v);
        if (idx === 1) return '$' + v.toFixed(2);
        return v.toString();
      },
    };
  }

  function emptyChart(message) {
    return { type: 'empty', message };
  }

  // ─── Helpers ───

  function findAgent(sessions, query) {
    const q = query.toLowerCase().replace(/['"]/g, '');
    const agents = [...new Set(sessions.map(s => s.agent))];
    // Exact match
    let found = agents.find(a => a.toLowerCase() === q);
    if (found) return found;
    // Partial match
    found = agents.find(a => a.toLowerCase().includes(q));
    if (found) return found;
    // Prefix
    found = agents.find(a => a.toLowerCase().startsWith(q));
    return found || null;
  }

  function shortAgentName(name) {
    if (name.length > 16) return name.slice(0, 14) + '…';
    return name;
  }

  function shortModelName(name) {
    return name.replace('claude-', '').replace(/-\d{8}$/, '');
  }

  function formatDateLabel(d) {
    // "2026-02-11" → "Feb 11"
    const parts = d.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10);
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return n.toString();
  }

  function formatNumber(n) {
    return n.toLocaleString('en-US');
  }

  // ─── Canvas Chart Renderers ───

  function renderChart(chart) {
    currentChart = chart;
    animProgress = 0;
    chartRegions = [];
    hoverInfo = null;

    if (animFrame) cancelAnimationFrame(animFrame);

    if (!chart || chart.type === 'empty') {
      drawEmpty(chart?.message || 'No data');
      return;
    }

    animateChart();
  }

  function animateChart() {
    if (!analyticsActive || !currentChart) return;
    animProgress = Math.min(1, animProgress + 0.035);
    const eased = easeOutCubic(animProgress);

    drawChartFrame(currentChart, eased);

    if (animProgress < 1) {
      animFrame = requestAnimationFrame(animateChart);
    }
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function drawChartFrame(chart, progress) {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);

    // Grid
    drawChartGrid(w, h);

    // Title
    ctx.font = 'bold 13px "SF Mono", "Cascadia Code", "Fira Code", monospace';
    ctx.fillStyle = P.textBright;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(chart.title, 20, 16);

    // Legend for multi-dataset
    if (chart.datasets && chart.datasets.length > 1) {
      drawLegend(chart, w);
    }

    chartRegions = [];

    switch (chart.type) {
      case 'bar': drawBarChart(chart, w, h, progress); break;
      case 'line': drawLineChart(chart, w, h, progress); break;
      case 'grouped-bar': drawGroupedBarChart(chart, w, h, progress); break;
      case 'donut': drawDonutChart(chart, w, h, progress); break;
    }

    // Hover tooltip
    if (hoverInfo) drawTooltip(hoverInfo, w, h);
  }

  function drawChartGrid(w, h) {
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    const spacing = 50;
    for (let y = 40; y < h; y += spacing) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let x = 0; x < w; x += spacing) {
      ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  function drawLegend(chart, w) {
    ctx.font = '10px "SF Mono", "Cascadia Code", "Fira Code", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    let x = w - 20;
    for (let i = chart.datasets.length - 1; i >= 0; i--) {
      const ds = chart.datasets[i];
      const c = CHART_COLORS[ds.color % CHART_COLORS.length];
      const label = ds.label;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = P.text;
      ctx.fillText(label, x, 18);
      ctx.fillStyle = c.hex;
      ctx.fillRect(x - tw - 16, 20, 10, 10);
      x -= tw + 28;
    }
  }

  // ─── Bar Chart ───

  function drawBarChart(chart, w, h, progress) {
    const ds = chart.datasets[0];
    const vals = ds.values;
    const labels = chart.labels;
    const n = vals.length;

    const padLeft = 80, padRight = 30, padTop = 50, padBot = 50;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBot;
    const maxVal = Math.max(...vals, 1);
    const barGap = Math.max(4, chartW * 0.08 / n);
    const barW = Math.max(8, (chartW - barGap * (n + 1)) / n);

    const c = CHART_COLORS[ds.color % CHART_COLORS.length];

    // Y-axis labels
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v = (maxVal / yTicks) * i;
      const y = padTop + chartH - (i / yTicks) * chartH;
      ctx.fillText(chart.formatValue(v, 0), padLeft - 8, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(w - padRight, y); ctx.stroke();
    }

    // Bars
    for (let i = 0; i < n; i++) {
      const x = padLeft + barGap + i * (barW + barGap);
      const barH = (vals[i] / maxVal) * chartH * progress;
      const y = padTop + chartH - barH;

      // Glow
      ctx.shadowColor = c.hex;
      ctx.shadowBlur = 12;
      ctx.fillStyle = `rgba(${c.rgb}, 0.7)`;
      ctx.fillRect(x, y, barW, barH);
      ctx.shadowBlur = 0;

      // Inner gradient
      const grad = ctx.createLinearGradient(x, y, x, padTop + chartH);
      grad.addColorStop(0, `rgba(${c.rgb}, 0.9)`);
      grad.addColorStop(1, `rgba(${c.rgb}, 0.3)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, barH);

      // Top highlight
      ctx.fillStyle = `rgba(${c.rgb}, 1)`;
      ctx.fillRect(x, y, barW, 2);

      // X label
      ctx.save();
      ctx.font = '9px "SF Mono", monospace';
      ctx.fillStyle = P.textDim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelX = x + barW / 2;
      const labelY = padTop + chartH + 8;
      if (n <= 12) {
        ctx.fillText(labels[i], labelX, labelY);
      } else if (i % Math.ceil(n / 10) === 0) {
        ctx.fillText(labels[i], labelX, labelY);
      }
      ctx.restore();

      // Hit region
      chartRegions.push({
        x, y: padTop, w: barW, h: chartH,
        label: labels[i],
        value: chart.formatValue(vals[i], i),
        rawValue: vals[i],
      });
    }
  }

  // ─── Line Chart ───

  function drawLineChart(chart, w, h, progress) {
    const ds = chart.datasets[0];
    const vals = ds.values;
    const labels = chart.labels;
    const n = vals.length;
    if (n < 2) { drawBarChart(chart, w, h, progress); return; }

    const padLeft = 80, padRight = 30, padTop = 50, padBot = 50;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBot;
    const maxVal = Math.max(...vals, 1);
    const c = CHART_COLORS[ds.color % CHART_COLORS.length];

    // Y-axis
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v = (maxVal / yTicks) * i;
      const y = padTop + chartH - (i / yTicks) * chartH;
      ctx.fillText(chart.formatValue(v, 0), padLeft - 8, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(w - padRight, y); ctx.stroke();
    }

    // Points
    const points = [];
    for (let i = 0; i < n; i++) {
      const x = padLeft + (i / (n - 1)) * chartW;
      const y = padTop + chartH - (vals[i] / maxVal) * chartH;
      points.push({ x, y });
    }

    // Draw up to progress
    const drawN = Math.ceil(n * progress);

    // Area fill
    ctx.beginPath();
    ctx.moveTo(points[0].x, padTop + chartH);
    for (let i = 0; i < drawN; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(points[drawN - 1].x, padTop + chartH);
    ctx.closePath();
    const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
    areaGrad.addColorStop(0, `rgba(${c.rgb}, 0.15)`);
    areaGrad.addColorStop(1, `rgba(${c.rgb}, 0)`);
    ctx.fillStyle = areaGrad;
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < drawN; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = c.hex;
    ctx.lineWidth = 2;
    ctx.shadowColor = c.hex;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dots
    for (let i = 0; i < drawN; i++) {
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c.rgb}, 0.9)`;
      ctx.shadowColor = c.hex;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Inner bright dot
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 2, 0, Math.PI * 2);
      ctx.fillStyle = P.textBright;
      ctx.fill();
    }

    // X labels
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      if (n <= 12 || i % Math.ceil(n / 10) === 0) {
        ctx.fillText(labels[i], points[i].x, padTop + chartH + 8);
      }
    }

    // Hit regions
    for (let i = 0; i < n; i++) {
      chartRegions.push({
        x: points[i].x - 12, y: points[i].y - 12, w: 24, h: 24,
        label: labels[i],
        value: chart.formatValue(vals[i], i),
        rawValue: vals[i],
        isCircle: true, cx: points[i].x, cy: points[i].y, cr: 12,
      });
    }
  }

  // ─── Grouped Bar Chart ───

  function drawGroupedBarChart(chart, w, h, progress) {
    const labels = chart.labels;
    const datasets = chart.datasets;
    const n = labels.length;
    const m = datasets.length;

    const padLeft = 80, padRight = 30, padTop = 50, padBot = 50;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBot;

    // Determine max value across all datasets per category
    // For grouped bar with different scales, normalize per category
    const maxVals = [];
    for (let i = 0; i < n; i++) {
      let mv = 0;
      for (const ds of datasets) mv = Math.max(mv, ds.values[i] || 0);
      maxVals.push(mv || 1);
    }

    const groupW = chartW / n;
    const barGap = 4;
    const barW = Math.max(8, (groupW - barGap * (m + 1)) / m);

    // Y-axis — use max of all values
    const globalMax = Math.max(...maxVals, 1);

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const ds = datasets[j];
        const c = CHART_COLORS[ds.color % CHART_COLORS.length];
        const x = padLeft + i * groupW + barGap + j * (barW + barGap);
        const val = ds.values[i] || 0;
        const barH = (val / globalMax) * chartH * progress;
        const y = padTop + chartH - barH;

        ctx.shadowColor = c.hex;
        ctx.shadowBlur = 8;
        const grad = ctx.createLinearGradient(x, y, x, padTop + chartH);
        grad.addColorStop(0, `rgba(${c.rgb}, 0.85)`);
        grad.addColorStop(1, `rgba(${c.rgb}, 0.3)`);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);
        ctx.shadowBlur = 0;

        ctx.fillStyle = `rgba(${c.rgb}, 1)`;
        ctx.fillRect(x, y, barW, 2);

        chartRegions.push({
          x, y: padTop, w: barW, h: chartH,
          label: `${labels[i]} — ${ds.label}`,
          value: chart.formatValue(val, i),
          rawValue: val,
        });
      }

      // Group label
      ctx.font = '9px "SF Mono", monospace';
      ctx.fillStyle = P.textDim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(labels[i], padLeft + i * groupW + groupW / 2, padTop + chartH + 8);
    }
  }

  // ─── Donut Chart ───

  function drawDonutChart(chart, w, h, progress) {
    const values = chart.values;
    const labels = chart.labels;
    const total = values.reduce((s, v) => s + v, 0) || 1;

    const cx = w * 0.42;
    const cy = h * 0.52;
    const outerR = Math.min(w * 0.28, h * 0.35);
    const innerR = outerR * 0.55;

    let angle = -Math.PI / 2;
    const endAngle = -Math.PI / 2 + Math.PI * 2 * progress;

    for (let i = 0; i < values.length; i++) {
      const sliceAngle = (values[i] / total) * Math.PI * 2;
      const drawAngle = Math.min(sliceAngle, endAngle - angle);
      if (drawAngle <= 0) break;

      const c = CHART_COLORS[i % CHART_COLORS.length];

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, angle, angle + drawAngle);
      ctx.arc(cx, cy, innerR, angle + drawAngle, angle, true);
      ctx.closePath();

      ctx.fillStyle = `rgba(${c.rgb}, 0.75)`;
      ctx.shadowColor = c.hex;
      ctx.shadowBlur = 15;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Outer edge glow
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, angle, angle + drawAngle);
      ctx.strokeStyle = `rgba(${c.rgb}, 0.9)`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Hit region (use mid-angle for tooltip)
      const midAngle = angle + drawAngle / 2;
      const hitR = (outerR + innerR) / 2;
      chartRegions.push({
        isArc: true,
        cx, cy,
        innerR, outerR,
        startAngle: angle,
        endAngle: angle + drawAngle,
        label: labels[i],
        value: chart.formatValue(values[i]) + ` (${(values[i] / total * 100).toFixed(1)}%)`,
        rawValue: values[i],
      });

      angle += drawAngle;
    }

    // Center text
    ctx.font = 'bold 18px "SF Mono", monospace';
    ctx.fillStyle = P.textBright;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chart.formatValue(total), cx, cy - 6);
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('TOTAL', cx, cy + 12);

    // Legend on the right
    const legendX = w * 0.72;
    let legendY = h * 0.2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < labels.length; i++) {
      const c = CHART_COLORS[i % CHART_COLORS.length];
      ctx.fillStyle = c.hex;
      ctx.fillRect(legendX, legendY - 5, 10, 10);
      ctx.font = '10px "SF Mono", monospace';
      ctx.fillStyle = P.text;
      ctx.fillText(labels[i], legendX + 16, legendY);
      ctx.font = '9px "SF Mono", monospace';
      ctx.fillStyle = P.textDim;
      ctx.fillText(chart.formatValue(values[i]), legendX + 16, legendY + 14);
      legendY += 32;
    }
  }

  // ─── Empty State ───

  function drawEmpty(message) {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    drawChartGrid(w, h);

    ctx.font = '12px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message || 'No data to display', w / 2, h / 2);
  }

  // ─── Tooltip ───

  function drawTooltip(info, w, h) {
    const pad = 10;
    const lineH = 16;
    const lines = [info.label, info.value];
    ctx.font = '11px "SF Mono", monospace';
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    const tipW = maxW + pad * 2;
    const tipH = lines.length * lineH + pad * 2;

    let tx = mouseX + 16;
    let ty = mouseY - tipH / 2;
    if (tx + tipW > w - 10) tx = mouseX - tipW - 16;
    if (ty < 10) ty = 10;
    if (ty + tipH > h - 10) ty = h - tipH - 10;

    ctx.fillStyle = P.panelBg;
    ctx.strokeStyle = P.panelBorder;
    ctx.lineWidth = 1;
    ctx.shadowColor = P.cyan;
    ctx.shadowBlur = 12;
    roundRect(ctx, tx, ty, tipW, tipH, 5);
    ctx.fill();
    ctx.shadowBlur = 0;
    roundRect(ctx, tx, ty, tipW, tipH, 5);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 11px "SF Mono", monospace';
    ctx.fillStyle = P.textBright;
    ctx.fillText(lines[0], tx + pad, ty + pad);
    ctx.font = '11px "SF Mono", monospace';
    ctx.fillStyle = P.cyan;
    ctx.fillText(lines[1], tx + pad, ty + pad + lineH);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ─── Mouse Handling ───

  function handleMouseMove(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);

    hoverInfo = null;
    for (const r of chartRegions) {
      if (r.isArc) {
        const dx = mouseX - r.cx, dy = mouseY - r.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= r.innerR && dist <= r.outerR) {
          let angle = Math.atan2(dy, dx);
          // Normalize angles
          const normAngle = (a) => { while (a < -Math.PI) a += Math.PI * 2; while (a > Math.PI) a -= Math.PI * 2; return a; };
          // Check if angle is within slice
          const s = normAngle(r.startAngle);
          const e = normAngle(r.endAngle);
          const a = normAngle(angle);
          // Simple check: if arc spans the boundary, handle specially
          let inSlice = false;
          if (r.endAngle - r.startAngle >= Math.PI * 2 - 0.01) {
            inSlice = true;
          } else if (r.startAngle <= r.endAngle) {
            inSlice = angle >= r.startAngle && angle <= r.endAngle;
          } else {
            inSlice = angle >= r.startAngle || angle <= r.endAngle;
          }
          if (inSlice) { hoverInfo = r; break; }
        }
      } else if (r.isCircle) {
        const dx = mouseX - r.cx, dy = mouseY - r.cy;
        if (dx * dx + dy * dy < r.cr * r.cr) { hoverInfo = r; break; }
      } else {
        if (mouseX >= r.x && mouseX <= r.x + r.w && mouseY >= r.y && mouseY <= r.y + r.h) {
          hoverInfo = r; break;
        }
      }
    }

    canvas.style.cursor = hoverInfo ? 'pointer' : 'default';

    // Redraw with tooltip
    if (currentChart && currentChart.type !== 'empty') {
      drawChartFrame(currentChart, Math.min(1, animProgress));
    }
  }

  // ─── Chat UI ───

  function initChat() {
    const chatMsgs = document.getElementById('analytics-chat-messages');
    const chatInput = document.getElementById('analytics-chat-input');
    if (!chatMsgs || !chatInput) return;

    // Welcome message
    addSystemMessage(
      'Ask me about your agent fleet metrics.\n\n' +
      'Try:\n' +
      '  • "token burn by day"\n' +
      '  • "which agent burned the most tokens?"\n' +
      '  • "cost over time"\n' +
      '  • "compare today vs yesterday"\n' +
      '  • "model breakdown"\n' +
      '  • "sessions over time"\n' +
      '  • "input vs output"\n' +
      '  • "efficiency"'
    );

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const query = chatInput.value.trim();
        if (!query) return;
        chatInput.value = '';
        processQuery(query);
      }
    });
  }

  async function processQuery(query) {
    addUserMessage(query);

    // Ensure data
    if (!sessionsCache) {
      addSystemMessage('Fetching data…');
      await fetchData();
    }

    if (query.trim().toLowerCase() === 'help') {
      addSystemMessage(
        'Available queries:\n' +
        '  • token burn by day\n' +
        '  • tokens by agent / which agent burned the most\n' +
        '  • cost over time / cost trend\n' +
        '  • cost by agent\n' +
        '  • compare <agent> vs <agent>\n' +
        '  • today vs yesterday\n' +
        '  • model breakdown\n' +
        '  • cost breakdown\n' +
        '  • sessions over time\n' +
        '  • input vs output\n' +
        '  • turns by agent\n' +
        '  • efficiency\n' +
        '  • overview'
      );
      return;
    }

    const result = interpretQuery(query);
    if (!result) {
      addSystemMessage(
        'I couldn\'t understand that query.\n\n' +
        'Try asking:\n' +
        '  • "token burn by day"\n' +
        '  • "which agent burned the most?"\n' +
        '  • "cost over time"\n' +
        '  • "model breakdown"\n' +
        '  • "help" for full list'
      );
      return;
    }

    const chart = result.handler(result.match);
    if (!chart || chart.type === 'empty') {
      addSystemMessage(chart?.message || 'No data available for that query.');
      renderChart(chart);
      return;
    }

    addSystemMessage(`📊 ${chart.title}`);
    renderChart(chart);
  }

  function addUserMessage(text) {
    const chatMsgs = document.getElementById('analytics-chat-messages');
    if (!chatMsgs) return;
    const el = document.createElement('div');
    el.className = 'achat-msg achat-user';
    el.textContent = text;
    chatMsgs.appendChild(el);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  function addSystemMessage(text) {
    const chatMsgs = document.getElementById('analytics-chat-messages');
    if (!chatMsgs) return;
    const el = document.createElement('div');
    el.className = 'achat-msg achat-system';
    el.textContent = text;
    chatMsgs.appendChild(el);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  // ─── Canvas Setup ───

  function setupCanvas() {
    canvas = document.getElementById('analytics-chart-canvas');
    if (!canvas) return;
    resizeCanvas();
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', () => {
      hoverInfo = null;
      if (currentChart && currentChart.type !== 'empty') {
        drawChartFrame(currentChart, Math.min(1, animProgress));
      }
    });
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    ctx = canvas.getContext('2d');
    if (currentChart && currentChart.type !== 'empty') {
      drawChartFrame(currentChart, Math.min(1, animProgress));
    } else {
      drawEmpty('Ask a question to see a chart');
    }
  }

  // ─── Public API ───

  window.analyticsInit = async function() {
    if (analyticsActive) return;
    analyticsActive = true;
    setupCanvas();
    initChat();
    await fetchData();
    drawEmpty('Ask a question to see a chart');
  };

  window.analyticsDestroy = function() {
    analyticsActive = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    sessionsCache = null;
    summaryCache = null;
    currentChart = null;
    chartRegions = [];
    window.removeEventListener('resize', resizeCanvas);
  };

})();
