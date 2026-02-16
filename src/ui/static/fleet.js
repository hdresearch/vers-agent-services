// ═══════════════════════════════════════════
// Fleet View — Mission Control
// Agent map (Canvas), activity stream (SSE),
// vitals bar, quick actions.
// ═══════════════════════════════════════════

(function () {
  'use strict';

  const API = '/ui/api';
  let fleetActive = false;
  let fleetRAF = null;
  let fleetSSE = null;
  let fleetPollTimer = null;       // vitals refresh timer
  let fleetStreamPollTimer = null; // SSE fallback stream polling timer
  let nodes = [];       // {id, name, role, status, x, y, vx, vy, radius, vm}
  let hoveredNode = null;
  let selectedNode = null;
  let canvas, ctx;
  let canvasW = 0, canvasH = 0;
  let mouse = { x: -1000, y: -1000 };
  let streamEvents = [];
  let fleetPersonas = [];
  const MAX_STREAM = 200;
  const DPR = window.devicePixelRatio || 1;
  const STALE_MS = 5 * 60 * 1000; // 5 minutes — matches server stale threshold

  // ─── Colors ───
  const STATUS_COLORS = {
    running:     '#4f9',
    awake:       '#4f9',
    idle:        '#fd0',
    hibernating: '#666',
    stopped:     '#666',
    error:       '#f55',
    paused:      '#888',
  };
  const ROLE_COLORS = {
    orchestrator: '#a7f',
    infra:        '#5af',
    lieutenant:   '#f93',
    worker:       '#4f9',
    golden:       '#fd0',
    custom:       '#ccc',
  };

  function getNodeColor(node) {
    if (node.role === 'orchestrator' || node.role === 'infra') return ROLE_COLORS[node.role];
    return STATUS_COLORS[node.status] || '#666';
  }

  // ─── API helper ───
  function checkSessionExpiry(res) {
    if (res.status === 401 || res.status === 403) {
      window.location.href = '/ui/login';
      throw new Error('Session expired');
    }
    if (res.redirected && res.url.includes('/login')) {
      window.location.href = '/ui/login';
      throw new Error('Session expired');
    }
  }

  async function fapi(path, opts = {}) {
    const timeout = opts.timeout || 8000;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const fetchOpts = { signal: ctrl.signal };
      if (opts.method) fetchOpts.method = opts.method;
      if (opts.headers) fetchOpts.headers = opts.headers;
      if (opts.body) fetchOpts.body = opts.body;

      const res = await fetch(`${API}${path}`, fetchOpts);
      clearTimeout(t);

      // Handle session expiry — redirect to login
      checkSessionExpiry(res);
      if (!res.ok) throw new Error(`${res.status}`);

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        window.location.href = '/ui/login';
        throw new Error('Session expired');
      }
      return res.json();
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

  // ─── Data loading ───

  async function loadVitals() {
    try {
      const [vmsData, cryoData, personasData, tasksData, usageData, feedData] = await Promise.allSettled([
        fapi('/registry/vms?include_stale=true'),
        fapi('/cryo/agents'),
        fapi('/personas'),
        fapi('/board/tasks?compact=true'),
        fapi('/usage/summary'),
        fapi('/feed/events?limit=50'),
      ]);

      // Build unified agent list from registry + cryo
      const registryVms = vmsData.status === 'fulfilled' ? (vmsData.value.vms || []) : [];
      const cryoAgents = cryoData.status === 'fulfilled' ? (cryoData.value.agents || []) : [];
      const personas = personasData.status === 'fulfilled' ? (personasData.value.personas || []) : [];

      // Index registry VMs by name for dedup
      const registryByName = new Map();
      const registryById = new Map();
      for (const vm of registryVms) {
        registryByName.set(vm.name, vm);
        registryById.set(vm.id, vm);
      }

      // Merge cryo agents into unified list — cryo agents that aren't in registry get added
      const allVms = [...registryVms];
      for (const agent of cryoAgents) {
        // Check if this cryo agent is already in registry (by vmId or name)
        const inRegistryById = agent.currentVmId && registryById.has(agent.currentVmId);
        const inRegistryByName = registryByName.has(agent.name);

        if (inRegistryById) {
          // Enrich registry entry with cryo metadata
          const vm = registryById.get(agent.currentVmId);
          vm._cryo = agent;
          vm._persona = agent.persona;
        } else if (inRegistryByName) {
          const vm = registryByName.get(agent.name);
          vm._cryo = agent;
          vm._persona = agent.persona;
        } else {
          // Cryo-only agent (hibernating, not in registry) — synthesize a VM entry
          const status = agent.status === 'hibernating' ? 'stopped'
                       : agent.status === 'retired' ? 'stopped'
                       : agent.status === 'awake' ? 'running' : 'stopped';
          allVms.push({
            id: agent.currentVmId || `cryo-${agent.name}`,
            name: agent.name,
            role: 'worker',
            status,
            address: agent.currentVmId ? `${agent.currentVmId}.vm.vers.sh` : '',
            registeredBy: 'cryo',
            registeredAt: agent.createdAt || '',
            lastSeen: agent.lastWokenAt || agent.lastHibernatedAt || agent.createdAt || '',
            _cryo: agent,
            _persona: agent.persona,
            _source: 'cryo',
          });
        }
      }

      // Store personas for detail popover
      fleetPersonas = personas;

      updateNodes(allVms);

      let awake = 0, idle = 0, error = 0, hibernating = 0;
      for (const vm of allVms) {
        const cryoStatus = vm._cryo?.status;
        const s = cryoStatus || (vm.status || 'unknown').toLowerCase();
        if (s === 'running' || s === 'awake') awake++;
        else if (s === 'idle') idle++;
        else if (s === 'error') error++;
        else hibernating++;
      }
      setText('fv-agents', allVms.length);
      setText('fv-awake', awake);
      setText('fv-idle', idle);
      setText('fv-error', error);
      setText('fv-hibernating', hibernating);

      // Tasks
      if (tasksData.status === 'fulfilled') {
        const tasks = tasksData.value.tasks || [];
        let open = 0, done = 0;
        for (const t of tasks) {
          if (t.status === 'done') done++;
          else open++;
        }
        setText('fv-tasks-open', open);
        setText('fv-tasks-done', done);
      }

      // Usage — API returns { range, totals: { tokens, cost, sessions, vms }, byAgent }
      // Guard against error responses ({ error: "..." }) and legacy flat shapes.
      if (usageData.status === 'fulfilled') {
        const u = usageData.value;
        if (u && !u.error) {
          // Prefer nested totals shape; fall back to flat properties for compat
          const totals = u.totals || {};
          let totalTokens = Number(totals.tokens) || 0;
          let totalCost   = Number(totals.cost)   || 0;

          // Fallback: sum from byAgent if totals came back empty but agents exist
          if (!totalTokens && !totalCost && u.byAgent) {
            for (const a of Object.values(u.byAgent)) {
              totalTokens += Number(a.tokens) || 0;
              totalCost   += Number(a.cost)   || 0;
            }
          }

          setText('fv-tokens', totalTokens > 1000000 ? (totalTokens / 1000000).toFixed(1) + 'M' : totalTokens > 1000 ? (totalTokens / 1000).toFixed(0) + 'K' : totalTokens || '—');
          setText('fv-cost', totalCost ? '$' + totalCost.toFixed(2) : '—');
        }
      }

      // Last deploy from feed
      if (feedData.status === 'fulfilled') {
        const events = Array.isArray(feedData.value) ? feedData.value : (feedData.value.events || []);
        const deploy = events.find(e => e.type === 'task_completed' && (e.summary || '').toLowerCase().includes('deploy'));
        setText('fv-last-deploy', deploy ? timeAgo(deploy.timestamp) : 'n/a');
        // Seed stream
        if (streamEvents.length === 0) {
          const list = events.slice().reverse();
          for (const evt of list) addStreamEvent(evt, false);
        }
      }
    } catch (e) {
      console.error('Fleet vitals error:', e);
    }
  }

  // ─── Node management (force-directed layout) ───

  function effectiveStatus(vm) {
    // Cryo status takes priority if present
    const cryo = vm._cryo;
    if (cryo) {
      const cs = (cryo.status || '').toLowerCase();
      if (cs === 'hibernating') return 'hibernating';
      if (cs === 'retired') return 'stopped';
      if (cs === 'awake') return 'running';
    }

    const s = (vm.status || 'unknown').toLowerCase();

    // Mark stale running VMs (no heartbeat for 5min) as idle unless pinned
    if (s === 'running' && !vm.pinned && vm.lastSeen) {
      const age = Date.now() - new Date(vm.lastSeen).getTime();
      if (age > STALE_MS) return 'idle';
    }

    return s;
  }

  function updateNodes(vms) {
    const existing = new Map(nodes.map(n => [n.id, n]));
    const newNodes = [];

    for (const vm of vms) {
      const prev = existing.get(vm.id);
      const isOrch = vm.role === 'orchestrator' || vm.role === 'infra';
      const isCryo = vm._source === 'cryo' || vm._cryo?.status === 'hibernating';
      const radius = isOrch ? 20 : isCryo ? 10 : 12;
      const status = effectiveStatus(vm);
      if (prev) {
        prev.name = vm.name || vm.id;
        prev.role = vm.role || 'worker';
        prev.status = status;
        prev.radius = radius;
        prev.vm = vm;
        newNodes.push(prev);
      } else {
        // Place new nodes randomly around center
        const angle = Math.random() * Math.PI * 2;
        const dist = 80 + Math.random() * 120;
        newNodes.push({
          id: vm.id,
          name: vm.name || vm.id,
          role: vm.role || 'worker',
          status,
          x: canvasW / 2 + Math.cos(angle) * dist,
          y: canvasH / 2 + Math.sin(angle) * dist,
          vx: 0, vy: 0,
          radius,
          vm,
        });
      }
    }
    nodes = newNodes;
  }

  // ─── Physics simulation (force-directed) ───

  function simulate() {
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    const DAMPING = 0.85;
    const REPULSION = 3000;
    const SPRING = 0.005;
    const CENTER_PULL = 0.01;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      // Pull to center
      a.vx += (cx - a.x) * CENTER_PULL;
      a.vy += (cy - a.y) * CENTER_PULL;

      // Repulsion from other nodes
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = a.radius + b.radius + 20;
        if (dist < minDist * 3) {
          const force = REPULSION / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      // Orchestrators/infra attract workers (spring)
      if (a.role !== 'orchestrator' && a.role !== 'infra') {
        const orch = nodes.find(n => n.role === 'orchestrator' || n.role === 'infra');
        if (orch) {
          const dx = orch.x - a.x;
          const dy = orch.y - a.y;
          a.vx += dx * SPRING;
          a.vy += dy * SPRING;
        }
      }
    }

    for (const n of nodes) {
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx;
      n.y += n.vy;
      // Keep in bounds
      n.x = Math.max(n.radius + 10, Math.min(canvasW - n.radius - 10, n.x));
      n.y = Math.max(n.radius + 10, Math.min(canvasH - n.radius - 10, n.y));
    }
  }

  // ─── Canvas rendering ───

  function render() {
    if (!fleetActive) return;

    simulate();

    ctx.clearRect(0, 0, canvasW, canvasH);

    // Draw grid
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = gridSize; x < canvasW; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvasH); ctx.stroke();
    }
    for (let y = gridSize; y < canvasH; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
    }

    // Draw connections (lines from orchestrator/infra to others)
    const orchNodes = nodes.filter(n => n.role === 'orchestrator' || n.role === 'infra');
    for (const orch of orchNodes) {
      for (const n of nodes) {
        if (n === orch) continue;
        ctx.beginPath();
        ctx.moveTo(orch.x, orch.y);
        ctx.lineTo(n.x, n.y);
        ctx.strokeStyle = 'rgba(79, 255, 153, 0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Draw lieutenant connections to workers
    const lts = nodes.filter(n => n.role === 'lieutenant');
    const workers = nodes.filter(n => n.role === 'worker');
    for (const lt of lts) {
      for (const w of workers) {
        const dx = lt.x - w.x, dy = lt.y - w.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 200) {
          ctx.beginPath();
          ctx.moveTo(lt.x, lt.y);
          ctx.lineTo(w.x, w.y);
          ctx.strokeStyle = 'rgba(249, 147, 51, 0.12)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // Draw nodes
    for (const n of nodes) {
      const color = getNodeColor(n);
      const isHovered = n === hoveredNode;
      const isSelected = n === selectedNode;

      // Glow
      if (isHovered || isSelected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 8, 0, Math.PI * 2);
        ctx.fillStyle = color.replace(')', ', 0.15)').replace('rgb', 'rgba').replace('#', '');
        // Use hex to rgba
        const r = parseInt(color.slice(1, 2), 16) * 17;
        const g = parseInt(color.slice(2, 3), 16) * 17;
        const b = parseInt(color.slice(3, 4), 16) * 17;
        ctx.fillStyle = `rgba(${r},${g},${b},0.15)`;
        ctx.fill();
      }

      // Pulse ring for running nodes
      if (n.status === 'running' || n.status === 'awake') {
        const pulse = Math.sin(Date.now() / 800 + n.x) * 0.3 + 0.7;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = pulse * 0.3;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = (n.status === 'hibernating' || n.status === 'stopped') ? 0.4 : 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Border
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.strokeStyle = isSelected ? '#fff' : isHovered ? color : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Dashed border for cryo/stale agents
      if (n.status === 'hibernating') {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 3, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Role icon in center
      ctx.fillStyle = '#000';
      ctx.font = `${n.radius < 14 ? 10 : 13}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const isCryoNode = n.vm?._source === 'cryo' || n.vm?._cryo?.status === 'hibernating';
      const icon = n.role === 'orchestrator' ? '◉' : n.role === 'infra' ? '⬡' : n.role === 'lieutenant' ? '◈' : isCryoNode ? '❄' : '●';
      ctx.fillText(icon, n.x, n.y);

      // Label below
      ctx.fillStyle = isHovered || isSelected ? '#eee' : '#888';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      const label = n.name.length > 16 ? n.name.slice(0, 14) + '…' : n.name;
      ctx.fillText(label, n.x, n.y + n.radius + 12);
    }

    // Empty state
    if (nodes.length === 0) {
      ctx.fillStyle = '#444';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No agents in registry or cryochamber', canvasW / 2, canvasH / 2);
    }

    fleetRAF = requestAnimationFrame(render);
  }

  // ─── Canvas interaction ───

  function initCanvas() {
    canvas = document.getElementById('fleet-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resizeCanvas();

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const headerH = wrap.querySelector('.fleet-map-header')?.offsetHeight || 0;
    canvasW = rect.width;
    canvasH = rect.height - headerH;
    canvas.width = canvasW * DPR;
    canvas.height = canvasH * DPR;
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // Re-center nodes if they're off screen
    for (const n of nodes) {
      if (n.x > canvasW || n.y > canvasH) {
        n.x = canvasW / 2 + (Math.random() - 0.5) * 200;
        n.y = canvasH / 2 + (Math.random() - 0.5) * 200;
      }
    }
  }

  function hitTest(mx, my) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) return n;
    }
    return null;
  }

  function onMouseLeave() {
    mouse.x = -1000; mouse.y = -1000; hoveredNode = null;
  }

  function getTouchPos(e) {
    const touch = e.touches[0] || e.changedTouches[0];
    if (!touch || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function onTouchStart(e) {
    const pos = getTouchPos(e);
    if (!pos) return;
    mouse.x = pos.x;
    mouse.y = pos.y;
    hoveredNode = hitTest(pos.x, pos.y);
    if (hoveredNode) e.preventDefault(); // prevent scroll when interacting with a node
  }

  function onTouchMove(e) {
    const pos = getTouchPos(e);
    if (!pos) return;
    mouse.x = pos.x;
    mouse.y = pos.y;
    hoveredNode = hitTest(pos.x, pos.y);
    if (hoveredNode) e.preventDefault();
  }

  function onTouchEnd(e) {
    const pos = getTouchPos(e);
    if (!pos) return;
    const hit = hitTest(pos.x, pos.y);
    if (hit) {
      e.preventDefault();
      selectedNode = hit;
      showDetail(hit);
    } else {
      selectedNode = null;
      hideDetail();
    }
    // Clear hover state after touch
    setTimeout(() => { mouse.x = -1000; mouse.y = -1000; hoveredNode = null; }, 300);
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
    hoveredNode = hitTest(mouse.x, mouse.y);
    canvas.style.cursor = hoveredNode ? 'pointer' : 'crosshair';
  }

  function onCanvasClick(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);

    if (hit) {
      selectedNode = hit;
      showDetail(hit);
    } else {
      selectedNode = null;
      hideDetail();
    }
  }

  function showDetail(node) {
    const el = document.getElementById('fleet-detail');
    const vm = node.vm || {};
    const cryo = vm._cryo;
    document.getElementById('fd-name').textContent = node.name;
    document.getElementById('fd-role').textContent = node.role + (vm._persona ? ` · ${vm._persona}` : '');

    const statusEl = document.getElementById('fd-status');
    statusEl.textContent = node.status + (vm._source === 'cryo' ? ' (cryo)' : '');
    statusEl.style.color = STATUS_COLORS[node.status] || '#ccc';

    const metaParts = [
      vm.address ? `<div>Address: <span style="color:var(--blue)">${esc(vm.address)}</span></div>` : '',
      `<div>Last seen: ${timeAgo(vm.lastSeen || vm.registeredAt)}</div>`,
      vm.registeredBy ? `<div>Registered by: ${esc(vm.registeredBy)}</div>` : '',
    ];

    // Cryo-specific metadata
    if (cryo) {
      if (cryo.latestCommitId) metaParts.push(`<div>Commit: <span style="color:#fd0">${esc(cryo.latestCommitId.slice(0, 12))}</span></div>`);
      if (cryo.lastHibernatedAt) metaParts.push(`<div>Hibernated: ${timeAgo(cryo.lastHibernatedAt)}</div>`);
      if (cryo.lastWokenAt) metaParts.push(`<div>Last woken: ${timeAgo(cryo.lastWokenAt)}</div>`);
      if (cryo.hibernationCount) metaParts.push(`<div>Hibernation cycles: ${cryo.hibernationCount}</div>`);
      if (cryo.tags?.length) metaParts.push(`<div>Tags: ${cryo.tags.map(t => `<span style="color:#888">${esc(t)}</span>`).join(', ')}</div>`);
    }

    // Persona info
    if (vm._persona && fleetPersonas.length) {
      const persona = fleetPersonas.find(p => p.name === vm._persona);
      if (persona?.description) {
        metaParts.push(`<div style="margin-top:4px;color:#888;font-style:italic">${esc(persona.description)}</div>`);
      }
    }

    document.getElementById('fd-meta').innerHTML = metaParts.join('');

    const services = vm.services || [];
    if (services.length) {
      document.getElementById('fd-services').innerHTML = 'Services: ' +
        services.map(s => `<span class="fd-svc">${esc(s.name)}:${s.port}</span>`).join(', ');
    } else {
      document.getElementById('fd-services').textContent = '';
    }

    el.style.display = 'block';
  }

  function hideDetail() {
    document.getElementById('fleet-detail').style.display = 'none';
  }

  // ─── Activity stream ───

  function addStreamEvent(evt, prepend = true) {
    const stream = document.getElementById('fleet-stream');
    if (!stream) return;

    // Remove empty state
    const empty = stream.querySelector('.empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'fleet-evt';
    const typeClass = 't-' + (evt.type || 'custom');
    el.innerHTML = `
      <div class="fleet-evt-header">
        <span class="fleet-evt-agent">${esc(evt.agent || '—')}</span>
        <span class="fleet-evt-type ${typeClass}">${esc(evt.type || 'event')}</span>
        <span class="fleet-evt-time">${evt.timestamp ? timeAgo(evt.timestamp) : ''}</span>
      </div>
      <div class="fleet-evt-summary">${esc(evt.summary || evt.detail || '')}</div>
    `;

    if (prepend) {
      stream.prepend(el);
    } else {
      stream.appendChild(el);
    }

    streamEvents.push(evt);
    // Trim
    while (stream.children.length > MAX_STREAM) {
      stream.lastElementChild?.remove();
      streamEvents.shift();
    }
  }

  function startFleetSSE() {
    if (fleetSSE) { try { fleetSSE.close(); } catch {} }
    // Clear any stale fallback poll timer from a previous SSE attempt
    if (fleetStreamPollTimer) { clearInterval(fleetStreamPollTimer); fleetStreamPollTimer = null; }

    try {
      fleetSSE = new EventSource(`${API}/feed/stream`);
      fleetSSE.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          addStreamEvent(evt);
        } catch {}
      };
      fleetSSE.onerror = () => {
        // Fall back to polling for stream events
        if (fleetSSE) { try { fleetSSE.close(); } catch {} fleetSSE = null; }
        if (!fleetStreamPollTimer && fleetActive) {
          fleetStreamPollTimer = setInterval(pollStream, 15000);
        }
      };
    } catch {
      if (!fleetStreamPollTimer) fleetStreamPollTimer = setInterval(pollStream, 15000);
    }
  }

  async function pollStream() {
    try {
      const data = await fapi('/feed/events?limit=20');
      const events = Array.isArray(data) ? data : (data.events || []);
      // Only add new events
      const existing = new Set(streamEvents.map(e => e.id || (e.timestamp + e.summary)));
      for (const evt of events.reverse()) {
        const key = evt.id || (evt.timestamp + evt.summary);
        if (!existing.has(key)) {
          addStreamEvent(evt);
          existing.add(key);
        }
      }
    } catch {}
  }

  // ─── Quick actions ───

  let actionsInitialized = false;

  function onNewTask() {
    const title = prompt('Task title:');
    if (!title) return;
    fapi('/board/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, createdBy: 'dashboard-user' }),
    }).then(() => loadVitals())
      .catch(e => {
        if (e.message !== 'Session expired') alert('Failed to create task: ' + e.message);
      });
  }

  function onWakeAgent() {
    const choices = nodes.filter(n => n.status === 'hibernating' || n.status === 'stopped' || n.status === 'idle');
    if (!choices.length) { alert('No idle/hibernating agents to wake.'); return; }
    const list = choices.map(n => n.name).join(', ');
    const name = prompt(`Wake which agent?\nAvailable: ${list}`);
    if (!name) return;
    const target = choices.find(n => n.name.toLowerCase().includes(name.toLowerCase()));
    if (!target) { alert('Agent not found.'); return; }

    // If it's a cryo agent, try to wake via cryo API
    const cryo = target.vm?._cryo;
    if (cryo && cryo.status === 'hibernating') {
      const vmId = prompt(`VM ID to wake ${target.name} into (or cancel):`);
      if (!vmId) return;
      fapi(`/cryo/agents/${encodeURIComponent(target.name)}/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vmId, address: `${vmId}.vm.vers.sh` }),
      }).then(() => { alert(`${target.name} is waking up!`); loadVitals(); })
        .catch(e => { if (e.message !== 'Session expired') alert('Wake failed: ' + e.message); });
      return;
    }

    alert(`Wake signal sent to ${target.name}.\n(Requires vers CLI integration for actual VM resume.)`);
  }

  function onJumpChat() {
    const chatTab = document.querySelector('.tab[data-view="chat"]');
    if (chatTab) chatTab.click();
  }

  function onDetailClose(e) {
    e.stopPropagation();
    selectedNode = null;
    hideDetail();
  }

  function initActions() {
    if (actionsInitialized) return; // prevent duplicate listeners on re-init
    actionsInitialized = true;

    document.getElementById('fleet-new-task')?.addEventListener('click', onNewTask);
    document.getElementById('fleet-wake-agent')?.addEventListener('click', onWakeAgent);
    document.getElementById('fleet-jump-chat')?.addEventListener('click', onJumpChat);
    document.getElementById('fleet-detail-close')?.addEventListener('click', onDetailClose);
  }

  function destroyActions() {
    if (!actionsInitialized) return;
    actionsInitialized = false;

    document.getElementById('fleet-new-task')?.removeEventListener('click', onNewTask);
    document.getElementById('fleet-wake-agent')?.removeEventListener('click', onWakeAgent);
    document.getElementById('fleet-jump-chat')?.removeEventListener('click', onJumpChat);
    document.getElementById('fleet-detail-close')?.removeEventListener('click', onDetailClose);
  }

  // ─── Lifecycle ───

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  window._fleetInit = function () {
    if (fleetActive) return;
    fleetActive = true;
    initCanvas();
    initActions();
    loadVitals();
    startFleetSSE();
    fleetRAF = requestAnimationFrame(render);

    // Refresh vitals every 15s
    fleetPollTimer = setInterval(loadVitals, 15000);
  };

  window._fleetDestroy = function () {
    fleetActive = false;

    // Cancel animation frame
    if (fleetRAF) { cancelAnimationFrame(fleetRAF); fleetRAF = null; }

    // Close SSE connection
    if (fleetSSE) { try { fleetSSE.close(); } catch {} fleetSSE = null; }

    // Clear all timers
    if (fleetPollTimer) { clearInterval(fleetPollTimer); fleetPollTimer = null; }
    if (fleetStreamPollTimer) { clearInterval(fleetStreamPollTimer); fleetStreamPollTimer = null; }

    // Remove canvas event listeners to prevent leak on tab switch
    if (canvas) {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('click', onCanvasClick);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    }
    window.removeEventListener('resize', resizeCanvas);

    // Remove quick-action button listeners
    destroyActions();

    // Release DOM and state references so GC can collect
    canvas = null;
    ctx = null;
    nodes = [];
    hoveredNode = null;
    selectedNode = null;
    streamEvents = [];
  };
})();
