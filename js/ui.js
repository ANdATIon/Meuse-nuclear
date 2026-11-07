/* ------------------------------------------------------------------
   js/ui.js
   Rendering of reactor cards, plant sections, notice panel,
   error banners, tabs and time-range selector
   ------------------------------------------------------------------ */

function tickCountdown() {
  if (typeof nextRefreshAt === 'undefined' || !nextRefreshAt) {
    if (ui.countdown) ui.countdown.textContent = '—';
    return;
  }
  const left = Math.max(0, nextRefreshAt - Date.now());
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000);
  if (ui.countdown) {
    ui.countdown.textContent = left > 0 ? (mm + ' dk ' + ss + ' sn') : '…';
  }
}

function setCardBusy(card, busy) {
  card.classList.toggle('busy', busy);
}

function setCardEmpty(card, el, message) {
  if (message) {
    el.textContent = message;
    card.classList.add('is-empty');
  } else {
    el.textContent = '';
    card.classList.remove('is-empty');
  }
}

function showCardError(el, message) {
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function renderFoot(el, points, unit, fmt) {
  if (!points || points.length < 2) {
    el.innerHTML = '';
    return;
  }
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (const p of points) {
    if (!Number.isFinite(p.y)) continue;
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
    sum += p.y;
    n++;
  }
  if (n < 2) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML =
    '<span>En düşük: <b>' + fmt.format(min) + ' ' + unit + '</b></span>' +
    '<span>En yüksek: <b>' + fmt.format(max) + ' ' + unit + '</b></span>' +
    '<span>Ortalama: <b>' + fmt.format(sum / n) + ' ' + unit + '</b></span>' +
    '<span>Ölçüm: <b>' + n.toLocaleString('tr-TR') + '</b></span>';
}
/* ------------------------------------------------------------------
   Hata kaydı / üst uyarı
   ------------------------------------------------------------------ */
function fail(key, label, reason) {
  failures.set(key, { label, reason });
}

function clearFail(key) {
  failures.delete(key);
}

function renderBanner() {
  if (failures.size === 0) {
    ui.banner.hidden = true;
    ui.bannerMsg.textContent = '';
    ui.statusDot.className = 'pulse';
    return;
  }

  const lines = Array.from(failures.values()).map((f) => '• ' + f.label + ' — ' + f.reason);

  ui.bannerTitle.textContent = failures.size > 1
    ? 'Veri güncellenemedi (' + failures.size + ' kaynak)'
    : 'Veri güncellenemedi';
  ui.bannerMsg.textContent = lines.join('\n');
  ui.banner.hidden = false;
  ui.statusDot.className = failures.size >= 3 ? 'pulse down' : 'pulse stale';
}

  /* ------------------------------------------------------------------
     Santral bölümleri HTML şablonu
     ------------------------------------------------------------------ */
function plantSectionHtml(plant) {
  const key = esc(plant.key);
  const units = orderedUnits(plant);
  const color = '#58A6FF';
  const overlay = '';
  const riverHost = plant.river
    ? '<div class="river-host" data-river-host="' + key + '"></div>'
    : '';
  const weatherHost = plant.key === 'chooz'
    ? '<div class="weather-host" data-weather-host="' + key + '"></div>'
    : '';

  return '<section class="plant-section" id="plantSection_' + key + '" data-plant="' + key + '">' +
    '<div class="section-head">' +
      '<div><h2>' + esc(plant.label) + '</h2>' +
        '<p class="section-sub">' +
          esc(plant.countryLabel || plant.country || '') +
          ' · ENTSO-E <code>' + esc((plant.zone && plant.zone.eic) || '') + '</code>' +
          ' · ' + esc(units.map((unit) => unit.label).join(' / ')) +
        '</p></div>' +
      '<span class="section-meta" style="color:' + color + '">' + esc(plant.country || '') + '</span>' +
    '</div>' +
    '<div class="grid">' +
      '<article class="card wide" id="genCard_' + key + '">' +
        '<div class="card-head">' +
          '<div>' +
            '<h2>' + esc(plant.label) + ' üretimi</h2>' +
            '<div class="card-source">ENTSO-E Transparency Platform (A73)</div>' +
          '</div>' +
          '<span class="tag"><span id="genTag_' + key + '">son 7 gün</span> · MW</span>' +
        '</div>' +
        '<div class="chart-box">' +
          '<canvas id="genChart_' + key + '" role="img" aria-label="' +
            esc(plant.label) + ' üretim grafiği, megavat"></canvas>' +
          '<div class="overlay"><span class="spinner"></span> Yükleniyor…</div>' +
          '<div class="chart-empty" id="genEmpty_' + key + '"></div>' +
        '</div>' +
        '<p class="card-err" id="genErr_' + key + '" hidden></p>' +
        '<div class="card-foot" id="genFoot_' + key + '"></div>' +
      '</article>' +
      '<article class="card wide" id="noticeCard_' + key + '">' +
        '<div class="card-head">' +
          '<div>' +
            '<h2>' + esc(plant.label) + ' kesinti bildirimleri</h2>' +
            '<div class="card-source">ENTSO-E Transparency Platform (A80 / A77)</div>' +
          '</div>' +
          '<span class="tag" id="noticeTag_' + key + '">—</span>' +
        '</div>' +
        '<div class="notice-list" id="noticeList_' + key + '" aria-live="polite">' +
          '<div class="notice-loading">ENTSO-E kesinti bildirimleri yükleniyor…</div></div>' +
        '<p class="card-err" id="noticeErr_' + key + '" hidden></p>' +
      '</article>' +
    '</div>' +
    weatherHost +
    riverHost +
  '</section>';
}

function beSectionHtml() {
  const color = '#58A6FF';
  return '<section class="plant-section" id="plantSection_belgium" data-plant="belgium">' +
    '<div class="section-head">' +
      '<div><h2>Belçika</h2>' +
        '<p class="section-sub">' +
          'Belçika · ENTSO-E <code>10YBE----------2</code> · Doel 4 / Tihange 3' +
        '</p></div>' +
      '<span class="section-meta" style="color:' + color + '">BE</span>' +
    '</div>' +
    '<div class="grid">' +
      '<article class="card wide" id="beNuclearCard">' +
        '<div class="card-head">' +
          '<div>' +
            '<h2>Belçika nükleer toplam üretimi (A75)</h2>' +
            '<div class="card-source">ENTSO-E Transparency Platform (A75)</div>' +
          '</div>' +
          '<span class="tag"><span id="beNuclearTag">son 7 gün</span> · MW</span>' +
        '</div>' +
        '<div class="chart-box">' +
          '<canvas id="beNuclearChart" role="img" aria-label="Belçika nükleer toplam üretim grafiği, megavat"></canvas>' +
          '<div class="overlay"><span class="spinner"></span> Yükleniyor…</div>' +
          '<div class="chart-empty" id="beNuclearEmpty"></div>' +
        '</div>' +
        '<p class="card-err" id="beNuclearErr" hidden></p>' +
        '<div class="card-foot" id="beNuclearFoot"></div>' +
      '</article>' +
    '</div>' +
  '</section>';
}

function beMixSectionHtml() {
  const color = '#58A6FF';
  return '<section class="plant-section" id="plantSection_beMix" data-plant="beMix">' +
    '<div class="section-head">' +
      '<div><h2>Belçika elektrik üretimi</h2>' +
        '<p class="section-sub">' +
          'Belçika · ENTSO-E <code>10YBE----------2</code> · anlık üretim karması (A75 · A16)' +
        '</p></div>' +
      '<span class="section-meta" style="color:' + color + '">BE</span>' +
    '</div>' +
    '<div class="grid">' +
      '<article class="card wide" id="beMixCard">' +
        '<div class="card-head">' +
          '<div>' +
            '<h2>Üretim türüne göre anlık güç</h2>' +
            '<div class="card-source">ENTSO-E Transparency Platform (A75 · A16)</div>' +
          '</div>' +
          '<div class="mix-head-tools">' +
            '<div class="mix-toggle" id="beMixMode" role="group" aria-label="Bar ölçeği">' +
              '<button type="button" class="seg-btn is-active" data-mix-mode="capacity" aria-pressed="true">Kapasite %</button>' +
              '<button type="button" class="seg-btn" data-mix-mode="share" aria-pressed="false">Pay %</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="mix-summary">' +
          '<div class="mix-total">' +
            '<span class="mix-total-label">Toplam üretim</span>' +
            '<span class="mix-total-value" id="beMixTotal">—<span class="unit">MW</span></span>' +
          '</div>' +
          '<div class="mix-updated" id="beMixUpdated">—</div>' +
        '</div>' +
        '<div class="mix-list" id="beMixList" aria-live="polite">' +
          '<div class="mix-loading"><span class="spinner"></span> Üretim karması yükleniyor…</div>' +
        '</div>' +
        '<div class="mix-tooltip" id="beMixTooltip" role="tooltip" hidden></div>' +
        '<p class="card-err" id="beMixErr" hidden></p>' +
      '</article>' +
    '</div>' +
  '</section>';
}

function frMixSectionHtml() {
  const color = '#58A6FF';
  return '<section class="plant-section" id="plantSection_frMix" data-plant="frMix">' +
    '<div class="section-head">' +
      '<div><h2>Fransa elektrik üretimi</h2>' +
        '<p class="section-sub">' +
          'Fransa · ENTSO-E <code>10YFR-RTE------C</code> · anlık üretim karması (A75 · A16)' +
        '</p></div>' +
      '<span class="section-meta" style="color:' + color + '">FR</span>' +
    '</div>' +
    '<div class="grid">' +
      '<article class="card wide" id="frMixCard">' +
        '<div class="card-head">' +
          '<div>' +
            '<h2>Üretim türüne göre anlık güç</h2>' +
            '<div class="card-source">ENTSO-E Transparency Platform (A75 · A16)</div>' +
          '</div>' +
          '<div class="mix-head-tools">' +
            '<div class="mix-toggle" id="frMixMode" role="group" aria-label="Bar ölçeği">' +
              '<button type="button" class="seg-btn is-active" data-mix-mode="capacity" aria-pressed="true">Kapasite %</button>' +
              '<button type="button" class="seg-btn" data-mix-mode="share" aria-pressed="false">Pay %</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="mix-summary">' +
          '<div class="mix-total">' +
            '<span class="mix-total-label">Toplam üretim</span>' +
            '<span class="mix-total-value" id="frMixTotal">—<span class="unit">MW</span></span>' +
          '</div>' +
          '<div class="mix-updated" id="frMixUpdated">—</div>' +
        '</div>' +
        '<div class="mix-list" id="frMixList" aria-live="polite">' +
          '<div class="mix-loading"><span class="spinner"></span> Üretim karması yükleniyor…</div>' +
        '</div>' +
        '<div class="mix-tooltip" id="frMixTooltip" role="tooltip" hidden></div>' +
        '<p class="card-err" id="frMixErr" hidden></p>' +
      '</article>' +
    '</div>' +
  '</section>';
}

function weatherSectionHtml() {
  return '<section class="weather-panel" id="weatherPanel" aria-live="polite">' +
    '<div class="section-head weather-head">' +
      '<div><h2>Chooz Bölgesi Hava Durumu</h2>' +
        '<p class="section-sub">Open-Meteo · 50.09°N, 4.79°E · Europe/Brussels</p>' +
      '</div>' +
      '<span class="section-meta" id="weatherMeta">—</span>' +
    '</div>' +
    '<div class="card weather-now-card">' +
      '<div class="weather-current">' +
        '<div class="weather-now">' +
          '<span class="weather-temp" id="weatherTemp">—<span class="unit">°C</span></span>' +
          '<span class="weather-condition">' +
            '<span class="weather-icon" id="weatherIcon">·</span>' +
            '<span id="weatherCondition">—</span>' +
          '</span>' +
        '</div>' +
        '<div class="weather-metrics">' +
          '<span class="weather-metric"><span>Nem</span><b id="weatherHumidity">—</b></span>' +
          '<span class="weather-metric"><span>Rüzgar</span><b id="weatherWind">—</b></span>' +
          '<span class="weather-metric"><span>Yağış</span><b id="weatherPrecip">—</b></span>' +
        '</div>' +
      '</div>' +
      '<p class="card-err" id="weatherErr" hidden></p>' +
      '<div class="weather-forecast" id="weatherForecast">' +
        '<div class="weather-loading"><span class="spinner"></span> Hava durumu yükleniyor…</div>' +
      '</div>' +
    '</div>' +
    '<div class="card weather-chart-card" id="weatherChartCard">' +
      '<div class="card-head">' +
        '<div>' +
          '<h2>Yağış ve Debi Korelasyonu</h2>' +
          '<div class="card-source">Open-Meteo yağış · Hub\'Eau debi (son 30 gün)</div>' +
        '</div>' +
        '<span class="tag">mm / m³/s</span>' +
      '</div>' +
      '<div class="chart-box weather-chart-box">' +
        '<canvas id="weatherChart" role="img" aria-label="Son 30 gün yağış ve debi korelasyon grafiği"></canvas>' +
        '<div class="chart-empty" id="weatherEmpty"></div>' +
      '</div>' +
      '<div class="card-foot" id="weatherFoot"></div>' +
    '</div>' +
  '</section>';
}

function buildPlantSections() {
  const plants = orderedPlants();
  const beMixHtml = beMixSectionHtml();
  const beHtml = beSectionHtml();
  const frMixHtml = frMixSectionHtml();
  const beIndex = plants.findIndex((p) => p.country === 'BE');
  const choozIndex = plants.findIndex((p) => p.key === 'chooz');

  // Fransa karması Chooz bölümünden hemen önce, Belçika karması ise ilk
  // Belçika santralinden önce gösterilir.
  let html = plants.map((plant, index) => {
    let out = '';
    if (index === choozIndex) out += frMixHtml;
    if (index === beIndex) out += beMixHtml + beHtml;
    return out + plantSectionHtml(plant);
  }).join('');
  if (beIndex < 0) html += beMixHtml + beHtml;
  if (choozIndex < 0) html = frMixHtml + html;

  ui.plantSections.innerHTML = html;

  // Nehir paneli tek örnektir: ilk nehirli santralin (Chooz) altına taşınır.
  const riverPlant = plants.find((plant) => plant.river);
  if (riverPlant && ui.riverPanel) {
    const host = ui.plantSections.querySelector(
      '[data-river-host="' + riverPlant.key + '"]'
    );
    if (host) host.appendChild(ui.riverPanel);
  }
  ui.riverSource.hidden = true;

  // Hava durumu bölümü Chooz üretim grafiği ile nehir paneli arasına girer.
  const weatherHost = ui.plantSections.querySelector('[data-weather-host="chooz"]');
  if (weatherHost) weatherHost.innerHTML = weatherSectionHtml();

  ui.reactorGrid.innerHTML =
    '<div class="reactor-loading"><span class="spinner"></span> Reaktör verisi yükleniyor…</div>';
}

  /* ------------------------------------------------------------------
     Zaman aralığı ve istasyon sekme kontrolleri
     ------------------------------------------------------------------ */
function warnRange(text) {
  ui.rangeWarnText.textContent = text;
  ui.rangeWarn.hidden = false;
}

function clearRangeWarn() {
  ui.rangeWarn.hidden = true;
  ui.rangeWarnText.textContent = '';
}

function updateRangeButtons() {
  Array.prototype.forEach.call(
    ui.rangeGroup.querySelectorAll('[data-range]'),
    (btn) => btn.classList.toggle('is-active', btn.dataset.range === state.range)
  );
  ui.customRange.hidden = state.range !== 'custom';
}

function rangeTag() {
  if (state.range === 'custom' && state.custom) {
    return fmtDDMMTime.format(new Date(state.custom.from)) + ' – ' +
           fmtDDMMTime.format(new Date(state.custom.to));
  }
  return RANGES[state.range] ? RANGES[state.range].tag : '';
}

/**
 * Aralık değişimi AĞ İSTEĞİ YAPMAZ: 30 günlük veri bellekte,
 * yalnızca seçilen aralığa göre filtrelenir.
 */
function setRange(range) {
  if (range !== 'custom' && !RANGES[range]) return;
  state.range = range;

  if (range === 'custom') {
    const { oldest, newest } = stationCoverage();
    const to = newest || Date.now();
    const from = oldest || (to - 7 * DAY);

    if (!state.custom) state.custom = { from, to };
    clampCustomToCoverage();
    syncCustomBounds();
    clearRangeWarn();
  } else {
    clearRangeWarn();
  }

  updateRangeButtons();
  renderAll();
}

/** Özel aralığı uygular; başlangıç en eski ölçümden önce olamaz. */
function applyCustomRange() {
  const from = Date.parse(ui.fromInput.value);
  const to = Date.parse(ui.toInput.value);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    warnRange('Başlangıç ve bitiş için geçerli bir tarih-saat seçin.');
    return;
  }

  const { oldest } = stationCoverage();
  let start = from;
  let note = '';

  if (oldest && start < oldest) {
    start = oldest;
    ui.fromInput.value = toInputValue(start);
    note = 'Canlı veriler yalnızca son ~30 günü kapsıyor. Başlangıç, mevcut en eski ölçüme (' +
      fmtFull.format(start) + ') çekildi.';
  }

  if (to <= start) {
    warnRange('Bitiş zamanı, başlangıçtan sonra olmalı.');
    return;
  }

  state.custom = { from: start, to };
  state.range = 'custom';
  updateRangeButtons();
  syncCustomBounds();

  if (note) warnRange(note);
  else clearRangeWarn();

  renderAll();   // yine ağ isteği yok
}

/* ------------------------------------------------------------------
   Çizim
   ------------------------------------------------------------------ */
const LIVE_UI = {
  h: {
    label: 'Su seviyesi', unit: 'm', fmt: nfH,
    chartLabel: 'Su seviyesi (m)',
    card: ui.hCard, errEl: ui.hErr, emptyEl: ui.hEmpty, footEl: ui.hFoot
  },
  q: {
    label: 'Debi', unit: 'm³/s', fmt: nfQ,
    chartLabel: 'Debi (ham)',
    card: ui.qCard, errEl: ui.qErr, emptyEl: ui.qEmpty, footEl: ui.qFoot
  }
};

function renderStationTabs() {
  ui.stationTabs.innerHTML = '';
  for (const st of state.stations) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-tab' + (st.code === state.code ? ' is-active' : '');
    btn.dataset.code = st.code;
    btn.title = st.name;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = st.name;

    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = st.code;

    btn.appendChild(name);
    btn.appendChild(code);
    btn.addEventListener('click', () => selectStation(st.code));
    ui.stationTabs.appendChild(btn);
  }
}

function renderStationHeader() {
  const st = state.stations.find((s) => s.code === state.code);
  const name = st ? st.name : state.code;
  ui.stationTitle.textContent = name;
  ui.stationCode.textContent = state.code;
  document.title = name + ' · Meuse – Chooz · Reaktörler';
}

function updateRangeTags() {
  const tag = rangeTag();
  ui.hTag.textContent = tag;
  ui.qTag.textContent = tag;
  ui.cmpTag.textContent = tag;
  const beTag = $('beNuclearTag');
  if (beTag) beTag.textContent = tag;
  orderedPlants().forEach((plant) => {
    const el = $('genTag_' + plant.key);
    if (el) el.textContent = tag;
  });
}

function clearLiveChart(key) {
  const chart = charts[key];
  chart.data.datasets.forEach((ds) => { ds.data = []; });
  chart.update('none');
}

function renderLiveCard(key, series) {
  const cfg = LIVE_UI[key];
  const chart = charts[key];

  setCardEmpty(cfg.card, cfg.emptyEl, null);
  showCardError(cfg.errEl, '');

  if (!series) {                 // henüz yükleniyor
    clearFail(key);
    return;
  }

  if (series.error) {
    clearLiveChart(key);
    cfg.footEl.innerHTML = '';
    fail(key, cfg.label + ' (' + state.code + ')', series.error.message);
    showCardError(cfg.errEl, cfg.label + ' verisi alınamadı. ' + series.error.message);
    return;
  }

  clearFail(key);

  if (series.count === 0) {
    clearLiveChart(key);
    cfg.footEl.innerHTML = '';
    setCardEmpty(cfg.card, cfg.emptyEl, 'Bu istasyon bu ölçümü yayınlamıyor.');
    return;
  }

  const bounds = currentBounds();
  let points = filterPoints(series.points, bounds);

  // Water level: single point drop >0.05m and recover on next point -> set to null
  if (key === 'h' && points.length >= 3) {
    points = points.map((p, i, arr) => {
      if (i > 0 && i < arr.length - 1) {
        const prev = arr[i - 1];
        const next = arr[i + 1];
        if (Number.isFinite(p.y) && Number.isFinite(prev.y) && Number.isFinite(next.y)) {
          if ((prev.y - p.y > 0.05) && (next.y - p.y > 0.05)) {
            return { x: p.x, y: null };
          }
        }
      }
      return p;
    });
  }

  if (points.length < 2) {
    clearLiveChart(key);
    cfg.footEl.innerHTML = '';
    setCardEmpty(cfg.card, cfg.emptyEl, points.length === 0
      ? 'Seçilen aralıkta ölçüm bulunamadı.'
      : 'Seçilen aralıkta grafik için yeterli ölçüm yok.');
    return;
  }

  const span = points[points.length - 1].x - points[0].x;
  setChartTickFormat(chart, tickFormatterForSpan(span));

  // Ham seri — büyük boşluklarda çizgi kopar.
  chart.data.datasets[0].label = cfg.chartLabel;
  chart.data.datasets[0].data = withGaps(points, CONFIG.gaps.breakMs);

  // Q grafiğinde 12 günlük ortalama (ham veriden bağımsız hesaplanır).
  if (key === 'q' && chart.data.datasets[1]) {
    const rolling = filterPoints(series.rolling || [], bounds);
    chart.data.datasets[1].data = rolling.length >= 2
      ? withGaps(rolling, CONFIG.gaps.breakMs)
      : [];
  }

  chart.update('none');
  renderFoot(cfg.footEl, points, cfg.unit, cfg.fmt);
}

function renderElabCard() {
  const entry = state.elab.get(state.code);
  const chart = charts.d;

  setCardEmpty(ui.dCard, ui.dEmpty, null);
  showCardError(ui.dErr, '');

  if (!entry) {
    clearFail('d');
    return;
  }

  if (entry.error) {
    chart.data.datasets[0].data = [];
    chart.update('none');
    ui.dFoot.innerHTML = '';
    fail('d', 'Günlük ortalama debi (QmnJ)', entry.error.message);
    showCardError(ui.dErr, 'Günlük ortalama debi verisi alınamadı. ' + entry.error.message);
    return;
  }

  clearFail('d');

  if (entry.count === 0 || entry.points.length === 0) {
    chart.data.datasets[0].data = [];
    chart.update('none');
    ui.dFoot.innerHTML = '';
    setCardEmpty(ui.dCard, ui.dEmpty, 'Bu istasyon bu ölçümü yayınlamıyor.');
    return;
  }

  pushChart('d', entry.points, 'Günlük ortalama debi (m³/s)');
  renderFoot(ui.dFoot, entry.points, 'm³/s', nfQ);
}

function setHeroValue(el, unit, value) {
  el.classList.toggle('skeleton', value === null);
  el.innerHTML = (value === null ? '—' : value) + '<span class="unit">' + unit + '</span>';
}

function updateHero() {
  const live = state.live.get(state.code) || {};
  const defs = [
    { series: live.h, el: ui.hValue, time: ui.hTime, unit: 'm', fmt: nfH },
    { series: live.q, el: ui.qValue, time: ui.qTime, unit: 'm³/s', fmt: nfQ }
  ];

  for (const d of defs) {
    if (d.series && d.series.newest) {
      const last = d.series.points[d.series.points.length - 1];
      setHeroValue(d.el, d.unit, d.fmt.format(last.y));
      d.time.innerHTML = '<b>' + fmtFull.format(new Date(last.x)) + '</b> · yerel saat';
    } else if (d.series && !d.series.error && d.series.count === 0) {
      setHeroValue(d.el, d.unit, null);
      d.time.textContent = 'Bu istasyon bu ölçümü yayınlamıyor';
    } else {
      setHeroValue(d.el, d.unit, null);
      d.time.textContent = d.series && d.series.error ? 'Veri alınamadı' : '—';
    }
  }
}

function resetHero() {
  setHeroValue(ui.hValue, 'm', null);
  setHeroValue(ui.qValue, 'm³/s', null);
  ui.hTime.textContent = '—';
  ui.qTime.textContent = '—';
  resetStatusCard();
}

/* ------------------------------------------------------------------
   Durum kartı: 12 günlük ortalamaya göre çalışabilir ünite sayısı
   ------------------------------------------------------------------ */
function resetStatusCard() {
  ui.statusCard.className = 'hero-card status';
  ui.statusAvg.classList.add('skeleton');
  ui.statusAvg.innerHTML = '—<span class="unit">m³/s</span>';
  ui.statusBadge.textContent = '—';
  ui.statusBadge.className = 'status-badge';
  ui.statusTrend.className = 'hero-time';
  ui.statusTrend.textContent = '—';
  if (ui.cross22) ui.cross22.textContent = '—';
  if (ui.cross20) ui.cross20.textContent = '—';
}

function renderStatusCard() {
  renderCrossings();

  const entry = state.live.get(state.code);
  const q = entry && entry.q;
  const rolling = q && !q.error && Array.isArray(q.rolling) ? q.rolling : [];
  const latest = rolling.length ? rolling[rolling.length - 1] : null;

  if (!latest) {
    resetStatusCard();
    ui.statusAvg.classList.add('skeleton');
    ui.statusAvg.innerHTML = '—<span class="unit">m³/s</span>';
    ui.statusBadge.textContent = 'Veri yok';
    ui.statusBadge.className = 'status-badge';
    ui.statusTrend.textContent =
      q && q.error ? 'Debi verisi alınamadı' : 'Yeterli geçmiş veri yok';
    return;
  }

  const avg = latest.y;
  let tone, badge;

  if (avg >= CONFIG.thresholds.twoUnits.value) {
    tone = 'ok';
    badge = '2 ünite çalışabilir';
  } else if (avg >= CONFIG.thresholds.oneUnit.value) {
    tone = 'warn';
    badge = '1 ünite çalışabilir';
  } else {
    tone = 'stop';
    badge = '0 ünite – santral durmalı';
  }

  // Trend: 24 saat önceki 12 günlük ortalama ile karşılaştır.
  const prev = nearestPoint(rolling, latest.x - CONFIG.rolling.trendLookbackMs, 3 * 60 * 60 * 1000);

  ui.statusCard.className = 'hero-card status ' + tone;
  ui.statusAvg.classList.remove('skeleton');
  ui.statusAvg.innerHTML = nfQ.format(avg) + '<span class="unit">m³/s</span>';
  ui.statusBadge.textContent = badge;
  ui.statusBadge.className = 'status-badge ' + tone;

  if (!prev) {
    ui.statusTrend.className = 'hero-time status-trend';
    ui.statusTrend.textContent = '24 saat önceki veri yok';
    return;
  }

  const diff = avg - prev.y;
  let trend, arrow, label;

  if (Math.abs(diff) < CONFIG.rolling.trendEpsilon) {
    trend = 'stable'; arrow = '→'; label = 'sabit';
  } else if (diff > 0) {
    trend = 'up'; arrow = '↑'; label = 'artıyor';
  } else {
    trend = 'down'; arrow = '↓'; label = 'azalıyor';
  }

  ui.statusTrend.className = 'hero-time status-trend ' + trend;
  ui.statusTrend.innerHTML =
    '<span class="arrow">' + arrow + '</span> ' + label +
    ' · 24 sa önce <b>' + nfQ.format(prev.y) + ' m³/s</b>';
}

  /* ------------------------------------------------------------------
     Eşik geçişleri
     ------------------------------------------------------------------ */
function renderCrossings() {
  const entry = state.live.get(state.code);
  const q = entry && entry.q;
  const rolling = q && !q.error && Array.isArray(q.rolling) ? q.rolling : [];
  const latestX = rolling.length ? rolling[rolling.length - 1].x : Date.now();
  const cutoff = latestX - CONFIG.rolling.windowDays * DAY;

  const defs = [
    { el: ui.cross22, value: CONFIG.thresholds.twoUnits.value },
    { el: ui.cross20, value: CONFIG.thresholds.oneUnit.value }
  ];

  for (const def of defs) {
    if (!def.el) continue;

    if (!rolling.length) {
      def.el.innerHTML = '<span class="cross-none">' +
        (q && q.error ? 'debi verisi alınamadı' : 'yeterli geçmiş veri yok') +
        '</span>';
      continue;
    }

    const hit = lastThresholdCrossing(rolling, def.value, cutoff);
    if (!hit) {
      def.el.innerHTML = '<span class="cross-none">son ' +
        CONFIG.rolling.windowDays + ' günde geçiş yok</span>';
      continue;
    }

    def.el.innerHTML =
      '<span class="cross-dir ' + hit.dir + '">' +
      (hit.dir === 'up' ? '↑ yukarı' : '↓ aşağı') + '</span>' +
      ' · <b>' + fmtFull.format(new Date(hit.x)) + '</b>';
  }
}

  /* ------------------------------------------------------------------
     Reaktör kartları ve sparkline
     ------------------------------------------------------------------ */
function sparklineSvg(points) {
  const pts = (points || []).filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  if (pts.length < 2) {
    return '<div class="spark-empty">Son 7 gün için yeterli veri yok</div>';
  }

  const w = 280;
  const h = 50;
  const pad = 4;
  const minX = pts[0][0];
  const maxX = pts[pts.length - 1][0];
  const values = pts.map((p) => p[1]).concat([0]);
  let minY = Math.min.apply(null, values);
  let maxY = Math.max.apply(null, values);
  if (maxY - minY < 1) {
    maxY += 1;
    minY -= 1;
  }

  const sx = (x) => pad + (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * (w - 2 * pad));
  const sy = (y) => h - pad - ((y - minY) / (maxY - minY)) * (h - 2 * pad);
  const path = pts.map((p, i) =>
    (i ? 'L' : 'M') + sx(p[0]).toFixed(1) + ' ' + sy(p[1]).toFixed(1)
  ).join(' ');

  const zeroY = sy(0).toFixed(1);
  const last = pts[pts.length - 1];

  return '<svg class="spark" viewBox="0 0 280 50" preserveAspectRatio="none" ' +
    'role="img" aria-label="Son 7 gün net üretim">' +
    '<line class="spark-zero" x1="0" y1="' + zeroY + '" x2="280" y2="' + zeroY + '"></line>' +
    '<path class="spark-line" d="' + path + '"></path>' +
    '<circle class="spark-dot" cx="' + sx(last[0]).toFixed(1) + '" cy="' +
      sy(last[1]).toFixed(1) + '" r="2.4"></circle>' +
    '</svg>';
}

function renderTopStrip(units, genUnits, notices, now, es) {
  const leftEl = $('topStripUnits');
  const rightEl = $('topStripMetrics');
  if (!leftEl || !rightEl) return;

  const unitShortNames = {
    chooz1: 'B1',
    chooz2: 'B2',
    doel4: 'D4',
    tihange3: 'T3'
  };

  const order = ['chooz1', 'chooz2', 'doel4', 'tihange3'];
  let totalNet = 0;
  let hasExcluded = false;

  const unitMap = new Map((units || []).map(u => [u.key, u]));

  const unitHtml = order.map(k => {
    const unit = unitMap.get(k) || { key: k, label: k };
    const genUnit = genUnits.get(k);
    const snap = unitSnapshot(k, genUnit, notices, now, es && es.beAttribution);

    const latest = genUnit && genUnit.points && genUnit.points.length
      ? genUnit.points[genUnit.points.length - 1]
      : null;
    const isStale24h = !latest || (now - latest[0] > 24 * 60 * 60 * 1000);

    const isBelgian = (k === 'doel4' || k === 'tihange3');
    const hasFreshA73 = !!latest && (
      !isStale24h ||
      (es.beNuclearTotal && latest[0] >= es.beNuclearTotal.timestamp_ms)
    );
    let isEstimated = false;
    try {
      isEstimated = isBelgian && snap.attribution && snap.attribution.estimatedMW != null && !hasFreshA73;
    } catch (_) {}

    let dotClass = 'ok';
    if (isEstimated) {
      const estMW = snap.attribution.estimatedMW;
      if (estMW != null && Number.isFinite(estMW)) {
        totalNet += estMW;
      }
      if (snap.attribution.lowConfidence || snap.attribution.confidence === 'low') {
        dotClass = 'warn';
      } else if (estMW <= 50) {
        dotClass = 'bad';
      } else {
        dotClass = 'ok';
      }
    } else if (isStale24h) {
      dotClass = 'stale';
      hasExcluded = true;
    } else {
      if (snap.tone === 'ok') dotClass = 'ok';
      else if (snap.tone === 'warn') dotClass = 'warn';
      else dotClass = 'bad';

      if (snap.netMW != null && Number.isFinite(snap.netMW)) {
        totalNet += snap.netMW;
      }
    }

    const shortName = unitShortNames[k] || snap.label || k;
    return '<span class="top-strip-unit"><span class="top-strip-dot ' + dotClass + '"></span>' + esc(shortName) + '</span>';
  }).join('');

  leftEl.innerHTML = unitHtml;

  // Discharge m³/s from current live q
  const entry = state.live.get(state.code);
  const qSeries = entry && entry.q;
  let dischargeText = '—';
  if (qSeries && qSeries.points && qSeries.points.length) {
    const lastQ = qSeries.points[qSeries.points.length - 1];
    if (lastQ && Number.isFinite(lastQ.y)) {
      dischargeText = nfQ.format(lastQ.y);
    }
  }

  const mwStr = nfMW.format(totalNet) + (hasExcluded ? '*' : '') + ' MW';
  rightEl.innerHTML =
    '<span class="top-strip-item">NET: <b>' + mwStr + '</b></span>' +
    '<span class="top-strip-item">DEBİ: <b>' + dischargeText + ' m³/s</b></span>';
}

/** Reaktör net gücünün nominal kapasiteye oranı için nominal MW değeri. */
function unitNominalMW(unit, snap) {
  if (unit && Number.isFinite(unit.nominalMW)) return unit.nominalMW;
  const key = unit && unit.key;
  if (key === 'chooz1' || key === 'chooz2') return 1500;
  if (key === 'doel4') return 1033;
  if (key === 'tihange3') return 1038;
  if (snap && Number.isFinite(snap.installedMW)) return snap.installedMW;
  return 0;
}

function renderReactors() {
  if (!ui.reactorGrid) return;

  const es = state.entsoe;
  if (!es) {
    ui.reactorGrid.innerHTML =
      '<div class="reactor-loading"><span class="spinner"></span> Reaktör verisi yükleniyor…</div>';
    if (ui.reactorMeta) ui.reactorMeta.textContent = '—';
    return;
  }

  const now = Date.now();
  const genUnits = new Map(((es.gen && es.gen.units) || []).map((u) => [u.key, u]));
  const notices = (es.out && es.out.notices) || [];
  const units = allOverviewUnits();
  const activeCount = notices.filter((n) => n.status === 'active').length;

  renderTopStrip(units, genUnits, notices, now, es);

  if (ui.reactorMeta) {
    let metaText = units.length + ' reaktör';
    if (es.out && es.out.counts) {
      metaText += ' · ' + activeCount + ' aktif bildirim';
    }
    // Belçika nükleer toplam ve son ünite verisi zamanı
    let beMW = null;
    if (es.beNuclearSeries && es.beNuclearSeries.length > 0) {
      const last = es.beNuclearSeries[es.beNuclearSeries.length - 1];
      if (last && Number.isFinite(Number(last.mw))) beMW = Number(last.mw);
    } else if (es.beNuclearTotal && Number.isFinite(Number(es.beNuclearTotal.value_mw))) {
      beMW = Number(es.beNuclearTotal.value_mw);
    }
    if (beMW !== null) {
      metaText += ' · BELÇİKA NÜKLEER: ' + nfMW.format(beMW) + ' MW (CANLI)';
    } else if (es.beNuclearTotal) {
      metaText += ' | Belçika nükleer: ' + nfMW.format(es.beNuclearTotal.value_mw) + ' MW (canlı)';
    }
    if (es.beAttribution && es.beAttribution.tUnitStr) {
      metaText += ' · ünite verisi son: ' + es.beAttribution.tUnitStr;
    }
    ui.reactorMeta.textContent = metaText;
  }

  const sparkFrom = now - 7 * DAY;

  ui.reactorGrid.innerHTML = units.map((unit) => {
    const plant = unit.plant || {};
    const genUnit = genUnits.get(unit.key);
    const snap = unitSnapshot(unit.key, genUnit, notices, now, es && es.beAttribution);
    const toneClass = snap.tone ? 'tone-' + snap.tone : '';
    const latestPt = genUnit && genUnit.points && genUnit.points.length
      ? genUnit.points[genUnit.points.length - 1]
      : null;
    const isStale24 = !latestPt || (now - latestPt[0] > 24 * 60 * 60 * 1000);

    const isBelgian = (unit.key === 'doel4' || unit.key === 'tihange3');
    const hasFreshA73 = !!latestPt && (
      (now - latestPt[0] <= 24 * 60 * 60 * 1000) ||
      (es.beNuclearTotal && latestPt[0] >= es.beNuclearTotal.timestamp_ms)
    );
    let isBelgianEstimated = false;
    try {
      isBelgianEstimated = isBelgian && snap.attribution && snap.attribution.estimatedMW != null && !hasFreshA73;
    } catch (_) {}

    const displayMW = isBelgianEstimated ? snap.attribution.estimatedMW : snap.netMW;
    const netClass = displayMW == null ? ' none' : (displayMW < -0.5 ? ' negative' : '');
    const netHtml = displayMW == null
      ? 'üretim verisi yok'
      : nfMW.format(displayMW) + ' <span class="unit">MW net</span>';

    // Kapasite kullanımı: net MW / kurulu nominal MW.
    const nominalMW = unitNominalMW(unit, snap);
    const capPct = displayMW != null && Number.isFinite(displayMW) && nominalMW > 0
      ? Math.max(0, Math.min(100, (displayMW / nominalMW) * 100))
      : 0;
    const capColor = capPct >= 80 ? 'var(--ok)' : capPct >= 20 ? 'var(--power)' : 'var(--bad)';
    const capHtml = '<div class="reactor-cap" role="img" aria-label="Kapasite kullanımı ' +
      Math.round(capPct) + '%">' +
      '<div class="reactor-cap-fill" style="width:' + capPct.toFixed(1) +
      '%;background:' + capColor + '"></div></div>';
    let availHtml = '—';
    if (snap.scheduledMW != null) {
      availHtml = nfMW.format(snap.scheduledMW) + '<small>MW</small>';
      if (snap.nextStepText) {
        availHtml += ' <span class="reactor-plan" style="font-size:10px;font-weight:normal;color:var(--muted,#6E7681);margin-left:4px">(' + esc(snap.nextStepText) + ')</span>';
      }
    } else if (snap.availableMW != null) {
      availHtml = nfMW.format(snap.availableMW) + '<small>MW</small>';
    } else if (snap.installedMW != null) {
      availHtml = nfMW.format(snap.installedMW) + '<small>MW kurulu</small>';
    }

    let statusText = '';
    let statusClass = '';
    if (isBelgianEstimated) {
      const isLow = snap.attribution.lowConfidence || snap.attribution.confidence === 'low' || (es.beAttribution && es.beAttribution.uncertain);
      statusText = isLow ? 'TAHMİN (DÜŞÜK GÜVEN)' : 'TAHMİN';
      if (isLow) {
        statusClass = 'warn';
      } else if (snap.attribution.estimatedMW <= 50) {
        statusClass = 'bad';
      } else {
        statusClass = 'ok';
      }
    } else if (isStale24) {
      const days = latestPt ? Math.max(1, Math.floor((now - latestPt[0]) / (24 * 60 * 60 * 1000))) : 1;
      statusText = 'VERİ ESKİ ' + days + 'g';
      statusClass = 'stale';
    } else {
      const lbl = String(snap.label || '').toLowerCase();
      if (lbl.includes('kapalı')) {
        statusText = 'KAPALI';
        statusClass = 'bad';
      } else if (lbl.includes('kısıtlı')) {
        statusText = 'KISITLI';
        statusClass = 'warn';
      } else {
        statusText = 'ÇALIŞIYOR';
        statusClass = 'ok';
      }
    }

    const sparkPoints = (genUnit && genUnit.points ? genUnit.points : [])
      .filter((p) => p[0] >= sparkFrom && p[0] <= now);

    // Aşılmış bildirim varsa göster
    const supersededHtml = snap.supersededNotices && snap.supersededNotices.length
      ? '<div class="reactor-superseded">Aşılmış bildirimler: ' + snap.supersededNotices.length + '</div>'
      : '';

    const partialNote = (isBelgianEstimated && snap.attribution && snap.attribution.partialNote) || '';
    const partialNoteHtml = partialNote
      ? '<div class="reactor-partial-note" style="color:var(--warn,#D29922);font-size:11px;font-weight:600;margin-top:2px">' + esc(partialNote) + '</div>'
      : '';

    const footerSource = isBelgianEstimated
      ? 'Kaynak: A75 Belçika nükleer toplamı + bildirimler'
      : (snap.sourceInfo || '');

    return '<article class="reactor-card ' + toneClass + '">' +
      '<div class="reactor-top">' +
        '<div>' +
          '<div class="reactor-plant">' + esc(plant.label || '') + ' · ' +
            esc(plant.countryLabel || plant.country || '') + '</div>' +
          '<div class="reactor-name">' + esc(unit.label) + '</div>' +
        '</div>' +
        '<span class="status-plain ' + statusClass + '">' + esc(statusText) + '</span>' +
      '</div>' +
      '<div class="reactor-net' + netClass + '">' + netHtml + '</div>' +
      capHtml +
      partialNoteHtml +
      '<div class="reactor-metrics">' +
        '<div class="reactor-metric">' +
          '<span class="reactor-metric-label">Kullanılabilir</span>' +
          '<b>' + availHtml + '</b>' +
        '</div>' +
      '</div>' +
      '<div class="reactor-spark">' + sparklineSvg(sparkPoints) + '</div>' +
      '<div class="reactor-notice">' + snap.extra + '</div>' +
      supersededHtml +
      '<div class="reactor-source" title="' + esc(footerSource) + '"><small>' + esc(footerSource) + '</small></div>' +
      '</article>';
  }).join('');
}

  /* ------------------------------------------------------------------
     Santral üretim kartı
     ------------------------------------------------------------------ */
function renderPlantGenCard(plant) {
  const es = state.entsoe;
  const chart = charts.gen.get(plant.key);
  const card = $('genCard_' + plant.key);
  const emptyEl = $('genEmpty_' + plant.key);
  const errEl = $('genErr_' + plant.key);
  const footEl = $('genFoot_' + plant.key);
  if (!card || !chart || !emptyEl || !errEl || !footEl) return;

  setCardEmpty(card, emptyEl, null);
  showCardError(errEl, '');

  if (!es) {
    clearFail('entsoe-gen-' + plant.key);
    return;
  }

  if (es.genError) {
    chart.data.datasets.forEach((ds) => { ds.data = []; });
    chart.update('none');
    footEl.innerHTML = '';
    const message = entsoeErrorMessage(es.genError);
    fail('entsoe-gen-' + plant.key, plant.label + ' üretimi', message);
    setCardEmpty(card, emptyEl, plant.label + ' üretim verisi alınamadı. ' + message);
    return;
  }

  clearFail('entsoe-gen-' + plant.key);

  const gen = es.gen;
  const bounds = currentBounds();
  const units = orderedUnits(plant);
  const latestParts = [];
  let anyData = false;
  let latestX = -Infinity;

  units.forEach((def, index) => {
    const unit = ((gen && gen.units) || []).find((u) => u.key === def.key);
    const dataset = chart.data.datasets[index];
    if (!dataset) return;

    const points = unit && unit.points
      ? unit.points.map((p) => ({ x: p[0], y: p[1], gen: p[2], cons: p[3] }))
      : [];
    const filtered = filterPoints(points, bounds);

    dataset.label = (unit && unit.name ? unit.name : def.label) + ' (MW)';
    dataset.data = filtered.length
      ? withGaps(filtered, CONFIG.entsoe.genBreakMs)
      : [];

    if (filtered.length >= 2) anyData = true;
    if (filtered.length) {
      const last = filtered[filtered.length - 1];
      latestParts.push(esc(def.label) + ': <b>Net ' + nfMW.format(last.y) + ' MW</b>');
      if (last.x > latestX) latestX = last.x;
    }
  });

  // 12 günlük ortalama debi (ikinci eksen) kaldırıldı

  if (Number.isFinite(latestX)) {
    const first = bounds && bounds.from ? bounds.from : latestX - DAY;
    setChartTickFormat(chart, tickFormatterForSpan(latestX - first));
  }

  chart.update('none');

  const zoneKey = plant.zone && plant.zone.key;
  const zoneInfo = gen && gen.zones && zoneKey ? gen.zones[zoneKey] : null;
  const zoneDays = zoneInfo && zoneInfo.days ? zoneInfo.days : null;
  const progress = genProgressParts(zoneDays);
  const pending = !!(zoneDays && Array.isArray(zoneDays.pending) && zoneDays.pending.length);
  const missing = !!(zoneDays && Array.isArray(zoneDays.missing) && zoneDays.missing.length);

  if (!anyData) {
    if (pending || missing) {
      footEl.innerHTML = progress.map((p) => '<span>' + p + '</span>').join('');
      setCardEmpty(card, emptyEl, pending
        ? plant.label + ' üretim verisi yükleniyor… İlk günler hazır oldukça çizilecek.'
        : 'Seçilen aralıkta ' + plant.label + ' üretim verisi bulunamadı.');
      return;
    }
    footEl.innerHTML = '';
    setCardEmpty(card, emptyEl,
      'Seçilen aralıkta ' + plant.label + ' üretim verisi bulunamadı. ' +
      'ENTSO-E A73 verisi birkaç gün gecikmeli olabilir.');
    return;
  }

  const parts = [];
  if (latestParts.length) parts.push(latestParts.join(' · '));
  if (Number.isFinite(latestX)) {
    parts.push('Son veri: <b>' + fmtDDMMTime.format(new Date(latestX)) + '</b>');
  }
  parts.push.apply(parts, progress);

  const warnings = (gen && gen.warnings) || [];
  const missingWarningsOnly = missing && warnings.length &&
    warnings.every((w) => /alinamadi/i.test(w));
  if (warnings.length && !missingWarningsOnly) {
    parts.push('<span title="' + esc(warnings.join(' | ')) + '">⚠ ' +
      warnings.length + ' uyarı</span>');
  }
  footEl.innerHTML = parts.map((p) => '<span>' + p + '</span>').join('');
}

  /* ------------------------------------------------------------------
     Santral kesinti bildirimleri ve karşılaştırma kartı
     ------------------------------------------------------------------ */
function noticeItemHtml(notice, now, allNotices) {
  const rel = noticeRefState(notice, now);
  const isInfo = noticeIsInfo(notice);
  const kindLabel = noticeKindText(notice);
  const superseded = noticeIsSuperseded(notice, allNotices, now);

  let badgeClass = 'active';
  let badgeText = 'Aktif · ' + kindLabel;

  if (notice.status === 'cancelled') {
    badgeClass = 'cancelled';
    badgeText = 'İptal';
  } else if (notice.status === 'withdrawn') {
    badgeClass = 'cancelled';
    badgeText = 'Geri çekildi';
  } else if (isInfo) {
    badgeClass = 'info';
    badgeText = rel === 'upcoming' ? 'Ek bilgi · planlandı'
      : rel === 'ended' ? 'Ek bilgi · bitti'
      : 'Ek bilgi';
  } else if (superseded) {
    badgeClass = 'superseded';
    badgeText = 'Aşılmış · ' + kindLabel;
  } else if (rel === 'upcoming') {
    badgeClass = notice.kind === 'forced' ? 'forced' : 'planned';
    badgeText = notice.kind === 'planned' && noticeIsEnvironmental(notice)
      ? 'Planlı – çevresel kısıt'
      : 'Planlandı';
  } else if (rel === 'ended') {
    badgeClass = notice.kind === 'forced' ? 'forced'
      : notice.kind === 'planned' ? 'planned' : 'active';
    badgeText = 'Son ' + CONFIG.entsoe.recentNoticeDays + ' gün · bitti';
  } else {
    badgeClass = notice.kind === 'forced' ? 'forced'
      : notice.kind === 'planned' ? 'planned' : 'active';
  }

  const itemClasses = ['notice'];
  if (rel === 'active' && !superseded) itemClasses.push('is-active');
  if (superseded) itemClasses.push('is-superseded');
  if (isInfo) itemClasses.push('is-info');
  else if (notice.kind === 'forced') itemClasses.push('is-forced');
  else if (notice.kind === 'planned') itemClasses.push('is-planned');
  if (notice.status !== 'active') itemClasses.push('is-cancelled');

  const startText = Number.isFinite(notice.start)
    ? fmtDDMMTime.format(new Date(notice.start))
    : '—';
  const endText = Number.isFinite(notice.end)
    ? fmtDDMMTime.format(new Date(notice.end))
    : 'süresiz';
  const span = Number.isFinite(notice.end) && Number.isFinite(notice.start)
    ? formatSpan(notice.end - notice.start)
    : '';

  const when = startText + ' → ' + endText + (span ? ' · <b>' + span + '</b>' : '');

  const reasonLabel = noticeReasonText(notice);
  let reasonHtml = '';
  if (reasonLabel || notice.reasonText) {
    const bits = [];
    if (reasonLabel) bits.push('<b>' + esc(reasonLabel) + '</b>');
    if (notice.reasonCode && reasonLabel !== notice.reasonCode) {
      bits.push('(' + esc(notice.reasonCode) + ')');
    }
    if (notice.reasonText && notice.reasonText !== reasonLabel) {
      bits.push('<span class="raw">' + esc(notice.reasonText) + '</span>');
    }
    reasonHtml = '<div class="notice-reason">' + bits.join(' ') + '</div>';
  }

  const commentHtml = notice.comment
    ? '<p class="notice-comment">"' + esc(notice.comment) + '"</p>'
    : '';

  const mwText = noticeMwText(notice);
  const meta = [];
  meta.push('Rev. ' + esc(notice.revision || 0));
  if (Number.isFinite(notice.created)) {
    meta.push('oluşturuldu ' + fmtDDMMTime.format(new Date(notice.created)));
  }
  if (notice.docType) meta.push(esc(notice.docType));
  if (superseded) {
    meta.push('<span class="superseded-note">Aşılmış bildirim</span>');
  }

  return '<div class="' + itemClasses.join(' ') + '">' +
    '<div class="notice-top">' +
    '<span class="notice-badge ' + badgeClass + '">' + esc(badgeText) + '</span>' +
    '<span class="notice-unit">' + esc(notice.unitLabel || notice.unitName || '') + '</span>' +
    (mwText ? '<span class="notice-mw">' + mwText + '</span>' : '') +
    '</div>' +
    '<div class="notice-when">' + when + '</div>' +
    reasonHtml +
    commentHtml +
    '<div class="notice-meta">' + meta.join(' · ') + '</div>' +
    '</div>';
}

function renderPlantNotices(plant) {
  const es = state.entsoe;
  const listEl = $('noticeList_' + plant.key);
  const tagEl = $('noticeTag_' + plant.key);
  const errEl = $('noticeErr_' + plant.key);
  if (!listEl || !tagEl || !errEl) return;

  showCardError(errEl, '');

  if (!es) {
    listEl.innerHTML =
      '<div class="notice-loading">ENTSO-E kesinti bildirimleri yükleniyor…</div>';
    tagEl.textContent = '—';
    return;
  }

  if (es.outError) {
    const message = entsoeErrorMessage(es.outError);
    fail('entsoe-out-' + plant.key, plant.label + ' kesinti bildirimleri', message);
    showCardError(errEl, 'Kesinti bildirimleri alınamadı. ' + message);
  } else {
    clearFail('entsoe-out-' + plant.key);
  }

  const out = es.out;
  if (!out) {
    listEl.innerHTML = '<div class="notice-empty">' +
      (es.outError ? 'Kesinti bildirimleri alınamadı.' : 'Kesinti bildirimi verisi yok.') +
      '</div>';
    tagEl.textContent = es.outError ? 'hata' : 'veri yok';
    return;
  }

  const now = Date.now();
  const recentCut = now - CONFIG.entsoe.recentNoticeDays * DAY;
  const forwardCut = now + CONFIG.entsoe.outageForwardDays * DAY;

  const plantNotices = (out.notices || []).filter((n) => n.plantKey === plant.key);

  // 1. Sadece yapılandırılmış üniteler için bildirimleri al
  const configuredUnitKeys = (plant.units || []).map(u => u.key);
  const relevantNotices = plantNotices.filter(n => configuredUnitKeys.includes(n.unitKey));

  // 2. mRID bazında son revision'ı tut (backend zaten yapıyor ama frontend'de de garantile)
  const byMrid = new Map();
  for (const n of relevantNotices) {
    const key = n.id + '|' + (n.unitKey || '');
    const existing = byMrid.get(key);
    if (!existing || (n.revision || 0) > (existing.revision || 0)) {
      byMrid.set(key, n);
    }
  }
  const uniqueNotices = Array.from(byMrid.values());

  // 3. İlgili bildirimleri filtrele
  const relevant = uniqueNotices.filter((notice) => {
    const state = noticeRefState(notice, now);
    if (state === 'active') return true;
    if (state === 'upcoming') {
      return !Number.isFinite(notice.start) || notice.start <= forwardCut;
    }
    if (Number.isFinite(notice.end)) return notice.end >= recentCut;
    if (Number.isFinite(notice.start)) return notice.start >= recentCut;
    return false;
  });

  // 4. Aşılmış bildirimleri işaretle (uniqueNotices içinde)
  for (const n of relevant) {
    n._superseded = noticeIsSuperseded(n, uniqueNotices, now);
  }

  const priority = (notice) => {
    if (notice.status !== 'active') return 4;
    if (notice._superseded) return 5; // Aşılmış en sona
    const state = noticeRefState(notice, now);
    if (state === 'active') {
      return notice.kind === 'forced' ? 0 : notice.kind === 'planned' ? 1 : 2;
    }
    return 3;
  };

  relevant.sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    if (pa <= 2) return (a.end || 0) - (b.end || 0);
    return (b.end || 0) - (a.end || 0);
  });

  const shown = relevant.slice(0, CONFIG.entsoe.noticeMaxItems);

  // Sayılar: sadece aktif VE aşılmış olmayan, sadece yapılandırılmış üniteler
  const activeCount = relevant.filter((n) => noticeRefState(n, now) === 'active' && !n._superseded).length;
  const plannedCount = relevant.filter((n) => noticeRefState(n, now) === 'upcoming' && !n._superseded).length;
  const recentCount = relevant.filter((n) => {
    const state = noticeRefState(n, now);
    return (state === 'ended' || (n.status !== 'active' &&
      Number.isFinite(n.end) && n.end >= recentCut)) && !n._superseded;
  }).length;

  // Ünite başına sayı
  const perUnitCounts = {};
  for (const key of configuredUnitKeys) {
    const unitNotices = relevant.filter(n => n.unitKey === key && !n._superseded);
    perUnitCounts[key] = {
      active: unitNotices.filter(n => noticeRefState(n, now) === 'active').length,
      upcoming: unitNotices.filter(n => noticeRefState(n, now) === 'upcoming').length
    };
  }

  const unitCountStr = configuredUnitKeys.map(k => {
    const c = perUnitCounts[k];
    return (c.active || c.upcoming) ? (UNIT_BY_KEY[k]?.label || k) + ': ' + c.active + (c.upcoming ? '/' + c.upcoming : '') : '';
  }).filter(Boolean).join(' | ');

  tagEl.textContent =
    'aktif ' + activeCount +
    (plannedCount ? ' · planlanan ' + plannedCount : '') +
    (unitCountStr ? ' · ' + unitCountStr : '') +
    ' · son ' + CONFIG.entsoe.recentNoticeDays + ' gün ' + recentCount;

  if (!shown.length) {
    listEl.innerHTML = '<div class="notice-empty">Son ' +
      CONFIG.entsoe.recentNoticeDays + ' günde ' + esc(plant.label) +
      ' için kesinti bildirimi yok.</div>';
    return;
  }

  listEl.innerHTML = shown.map((notice) => noticeItemHtml(notice, now, uniqueNotices)).join('');
}

/* ------------------------------------------------------------------
   Karşılaştırma kartı: istasyonların debisi tek grafikte
   ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   Karşılaştırma kartı: üç istasyonun debisi tek grafikte
   ------------------------------------------------------------------ */
function renderCompareCard() {
  const chart = charts.cmp;
  const bounds = currentBounds();
  let withData = 0;
  let minX = Infinity;
  let maxX = -Infinity;

  const datasets = STATION_CODES.map((code, idx) => {
    const st = state.stations.find((s) => s.code === code);
    const name = st ? st.name : code;
    const color = CONFIG.colors.compare[idx % CONFIG.colors.compare.length];
    const entry = state.live.get(code);
    const series = entry && entry.q;

    let empty = !series || series.error || series.count === 0 || !series.points;
    let data = [];

    if (!empty) {
      const raw = filterPoints(series.points, bounds);
      if (raw.length < 2) {
        empty = true;
      } else {
        // Büyük boşluklarda çizgi kopar.
        data = withGaps(raw, CONFIG.gaps.breakMs);
        for (const p of raw) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
        }
      }
    }

    if (!empty) withData++;

    return {
      label: empty ? name + ' — veri yok' : name,
      data,
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 1.7,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: color,
      pointHoverBorderColor: '#12171E',
      pointHoverBorderWidth: 2,
      tension: 0.2,
      fill: false,
      spanGaps: false
    };
  });

  chart.data.datasets = datasets;

  if (Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX) {
    setChartTickFormat(chart, tickFormatterForSpan(maxX - minX));
  }

  chart.update('none');
  showCardError(ui.cmpErr, '');

  if (withData === 0) {
    setCardEmpty(ui.cmpCard, ui.cmpEmpty,
      'Seçilen aralıkta hiçbir istasyonda debi verisi yok. Aralığı değiştirmeyi deneyin.');
    ui.cmpFoot.innerHTML = '';
    return;
  }

  setCardEmpty(ui.cmpCard, ui.cmpEmpty, null);
  ui.cmpFoot.innerHTML =
    '<span>Veri olan istasyon: <b>' + withData + ' / ' + STATION_CODES.length + '</b></span>';
}

  /* ------------------------------------------------------------------
     Genel çizim (renderAll)
     ------------------------------------------------------------------ */
function renderAll() {
  renderStationHeader();
  updateRangeTags();
  syncCustomBounds();
  renderReactors();

  try {
    renderBeNuclearCard();
  } catch (err) {
    console.warn('[renderBeNuclearCard]', err);
  }

  try {
    renderBeMixCard();
  } catch (err) {
    console.warn('[renderBeMixCard]', err);
  }

  try {
    renderFrMixCard();
  } catch (err) {
    console.warn('[renderFrMixCard]', err);
  }

  try {
    renderWeather();
  } catch (err) {
    console.warn('[renderWeather]', err);
  }

  orderedPlants().forEach((plant) => {
    renderPlantGenCard(plant);
    renderPlantNotices(plant);
  });

  if (state.view === 'compare') {
    renderCompareCard();
    renderBanner();
    return;
  }

  const live = state.live.get(state.code) || null;
  renderLiveCard('h', live ? live.h : null);
  renderLiveCard('q', live ? live.q : null);
  renderElabCard();
  updateHero();
  renderStatusCard();
  renderBanner();

  if (state.entsoe) {
    const es = state.entsoe;
    const now = Date.now();
    const genUnits = new Map(((es.gen && es.gen.units) || []).map((u) => [u.key, u]));
    const notices = (es.out && es.out.notices) || [];
    renderTopStrip(allOverviewUnits(), genUnits, notices, now, es);
  }
}

function renderBeNuclearCard() {
  if (!charts.beNuclear && typeof initBeNuclearChart === 'function') {
    initBeNuclearChart();
  }
  const chart = charts.beNuclear;
  const card = $('beNuclearCard');
  const emptyEl = $('beNuclearEmpty');
  const errEl = $('beNuclearErr');
  const footEl = $('beNuclearFoot');
  if (!card || !chart || !emptyEl || !errEl || !footEl) return;

  setCardEmpty(card, emptyEl, null);
  showCardError(errEl, '');

  const es = state.entsoe;
  if (!es) return;

  const rawSeries = es.beNuclearSeries || [];
  if (!rawSeries.length) {
    chart.data.datasets.forEach((ds) => { ds.data = []; });
    chart.update('none');
    footEl.innerHTML = '';
    setCardEmpty(card, emptyEl, 'Belçika nükleer toplam üretim verisi henüz hazır değil.');
    return;
  }

  const bounds = currentBounds();
  const points = rawSeries.map((p) => ({
    x: typeof p.t === 'number' ? p.t : new Date(p.t).getTime(),
    y: Number(p.mw)
  })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  const filtered = filterPoints(points, bounds);
  const dataset = chart.data.datasets[0];
  if (!dataset) return;

  dataset.label = 'Belçika nükleer toplamı (MW)';
  dataset.data = filtered.length
    ? withGaps(filtered, (CONFIG.entsoe && CONFIG.entsoe.genBreakMs) || (2 * 60 * 60 * 1000))
    : [];

  if (filtered.length) {
    const latestX = filtered[filtered.length - 1].x;
    const first = bounds && bounds.from ? bounds.from : latestX - DAY;
    setChartTickFormat(chart, tickFormatterForSpan(latestX - first));
    renderFoot(footEl, filtered, 'MW', nfMW);
  } else {
    footEl.innerHTML = '';
  }

  chart.update('none');

  if (!filtered.length) {
    setCardEmpty(card, emptyEl, 'Seçilen aralıkta veri bulunamadı.');
  }
}

/* ------------------------------------------------------------------
   Belçika A75 üretim karması (anlık, geçmiş tutulmaz)
   ------------------------------------------------------------------ */
const nfMixPct = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

function beMixData() {
  const mix = state.entsoe && state.entsoe.mix;
  if (!mix || !mix.categories) return null;

  const values = BE_MIX_CATEGORIES.map((cat) => {
    const rawMw = Number(mix.categories[cat.key]);
    const mw = Number.isFinite(rawMw) ? rawMw : 0;
    const rawCapacity = Number(BE_MIX_CAPACITY_MW[cat.key]);
    const capacity = Number.isFinite(rawCapacity) ? rawCapacity : 0;
    return Object.assign({}, cat, {
      mw,
      capacity,
      utilization: capacity > 0 ? (mw / capacity) * 100 : 0
    });
  });

  const totalValue = Number(mix.total_mw);
  const total = Number.isFinite(totalValue)
    ? totalValue
    : values.reduce((sum, cat) => sum + cat.mw, 0);

  values.forEach((cat) => {
    cat.share = total > 0 ? (cat.mw / total) * 100 : 0;
  });

  return { mix, total, values };
}

function beMixFillPct(cat, mode) {
  const raw = mode === 'share' ? cat.share : cat.utilization;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, raw));
}

function beMixPctText(value) {
  return Number.isFinite(value) ? nfMixPct.format(value) + '%' : '—';
}

function beMixValueHtml(cat, mode) {
  const pct = mode === 'share' ? cat.share : cat.utilization;
  return '<span class="mix-pct">' + beMixPctText(pct) + '</span>' +
    '<span class="mix-mw">' + nfTick.format(cat.mw) + ' MW</span>';
}

function beMixRowHtml(cat, mode) {
  const zero = Math.abs(cat.mw) < 0.05;
  const width = zero ? 0 : beMixFillPct(cat, mode);
  const classes = 'mix-row' + (zero ? ' is-off' : '') + (cat.mw < 0 ? ' is-negative' : '');
  const status = zero
    ? '<span class="mix-status">çalışmıyor</span>'
    : (cat.mw < 0 ? '<span class="mix-status">şarj</span>' : '');

  return '<div class="' + classes + '" data-mix-key="' + esc(cat.key) +
      '" tabindex="0" aria-label="' + esc(cat.label) + '">' +
    '<div class="mix-name"><span class="mix-label">' + esc(cat.label) + '</span>' +
      status + '</div>' +
    '<div class="mix-track" aria-hidden="true"><span class="mix-fill" data-mix-fill style="width:' +
      width.toFixed(1) + '%;background:' + cat.color + '"></span></div>' +
    '<div class="mix-value" data-mix-value>' + beMixValueHtml(cat, mode) + '</div>' +
  '</div>';
}

function updateBeMixBars() {
  const data = beMixData();
  if (!data) return;

  const mode = state.mixMode;
  const byKey = new Map(data.values.map((cat) => [cat.key, cat]));
  const rows = document.querySelectorAll('#beMixList .mix-row');

  Array.prototype.forEach.call(rows, (row) => {
    const cat = byKey.get(row.dataset.mixKey);
    if (!cat) return;

    const zero = Math.abs(cat.mw) < 0.05;
    const fill = row.querySelector('[data-mix-fill]');
    if (fill) {
      fill.style.width = (zero ? 0 : beMixFillPct(cat, mode)).toFixed(1) + '%';
    }

    const value = row.querySelector('[data-mix-value]');
    if (value) value.innerHTML = beMixValueHtml(cat, mode);

    row.setAttribute('aria-label', cat.label + ': ' +
      beMixPctText(mode === 'share' ? cat.share : cat.utilization) + ', ' +
      nfTick.format(cat.mw) + ' MW');
  });

  hideBeMixTooltip();
}

function setBeMixMode(mode) {
  if (mode !== 'capacity' && mode !== 'share') return;
  if (state.mixMode === mode) return;

  state.mixMode = mode;
  const group = $('beMixMode');
  if (group) {
    Array.prototype.forEach.call(group.querySelectorAll('[data-mix-mode]'), (btn) => {
      const active = btn.dataset.mixMode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  updateBeMixBars();
}

function renderBeMixCard() {
  const card = $('beMixCard');
  const listEl = $('beMixList');
  const totalEl = $('beMixTotal');
  const updatedEl = $('beMixUpdated');
  const errEl = $('beMixErr');
  if (!card || !listEl || !totalEl || !updatedEl || !errEl) return;

  showCardError(errEl, '');

  const es = state.entsoe;
  if (!es) return;

  if (es.mixError) {
    const message = entsoeErrorMessage(es.mixError);
    fail('entsoe-be-mix', 'Belçika elektrik üretimi', message);
    showCardError(errEl, 'Belçika üretim karması alınamadı. ' + message);
    listEl.innerHTML = '<div class="mix-empty">Üretim karması verisi alınamadı.</div>';
    totalEl.innerHTML = '—<span class="unit">MW</span>';
    updatedEl.textContent = '—';
    hideBeMixTooltip();
    return;
  }

  clearFail('entsoe-be-mix');

  const data = beMixData();
  if (!data) {
    listEl.innerHTML =
      '<div class="mix-empty">Belçika üretim karması verisi henüz hazır değil.</div>';
    totalEl.innerHTML = '—<span class="unit">MW</span>';
    updatedEl.textContent = '—';
    hideBeMixTooltip();
    return;
  }

  const { mix, total, values } = data;

  totalEl.innerHTML = nfMW.format(total) + '<span class="unit">MW</span>';
  totalEl.classList.toggle('negative', total < 0);

  const updatedMs = Date.parse(mix.updated || mix.fetched_at || '');
  updatedEl.innerHTML = Number.isFinite(updatedMs)
    ? 'Son veri: <b>' + fmtFull.format(new Date(updatedMs)) + '</b>'
    : 'Son veri: —';
  updatedEl.title = 'ENTSO-E A75 veri zamanı · tüm saatler Europe/Brussels';

  listEl.innerHTML = values.map((cat) => beMixRowHtml(cat, state.mixMode)).join('');
  hideBeMixTooltip();
}

/* ------------------------------------------------------------------
   Üretim karması tooltip'i (fare + dokunma)
   ------------------------------------------------------------------ */
function beMixItemForRow(row) {
  const data = beMixData();
  if (!data || !row) return null;
  return data.values.find((cat) => cat.key === row.dataset.mixKey) || null;
}

function positionBeMixTooltip(evt, row) {
  const card = $('beMixCard');
  const tip = $('beMixTooltip');
  if (!card || !tip || tip.hidden) return;

  const cardRect = card.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const clientX = evt && Number.isFinite(evt.clientX) && evt.clientX > 0
    ? evt.clientX
    : rowRect.left + rowRect.width / 2;
  const clientY = evt && Number.isFinite(evt.clientY) && evt.clientY > 0
    ? evt.clientY
    : rowRect.top + rowRect.height / 2;

  let left = clientX - cardRect.left + 12;
  let top = clientY - cardRect.top + 14;
  const maxLeft = card.clientWidth - tip.offsetWidth - 8;
  const maxTop = card.clientHeight - tip.offsetHeight - 8;

  if (left > maxLeft) left = maxLeft;
  if (top > maxTop) {
    top = clientY - cardRect.top - tip.offsetHeight - 12;
  }

  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

function showBeMixTooltip(row, evt) {
  const tip = $('beMixTooltip');
  const cat = beMixItemForRow(row);
  if (!tip || !cat) return;

  tip.innerHTML =
    '<div class="mix-tip-title">' + esc(cat.label) + '</div>' +
    '<div class="mix-tip-row"><span>Anlık güç</span><b>' + nfTick.format(cat.mw) + ' MW</b></div>' +
    '<div class="mix-tip-row"><span>Kapasite kullanımı</span><b>' + beMixPctText(cat.utilization) + '</b></div>' +
    '<div class="mix-tip-row"><span>Üretim payı</span><b>' + beMixPctText(cat.share) + '</b></div>';

  tip.dataset.mixKey = cat.key;
  tip.hidden = false;

  const list = $('beMixList');
  if (list) {
    Array.prototype.forEach.call(list.querySelectorAll('.mix-row.is-active'), (el) => {
      el.classList.remove('is-active');
    });
  }
  row.classList.add('is-active');
  positionBeMixTooltip(evt, row);
}

function hideBeMixTooltip() {
  const tip = $('beMixTooltip');
  if (tip) {
    tip.hidden = true;
    delete tip.dataset.mixKey;
  }
  const list = $('beMixList');
  if (list) {
    Array.prototype.forEach.call(list.querySelectorAll('.mix-row.is-active'), (el) => {
      el.classList.remove('is-active');
    });
  }
}

function initBeMixInteractions() {
  const list = $('beMixList');
  const toggle = $('beMixMode');

  if (toggle && toggle.dataset.bound !== '1') {
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', (evt) => {
      const btn = evt.target.closest('[data-mix-mode]');
      if (btn) setBeMixMode(btn.dataset.mixMode);
    });
  }

  if (!list || list.dataset.bound === '1') return;
  list.dataset.bound = '1';

  list.addEventListener('pointerover', (evt) => {
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const row = evt.target.closest('.mix-row');
    if (row) showBeMixTooltip(row, evt);
  });

  list.addEventListener('pointermove', (evt) => {
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const row = evt.target.closest('.mix-row');
    if (row && !$('beMixTooltip').hidden) positionBeMixTooltip(evt, row);
  });

  list.addEventListener('pointerout', (evt) => {
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const row = evt.target.closest('.mix-row');
    if (!row) return;
    const to = evt.relatedTarget;
    if (!to || !row.contains(to)) hideBeMixTooltip();
  });

  list.addEventListener('click', (evt) => {
    const row = evt.target.closest('.mix-row');
    if (!row) return;

    if (evt.pointerType === 'mouse') {
      showBeMixTooltip(row, evt);
      return;
    }

    const tip = $('beMixTooltip');
    if (tip && !tip.hidden && tip.dataset.mixKey === row.dataset.mixKey) {
      hideBeMixTooltip();
    } else {
      showBeMixTooltip(row, evt);
    }
  });

  list.addEventListener('focusin', (evt) => {
    const row = evt.target.closest('.mix-row');
    if (row) showBeMixTooltip(row, null);
  });

  list.addEventListener('focusout', (evt) => {
    const row = evt.target.closest('.mix-row');
    if (row) hideBeMixTooltip();
  });

  list.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const row = evt.target.closest('.mix-row');
    if (!row) return;
    evt.preventDefault();
    showBeMixTooltip(row, null);
  });

  document.addEventListener('pointerdown', (evt) => {
    const tip = $('beMixTooltip');
    if (!list.contains(evt.target) && !(tip && tip.contains(evt.target))) {
      hideBeMixTooltip();
    }
  }, true);

  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') hideBeMixTooltip();
  });
}

/* ------------------------------------------------------------------
   Fransa A75 üretim karması (anlık, geçmiş tutulmaz)
   ------------------------------------------------------------------ */
function frMixData() {
  const mix = state.entsoe && state.entsoe.frMix;
  if (!mix || !mix.categories) return null;

  const values = FR_MIX_CATEGORIES.map((cat) => {
    const rawMw = Number(mix.categories[cat.key]);
    const mw = Number.isFinite(rawMw) ? rawMw : 0;
    const rawCapacity = Number(FR_MIX_CAPACITY_MW[cat.key]);
    const capacity = Number.isFinite(rawCapacity) ? rawCapacity : 0;
    return Object.assign({}, cat, {
      mw,
      capacity,
      utilization: capacity > 0 ? (mw / capacity) * 100 : 0
    });
  });

  const totalValue = Number(mix.total_mw);
  const total = Number.isFinite(totalValue)
    ? totalValue
    : values.reduce((sum, cat) => sum + cat.mw, 0);

  values.forEach((cat) => {
    cat.share = total > 0 ? (cat.mw / total) * 100 : 0;
  });

  return { mix, total, values };
}

function frMixFillPct(cat, mode) {
  const raw = mode === 'share' ? cat.share : cat.utilization;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, raw));
}

function frMixPctText(value) {
  return Number.isFinite(value) ? nfMixPct.format(value) + '%' : '—';
}

function frMixValueHtml(cat, mode) {
  const pct = mode === 'share' ? cat.share : cat.utilization;
  return '<span class="mix-pct">' + frMixPctText(pct) + '</span>' +
    '<span class="mix-mw">' + nfTick.format(cat.mw) + ' MW</span>';
}

function frMixRowHtml(cat, mode) {
  const zero = Math.abs(cat.mw) < 0.05;
  const width = zero ? 0 : frMixFillPct(cat, mode);
  const classes = 'mix-row' + (zero ? ' is-off' : '') + (cat.mw < 0 ? ' is-negative' : '');
  const status = zero
    ? '<span class="mix-status">çalışmıyor</span>'
    : (cat.mw < 0 ? '<span class="mix-status">şarj</span>' : '');

  return '<div class="' + classes + '" data-mix-key="' + esc(cat.key) +
      '" tabindex="0" aria-label="' + esc(cat.label) + '">' +
    '<div class="mix-name"><span class="mix-label">' + esc(cat.label) + '</span>' +
      status + '</div>' +
    '<div class="mix-track" aria-hidden="true"><span class="mix-fill" data-mix-fill style="width:' +
      width.toFixed(1) + '%;background:' + cat.color + '"></span></div>' +
    '<div class="mix-value" data-mix-value>' + frMixValueHtml(cat, mode) + '</div>' +
  '</div>';
}

function updateFrMixBars() {
  const data = frMixData();
  if (!data) return;

  const mode = state.frMixMode;
  const byKey = new Map(data.values.map((cat) => [cat.key, cat]));
  const rows = document.querySelectorAll('#frMixList .mix-row');

  Array.prototype.forEach.call(rows, (row) => {
    const cat = byKey.get(row.dataset.mixKey);
    if (!cat) return;

    const zero = Math.abs(cat.mw) < 0.05;
    const fill = row.querySelector('[data-mix-fill]');
    if (fill) {
      fill.style.width = (zero ? 0 : frMixFillPct(cat, mode)).toFixed(1) + '%';
    }

    const value = row.querySelector('[data-mix-value]');
    if (value) value.innerHTML = frMixValueHtml(cat, mode);

    row.setAttribute('aria-label', cat.label + ': ' +
      frMixPctText(mode === 'share' ? cat.share : cat.utilization) + ', ' +
      nfTick.format(cat.mw) + ' MW');
  });

  hideFrMixTooltip();
}

function setFrMixMode(mode) {
  if (mode !== 'capacity' && mode !== 'share') return;
  if (state.frMixMode === mode) return;

  state.frMixMode = mode;
  const group = $('frMixMode');
  if (group) {
    Array.prototype.forEach.call(group.querySelectorAll('[data-mix-mode]'), (btn) => {
      const active = btn.dataset.mixMode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  updateFrMixBars();
}

function renderFrMixCard() {
  const card = $('frMixCard');
  const listEl = $('frMixList');
  const totalEl = $('frMixTotal');
  const updatedEl = $('frMixUpdated');
  const errEl = $('frMixErr');
  if (!card || !listEl || !totalEl || !updatedEl || !errEl) return;

  showCardError(errEl, '');

  const es = state.entsoe;
  if (!es) return;

  if (es.frMixError) {
    const message = entsoeErrorMessage(es.frMixError);
    fail('entsoe-fr-mix', 'Fransa elektrik üretimi', message);
    showCardError(errEl, 'Fransa üretim karması alınamadı. ' + message);
    listEl.innerHTML = '<div class="mix-empty">Üretim karması verisi alınamadı.</div>';
    totalEl.innerHTML = '—<span class="unit">MW</span>';
    updatedEl.textContent = '—';
    hideFrMixTooltip();
    return;
  }

  clearFail('entsoe-fr-mix');

  const data = frMixData();
  if (!data) {
    listEl.innerHTML =
      '<div class="mix-empty">Fransa üretim karması verisi henüz hazır değil.</div>';
    totalEl.innerHTML = '—<span class="unit">MW</span>';
    updatedEl.textContent = '—';
    hideFrMixTooltip();
    return;
  }

  const { mix, total, values } = data;

  totalEl.innerHTML = nfMW.format(total) + '<span class="unit">MW</span>';
  totalEl.classList.toggle('negative', total < 0);

  const updatedMs = Date.parse(mix.updated || mix.fetched_at || '');
  updatedEl.innerHTML = Number.isFinite(updatedMs)
    ? 'Son veri: <b>' + fmtFull.format(new Date(updatedMs)) + '</b>'
    : 'Son veri: —';
  updatedEl.title = 'ENTSO-E A75 veri zamanı · tüm saatler Europe/Brussels';

  listEl.innerHTML = values.map((cat) => frMixRowHtml(cat, state.frMixMode)).join('');
  hideFrMixTooltip();
}

/* ------------------------------------------------------------------
   Fransa üretim karması tooltip'i (fare + dokunma)
   ------------------------------------------------------------------ */
function frMixItemForRow(row) {
  const data = frMixData();
  if (!data || !row) return null;
  return data.values.find((cat) => cat.key === row.dataset.mixKey) || null;
}

function positionFrMixTooltip(evt, row) {
  const card = $('frMixCard');
  const tip = $('frMixTooltip');
  if (!card || !tip || tip.hidden) return;

  const cardRect = card.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const clientX = evt && Number.isFinite(evt.clientX) && evt.clientX > 0
    ? evt.clientX
    : rowRect.left + rowRect.width / 2;
  const clientY = evt && Number.isFinite(evt.clientY) && evt.clientY > 0
    ? evt.clientY
    : rowRect.top + rowRect.height / 2;

  let left = clientX - cardRect.left + 12;
  let top = clientY - cardRect.top + 14;
  const maxLeft = card.clientWidth - tip.offsetWidth - 8;
  const maxTop = card.clientHeight - tip.offsetHeight - 8;

  if (left > maxLeft) left = maxLeft;
  if (top > maxTop) {
    top = clientY - cardRect.top - tip.offsetHeight - 12;
  }

  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

function showFrMixTooltip(row, evt) {
  const tip = $('frMixTooltip');
  const cat = frMixItemForRow(row);
  if (!tip || !cat) return;

  tip.innerHTML =
    '<div class="mix-tip-title">' + esc(cat.label) + '</div>' +
    '<div class="mix-tip-row"><span>Anlık güç</span><b>' + nfTick.format(cat.mw) + ' MW</b></div>' +
    '<div class="mix-tip-row"><span>Kapasite kullanımı</span><b>' + frMixPctText(cat.utilization) + '</b></div>' +
    '<div class="mix-tip-row"><span>Üretim payı</span><b>' + frMixPctText(cat.share) + '</b></div>';

  tip.dataset.mixKey = cat.key;
  tip.hidden = false;

  const list = $('frMixList');
  if (list) {
    Array.prototype.forEach.call(list.querySelectorAll('.mix-row.is-active'), (el) => {
      el.classList.remove('is-active');
    });
  }
  row.classList.add('is-active');
  positionFrMixTooltip(evt, row);
}

function hideFrMixTooltip() {
  const tip = $('frMixTooltip');
  if (tip) {
    tip.hidden = true;
    delete tip.dataset.mixKey;
  }
  const list = $('frMixList');
  if (list) {
    Array.prototype.forEach.call(list.querySelectorAll('.mix-row.is-active'), (el) => {
      el.classList.remove('is-active');
    });
  }
}

function initFrMixInteractions() {
  const list = $('frMixList');
  const toggle = $('frMixMode');

  if (toggle && toggle.dataset.bound !== '1') {
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', (evt) => {
      const btn = evt.target.closest('[data-mix-mode]');
      if (btn) setFrMixMode(btn.dataset.mixMode);
    });
  }

  if (!list || list.dataset.bound === '1') return;
  list.dataset.bound = '1';

  list.addEventListener('pointerover', (evt) => {
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const row = evt.target.closest('.mix-row');
    if (row) showFrMixTooltip(row, evt);
  });

  list.addEventListener('pointermove', (evt) => {
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const row = evt.target.closest('.mix-row');
    if (row && !$('frMixTooltip').hidden) positionFrMixTooltip(evt, row);
  });

  list.addEventListener('pointerout', (evt) => {
    if (evt.pointerType && evt.pointerType !== 'mouse') return;
    const row = evt.target.closest('.mix-row');
    if (!row) return;
    const to = evt.relatedTarget;
    if (!to || !row.contains(to)) hideFrMixTooltip();
  });

  list.addEventListener('click', (evt) => {
    const row = evt.target.closest('.mix-row');
    if (!row) return;

    if (evt.pointerType === 'mouse') {
      showFrMixTooltip(row, evt);
      return;
    }

    const tip = $('frMixTooltip');
    if (tip && !tip.hidden && tip.dataset.mixKey === row.dataset.mixKey) {
      hideFrMixTooltip();
    } else {
      showFrMixTooltip(row, evt);
    }
  });

  list.addEventListener('focusin', (evt) => {
    const row = evt.target.closest('.mix-row');
    if (row) showFrMixTooltip(row, null);
  });

  list.addEventListener('focusout', (evt) => {
    const row = evt.target.closest('.mix-row');
    if (row) hideFrMixTooltip();
  });

  list.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const row = evt.target.closest('.mix-row');
    if (!row) return;
    evt.preventDefault();
    showFrMixTooltip(row, null);
  });

  document.addEventListener('pointerdown', (evt) => {
    const tip = $('frMixTooltip');
    if (!list.contains(evt.target) && !(tip && tip.contains(evt.target))) {
      hideFrMixTooltip();
    }
  }, true);

  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') hideFrMixTooltip();
  });
}

/* ------------------------------------------------------------------
   Chooz bölgesi hava durumu ve yağış/debi korelasyonu
   ------------------------------------------------------------------ */
function renderWeather() {
  const panel = $('weatherPanel');
  if (!panel) return;

  const weather = state.weather;
  if (!weather) return;

  const errEl = $('weatherErr');
  const forecastEl = $('weatherForecast');
  const tempEl = $('weatherTemp');
  const iconEl = $('weatherIcon');
  const conditionEl = $('weatherCondition');
  const humidityEl = $('weatherHumidity');
  const windEl = $('weatherWind');
  const precipEl = $('weatherPrecip');
  const metaEl = $('weatherMeta');

  const hasData = !!(weather.current || weather.daily || weather.hourly);
  if (!hasData) {
    const message = weather.error || 'Hava durumu verisi alınamadı.';
    if (errEl) {
      errEl.textContent = 'Hava durumu alınamadı. ' + message;
      errEl.hidden = false;
    }
    if (forecastEl) {
      forecastEl.innerHTML = '<div class="weather-empty">Tahmin verisi yok.</div>';
    }
    if (tempEl) tempEl.innerHTML = '—<span class="unit">°C</span>';
    if (iconEl) iconEl.textContent = '·';
    if (conditionEl) conditionEl.textContent = '—';
    if (humidityEl) humidityEl.textContent = '—';
    if (windEl) windEl.textContent = '—';
    if (precipEl) precipEl.textContent = '—';
    if (metaEl) metaEl.textContent = '—';
    renderWeatherChart(weather);
    return;
  }

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  const current = weather.current || null;
  if (current) {
    const temp = Number(current.temperature_2m);
    if (tempEl) {
      tempEl.innerHTML = (Number.isFinite(temp) ? nfTick.format(temp) : '—') +
        '<span class="unit">°C</span>';
    }
    if (iconEl) iconEl.textContent = weatherIcon(current.weather_code);
    if (conditionEl) conditionEl.textContent = weatherLabel(current.weather_code);

    const humidity = Number(current.relative_humidity_2m);
    if (humidityEl) {
      humidityEl.textContent = Number.isFinite(humidity) ? Math.round(humidity) + '%' : '—';
    }
    const wind = Number(current.wind_speed_10m);
    if (windEl) {
      windEl.textContent = Number.isFinite(wind) ? nfTick.format(wind) + ' km/h' : '—';
    }
    const precip = Number(current.precipitation);
    if (precipEl) {
      precipEl.textContent = Number.isFinite(precip) ? nfTick.format(precip) + ' mm' : '—';
    }
    if (metaEl) {
      const time = String(current.time || '');
      metaEl.textContent = time ? time.slice(0, 16).replace('T', ' ') + ' · Brüksel' : '—';
    }
  } else {
    if (tempEl) tempEl.innerHTML = '—<span class="unit">°C</span>';
    if (iconEl) iconEl.textContent = '·';
    if (conditionEl) conditionEl.textContent = '—';
    if (humidityEl) humidityEl.textContent = '—';
    if (windEl) windEl.textContent = '—';
    if (precipEl) precipEl.textContent = '—';
    if (metaEl) metaEl.textContent = '—';
  }

  const daily = weather.daily;
  if (forecastEl && daily && Array.isArray(daily.time) && daily.time.length) {
    forecastEl.innerHTML = daily.time.slice(0, 5).map((day, index) => {
      const code = daily.weather_code ? daily.weather_code[index] : 0;
      const max = Number(daily.temperature_2m_max ? daily.temperature_2m_max[index] : NaN);
      const min = Number(daily.temperature_2m_min ? daily.temperature_2m_min[index] : NaN);
      const rain = Number(daily.precipitation_sum ? daily.precipitation_sum[index] : NaN);

      return '<div class="weather-day">' +
        '<span class="weather-day-name">' + esc(weatherDayLabel(day, index)) + '</span>' +
        '<span class="weather-day-icon" title="' + esc(weatherLabel(code)) + '">' +
          weatherIcon(code) + '</span>' +
        '<span class="weather-day-temps"><b>' +
          (Number.isFinite(max) ? Math.round(max) + '°' : '—') + '</b><span>' +
          (Number.isFinite(min) ? Math.round(min) + '°' : '—') + '</span></span>' +
        '<span class="weather-day-rain">' +
          (Number.isFinite(rain) ? nfTick.format(rain) + ' mm' : '—') + '</span>' +
      '</div>';
    }).join('');
  } else if (forecastEl) {
    forecastEl.innerHTML = '<div class="weather-empty">Tahmin verisi yok.</div>';
  }

  renderWeatherChart(weather);
}

function renderWeatherChart(weather) {
  const chart = charts.weather;
  const card = $('weatherChartCard');
  const emptyEl = $('weatherEmpty');
  const footEl = $('weatherFoot');
  if (!chart || !card || !emptyEl || !footEl) return;

  setCardEmpty(card, emptyEl, null);

  const now = Date.now();
  const from = now - 30 * DAY;
  const to = now + DAY;

  const precipitation = [];
  const hourly = weather && weather.hourly;
  if (hourly && Array.isArray(hourly.time) && Array.isArray(hourly.precipitation)) {
    for (let i = 0; i < hourly.time.length; i += 1) {
      const x = weatherTimeToMs(hourly.time[i]);
      const y = Number(hourly.precipitation[i]);
      if (Number.isFinite(x) && Number.isFinite(y) && x >= from && x <= to) {
        precipitation.push({ x, y });
      }
    }
  }

  const live = state.live.get(state.code) || null;
  const qPoints = live && live.q && Array.isArray(live.q.points) ? live.q.points : [];
  const discharge = qPoints.filter((p) =>
    Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= from && p.x <= to
  );

  chart.data.datasets[0].data = precipitation;
  chart.data.datasets[1].data = discharge.length
    ? withGaps(discharge, CONFIG.gaps.breakMs)
    : [];

  if (!precipitation.length && !discharge.length) {
    chart.data.datasets.forEach((ds) => { ds.data = []; });
    chart.update('none');
    footEl.innerHTML = '';
    setCardEmpty(card, emptyEl, 'Son 30 gün için yağış/debi verisi bulunamadı.');
    return;
  }

  chart.$tickFmt = tickFormatterForSpan(30 * DAY);
  chart.update('none');

  let totalRain = 0;
  precipitation.forEach((p) => { totalRain += p.y; });
  let qSum = 0;
  discharge.forEach((p) => { qSum += p.y; });
  const qAvg = discharge.length ? qSum / discharge.length : null;

  footEl.innerHTML =
    '<span>Toplam yağış: <b>' + nfTick.format(totalRain) + ' mm</b></span>' +
    '<span>Ortalama debi: <b>' +
      (qAvg == null ? '—' : nfQ.format(qAvg)) + ' m³/s</b></span>' +
    '<span>Saatlik yağış: <b>' + precipitation.length.toLocaleString('tr-TR') + '</b></span>' +
    '<span>Debi ölçümü: <b>' + discharge.length.toLocaleString('tr-TR') + '</b></span>';
}
