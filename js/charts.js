/* ------------------------------------------------------------------
   js/charts.js
   All chart creation and updating (Chart.js plugins, builders, configs)
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Chart.js eklentisi: debi eşik çizgileri (22 ve 20 m³/s)
   Ek kütüphane gerektirmez; çizgiler ve etiketler doğrudan çizilir.
   ------------------------------------------------------------------ */
function thresholdLineList() {
  return [CONFIG.thresholds.twoUnits, CONFIG.thresholds.oneUnit].map((t) => ({
    value: t.value,
    label: t.label,
    color: t.color,
    labelOffset: t.labelOffset,
    showLabel: true
  }));
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const thresholdPlugin = {
  id: 'hubeauThresholds',
  afterDatasetsDraw(chart) {
    const opts = chart.options.plugins && chart.options.plugins.hubeauThresholds;
    if (!opts || !opts.enabled) return;

    const area = chart.chartArea;
    const yScale = chart.scales && chart.scales.y;
    if (!area || !yScale) return;

    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    for (const line of opts.lines) {
      const y = yScale.getPixelForValue(line.value);
      if (!Number.isFinite(y) || y < area.top - 1 || y > area.bottom + 1) continue;

      // Kesikli eşik çizgisi --warn
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#D29922';
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (!line.showLabel) continue;

      // Sağ üst/köşede küçük etiket
      const padX = 5;
      const labelH = 15;
      const boxW = ctx.measureText(line.label).width + padX * 2;
      const boxX = area.right - boxW - 4;
      let boxY = line.labelOffset === 'below' ? y + 3 : y - labelH - 3;
      boxY = Math.max(area.top + 2, Math.min(boxY, area.bottom - labelH - 2));

      roundRectPath(ctx, boxX, boxY, boxW, labelH, 2);
      ctx.fillStyle = '#0B0F14';
      ctx.fill();
      ctx.strokeStyle = '#D29922';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#D29922';
      ctx.fillText(line.label, boxX + padX, boxY + labelH / 2 + 0.5);
    }

    ctx.restore();
  }
};

const lastValueLabelPlugin = {
  id: 'lastValueLabel',
  afterDatasetsDraw(chart) {
    const area = chart.chartArea;
    const meta = chart.getSortedVisibleDatasetMetas();
    if (!area || !meta || !meta.length) return;

    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    meta.forEach((m) => {
      const ds = chart.data.datasets[m.index];
      if (!ds || ds.hidden || !m.data || !m.data.length) return;

      // Find the last valid point in m.data
      let lastPoint = null;
      let lastRaw = null;
      for (let i = m.data.length - 1; i >= 0; i--) {
        const p = m.data[i];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && !p.skip) {
          lastPoint = p;
          lastRaw = ds.data[i];
          break;
        }
      }
      if (!lastPoint || lastRaw == null) return;
      const val = typeof lastRaw === 'object' && lastRaw !== null ? lastRaw.y : lastRaw;
      if (!Number.isFinite(val)) return;

      const fmt = typeof ds.$fmt === 'function' ? ds.$fmt : (v) => Number(v).toFixed(1);
      const text = fmt(val);
      const textW = ctx.measureText(text).width;
      const pad = 3;
      let lx = lastPoint.x + 5;
      if (lx + textW + pad * 2 > area.right) {
        lx = lastPoint.x - textW - pad * 2 - 5;
      }
      let ly = Math.max(area.top + 7, Math.min(lastPoint.y, area.bottom - 7));

      roundRectPath(ctx, lx, ly - 7, textW + pad * 2, 14, 2);
      ctx.fillStyle = '#0F151C';
      ctx.fill();
      ctx.strokeStyle = '#1F2933';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = ds.borderColor || '#E6EDF3';
      ctx.fillText(text, lx + pad, ly + 0.5);
    });

    ctx.restore();
  }
};

const zeroLinePlugin = {
  id: 'zeroLine',
  afterDatasetsDraw(chart) {
    const opts = chart.options.plugins && chart.options.plugins.zeroLine;
    if (!opts || !opts.enabled) return;

    const area = chart.chartArea;
    const yScale = chart.scales && chart.scales.y;
    if (!area || !yScale) return;

    const y = yScale.getPixelForValue(0);
    if (!Number.isFinite(y) || y < area.top - 1 || y > area.bottom + 1) return;

    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(226,232,240,.62)';
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();

    ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,.76)';
    ctx.textBaseline = 'bottom';
    ctx.fillText('0 MW', area.left + 6, y - 3);
    ctx.restore();
  }
};

/* ------------------------------------------------------------------
   Grafik Yapıcılar
   ------------------------------------------------------------------ */
function zeroLinePluginStub() {}

/**
 * x ekseni "linear" (ms zaman damgası) — Chart.js tarih eklentisi gerekmez,
 * yalnızca Chart.js yüklenir. Etiket biçimi aralığa göre chart.$tickFmt ile değişir.
 */
function buildChart(canvasId, opts) {
  return new Chart($(canvasId), {
    type: 'line',
    data: {
      datasets: [{
        label: opts.label,
        data: [],
        borderColor: opts.color,
        borderWidth: 1.5,
        backgroundColor: 'transparent',
        fill: false,
        tension: opts.tension,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: opts.color,
        pointHoverBorderColor: '#0F151C',
        pointHoverBorderWidth: 1.5,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 550 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: opts.legend ? {
          display: true,
          position: opts.legendPosition || 'top',
          align: 'end',
          labels: {
            color: '#6E7681',
            usePointStyle: true,
            pointStyle: 'line',
            boxWidth: 18,
            boxHeight: 8,
            padding: 14,
            font: { size: 10, family: 'Inter' }
          }
        } : { display: false },
        lastValueLabel: { enabled: true },
        hubeauThresholds: {
          enabled: !!opts.thresholds,
          lines: opts.thresholds ? thresholdLineList() : []
        },
        zeroLine: {
          enabled: !!opts.zeroLine
        },
        tooltip: {
          backgroundColor: '#0F151C',
          borderColor: '#1F2933',
          borderWidth: 1,
          titleColor: '#E6EDF3',
          bodyColor: '#E6EDF3',
          padding: 11,
          cornerRadius: 2,
          displayColors: false,
          callbacks: {
            title: (items) => (items.length ? opts.titleFormat(items[0].parsed.x) : ''),
            label: (item) => {
              if (item.parsed.y == null || !Number.isFinite(item.parsed.y)) return null;
              if (item.dataset.$genTooltip) {
                const raw = item.raw || {};
                const gen = Number.isFinite(raw.gen) ? raw.gen : 0;
                const cons = Number.isFinite(raw.cons) ? raw.cons : 0;
                return 'Net: ' + nfMW.format(item.parsed.y) + ' MW (üretim ' +
                  nfMW.format(gen) + ' MW, iç tüketim ' + nfMW.format(cons) + ' MW)';
              }
              const fmt = typeof item.dataset.$fmt === 'function'
                ? item.dataset.$fmt
                : opts.valueFormat;
              const unit = item.dataset.$unit || opts.unit;
              const text = fmt(item.parsed.y) + ' ' + unit;
              // Birden fazla seri varsa hangi seri olduğunu da yaz.
              return item.chart.data.datasets.length > 1
                ? item.dataset.label + ': ' + text
                : text;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          bounds: 'data',
          grid: { color: '#1F2933', drawTicks: false },
          border: { display: false },
          ticks: {
            color: '#6E7681',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: opts.maxTicks,
            padding: 8,
            font: { size: 10, family: 'Inter' },
            callback: function (value) {
              const fmt = (this.chart && this.chart.$tickFmt) || opts.tickFormat;
              return fmt(value);
            }
          }
        },
        y: {
          suggestedMax: opts.suggestedMax,
          grid: { color: '#1F2933', drawTicks: false },
          border: { display: false },
          ticks: {
            color: '#6E7681',
            padding: 8,
            font: { size: 10, family: 'JetBrains Mono' },
            maxTicksLimit: 6,
            callback: (value) => opts.yFormat(value)
          }
        }
      }
    }
  });
}

function initCharts() {
  if (typeof Chart !== 'undefined' && typeof lastValueLabelPlugin !== 'undefined') {
    Chart.register(lastValueLabelPlugin);
  }

  charts.h = buildChart('hChart', {
    label: 'Su seviyesi (m)',
    color: '#39C5CF',
    unit: 'm',
    tension: 0.22,
    maxTicks: 7,
    tickFormat: (v) => fmtDDMM.format(new Date(v)),
    titleFormat: (v) => fmtFull.format(new Date(v)),
    valueFormat: (v) => nfH.format(v),
    yFormat: (v) => nfTick.format(v)
  });

  charts.q = buildChart('qChart', {
    label: 'Debi (ham)',
    color: '#39C5CF',
    unit: 'm³/s',
    tension: 0.22,
    maxTicks: 7,
    legend: true,
    thresholds: true,
    suggestedMax: CONFIG.thresholds.twoUnits.value * 1.1,
    tickFormat: (v) => fmtDDMM.format(new Date(v)),
    titleFormat: (v) => fmtFull.format(new Date(v)),
    valueFormat: (v) => nfQ.format(v),
    yFormat: (v) => nfTick.format(v)
  });

  // Q grafiğine ikinci seri: 12 günlük hareketli ortalama
  charts.q.data.datasets.push({
    label: CONFIG.rolling.windowDays + ' günlük ortalama',
    data: [],
    borderColor: '#D29922',
    borderWidth: 1.5,
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: '#D29922',
    pointHoverBorderColor: '#0F151C',
    pointHoverBorderWidth: 1.5,
    spanGaps: false
  });

  charts.d = buildChart('dChart', {
    label: 'Günlük ortalama debi (m³/s)',
    color: '#39C5CF',
    unit: 'm³/s',
    tension: 0.15,
    maxTicks: 9,
    tickFormat: (v) => fmtMonthYear.format(new Date(v)),
    titleFormat: (v) => fmtDayOnly.format(new Date(v)),
    valueFormat: (v) => nfQ.format(v),
    yFormat: (v) => nfTick.format(v)
  });

  // Karşılaştırma grafiği: veri setleri istasyonlara göre dinamik oluşturulur.
  charts.cmp = buildChart('cmpChart', {
    label: 'Debi (m³/s)',
    color: '#39C5CF',
    unit: 'm³/s',
    tension: 0.2,
    maxTicks: 8,
    legend: true,
    thresholds: true,
    suggestedMax: CONFIG.thresholds.twoUnits.value * 1.1,
    tickFormat: (v) => fmtDDMM.format(new Date(v)),
    titleFormat: (v) => fmtFull.format(new Date(v)),
    valueFormat: (v) => nfQ.format(v),
    yFormat: (v) => nfTick.format(v)
  });
  charts.cmp.data.datasets = [];
}

function initPlantCharts() {
  orderedPlants().forEach((plant) => {
    const canvasId = 'genChart_' + plant.key;
    if (!$(canvasId)) return;

    const units = orderedUnits(plant);
    const first = units[0] || { label: plant.label };
    const chart = buildChart(canvasId, {
      label: (first.label || plant.label) + ' (MW)',
      color: unitColor(plant, 0),
      unit: 'MW',
      tension: 0.16,
      maxTicks: 8,
      legend: units.length > 1,
      legendPosition: 'bottom',
      zeroLine: true,
      suggestedMax: 1600,
      tickFormat: (v) => fmtDDMM.format(new Date(v)),
      titleFormat: (v) => fmtFull.format(new Date(v)),
      valueFormat: (v) => nfMW.format(v),
      yFormat: (v) => nfMW.format(v)
    });

    chart.data.datasets[0].$unit = 'MW';
    chart.data.datasets[0].$fmt = (v) => nfMW.format(v);
    chart.data.datasets[0].$genTooltip = true;

    for (let index = 1; index < units.length; index += 1) {
      const color = unitColor(plant, index);
      chart.data.datasets.push({
        label: units[index].label + ' (MW)',
        data: [],
        borderColor: color,
        borderWidth: 1.5,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.16,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#0F151C',
        pointHoverBorderWidth: 1.5,
        spanGaps: false,
        $unit: 'MW',
        $fmt: (v) => nfMW.format(v),
        $genTooltip: true
      });
    }

    charts.gen.set(plant.key, chart);
  });
}

function pushChart(key, points, label) {
  const chart = charts[key];
  chart.data.datasets[0].label = label;
  chart.data.datasets[0].data = points;
  chart.update('none');
}

function setChartTickFormat(chart, fmt) {
  chart.$tickFmt = fmt;
}

// applyGenOverlay removed as rolling average overlay is removed from MW chart

function resetCharts() {
  ['h', 'q', 'd'].forEach((key) => {
    charts[key].data.datasets.forEach((ds) => { ds.data = []; });
    charts[key].update('none');
  });
  charts.cmp.data.datasets = [];
  charts.cmp.update('none');
  charts.gen.forEach((chart) => {
    chart.data.datasets.forEach((ds) => { ds.data = []; });
    chart.update('none');
  });
  ui.hFoot.innerHTML = '';
  ui.qFoot.innerHTML = '';
  ui.dFoot.innerHTML = '';
  ui.cmpFoot.innerHTML = '';
  orderedPlants().forEach((plant) => {
    const foot = $('genFoot_' + plant.key);
    if (foot) foot.innerHTML = '';
  });
}
