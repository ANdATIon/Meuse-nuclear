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
    ctx.font = '500 9.5px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    for (const line of opts.lines) {
      const y = yScale.getPixelForValue(line.value);
      if (!Number.isFinite(y) || y < area.top - 1 || y > area.bottom + 1) continue;

      // 22 m³/s yellow dashed, 20 m³/s red dashed, thinner (1px)
      const color = line.color || (line.value >= 21 ? '#D29922' : '#F85149');

      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (!line.showLabel) continue;

      // Sağ kenarda küçük, kutu çerçevesiz etiket
      let textY = line.labelOffset === 'below' ? y + 8 : y - 8;
      textY = Math.max(area.top + 6, Math.min(textY, area.bottom - 6));

      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(line.label, area.right - 6, textY);
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

    const items = [];
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

      items.push({
        text,
        textW,
        pad,
        lx,
        ly,
        color: ds.borderColor || '#E6EDF3'
      });
    });

    if (!items.length) {
      ctx.restore();
      return;
    }

    // Son değer etiketleri çakışmasın: 14px'den yakın olanları dikeyde kaydır
    items.sort((a, b) => a.ly - b.ly);
    const minDistance = 14;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < items.length; i++) {
        const diff = items[i].ly - items[i - 1].ly;
        if (diff < minDistance) {
          const shift = (minDistance - diff) / 2;
          items[i - 1].ly = Math.max(area.top + 7, items[i - 1].ly - shift);
          items[i].ly = Math.min(area.bottom - 7, items[i].ly + shift);
        }
      }
    }

    items.forEach((item) => {
      roundRectPath(ctx, item.lx, item.ly - 7, item.textW + item.pad * 2, 14, 2);
      ctx.fillStyle = '#12171E';
      ctx.fill();
      ctx.strokeStyle = '#1C222B';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = item.color;
      ctx.fillText(item.text, item.lx + item.pad, item.ly + 0.5);
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
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(110,118,129,.55)';
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();

    ctx.font = '600 10px "Inter", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(230,237,243,.6)';
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
        pointHoverBorderColor: '#12171E',
        pointHoverBorderWidth: 1.5,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
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
          backgroundColor: 'rgba(10, 14, 19, 0.92)',
          borderColor: 'rgba(255, 255, 255, 0.06)',
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
          grid: { color: '#141920', drawTicks: false },
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
        y: Object.assign(
          {
            suggestedMax: opts.suggestedMax,
            grid: { color: '#141920', drawTicks: false },
            border: { display: false },
            ticks: {
              color: '#6E7681',
              padding: 8,
              font: { size: 10, family: 'JetBrains Mono' },
              maxTicksLimit: 6,
              callback: (value) => opts.yFormat(value)
            }
          },
          opts.min !== undefined ? { min: opts.min } : {},
          opts.beginAtZero !== undefined ? { beginAtZero: opts.beginAtZero } : {}
        )
      }
    },
    plugins: opts.extraPlugins || []
  });
}

function initCharts() {
  if (typeof Chart !== 'undefined' && typeof lastValueLabelPlugin !== 'undefined') {
    Chart.register(lastValueLabelPlugin);
  }

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

  const qDynamicScalePlugin = {
    id: 'qDynamicScale',
    beforeUpdate(chart) {
      let maxVal = 0;
      const datasets = chart.data && chart.data.datasets;
      if (datasets) {
        for (let i = 0; i < datasets.length; i++) {
          const ds = datasets[i];
          if (ds.hidden || !ds.data) continue;
          for (let j = 0; j < ds.data.length; j++) {
            const pt = ds.data[j];
            if (pt == null) continue;
            const yVal = typeof pt === 'object' && pt !== null ? pt.y : pt;
            if (Number.isFinite(yVal) && yVal > maxVal) {
              maxVal = yVal;
            }
          }
        }
      }
      const yScaleOpts = chart.options && chart.options.scales && chart.options.scales.y;
      if (yScaleOpts) {
        yScaleOpts.min = 0;
        yScaleOpts.beginAtZero = true;
        if (maxVal > 0) {
          // max = max(data) rounded up to next 10 (en az 30 m³/s ki 22 ve 20 eşikleri rahatça görünsün)
          const targetMax = Math.max(30, Math.ceil(maxVal / 10) * 10);
          yScaleOpts.max = targetMax;
          if (chart.scales && chart.scales.y) {
            chart.scales.y.options.min = 0;
            chart.scales.y.options.beginAtZero = true;
            chart.scales.y.options.max = targetMax;
          }
        }
      }
    }
  };

  charts.q = buildChart('qChart', {
    label: 'Debi (ham)',
    color: COLORS.q,
    unit: 'm³/s',
    tension: 0.22,
    maxTicks: 7,
    legend: true,
    thresholds: true,
    min: 0,
    beginAtZero: true,
    extraPlugins: [qDynamicScalePlugin],
    tickFormat: (v) => fmtDDMM.format(new Date(v)),
    titleFormat: (v) => fmtFull.format(new Date(v)),
    valueFormat: (v) => nfQ.format(v),
    yFormat: (v) => nfTick.format(v)
  });

  // Ham seri: yeşil 1.5px, ortalama çizgisinin altında
  charts.q.data.datasets[0].borderColor = COLORS.q;
  charts.q.data.datasets[0].borderWidth = 1.5;
  charts.q.data.datasets[0].order = 2;

  // Q grafiğine ikinci seri: 12 günlük hareketli ortalama — mavi %50, 2px, ham debinin üstünde
  charts.q.data.datasets.push({
    label: CONFIG.rolling.windowDays + ' günlük ortalama',
    data: [],
    borderColor: CONFIG.colors.rolling,
    borderWidth: 2,
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: CONFIG.colors.rolling,
    pointHoverBorderColor: '#12171E',
    pointHoverBorderWidth: 1.5,
    spanGaps: false,
    order: 1
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
    color: COLORS.h,
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

  initWeatherChart();
}

function initWeatherChart() {
  if (!$('weatherChart')) return;
  if (charts.weather) {
    try { charts.weather.destroy(); } catch (e) {}
  }

  const chart = buildChart('weatherChart', {
    label: 'Yağış (mm)',
    color: '#58A6FF',
    unit: 'mm',
    tension: 0,
    maxTicks: 8,
    legend: true,
    legendPosition: 'top',
    min: 0,
    beginAtZero: true,
    tickFormat: (v) => fmtDDMM.format(new Date(v)),
    titleFormat: (v) => fmtFull.format(new Date(v)),
    valueFormat: (v) => nfQ.format(v),
    yFormat: (v) => nfTick.format(v)
  });

  const rain = chart.data.datasets[0];
  rain.type = 'bar';
  rain.label = 'Yağış (mm)';
  rain.yAxisID = 'y';
  rain.backgroundColor = 'rgba(88, 166, 255, 0.3)';
  rain.borderColor = '#58A6FF';
  rain.borderWidth = 1;
  rain.borderSkipped = false;
  rain.barPercentage = 1;
  rain.categoryPercentage = 1;
  rain.maxBarThickness = 6;
  rain.pointRadius = 0;
  rain.$unit = 'mm';
  rain.$fmt = (v) => nfQ.format(v);
  rain.order = 2;

  chart.data.datasets.push({
    type: 'line',
    label: 'Debi (m³/s)',
    data: [],
    yAxisID: 'y1',
    borderColor: '#3FB950',
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    fill: false,
    tension: 0.2,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: '#3FB950',
    pointHoverBorderColor: '#12171E',
    pointHoverBorderWidth: 1.5,
    spanGaps: false,
    $unit: 'm³/s',
    $fmt: (v) => nfQ.format(v),
    order: 1
  });

  const axisTicks = {
    color: '#6E7681',
    padding: 8,
    font: { size: 10, family: 'JetBrains Mono' },
    maxTicksLimit: 6,
    callback: (value) => nfTick.format(value)
  };

  chart.options.scales.y = {
    position: 'left',
    beginAtZero: true,
    grid: { color: '#141920', drawTicks: false },
    border: { display: false },
    ticks: axisTicks
  };
  chart.options.scales.y1 = {
    position: 'right',
    beginAtZero: true,
    grid: { color: '#141920', drawTicks: false, drawOnChartArea: false },
    border: { display: false },
    ticks: axisTicks
  };
  chart.options.plugins.legend.labels.pointStyle = 'rectRounded';
  chart.options.plugins.lastValueLabel = { enabled: false };
  chart.options.plugins.zeroLine = { enabled: false };
  chart.options.plugins.hubeauThresholds = { enabled: false, lines: [] };

  charts.weather = chart;
}

function getPlantNominalCapacity(plant) {
  const units = orderedUnits(plant);
  let sum = 0;
  for (const u of units) {
    if (Number.isFinite(u.nominalMW)) {
      sum += u.nominalMW;
    } else if (u.key === 'chooz1' || u.key === 'chooz2') {
      sum += 1500;
    } else if (u.key === 'doel4') {
      sum += 1033;
    } else if (u.key === 'tihange3') {
      sum += 1038;
    } else {
      sum += 1000;
    }
  }
  return sum;
}

const choozDynamicMinPlugin = {
  id: 'choozDynamicMin',
  beforeUpdate(chart) {
    let lowest = 0;
    const datasets = chart.data && chart.data.datasets;
    if (datasets) {
      for (let i = 0; i < datasets.length; i++) {
        const ds = datasets[i];
        if (ds.hidden || !ds.data) continue;
        for (let j = 0; j < ds.data.length; j++) {
          const pt = ds.data[j];
          if (pt == null) continue;
          const yVal = typeof pt === 'object' && pt !== null ? pt.y : pt;
          if (Number.isFinite(yVal) && yVal < lowest) {
            lowest = yVal;
          }
        }
      }
    }
    const yScaleOpts = chart.options && chart.options.scales && chart.options.scales.y;
    if (yScaleOpts) {
      if (lowest < 0) {
        // min(0, lowest data value) - small padding, so negative values (grid consumption) stay visible
        const pad = Math.max(20, Math.round(Math.abs(lowest) * 0.15));
        const newMin = Math.floor(lowest - pad);
        yScaleOpts.min = newMin;
        yScaleOpts.beginAtZero = false;
        if (chart.scales && chart.scales.y) {
          chart.scales.y.options.min = newMin;
          chart.scales.y.options.beginAtZero = false;
        }
      } else {
        yScaleOpts.min = 0;
        yScaleOpts.beginAtZero = true;
        if (chart.scales && chart.scales.y) {
          chart.scales.y.options.min = 0;
          chart.scales.y.options.beginAtZero = true;
        }
      }
    }
  }
};

function initPlantCharts() {
  orderedPlants().forEach((plant) => {
    const canvasId = 'genChart_' + plant.key;
    if (!$(canvasId)) return;

    const isChooz = plant.key === 'chooz';
    const units = orderedUnits(plant);
    const first = units[0] || { label: plant.label };
    const plantCapacity = getPlantNominalCapacity(plant);
    const suggestedMax = Math.round(plantCapacity * 1.1);

    const chart = buildChart(canvasId, {
      label: (first.label || plant.label) + ' (MW)',
      color: unitColor(plant, 0),
      unit: 'MW',
      tension: 0.16,
      maxTicks: 8,
      legend: units.length > 1,
      legendPosition: 'bottom',
      zeroLine: true,
      min: isChooz ? undefined : 0,
      beginAtZero: isChooz ? undefined : true,
      suggestedMax: suggestedMax,
      extraPlugins: isChooz ? [choozDynamicMinPlugin] : [],
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
        pointHoverBorderColor: '#12171E',
        pointHoverBorderWidth: 1.5,
        spanGaps: false,
        $unit: 'MW',
        $fmt: (v) => nfMW.format(v),
        $genTooltip: true
      });
    }

    charts.gen.set(plant.key, chart);
  });

  initBeNuclearChart();
}

function initBeNuclearChart() {
  const canvasId = 'beNuclearChart';
  if (!$(canvasId)) return;
  if (charts.beNuclear) {
    try { charts.beNuclear.destroy(); } catch (e) {}
  }
  const beCapacity = (CONFIG.entsoe && CONFIG.entsoe.belgianUnits
    ? CONFIG.entsoe.belgianUnits.reduce((acc, u) => acc + (u.nominalMW || 0), 0)
    : 0) || (1033 + 1038);
  const suggestedMax = Math.round(beCapacity * 1.1);

  charts.beNuclear = buildChart(canvasId, {
    label: 'Belçika nükleer toplamı (MW)',
    color: '#58A6FF',
    unit: 'MW',
    tension: 0.16,
    maxTicks: 8,
    legend: false,
    zeroLine: true,
    min: 0,
    beginAtZero: true,
    suggestedMax: suggestedMax,
    tickFormat: (v) => fmtDDMM.format(new Date(v)),
    titleFormat: (v) => fmtFull.format(new Date(v)),
    valueFormat: (v) => nfMW.format(v),
    yFormat: (v) => nfMW.format(v)
  });

  if (charts.beNuclear) {
    charts.beNuclear.data.datasets[0].$unit = 'MW';
    charts.beNuclear.data.datasets[0].$fmt = (v) => nfMW.format(v);
  }
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
  if (charts.beNuclear) {
    charts.beNuclear.data.datasets.forEach((ds) => { ds.data = []; });
    charts.beNuclear.update('none');
  }
  const beFoot = $('beNuclearFoot');
  if (beFoot) beFoot.innerHTML = '';

  if (charts.weather) {
    charts.weather.data.datasets.forEach((ds) => { ds.data = []; });
    charts.weather.update('none');
  }
  const weatherFoot = $('weatherFoot');
  if (weatherFoot) weatherFoot.innerHTML = '';
}
