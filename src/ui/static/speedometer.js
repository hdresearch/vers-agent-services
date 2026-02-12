// ═══════════════════════════════════════════════════════════════════════════
// Token Burn Speedometer — Real-time tok/s gauge with spring-physics needle
// Listens to SSE feed for token_update events, computes rolling rate
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── Config ───
  const WINDOW_MS = 10000;       // 10-second sliding window
  const DECAY_AFTER_MS = 5000;   // start decaying after 5s of silence
  const BASE_MAX_RATE = 5000;    // default max tok/s on gauge
  const SPRING_STIFFNESS = 0.08; // needle spring constant
  const SPRING_DAMPING = 0.7;    // needle damping (< 1 = overshoot)

  // ─── Color zones (angle ranges mapped to 0–1 of arc) ───
  const ZONES = [
    { from: 0,    to: 0.4,  color: '#00ffd5', rgb: '0, 255, 213' },   // green/cyan
    { from: 0.4,  to: 0.7,  color: '#ffaa00', rgb: '255, 170, 0' },   // yellow/amber
    { from: 0.7,  to: 1.0,  color: '#ff4466', rgb: '255, 68, 102' },  // red
  ];

  // ─── State ───
  let tokenEvents = [];       // { tokens, timestamp }
  let currentRate = 0;        // computed tok/s
  let displayRate = 0;        // smoothed for digital readout
  let needleAngle = 0;        // current needle position (radians)
  let needleVelocity = 0;     // for spring physics
  let maxRate = BASE_MAX_RATE; // auto-scales up
  let lastEventTime = 0;
  let animId = null;
  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let sseConnected = false;

  // ─── SSE Integration ───
  // We hook into the existing SSE connection from app.js by patching
  // EventSource or by directly listening. The app already has an
  // EventSource at /ui/api/feed/stream. We'll create our own listener
  // that coexists — or better, we expose a function for app.js to call.

  // Global hook: app.js SSE onmessage will call this if it exists
  window._speedometerOnFeedEvent = function (evt) {
    if (evt.type !== 'token_update' && evt.type !== 'cost_update') return;
    if (!evt.detail) return;

    try {
      const d = typeof evt.detail === 'string' ? JSON.parse(evt.detail) : evt.detail;
      const tokens = d.tokensThisTurn || 0;
      const ts = d.timestamp || Date.now();
      if (tokens > 0) {
        tokenEvents.push({ tokens, timestamp: ts });
        lastEventTime = Date.now();
      }
    } catch {
      // malformed detail, ignore
    }
  };

  // ─── Rate Computation ───
  function computeRate() {
    const now = Date.now();

    // Prune events outside the window
    const cutoff = now - WINDOW_MS;
    tokenEvents = tokenEvents.filter(e => e.timestamp > cutoff);

    if (tokenEvents.length === 0) {
      // Decay to 0 if no events
      const silenceMs = now - lastEventTime;
      if (silenceMs > DECAY_AFTER_MS) {
        const decayFactor = Math.max(0, 1 - (silenceMs - DECAY_AFTER_MS) / 5000);
        currentRate *= decayFactor;
        if (currentRate < 0.5) currentRate = 0;
      }
      return;
    }

    // Sum tokens in window, divide by window duration
    const totalTokens = tokenEvents.reduce((sum, e) => sum + e.tokens, 0);
    const windowStart = Math.max(cutoff, tokenEvents[0].timestamp);
    const windowDuration = (now - windowStart) / 1000; // seconds
    currentRate = windowDuration > 0 ? totalTokens / Math.max(windowDuration, 0.5) : 0;

    // Auto-scale if rate exceeds max
    if (currentRate > maxRate * 0.9) {
      maxRate = Math.ceil(currentRate / 1000) * 1000 + 1000;
    }
  }

  // ─── Spring Physics for Needle ───
  function updateNeedle() {
    const targetAngle = rateToAngle(currentRate);
    const displacement = targetAngle - needleAngle;
    const springForce = displacement * SPRING_STIFFNESS;
    needleVelocity = (needleVelocity + springForce) * SPRING_DAMPING;
    needleAngle += needleVelocity;

    // Clamp
    const minAngle = Math.PI;
    const maxAngle = 2 * Math.PI;
    if (needleAngle < minAngle) {
      needleAngle = minAngle;
      needleVelocity = Math.abs(needleVelocity) * 0.3;
    }
    if (needleAngle > maxAngle) {
      needleAngle = maxAngle;
      needleVelocity = -Math.abs(needleVelocity) * 0.3;
    }

    // Smooth digital readout
    displayRate += (currentRate - displayRate) * 0.1;
    if (Math.abs(displayRate - currentRate) < 0.5) displayRate = currentRate;
  }

  function rateToAngle(rate) {
    const ratio = Math.min(rate / maxRate, 1);
    // Arc goes from PI (left) to 2*PI (right) — semicircle
    return Math.PI + ratio * Math.PI;
  }

  // ─── Rendering ───
  function render(time) {
    if (!ctx) return;

    computeRate();
    updateNeedle();

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const cx = w / 2;
    const cy = h * 0.82;
    const outerR = Math.min(cx - 10, cy - 10);
    const innerR = outerR * 0.7;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // ─── Draw arc zones ───
    for (const zone of ZONES) {
      const startAngle = Math.PI + zone.from * Math.PI;
      const endAngle = Math.PI + zone.to * Math.PI;

      // Glow layer
      const glowIntensity = 0.08 + Math.sin(time * 0.002 + zone.from * 5) * 0.03;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR + 2, startAngle, endAngle);
      ctx.strokeStyle = `rgba(${zone.rgb}, ${glowIntensity})`;
      ctx.lineWidth = 12;
      ctx.shadowColor = zone.color;
      ctx.shadowBlur = 15;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Main arc
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, startAngle, endAngle);
      ctx.strokeStyle = `rgba(${zone.rgb}, 0.35)`;
      ctx.lineWidth = 6;
      ctx.stroke();

      // Bright filled portion up to needle
      const needleRatio = (needleAngle - Math.PI) / Math.PI;
      if (needleRatio > zone.from) {
        const fillEnd = Math.min(needleRatio, zone.to);
        const fillStartAngle = Math.PI + zone.from * Math.PI;
        const fillEndAngle = Math.PI + fillEnd * Math.PI;
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, fillStartAngle, fillEndAngle);
        ctx.strokeStyle = `rgba(${zone.rgb}, 0.8)`;
        ctx.lineWidth = 6;
        ctx.shadowColor = zone.color;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // ─── Tick marks ───
    const tickCount = 10;
    for (let i = 0; i <= tickCount; i++) {
      const ratio = i / tickCount;
      const angle = Math.PI + ratio * Math.PI;
      const isMajor = i % 2 === 0;
      const tickInner = isMajor ? outerR - 12 : outerR - 7;
      const tickOuter = outerR - 2;

      const x1 = cx + Math.cos(angle) * tickInner;
      const y1 = cy + Math.sin(angle) * tickInner;
      const x2 = cx + Math.cos(angle) * tickOuter;
      const y2 = cy + Math.sin(angle) * tickOuter;

      // Zone color for tick
      let tickColor = ZONES[0].rgb;
      for (const z of ZONES) {
        if (ratio >= z.from && ratio <= z.to) { tickColor = z.rgb; break; }
      }

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgba(${tickColor}, ${isMajor ? 0.6 : 0.3})`;
      ctx.lineWidth = isMajor ? 2 : 1;
      ctx.stroke();

      // Labels on major ticks
      if (isMajor) {
        const labelR = outerR - 20;
        const lx = cx + Math.cos(angle) * labelR;
        const ly = cy + Math.sin(angle) * labelR;
        const val = Math.round(ratio * maxRate);
        const label = val >= 1000 ? (val / 1000).toFixed(0) + 'k' : String(val);
        ctx.font = '7px "SF Mono", "Cascadia Code", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(${tickColor}, 0.5)`;
        ctx.fillText(label, lx, ly);
      }
    }

    // ─── Needle ───
    const needleLen = outerR - 8;
    const needleTipX = cx + Math.cos(needleAngle) * needleLen;
    const needleTipY = cy + Math.sin(needleAngle) * needleLen;
    const needleBaseLen = 8;
    const perpAngle = needleAngle + Math.PI / 2;
    const bx1 = cx + Math.cos(perpAngle) * needleBaseLen / 2;
    const by1 = cy + Math.sin(perpAngle) * needleBaseLen / 2;
    const bx2 = cx - Math.cos(perpAngle) * needleBaseLen / 2;
    const by2 = cy - Math.sin(perpAngle) * needleBaseLen / 2;

    // Needle glow
    ctx.beginPath();
    ctx.moveTo(bx1, by1);
    ctx.lineTo(needleTipX, needleTipY);
    ctx.lineTo(bx2, by2);
    ctx.closePath();
    ctx.shadowColor = '#ff4466';
    ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(255, 68, 102, 0.6)';
    ctx.fill();
    ctx.shadowBlur = 0;

    // Needle body
    ctx.beginPath();
    ctx.moveTo(bx1, by1);
    ctx.lineTo(needleTipX, needleTipY);
    ctx.lineTo(bx2, by2);
    ctx.closePath();
    const needleGrad = ctx.createLinearGradient(cx, cy, needleTipX, needleTipY);
    needleGrad.addColorStop(0, 'rgba(200, 200, 220, 0.8)');
    needleGrad.addColorStop(0.7, 'rgba(255, 100, 120, 0.9)');
    needleGrad.addColorStop(1, 'rgba(255, 68, 102, 1)');
    ctx.fillStyle = needleGrad;
    ctx.fill();

    // Needle tip glow dot
    ctx.beginPath();
    ctx.arc(needleTipX, needleTipY, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 68, 102, 0.9)';
    ctx.shadowColor = '#ff4466';
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Center hub
    const hubGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 8);
    hubGrad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
    hubGrad.addColorStop(0.5, 'rgba(100, 100, 120, 0.4)');
    hubGrad.addColorStop(1, 'rgba(40, 40, 60, 0.6)');
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = hubGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 255, 213, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ─── Digital readout ───
    const rateStr = displayRate < 10 ? displayRate.toFixed(1) : Math.round(displayRate).toString();
    ctx.font = 'bold 16px "SF Mono", "Cascadia Code", "Fira Code", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Rate color based on zone
    const ratio = Math.min(currentRate / maxRate, 1);
    let rateColor = ZONES[0].color;
    for (const z of ZONES) {
      if (ratio >= z.from) rateColor = z.color;
    }
    ctx.fillStyle = rateColor;
    ctx.shadowColor = rateColor;
    ctx.shadowBlur = 8;
    ctx.fillText(rateStr, cx, cy + 4);
    ctx.shadowBlur = 0;

    // "tok/s" label
    ctx.font = '8px "SF Mono", "Cascadia Code", monospace';
    ctx.fillStyle = 'rgba(192, 192, 192, 0.5)';
    ctx.fillText('TOKENS/SEC', cx, cy + 22);

    // ─── Idle pulse ───
    if (currentRate < 0.5) {
      const pulse = Math.sin(time * 0.002) * 0.08 + 0.08;
      ctx.beginPath();
      ctx.arc(cx, cy, outerR + 4, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = `rgba(0, 255, 213, ${pulse})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();

    animId = requestAnimationFrame(render);
  }

  // ─── Setup ───
  function init() {
    canvas = document.getElementById('m-speedometer');
    if (!canvas) return;

    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // Use the CSS size (200x120) for the logical size, scale by dpr
    canvas.width = 200 * dpr;
    canvas.height = 120 * dpr;
    ctx = canvas.getContext('2d');

    needleAngle = Math.PI; // start at 0
    animId = requestAnimationFrame(render);
  }

  function destroy() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    ctx = null;
    canvas = null;
  }

  // ─── Expose for metrics lifecycle ───
  window._speedometerInit = init;
  window._speedometerDestroy = destroy;

})();
