// ═══════════════════════════════════════════════════════════════════════════
// Analytics Chat — Server-backed natural language query interface
// Sends questions to POST /ui/api/analytics/query, renders structured responses
// with formatted tables, numbers, and inline charts
// ═══════════════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  const ANALYTICS_API = '/ui/api/analytics/query';

  // ─── Color Palette ───
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
    { hex: P.pink,   rgb: '255, 102, 204' },
  ];

  // ─── State ───
  let canvas, ctx;
  let currentChart = null;
  let animProgress = 0;
  let animFrame = null;
  let hoverInfo = null;
  let mouseX = -1, mouseY = -1;
  let analyticsActive = false;
  let chartRegions = [];
  let queryHistory = [];
  let isQuerying = false;

  // ─── Server Query ───

  async function sendQuery(question) {
    const res = await fetch(ANALYTICS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      throw new Error(`Query failed: ${res.status}`);
    }
    return res.json();
  }

  // ─── Chart Builders from Server Response ───

  function buildChartFromResponse(result) {
    if (!result.data || !result.data.rows || result.data.rows.length === 0) {
      return null;
    }

    const hint = result.chartHint || 'table';
    const data = result.data;

    if (hint === 'number' && data.value !== undefined) {
      return {
        type: 'number',
        title: result.answer,
        value: data.value,
        unit: data.unit || '',
      };
    }

    if (hint === 'bar' && data.columns && data.rows) {
      return buildBarFromTable(data);
    }

    if (hint === 'line' && data.columns && data.rows) {
      return buildLineFromTable(data);
    }

    if (hint === 'donut' && data.columns && data.rows) {
      return buildDonutFromTable(data);
    }

    // Default: table view
    return null;
  }

  function buildBarFromTable(data) {
    const labels = data.rows.map(r => String(r[0]));
    // Find first numeric column
    let valueIdx = 1;
    for (let i = 1; i < data.columns.length; i++) {
      const val = data.rows[0]?.[i];
      if (typeof val === 'number') { valueIdx = i; break; }
      // Try parsing string numbers
      if (typeof val === 'string' && !isNaN(parseFloat(val.replace(/[$,KM%]/g, '')))) { valueIdx = i; break; }
    }

    const values = data.rows.map(r => {
      let v = r[valueIdx];
      if (typeof v === 'string') v = parseFloat(v.replace(/[$,KM%]/g, '')) || 0;
      return v;
    });

    return {
      type: 'bar',
      title: data.columns[valueIdx] + ' by ' + data.columns[0],
      labels,
      values,
      formatValue: (v) => {
        const col = data.columns[valueIdx].toLowerCase();
        if (col.includes('cost') || col.includes('$')) return '$' + v.toFixed(2);
        if (col.includes('%')) return v.toFixed(1) + '%';
        return formatNumber(v);
      },
    };
  }

  function buildLineFromTable(data) {
    const labels = data.rows.map(r => String(r[0]));
    let valueIdx = 1;
    for (let i = 1; i < data.columns.length; i++) {
      const val = data.rows[0]?.[i];
      if (typeof val === 'string' && val.startsWith('$')) { valueIdx = i; break; }
      if (typeof val === 'number') { valueIdx = i; break; }
    }
    const values = data.rows.map(r => {
      let v = r[valueIdx];
      if (typeof v === 'string') v = parseFloat(v.replace(/[$,KM%]/g, '')) || 0;
      return v;
    });

    return {
      type: 'line',
      title: data.columns[valueIdx] + ' over time',
      labels,
      values,
      formatValue: (v) => {
        const col = data.columns[valueIdx].toLowerCase();
        if (col.includes('cost') || col.includes('$')) return '$' + v.toFixed(2);
        return formatNumber(v);
      },
    };
  }

  function buildDonutFromTable(data) {
    const labels = data.rows.map(r => String(r[0]));
    let valueIdx = 1;
    for (let i = 1; i < data.columns.length; i++) {
      const val = data.rows[0]?.[i];
      if (typeof val === 'string' && val.startsWith('$')) { valueIdx = i; break; }
      if (typeof val === 'number') { valueIdx = i; break; }
    }
    const values = data.rows.map(r => {
      let v = r[valueIdx];
      if (typeof v === 'string') v = parseFloat(v.replace(/[$,KM%]/g, '')) || 0;
      return v;
    });

    return {
      type: 'donut',
      title: data.columns[0] + ' breakdown',
      labels,
      values,
      formatValue: (v) => formatNumber(v),
    };
  }

  function formatNumber(n) {
    if (typeof n !== 'number') return String(n);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    if (n !== Math.floor(n)) return n.toFixed(2);
    return n.toLocaleString('en-US');
  }

  // ─── Chart Rendering ───

  function renderChart(chart) {
    currentChart = chart;
    animProgress = 0;
    chartRegions = [];
    hoverInfo = null;
    if (animFrame) cancelAnimationFrame(animFrame);

    if (!chart) {
      drawEmpty('Ask a question to see a chart');
      return;
    }

    animateChart();
  }

  function animateChart() {
    if (!analyticsActive || !currentChart) return;
    animProgress = Math.min(1, animProgress + 0.04);
    const eased = 1 - Math.pow(1 - animProgress, 3);
    drawChartFrame(currentChart, eased);
    if (animProgress < 1) {
      animFrame = requestAnimationFrame(animateChart);
    }
  }

  function drawChartFrame(chart, progress) {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);

    // Title
    ctx.font = 'bold 13px "SF Mono", "Cascadia Code", "Fira Code", monospace';
    ctx.fillStyle = P.textBright;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const titleText = chart.title || '';
    if (titleText.length > 60) {
      ctx.fillText(titleText.slice(0, 58) + '…', 20, 16);
    } else {
      ctx.fillText(titleText, 20, 16);
    }

    chartRegions = [];

    switch (chart.type) {
      case 'bar': drawBar(chart, w, h, progress); break;
      case 'line': drawLine(chart, w, h, progress); break;
      case 'donut': drawDonut(chart, w, h, progress); break;
      case 'number': drawBigNumber(chart, w, h, progress); break;
    }

    if (hoverInfo) drawTooltip(hoverInfo, w, h);
  }

  function drawGrid(w, h) {
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    for (let y = 40; y < h; y += 50) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let x = 0; x < w; x += 50) {
      ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  function drawBar(chart, w, h, progress) {
    const vals = chart.values;
    const labels = chart.labels;
    const n = vals.length;
    if (n === 0) return;

    const padLeft = 80, padRight = 30, padTop = 50, padBot = 55;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBot;
    const maxVal = Math.max(...vals, 0.001);
    const barGap = Math.max(4, chartW * 0.06 / n);
    const barW = Math.max(6, (chartW - barGap * (n + 1)) / n);

    // Y-axis
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const v = (maxVal / 5) * i;
      const y = padTop + chartH - (i / 5) * chartH;
      ctx.fillText(chart.formatValue(v), padLeft - 8, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(w - padRight, y); ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const x = padLeft + barGap + i * (barW + barGap);
      const barH = (vals[i] / maxVal) * chartH * progress;
      const y = padTop + chartH - barH;
      const ci = i % CHART_COLORS.length;
      const c = CHART_COLORS[ci];

      // Glow
      ctx.shadowColor = c.hex;
      ctx.shadowBlur = 10;
      const grad = ctx.createLinearGradient(x, y, x, padTop + chartH);
      grad.addColorStop(0, `rgba(${c.rgb}, 0.9)`);
      grad.addColorStop(1, `rgba(${c.rgb}, 0.3)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, barH);
      ctx.shadowBlur = 0;

      // Top highlight
      ctx.fillStyle = `rgba(${c.rgb}, 1)`;
      ctx.fillRect(x, y, barW, Math.min(2, barH));

      // X label
      ctx.font = '9px "SF Mono", monospace';
      ctx.fillStyle = P.textDim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const labelX = x + barW / 2;
      const labelY = padTop + chartH + 8;
      if (n <= 15 || i % Math.ceil(n / 10) === 0) {
        const lbl = labels[i].length > 12 ? labels[i].slice(0, 10) + '…' : labels[i];
        ctx.save();
        if (n > 8) {
          ctx.translate(labelX, labelY);
          ctx.rotate(-0.4);
          ctx.textAlign = 'right';
          ctx.fillText(lbl, 0, 0);
        } else {
          ctx.fillText(lbl, labelX, labelY);
        }
        ctx.restore();
      }

      // Value on top of bar
      if (barH > 15) {
        ctx.font = 'bold 9px "SF Mono", monospace';
        ctx.fillStyle = P.textBright;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(chart.formatValue(vals[i]), x + barW / 2, y - 4);
      }

      chartRegions.push({
        x, y: padTop, w: barW, h: chartH,
        label: labels[i],
        value: chart.formatValue(vals[i]),
      });
    }
  }

  function drawLine(chart, w, h, progress) {
    const vals = chart.values;
    const labels = chart.labels;
    const n = vals.length;
    if (n < 2) { drawBar(chart, w, h, progress); return; }

    const padLeft = 80, padRight = 30, padTop = 50, padBot = 50;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBot;
    const maxVal = Math.max(...vals, 0.001);
    const c = CHART_COLORS[1]; // purple for line charts

    // Y-axis
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const v = (maxVal / 5) * i;
      const y = padTop + chartH - (i / 5) * chartH;
      ctx.fillText(chart.formatValue(v), padLeft - 8, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(w - padRight, y); ctx.stroke();
    }

    const points = [];
    for (let i = 0; i < n; i++) {
      points.push({
        x: padLeft + (i / (n - 1)) * chartW,
        y: padTop + chartH - (vals[i] / maxVal) * chartH,
      });
    }

    const drawN = Math.ceil(n * progress);

    // Area fill
    ctx.beginPath();
    ctx.moveTo(points[0].x, padTop + chartH);
    for (let i = 0; i < drawN; i++) ctx.lineTo(points[i].x, points[i].y);
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

      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 2, 0, Math.PI * 2);
      ctx.fillStyle = P.textBright;
      ctx.fill();

      chartRegions.push({
        x: points[i].x - 12, y: points[i].y - 12, w: 24, h: 24,
        isCircle: true, cx: points[i].x, cy: points[i].y, cr: 12,
        label: labels[i],
        value: chart.formatValue(vals[i]),
      });
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
  }

  function drawDonut(chart, w, h, progress) {
    const values = chart.values;
    const labels = chart.labels;
    const total = values.reduce((s, v) => s + v, 0) || 1;

    const cx = w * 0.4;
    const cy = h * 0.52;
    const outerR = Math.min(w * 0.25, h * 0.33);
    const innerR = outerR * 0.55;

    let angle = -Math.PI / 2;
    const maxAngle = -Math.PI / 2 + Math.PI * 2 * progress;

    for (let i = 0; i < values.length; i++) {
      const sliceAngle = (values[i] / total) * Math.PI * 2;
      const drawAngle = Math.min(sliceAngle, maxAngle - angle);
      if (drawAngle <= 0) break;

      const c = CHART_COLORS[i % CHART_COLORS.length];

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, angle, angle + drawAngle);
      ctx.arc(cx, cy, innerR, angle + drawAngle, angle, true);
      ctx.closePath();
      ctx.fillStyle = `rgba(${c.rgb}, 0.75)`;
      ctx.shadowColor = c.hex;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(cx, cy, outerR, angle, angle + drawAngle);
      ctx.strokeStyle = `rgba(${c.rgb}, 0.9)`;
      ctx.lineWidth = 2;
      ctx.stroke();

      chartRegions.push({
        isArc: true, cx, cy, innerR, outerR,
        startAngle: angle, endAngle: angle + drawAngle,
        label: labels[i],
        value: chart.formatValue(values[i]) + ` (${(values[i] / total * 100).toFixed(1)}%)`,
      });

      angle += drawAngle;
    }

    // Center total
    ctx.font = 'bold 18px "SF Mono", monospace';
    ctx.fillStyle = P.textBright;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chart.formatValue(total), cx, cy - 6);
    ctx.font = '9px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('TOTAL', cx, cy + 12);

    // Legend
    const legendX = w * 0.7;
    let legendY = h * 0.15;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < labels.length && i < 10; i++) {
      const c = CHART_COLORS[i % CHART_COLORS.length];
      ctx.fillStyle = c.hex;
      ctx.fillRect(legendX, legendY - 5, 10, 10);
      ctx.font = '10px "SF Mono", monospace';
      ctx.fillStyle = P.text;
      const lbl = labels[i].length > 18 ? labels[i].slice(0, 16) + '…' : labels[i];
      ctx.fillText(lbl, legendX + 16, legendY);
      ctx.font = '9px "SF Mono", monospace';
      ctx.fillStyle = P.textDim;
      ctx.fillText(chart.formatValue(values[i]), legendX + 16, legendY + 14);
      legendY += 30;
    }
  }

  function drawBigNumber(chart, w, h, progress) {
    const value = chart.value * progress;
    const displayVal = formatNumber(Math.round(value));

    ctx.font = 'bold 48px "SF Mono", "Cascadia Code", monospace';
    ctx.fillStyle = P.cyan;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = P.cyan;
    ctx.shadowBlur = 30;
    ctx.fillText(displayVal, w / 2, h / 2 - 15);
    ctx.shadowBlur = 0;

    ctx.font = '14px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText(chart.unit.toUpperCase(), w / 2, h / 2 + 25);
  }

  function drawEmpty(message) {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);

    ctx.font = '12px "SF Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(message || 'Ask a question to see a chart', w / 2, h / 2);
  }

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
          const angle = Math.atan2(dy, dx);
          if (r.endAngle - r.startAngle >= Math.PI * 2 - 0.01) {
            hoverInfo = r; break;
          }
          if (angle >= r.startAngle && angle <= r.endAngle) {
            hoverInfo = r; break;
          }
          // Handle wrap-around
          const normAngle = angle < r.startAngle ? angle + Math.PI * 2 : angle;
          if (normAngle >= r.startAngle && normAngle <= r.endAngle) {
            hoverInfo = r; break;
          }
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
    if (currentChart) drawChartFrame(currentChart, Math.min(1, animProgress));
  }

  // ─── Table Rendering (HTML) ───

  function renderTable(data) {
    if (!data || !data.columns || !data.rows) return '';

    let html = '<div class="achat-table-wrap"><table class="achat-table"><thead><tr>';
    for (const col of data.columns) {
      html += `<th>${escHtml(col)}</th>`;
    }
    html += '</tr></thead><tbody>';

    const maxRows = 20;
    const rows = data.rows.slice(0, maxRows);
    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) {
        const cellStr = String(cell);
        const isNumber = /^\$?[\d,.]+[KM%]?$/.test(cellStr);
        html += `<td class="${isNumber ? 'num' : ''}">${escHtml(cellStr)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    if (data.rows.length > maxRows) {
      html += `<div class="achat-table-more">… and ${data.rows.length - maxRows} more rows</div>`;
    }
    html += '</div>';
    return html;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ─── Chat UI ───

  function initChat() {
    const chatMsgs = document.getElementById('analytics-chat-messages');
    const chatInput = document.getElementById('analytics-chat-input');
    if (!chatMsgs || !chatInput) return;

    // Only add welcome if chat is empty (preserve across tab switches)
    if (chatMsgs.children.length === 0) {
      addSystemMessage(
        '🔍 Ask me about your fleet metrics.\n\n' +
        'Try:\n' +
        '  • "how many tokens burned today?"\n' +
        '  • "which agent burned the most?"\n' +
        '  • "cost by day"\n' +
        '  • "today vs yesterday"\n' +
        '  • "overview"\n' +
        '  • "help" for full list'
      );
    }

    // Remove old listener to avoid duplicates
    chatInput.removeEventListener('keydown', handleChatKeydown);
    chatInput.addEventListener('keydown', handleChatKeydown);
  }

  function handleChatKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = e.target;
      const query = input.value.trim();
      if (!query || isQuerying) return;
      input.value = '';
      processQuery(query);
    }
  }

  async function processQuery(query) {
    addUserMessage(query);
    queryHistory.push(query);

    isQuerying = true;
    addLoadingMessage();

    try {
      const result = await sendQuery(query);
      removeLoadingMessage();

      // Show the text answer
      const hasTable = result.data && result.data.rows && result.data.rows.length > 0;
      let messageHtml = escHtml(result.answer);

      // Add table if present
      if (hasTable) {
        messageHtml += renderTable(result.data);
      }

      // Show SQL for transparency
      if (result.sql) {
        messageHtml += `<div class="achat-sql"><span class="achat-sql-label">SQL:</span> <code>${escHtml(result.sql.slice(0, 200))}</code></div>`;
      }

      addSystemMessageHtml(messageHtml);

      // Build and render chart
      const chart = buildChartFromResponse(result);
      if (chart) {
        renderChart(chart);
      }
    } catch (err) {
      removeLoadingMessage();
      addSystemMessage(`❌ Error: ${err.message}`);
    } finally {
      isQuerying = false;
    }
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

  function addSystemMessageHtml(html) {
    const chatMsgs = document.getElementById('analytics-chat-messages');
    if (!chatMsgs) return;
    const el = document.createElement('div');
    el.className = 'achat-msg achat-system';
    el.innerHTML = html;
    chatMsgs.appendChild(el);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  function addLoadingMessage() {
    const chatMsgs = document.getElementById('analytics-chat-messages');
    if (!chatMsgs) return;
    const el = document.createElement('div');
    el.className = 'achat-msg achat-system achat-loading';
    el.innerHTML = '<span class="achat-dots">●●●</span> Querying fleet data…';
    chatMsgs.appendChild(el);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  function removeLoadingMessage() {
    const el = document.querySelector('.achat-loading');
    if (el) el.remove();
  }

  // ─── Canvas Setup ───

  function setupCanvas() {
    canvas = document.getElementById('analytics-chart-canvas');
    if (!canvas) return;
    resizeCanvas();
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', () => {
      hoverInfo = null;
      if (currentChart) drawChartFrame(currentChart, Math.min(1, animProgress));
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
    if (currentChart) {
      drawChartFrame(currentChart, Math.min(1, animProgress));
    } else {
      drawEmpty('Ask a question to see a chart');
    }
  }

  // ─── Public API ───

  window.analyticsInit = function() {
    if (analyticsActive) return;
    analyticsActive = true;
    setupCanvas();
    initChat();
    if (!currentChart) drawEmpty('Ask a question to see a chart');
  };

  window.analyticsDestroy = function() {
    analyticsActive = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    // Don't clear state — preserve chat and chart across tab switches
    window.removeEventListener('resize', resizeCanvas);
  };

})();
