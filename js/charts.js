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
    ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (const line of opts.lines) {
      const y = yScale.getPixelForValue(line.value);
      if (!Number.isFinite(y) || y < area.top - 1 || y > area.bottom + 1) continue;

      // Kesikli eşik çizgisi
      ctx.beginPath();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = line.color;
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (!line.showLabel) continue;

      // Sağ üst/köşede küçük etiket
      const padX = 6;
      const labelH = 17;
      const boxW = ctx.measureText(line.label).width + padX * 2;
      const boxX = area.right - boxW - 4;
      let boxY = line.labelOffset === 'below' ? y + 4 : y - labelH - 4;
      boxY = Math.max(area.top + 2, Math.min(boxY, area.bottom - labelH - 2));

      roundRectPath(ctx, boxX, boxY, boxW, labelH, 5);
      ctx.fillStyle = 'rgba(6,10,19,.82)';
      ctx.fill();
      ctx.strokeStyle = hexToRgba(line.color, 0.38);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = line.color;
      ctx.fillText(line.label, boxX + padX, boxY + labelH / 2 + 0.5);
    }

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
function areaGradient(hex) {
  return (context) => {
    const { ctx, chartArea } = context.chart;
    if (!chartArea) return 'transparent';
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, hexToRgba(hex, 0.30));
    g.addColorStop(0.75, hexToRgba(hex, 0.05));
    g.addColorStop(1, hexToRgba(hex, 0));
    return g;
  };
}

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
        borderWidth: 1.7,
        backgroundColor: areaGradient(opts.color),
        fill: true,
        tension: opts.tension,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: opts.color,
        pointHoverBorderColor: '#0a1120',
        pointHoverBorderWidth: 2,
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
            color: '#8ea3c0',
            usePointStyle: true,
            pointStyle: 'line',
            boxWidth: 18,
            boxHeight: 8,
            padding: 14,
            font: { size: 10.5 }
          }
        } : { display: false },
        hubeauThresholds: {
          enabled: !!opts.thresholds,
          lines: opts.thresholds ? thresholdLineList() : []
        },
        zeroLine: {
          enabled: !!opts.zeroLine
        },
        tooltip: {
          backgroundColor: 'rgba(9,15,26,.96)',
          borderColor: 'rgba(148,163,184,.22)',
          borderWidth: 1,
          titleColor: '#dbe6f7',
          bodyColor: '#f1f5fb',
          padding: 11,
          cornerRadius: 9,
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
          grid: { color: 'rgba(148,163,184,.07)', drawTicks: false },
          border: { display: false },
          ticks: {
            color: '#7f93ae',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: opts.maxTicks,
            padding: 8,
            font: { size: 10.5 },
            callback: function (value) {
              const fmt = (this.chart && this.chart.$tickFmt) || opts.tickFormat;
              return fmt(value);
            }
          }
        },
        y: {
          suggestedMax: opts.suggestedMax,
          grid: { color: 'rgba(148,163,184,.07)', drawTicks: false },
          border: { display: false },
          ticks: {
            color: '#7f93ae',
            padding: 8,
            font: { size: 10.5 },
            maxTicksLimit: 6,
            callback: (value) => opts.yFormat(value)
          }
        }
      }
    }
  });
}

function initCharts() {
  charts.h = buildChart('hChart', {
    label: 'Su seviyesi (m)',
    color: COLORS.h,
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
    color: COLORS.q,
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
    borderColor: CONFIG.colors.rolling,
    borderWidth: 2.8,
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: CONFIG.colors.rolling,
    pointHoverBorderColor: '#0a1120',
    pointHoverBorderWidth: 2,
    spanGaps: false
  });

  charts.d = buildChart('dChart', {
    label: 'Günlük ortalama debi (m³/s)',
    color: COLORS.d,
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
    color: CONFIG.colors.compare[0],
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
        borderWidth: 1.7,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.16,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#0a1120',
        pointHoverBorderWidth: 2,
        spanGaps: false,
        $unit: 'MW',
        $fmt: (v) => nfMW.format(v),
        $genTooltip: true
      });
    }

    if (plant.river) {
      const overlayIndex = chart.data.datasets.length;
      chart.$overlayIndex = overlayIndex;
      chart.data.datasets.push({
        label: CONFIG.rolling.windowDays + ' günlük ortalama debi',
        data: [],
        borderColor: CONFIG.colors.genOverlay,
        borderWidth: 2.6,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: CONFIG.colors.genOverlay,
        pointHoverBorderColor: '#0a1120',
        pointHoverBorderWidth: 2,
        yAxisID: 'y1',
        hidden: true,
        spanGaps: false,
        $unit: 'm³/s',
        $fmt: (v) => nfQ.format(v)
      });

      chart.options.scales.y1 = {
        position: 'right',
        display: false,
        grid: { drawOnChartArea: false, color: 'rgba(148,163,184,.07)' },
        border: { display: false },
        ticks: {
          color: CONFIG.colors.genOverlay,
          padding: 8,
          font: { size: 10.5 },
          maxTicksLimit: 6,
          callback: (value) => nfTick.format(value)
        }
      };

      chart.options.plugins.legend.onClick = (evt, item, legend) => {
        if (item.datasetIndex === overlayIndex) {
          const input = $('genOverlay_' + plant.key);
          if (input) input.checked = !input.checked;
          applyGenOverlay(plant.key);
          return;
        }
        Chart.defaults.plugins.legend.onClick.call(legend, evt, item, legend);
      };
    }

    charts.gen.set(plant.key, chart);
  });

  orderedPlants().forEach((plant) => {
    const input = $('genOverlay_' + plant.key);
    if (!input) return;
    input.checked = !!CONFIG.entsoe.productionOverlayDefault;
    input.addEventListener('change', () => applyGenOverlay(plant.key));
    applyGenOverlay(plant.key);
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

function applyGenOverlay(plantKey) {
  const chart = charts.gen.get(plantKey);
  if (!chart || chart.$overlayIndex == null) return;

  const input = $('genOverlay_' + plantKey);
  const visible = !!(input && input.checked);
  const overlay = chart.data.datasets[chart.$overlayIndex];
  if (overlay) overlay.hidden = !visible;
  if (chart.options.scales.y1) chart.options.scales.y1.display = visible;
  chart.update('none');
}

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
