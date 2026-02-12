// ═══════════════════════════════════════════════════════════════════════════
// Agent Fleet Metrics — Token Burn Visualization
// Canvas-based force-directed agent tree, animated connections, sparklines
// ═══════════════════════════════════════════════════════════════════════════

const METRICS_API = '/ui/api';

// ─── Color Palette ───
const C = {
  bg:        '#0a0a0f',
  grid:      'rgba(0, 255, 213, 0.03)',
  gridBright:'rgba(0, 255, 213, 0.06)',
  cyan:      '#00ffd5',
  cyanDim:   'rgba(0, 255, 213, 0.3)',
  cyanGlow:  'rgba(0, 255, 213, 0.15)',
  purple:    '#b44aff',
  purpleDim: 'rgba(180, 74, 255, 0.3)',
  amber:     '#ffaa00',
  amberDim:  'rgba(255, 170, 0, 0.3)',
  red:       '#ff4466',
  text:      '#c0c0c0',
  textBright:'#ffffff',
  textDim:   '#555566',
  panel:     'rgba(12, 12, 20, 0.85)',
  panelBorder:'rgba(0, 255, 213, 0.12)',
};

// ─── State ───
let summaryData = null;
let sessionsData = null;
let treeNodes = [];
let treeEdges = [];
let animFrame = null;
let hoveredNode = null;
let selectedNode = null;
let mouseX = 0, mouseY = 0;
let canvasW = 0, canvasH = 0;
let treeCanvas, treeCtx;
let timelineCanvas, timelineCtx;
let metricsActive = false;
let lastFetchTime = 0;
let animTime = 0;
let particleSystems = [];

// Animated counter targets
let counterTargets = { tokens: 0, cost: 0, sessions: 0, agents: 0 };
let counterValues = { tokens: 0, cost: 0, sessions: 0, agents: 0 };

// ─── Data Fetching ───

async function fetchMetricsData() {
  try {
    const [summaryRes, sessionsRes] = await Promise.all([
      fetch(`${METRICS_API}/usage?range=30d`).then(r => r.ok ? r.json() : null),
      fetch(`${METRICS_API}/usage/sessions?range=30d`).then(r => r.ok ? r.json() : null),
    ]);
    summaryData = summaryRes;
    sessionsData = sessionsRes;
    lastFetchTime = Date.now();

    if (summaryData?.totals) {
      counterTargets.tokens = summaryData.totals.tokens || 0;
      counterTargets.cost = summaryData.totals.cost || 0;
      counterTargets.sessions = summaryData.totals.sessions || 0;
      counterTargets.agents = summaryData.byAgent ? Object.keys(summaryData.byAgent).length : 0;
    }

    buildTree();
    renderMetricsPanel();
  } catch (e) {
    console.error('Metrics fetch error:', e);
    useDemoData();
  }
}

function useDemoData() {
  summaryData = {
    range: '30d',
    totals: { tokens: 6842103, cost: 18.47, sessions: 17, vms: 8 },
    byAgent: {
      'orchestrator': { tokens: 2100000, cost: 5.80, sessions: 3 },
      'lt-share-links': { tokens: 1450000, cost: 3.92, sessions: 3 },
      'lt-usage': { tokens: 980000, cost: 2.65, sessions: 2 },
      'lt-bump': { tokens: 720000, cost: 1.95, sessions: 2 },
      'lt-inception': { tokens: 540000, cost: 1.46, sessions: 2 },
      'sub-lt-hello': { tokens: 320000, cost: 0.87, sessions: 1 },
      'lt-deploy': { tokens: 430000, cost: 1.16, sessions: 2 },
      'lt-metrics-ui': { tokens: 302103, cost: 0.66, sessions: 2 },
    }
  };
  sessionsData = {
    sessions: [
      { agent: 'orchestrator', parentAgent: null, model: 'claude-sonnet-4-20250514', tokens: { total: 800000, input: 500000, output: 300000 }, cost: { total: 2.20 }, turns: 15, startedAt: new Date(Date.now() - 3600000*4).toISOString(), endedAt: new Date(Date.now() - 3600000*3).toISOString() },
      { agent: 'orchestrator', parentAgent: null, model: 'claude-sonnet-4-20250514', tokens: { total: 700000, input: 420000, output: 280000 }, cost: { total: 1.90 }, turns: 12, startedAt: new Date(Date.now() - 7200000).toISOString(), endedAt: new Date(Date.now() - 3600000).toISOString() },
      { agent: 'lt-share-links', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 500000, input: 300000, output: 200000 }, cost: { total: 1.35 }, turns: 8, startedAt: new Date(Date.now() - 3600000*3.5).toISOString(), endedAt: new Date(Date.now() - 3600000*2.5).toISOString() },
      { agent: 'lt-share-links', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 480000, input: 280000, output: 200000 }, cost: { total: 1.30 }, turns: 10, startedAt: new Date(Date.now() - 5400000).toISOString(), endedAt: new Date(Date.now() - 3600000).toISOString() },
      { agent: 'lt-usage', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 490000, input: 290000, output: 200000 }, cost: { total: 1.33 }, turns: 9, startedAt: new Date(Date.now() - 3600000*3).toISOString(), endedAt: new Date(Date.now() - 3600000*2).toISOString() },
      { agent: 'lt-bump', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 360000, input: 200000, output: 160000 }, cost: { total: 0.97 }, turns: 7, startedAt: new Date(Date.now() - 3600000*2.8).toISOString(), endedAt: new Date(Date.now() - 3600000*2).toISOString() },
      { agent: 'lt-inception', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 300000, input: 180000, output: 120000 }, cost: { total: 0.81 }, turns: 6, startedAt: new Date(Date.now() - 3600000*2.5).toISOString(), endedAt: new Date(Date.now() - 3600000*1.5).toISOString() },
      { agent: 'sub-lt-hello', parentAgent: 'lt-inception', model: 'claude-sonnet-4-20250514', tokens: { total: 320000, input: 190000, output: 130000 }, cost: { total: 0.87 }, turns: 5, startedAt: new Date(Date.now() - 3600000*2).toISOString(), endedAt: new Date(Date.now() - 3600000*1.2).toISOString() },
      { agent: 'lt-deploy', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 430000, input: 250000, output: 180000 }, cost: { total: 1.16 }, turns: 11, startedAt: new Date(Date.now() - 1800000).toISOString(), endedAt: new Date(Date.now() - 600000).toISOString() },
      { agent: 'lt-metrics-ui', parentAgent: 'orchestrator', model: 'claude-sonnet-4-20250514', tokens: { total: 302103, input: 180000, output: 122103 }, cost: { total: 0.66 }, turns: 8, startedAt: new Date(Date.now() - 900000).toISOString(), endedAt: new Date().toISOString() },
    ],
    count: 10
  };

  counterTargets.tokens = summaryData.totals.tokens;
  counterTargets.cost = summaryData.totals.cost;
  counterTargets.sessions = summaryData.totals.sessions;
  counterTargets.agents = Object.keys(summaryData.byAgent).length;

  buildTree();
  renderMetricsPanel();
}

// ─── Tree Building ───

function buildTree() {
  if (!summaryData || !sessionsData) return;

  const agents = summaryData.byAgent || {};
  const sessions = sessionsData.sessions || [];

  // Build parent map from sessions
  const parentMap = {};
  const modelMap = {};
  const sessionCountMap = {};

  for (const s of sessions) {
    if (s.parentAgent) {
      parentMap[s.agent] = s.parentAgent;
    }
    modelMap[s.agent] = s.model;
    sessionCountMap[s.agent] = (sessionCountMap[s.agent] || 0) + 1;
  }

  // Build nodes
  const maxTokens = Math.max(...Object.values(agents).map(a => a.tokens || 0), 1);
  treeNodes = [];
  const nodeIndex = {};

  // Find root(s) — agents with no parent
  const allAgents = Object.keys(agents);
  const roots = allAgents.filter(a => !parentMap[a]);
  if (roots.length === 0 && allAgents.length > 0) roots.push(allAgents[0]);

  for (const name of allAgents) {
    const a = agents[name];
    const tokenRatio = (a.tokens || 0) / maxTokens;
    const isRoot = roots.includes(name);
    const radius = 18 + tokenRatio * 32;

    // Determine recent activity for glow intensity
    const agentSessions = sessions.filter(s => s.agent === name);
    const latestEnd = agentSessions.reduce((max, s) => {
      const t = new Date(s.endedAt).getTime();
      return t > max ? t : max;
    }, 0);
    const recency = Math.max(0, 1 - (Date.now() - latestEnd) / (24 * 3600000)); // 0-1 over 24h

    const node = {
      name,
      x: 0, y: 0,
      vx: 0, vy: 0,
      radius,
      tokens: a.tokens || 0,
      cost: a.cost || 0,
      sessions: a.sessions || 0,
      model: modelMap[name] || 'unknown',
      isRoot,
      parent: parentMap[name] || null,
      recency,
      tokenRatio,
      glowPhase: Math.random() * Math.PI * 2,
    };

    treeNodes.push(node);
    nodeIndex[name] = node;
  }

  // Position nodes — hierarchical layout with some randomness
  layoutTree(roots, nodeIndex);

  // Build edges
  treeEdges = [];
  for (const node of treeNodes) {
    if (node.parent && nodeIndex[node.parent]) {
      const parent = nodeIndex[node.parent];
      const tokenFlow = node.tokens / maxTokens;
      treeEdges.push({
        source: parent,
        target: node,
        tokenFlow,
        particles: [],
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  // Init particles on edges
  for (const edge of treeEdges) {
    const count = 2 + Math.floor(edge.tokenFlow * 6);
    for (let i = 0; i < count; i++) {
      edge.particles.push({
        t: Math.random(),
        speed: 0.003 + Math.random() * 0.004,
        size: 1.5 + edge.tokenFlow * 2.5,
        alpha: 0.4 + Math.random() * 0.6,
      });
    }
  }
}

function layoutTree(roots, nodeIndex) {
  if (treeNodes.length === 0) return;

  // BFS to assign levels
  const levels = {};
  const queue = [];
  for (const r of roots) {
    if (nodeIndex[r]) {
      levels[r] = 0;
      queue.push(r);
    }
  }

  while (queue.length > 0) {
    const name = queue.shift();
    const children = treeNodes.filter(n => n.parent === name);
    for (const child of children) {
      if (levels[child.name] === undefined) {
        levels[child.name] = (levels[name] || 0) + 1;
        queue.push(child.name);
      }
    }
  }

  // Assign any unvisited nodes
  for (const node of treeNodes) {
    if (levels[node.name] === undefined) levels[node.name] = 1;
  }

  // Group by level
  const byLevel = {};
  for (const node of treeNodes) {
    const lv = levels[node.name];
    if (!byLevel[lv]) byLevel[lv] = [];
    byLevel[lv].push(node);
  }

  const levelKeys = Object.keys(byLevel).map(Number).sort((a, b) => a - b);

  // Position
  const cx = canvasW / 2;
  const cy = canvasH * 0.18;
  const levelSpacing = Math.min(canvasH * 0.28, 180);

  for (const lv of levelKeys) {
    const nodes = byLevel[lv];
    const count = nodes.length;
    const totalWidth = canvasW * 0.7;
    const spacing = count > 1 ? totalWidth / (count - 1) : 0;
    const startX = cx - totalWidth / 2;

    for (let i = 0; i < count; i++) {
      nodes[i].x = count === 1 ? cx : startX + i * spacing;
      nodes[i].y = cy + lv * levelSpacing;
      // Add slight randomness
      nodes[i].x += (Math.random() - 0.5) * 20;
      nodes[i].y += (Math.random() - 0.5) * 10;
    }
  }
}

// ─── Force Simulation (gentle, just for organic movement) ───

function tickForces() {
  const centerX = canvasW / 2;
  const centerY = canvasH * 0.4;
  const damping = 0.92;
  const repulsion = 2000;
  const edgeAttraction = 0.003;
  const centerGravity = 0.0002;

  // Repulsion between nodes
  for (let i = 0; i < treeNodes.length; i++) {
    for (let j = i + 1; j < treeNodes.length; j++) {
      const a = treeNodes[i], b = treeNodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const minDist = a.radius + b.radius + 40;
      if (dist < minDist * 3) {
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
  }

  // Edge attraction
  for (const edge of treeEdges) {
    const dx = edge.target.x - edge.source.x;
    const dy = edge.target.y - edge.source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const idealDist = 160;
    const force = (dist - idealDist) * edgeAttraction;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    edge.source.vx += fx; edge.source.vy += fy;
    edge.target.vx -= fx; edge.target.vy -= fy;
  }

  // Center gravity
  for (const node of treeNodes) {
    node.vx += (centerX - node.x) * centerGravity;
    node.vy += (centerY - node.y) * centerGravity * 0.3;
  }

  // Apply velocities
  for (const node of treeNodes) {
    node.vx *= damping;
    node.vy *= damping;
    node.x += node.vx;
    node.y += node.vy;

    // Keep in bounds
    node.x = Math.max(node.radius + 20, Math.min(canvasW - node.radius - 20, node.x));
    node.y = Math.max(node.radius + 20, Math.min(canvasH - node.radius - 20, node.y));
  }
}

// ─── Canvas Rendering — Tree ───

function drawTree(time) {
  if (!treeCtx) return;
  const ctx = treeCtx;
  ctx.clearRect(0, 0, canvasW, canvasH);

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  drawGrid(ctx, time);
  drawEdges(ctx, time);
  drawNodes(ctx, time);
  drawHoverTooltip(ctx);
}

function drawGrid(ctx, time) {
  const spacing = 50;
  ctx.lineWidth = 1;

  // Horizontal lines
  for (let y = 0; y < canvasH; y += spacing) {
    const dist = Math.abs(y - canvasH / 2) / canvasH;
    ctx.strokeStyle = dist < 0.3 ? C.gridBright : C.grid;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasW, y);
    ctx.stroke();
  }

  // Vertical lines
  for (let x = 0; x < canvasW; x += spacing) {
    const dist = Math.abs(x - canvasW / 2) / canvasW;
    ctx.strokeStyle = dist < 0.3 ? C.gridBright : C.grid;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasH);
    ctx.stroke();
  }

  // Scanning line effect
  const scanY = ((time * 0.02) % (canvasH + 200)) - 100;
  const grad = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 40);
  grad.addColorStop(0, 'rgba(0, 255, 213, 0)');
  grad.addColorStop(0.5, 'rgba(0, 255, 213, 0.03)');
  grad.addColorStop(1, 'rgba(0, 255, 213, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, scanY - 40, canvasW, 80);
}

function drawEdges(ctx, time) {
  for (const edge of treeEdges) {
    const sx = edge.source.x, sy = edge.source.y;
    const tx = edge.target.x, ty = edge.target.y;

    // Bezier control points — organic curves
    const midX = (sx + tx) / 2;
    const midY = (sy + ty) / 2;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const curvature = dist * 0.15;
    const cp1x = sx + dx * 0.25 - dy * 0.1;
    const cp1y = sy + dy * 0.25 + Math.abs(dx) * 0.05;
    const cp2x = sx + dx * 0.75 + dy * 0.1;
    const cp2y = sy + dy * 0.75 - Math.abs(dx) * 0.05;

    // Edge glow
    const intensity = 0.15 + edge.tokenFlow * 0.4;
    const pulseIntensity = intensity + Math.sin(time * 0.002 + edge.phase) * 0.08;

    // Outer glow
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tx, ty);
    ctx.strokeStyle = `rgba(0, 255, 213, ${pulseIntensity * 0.3})`;
    ctx.lineWidth = 3 + edge.tokenFlow * 6;
    ctx.shadowColor = C.cyan;
    ctx.shadowBlur = 15 + edge.tokenFlow * 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Core line
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tx, ty);
    ctx.strokeStyle = `rgba(0, 255, 213, ${pulseIntensity})`;
    ctx.lineWidth = 1 + edge.tokenFlow * 2;
    ctx.stroke();

    // Particles flowing along the edge
    for (const p of edge.particles) {
      p.t += p.speed;
      if (p.t > 1) p.t -= 1;

      // Bezier position at t
      const t = p.t;
      const t2 = t * t, t3 = t2 * t;
      const mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt;
      const px = mt3 * sx + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * tx;
      const py = mt3 * sy + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * ty;

      // Particle glow
      ctx.beginPath();
      ctx.arc(px, py, p.size + 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 255, 213, ${p.alpha * 0.2})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 255, 213, ${p.alpha * 0.7})`;
      ctx.fill();

      // Bright core
      ctx.beginPath();
      ctx.arc(px, py, p.size * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.8})`;
      ctx.fill();
    }
  }
}

function drawNodes(ctx, time) {
  for (const node of treeNodes) {
    const isHovered = hoveredNode === node;
    const isSelected = selectedNode === node;
    const baseRadius = node.radius;
    const pulse = Math.sin(time * 0.003 + node.glowPhase) * 2;
    const r = baseRadius + pulse + (isHovered ? 4 : 0);

    // Determine color
    let color, colorDim, colorRgb;
    if (node.isRoot) {
      color = C.amber;
      colorDim = C.amberDim;
      colorRgb = '255, 170, 0';
    } else if (node.name.startsWith('sub-')) {
      color = C.purple;
      colorDim = C.purpleDim;
      colorRgb = '180, 74, 255';
    } else {
      color = C.cyan;
      colorDim = C.cyanDim;
      colorRgb = '0, 255, 213';
    }

    const glowIntensity = 0.3 + node.recency * 0.7;

    // Outer glow ring
    const outerGrad = ctx.createRadialGradient(node.x, node.y, r * 0.8, node.x, node.y, r * 2.5);
    outerGrad.addColorStop(0, `rgba(${colorRgb}, ${glowIntensity * 0.15})`);
    outerGrad.addColorStop(1, `rgba(${colorRgb}, 0)`);
    ctx.beginPath();
    ctx.arc(node.x, node.y, r * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = outerGrad;
    ctx.fill();

    // Node body
    const bodyGrad = ctx.createRadialGradient(node.x - r * 0.2, node.y - r * 0.2, r * 0.1, node.x, node.y, r);
    bodyGrad.addColorStop(0, `rgba(${colorRgb}, ${0.25 + glowIntensity * 0.15})`);
    bodyGrad.addColorStop(0.7, `rgba(${colorRgb}, ${0.08 + glowIntensity * 0.08})`);
    bodyGrad.addColorStop(1, `rgba(${colorRgb}, 0.02)`);

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // Border ring
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${colorRgb}, ${0.4 + glowIntensity * 0.4})`;
    ctx.lineWidth = isHovered || isSelected ? 2.5 : 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHovered ? 20 : 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Inner detail ring (token fill indicator)
    const fillAngle = Math.PI * 2 * node.tokenRatio;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r * 0.65, -Math.PI / 2, -Math.PI / 2 + fillAngle);
    ctx.strokeStyle = `rgba(${colorRgb}, ${0.5 + glowIntensity * 0.3})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Agent name label
    ctx.font = '11px "SF Mono", "Cascadia Code", "Fira Code", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Short name
    let displayName = node.name;
    if (displayName.length > 14) displayName = displayName.slice(0, 12) + '…';

    ctx.fillStyle = `rgba(${colorRgb}, ${0.7 + glowIntensity * 0.3})`;
    ctx.fillText(displayName, node.x, node.y);

    // Token count below
    const tokenStr = formatTokensShort(node.tokens);
    ctx.font = '9px "SF Mono", "Cascadia Code", "Fira Code", monospace';
    ctx.fillStyle = C.textDim;
    ctx.fillText(tokenStr, node.x, node.y + r + 14);
  }
}

function drawHoverTooltip(ctx) {
  if (!hoveredNode) return;
  const node = hoveredNode;

  const lines = [
    node.name,
    `tokens: ${formatNumber(node.tokens)}`,
    `cost: $${node.cost.toFixed(2)}`,
    `sessions: ${node.sessions}`,
    `model: ${node.model}`,
  ];

  const padding = 12;
  const lineHeight = 18;
  const width = 220;
  const height = lines.length * lineHeight + padding * 2;

  let tx = mouseX + 20;
  let ty = mouseY - height / 2;
  if (tx + width > canvasW - 10) tx = mouseX - width - 20;
  if (ty < 10) ty = 10;
  if (ty + height > canvasH - 10) ty = canvasH - height - 10;

  // Tooltip background
  ctx.fillStyle = 'rgba(8, 8, 16, 0.92)';
  ctx.strokeStyle = C.panelBorder;
  ctx.lineWidth = 1;
  ctx.shadowColor = C.cyan;
  ctx.shadowBlur = 15;

  roundRect(ctx, tx, ty, width, height, 6);
  ctx.fill();
  ctx.shadowBlur = 0;
  roundRect(ctx, tx, ty, width, height, 6);
  ctx.stroke();

  // Text
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      ctx.font = 'bold 12px "SF Mono", "Cascadia Code", "Fira Code", monospace';
      ctx.fillStyle = C.textBright;
    } else {
      ctx.font = '11px "SF Mono", "Cascadia Code", "Fira Code", monospace';
      ctx.fillStyle = C.text;
    }
    ctx.fillText(lines[i], tx + padding, ty + padding + i * lineHeight);
  }
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

// ─── Timeline Canvas ───

function drawTimeline(time) {
  if (!timelineCtx || !sessionsData) return;
  const ctx = timelineCtx;
  const w = timelineCanvas.width;
  const h = timelineCanvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  const sessions = sessionsData.sessions || [];
  if (sessions.length === 0) {
    ctx.font = '12px "SF Mono", monospace';
    ctx.fillStyle = C.textDim;
    ctx.textAlign = 'center';
    ctx.fillText('No session data', w / 2, h / 2);
    return;
  }

  // Find time range
  let minTime = Infinity, maxTime = -Infinity;
  for (const s of sessions) {
    const start = new Date(s.startedAt).getTime();
    const end = new Date(s.endedAt).getTime();
    if (start < minTime) minTime = start;
    if (end > maxTime) maxTime = end;
  }
  const duration = maxTime - minTime || 1;

  // Assign lanes per agent
  const agentNames = [...new Set(sessions.map(s => s.agent))];
  const laneHeight = Math.min(28, (h - 50) / agentNames.length);
  const topPad = 30;
  const leftPad = 120;
  const rightPad = 20;
  const chartW = w - leftPad - rightPad;

  // Time axis
  ctx.strokeStyle = 'rgba(0, 255, 213, 0.1)';
  ctx.lineWidth = 1;

  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const x = leftPad + (i / tickCount) * chartW;
    ctx.beginPath();
    ctx.moveTo(x, topPad - 5);
    ctx.lineTo(x, h);
    ctx.stroke();

    const t = new Date(minTime + (i / tickCount) * duration);
    const label = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = C.textDim;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, topPad - 10);
  }

  // Agent colors
  const agentColors = {};
  const palette = [C.cyan, C.purple, C.amber, '#ff6688', '#66aaff', '#88ff66', '#ff88cc', '#66ffcc'];
  agentNames.forEach((name, i) => {
    agentColors[name] = palette[i % palette.length];
  });

  // Agent labels
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '10px "SF Mono", monospace';

  for (let i = 0; i < agentNames.length; i++) {
    const y = topPad + i * laneHeight + laneHeight / 2;
    const name = agentNames[i];
    const shortName = name.length > 14 ? name.slice(0, 12) + '…' : name;
    ctx.fillStyle = agentColors[name];
    ctx.fillText(shortName, leftPad - 8, y);

    // Lane guide line
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(w - rightPad, y);
    ctx.stroke();
  }

  // Session bars
  const maxTokens = Math.max(...sessions.map(s => (s.tokens?.total || 0)), 1);

  for (const s of sessions) {
    const lane = agentNames.indexOf(s.agent);
    if (lane < 0) continue;

    const start = new Date(s.startedAt).getTime();
    const end = new Date(s.endedAt).getTime();
    const x1 = leftPad + ((start - minTime) / duration) * chartW;
    const x2 = leftPad + ((end - minTime) / duration) * chartW;
    const barW = Math.max(x2 - x1, 4);
    const y = topPad + lane * laneHeight + 3;
    const barH = laneHeight - 6;

    const tokenIntensity = (s.tokens?.total || 0) / maxTokens;
    const color = agentColors[s.agent];

    // Parse color for rgba
    const rgb = hexToRgb(color);

    // Bar glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 8 + tokenIntensity * 12;
    ctx.fillStyle = `rgba(${rgb}, ${0.3 + tokenIntensity * 0.5})`;
    roundRect(ctx, x1, y, barW, barH, 3);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Bar border
    ctx.strokeStyle = `rgba(${rgb}, ${0.5 + tokenIntensity * 0.3})`;
    ctx.lineWidth = 1;
    roundRect(ctx, x1, y, barW, barH, 3);
    ctx.stroke();

    // Active pulse effect if session is very recent
    const endAge = Date.now() - end;
    if (endAge < 300000) { // 5 min
      const pulseAlpha = Math.sin(time * 0.004) * 0.15 + 0.15;
      ctx.fillStyle = `rgba(${rgb}, ${pulseAlpha})`;
      roundRect(ctx, x1 - 2, y - 2, barW + 4, barH + 4, 5);
      ctx.fill();
    }
  }
}

function hexToRgb(hex) {
  if (hex.startsWith('rgba') || hex.startsWith('rgb')) {
    const match = hex.match(/[\d.]+/g);
    return match ? `${match[0]}, ${match[1]}, ${match[2]}` : '0, 255, 213';
  }
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '0, 255, 213';
}

// ─── Metrics Panel ───

function renderMetricsPanel() {
  if (!summaryData) return;

  // Model breakdown from sessions
  const modelBreakdown = {};
  if (sessionsData?.sessions) {
    for (const s of sessionsData.sessions) {
      const model = s.model || 'unknown';
      if (!modelBreakdown[model]) modelBreakdown[model] = { tokens: 0, cost: 0, sessions: 0 };
      modelBreakdown[model].tokens += s.tokens?.total || 0;
      modelBreakdown[model].cost += s.cost?.total || 0;
      modelBreakdown[model].sessions++;
    }
  }

  // Agent breakdown
  const agents = summaryData.byAgent || {};
  const agentList = Object.entries(agents)
    .sort(([, a], [, b]) => (b.cost || 0) - (a.cost || 0));

  // Build agent breakdown HTML
  let agentHTML = '';
  const maxAgentTokens = Math.max(...agentList.map(([, a]) => a.tokens || 0), 1);

  for (const [name, data] of agentList) {
    const pct = ((data.tokens || 0) / maxAgentTokens * 100).toFixed(0);
    const isRoot = name === 'orchestrator';
    const barColor = isRoot ? C.amber : name.startsWith('sub-') ? C.purple : C.cyan;
    agentHTML += `
      <div class="m-agent-row">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px">
          <div class="m-agent-name" style="color:${barColor}">${esc(name)}</div>
          <div style="display:flex;gap:8px">
            <span class="m-agent-tokens">${formatTokensShort(data.tokens || 0)}</span>
            <span class="m-agent-cost">$${(data.cost || 0).toFixed(2)}</span>
          </div>
        </div>
        <div class="m-agent-bar-wrap">
          <div class="m-agent-bar" style="width:${pct}%;background:${barColor};box-shadow:0 0 8px ${barColor}44"></div>
        </div>
      </div>`;
  }

  // Model breakdown HTML
  let modelHTML = '';
  for (const [model, data] of Object.entries(modelBreakdown)) {
    const shortModel = model.replace('claude-', '').replace('-20250514', '');
    modelHTML += `
      <div class="m-model-row">
        <span class="m-model-name">${esc(shortModel)}</span>
        <span class="m-model-sessions">${data.sessions}s</span>
        <span class="m-model-cost">$${data.cost.toFixed(2)}</span>
      </div>`;
  }

  const panelEl = document.getElementById('metrics-panel-content');
  if (panelEl) {
    panelEl.innerHTML = `
      <div class="m-section">
        <div class="m-section-label">BY AGENT</div>
        ${agentHTML}
      </div>
      <div class="m-section">
        <div class="m-section-label">BY MODEL</div>
        ${modelHTML || '<div class="m-empty">No model data</div>'}
      </div>
    `;
  }
}

// ─── Animated Counters ───

function updateCounters(dt) {
  const speed = 0.05;
  counterValues.tokens += (counterTargets.tokens - counterValues.tokens) * speed;
  counterValues.cost += (counterTargets.cost - counterValues.cost) * speed;
  counterValues.sessions += (counterTargets.sessions - counterValues.sessions) * speed;
  counterValues.agents += (counterTargets.agents - counterValues.agents) * speed;

  const tokensEl = document.getElementById('m-counter-tokens');
  const costEl = document.getElementById('m-counter-cost');
  const sessionsEl = document.getElementById('m-counter-sessions');
  const agentsEl = document.getElementById('m-counter-agents');

  if (tokensEl) tokensEl.textContent = formatNumber(Math.round(counterValues.tokens));
  if (costEl) costEl.textContent = '$' + counterValues.cost.toFixed(2);
  if (sessionsEl) sessionsEl.textContent = Math.round(counterValues.sessions).toString();
  if (agentsEl) agentsEl.textContent = Math.round(counterValues.agents).toString();
}

// ─── Sparkline ───

function drawSparkline() {
  const canvas = document.getElementById('m-sparkline');
  if (!canvas || !sessionsData) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.scale(2, 2);
  const dw = w / 2, dh = h / 2;

  ctx.clearRect(0, 0, dw, dh);

  const sessions = sessionsData.sessions || [];
  if (sessions.length < 2) {
    ctx.font = '9px monospace';
    ctx.fillStyle = C.textDim;
    ctx.textAlign = 'center';
    ctx.fillText('—', dw / 2, dh / 2);
    return;
  }

  // Create token burn over time buckets
  const now = Date.now();
  const windowMs = 24 * 3600000; // 24h
  const bucketCount = 24;
  const bucketMs = windowMs / bucketCount;
  const buckets = new Array(bucketCount).fill(0);

  for (const s of sessions) {
    const start = new Date(s.startedAt).getTime();
    const end = new Date(s.endedAt).getTime();
    const dur = end - start || 1;
    const tokPerMs = (s.tokens?.total || 0) / dur;

    for (let i = 0; i < bucketCount; i++) {
      const bStart = now - windowMs + i * bucketMs;
      const bEnd = bStart + bucketMs;
      const overlap = Math.max(0, Math.min(end, bEnd) - Math.max(start, bStart));
      buckets[i] += overlap * tokPerMs;
    }
  }

  const maxBucket = Math.max(...buckets, 1);
  const padding = 4;
  const chartW = dw - padding * 2;
  const chartH = dh - padding * 2;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, padding, 0, dh - padding);
  grad.addColorStop(0, 'rgba(0, 255, 213, 0.2)');
  grad.addColorStop(1, 'rgba(0, 255, 213, 0)');

  ctx.beginPath();
  ctx.moveTo(padding, dh - padding);

  for (let i = 0; i < bucketCount; i++) {
    const x = padding + (i / (bucketCount - 1)) * chartW;
    const y = dh - padding - (buckets[i] / maxBucket) * chartH;
    if (i === 0) ctx.lineTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.lineTo(padding + chartW, dh - padding);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  for (let i = 0; i < bucketCount; i++) {
    const x = padding + (i / (bucketCount - 1)) * chartW;
    const y = dh - padding - (buckets[i] / maxBucket) * chartH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C.cyan;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = C.cyan;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Endpoint dot
  const lastX = padding + chartW;
  const lastY = dh - padding - (buckets[bucketCount - 1] / maxBucket) * chartH;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = C.cyan;
  ctx.fill();
}

// ─── Utility ───

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function formatTokensShort(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ─── Main Loop ───

function animate(timestamp) {
  if (!metricsActive) return;
  animTime = timestamp || 0;

  tickForces();
  drawTree(animTime);
  drawTimeline(animTime);
  updateCounters(16);

  animFrame = requestAnimationFrame(animate);
}

// ─── Canvas Setup ───

function setupCanvases() {
  treeCanvas = document.getElementById('metrics-tree-canvas');
  timelineCanvas = document.getElementById('metrics-timeline-canvas');
  if (!treeCanvas || !timelineCanvas) return;

  resizeCanvases();
  window.addEventListener('resize', resizeCanvases);

  // Mouse interaction on tree canvas
  treeCanvas.addEventListener('mousemove', (e) => {
    const rect = treeCanvas.getBoundingClientRect();
    const scaleX = treeCanvas.width / rect.width;
    const scaleY = treeCanvas.height / rect.height;
    mouseX = (e.clientX - rect.left) * scaleX;
    mouseY = (e.clientY - rect.top) * scaleY;

    // Hit test nodes
    hoveredNode = null;
    for (const node of treeNodes) {
      const dx = mouseX - node.x, dy = mouseY - node.y;
      if (dx * dx + dy * dy < (node.radius + 8) * (node.radius + 8)) {
        hoveredNode = node;
        break;
      }
    }
    treeCanvas.style.cursor = hoveredNode ? 'pointer' : 'default';
  });

  treeCanvas.addEventListener('mouseleave', () => {
    hoveredNode = null;
  });

  treeCanvas.addEventListener('click', () => {
    selectedNode = hoveredNode;
  });
}

function resizeCanvases() {
  if (!treeCanvas || !timelineCanvas) return;

  const treeContainer = treeCanvas.parentElement;
  const timeContainer = timelineCanvas.parentElement;

  // Tree canvas — use 1:1 pixel ratio for sharpness
  const dpr = 1; // keep 1:1 for performance, Canvas blur is intentional aesthetic
  canvasW = treeContainer.clientWidth;
  canvasH = treeContainer.clientHeight;
  treeCanvas.width = canvasW;
  treeCanvas.height = canvasH;
  treeCtx = treeCanvas.getContext('2d');

  // Timeline canvas
  const tw = timeContainer.clientWidth;
  const th = timeContainer.clientHeight;
  timelineCanvas.width = tw;
  timelineCanvas.height = th;
  timelineCtx = timelineCanvas.getContext('2d');

  // Re-layout tree nodes if they exist
  if (treeNodes.length > 0) {
    const roots = treeNodes.filter(n => n.isRoot).map(n => n.name);
    const nodeIndex = {};
    treeNodes.forEach(n => nodeIndex[n.name] = n);
    layoutTree(roots, nodeIndex);
  }

  drawSparkline();
}

// ─── Public API ───

window.metricsInit = function() {
  if (metricsActive) return;
  metricsActive = true;
  setupCanvases();
  fetchMetricsData();
  animate();

  // Refresh data every 30s
  window._metricsRefresh = setInterval(() => {
    if (metricsActive) fetchMetricsData();
  }, 30000);
};

window.metricsDestroy = function() {
  metricsActive = false;
  if (animFrame) cancelAnimationFrame(animFrame);
  if (window._metricsRefresh) clearInterval(window._metricsRefresh);
  window.removeEventListener('resize', resizeCanvases);
};
