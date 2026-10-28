/* ------------------------------------------------------------------
   js/main.js
   Startup, refresh timers, event wiring
   ------------------------------------------------------------------ */

let refreshTimer = null;
let nextRefreshAt = 0;

function applyBusy() {
  const busy = state.busy > 0;
  [ui.hCard, ui.qCard, ui.dCard, ui.cmpCard].forEach((card) => {
    if (card) setCardBusy(card, busy);
  });
  orderedPlants().forEach((plant) => {
    const card = $('genCard_' + plant.key);
    if (card) setCardBusy(card, busy);
  });
  ui.refreshBtn.disabled = busy;
}

async function withBusy(fn) {
  state.busy++;
  applyBusy();
  try {
    return await fn();
  } finally {
    state.busy--;
    applyBusy();
  }
}

/* ------------------------------------------------------------------
   Görünüm: tek istasyon / karşılaştırma
   ------------------------------------------------------------------ */
function updateViewButtons() {
  Array.prototype.forEach.call(
    ui.viewGroup.querySelectorAll('[data-view]'),
    (btn) => btn.classList.toggle('is-active', btn.dataset.view === state.view)
  );
}

function applyViewVisibility() {
  const compare = state.view === 'compare';
  ui.hero.hidden = compare;          // durum kartı dahil
  ui.stationTabs.hidden = compare;
  ui.hCard.hidden = compare;
  ui.qCard.hidden = compare;
  ui.dCard.hidden = compare;
  ui.cmpCard.hidden = !compare;
}

async function setView(view) {
  if (view !== 'single' && view !== 'compare') return;
  if (state.view === view) return;

  state.view = view;
  updateViewButtons();
  applyViewVisibility();
  renderAll();

  if (view === 'compare') {
    await withBusy(async () => {
      await loadCompareData();
      if (state.view === 'compare') renderAll();
    });
  }
}



async function selectStation(code) {
  if (!STATION_CODES.includes(code)) return;

  if (code === state.code && state.live.has(code)) {
    renderStationTabs();
    renderStationHeader();
    return;
  }

  state.code = code;
  saveStation(code);
  renderStationTabs();
  renderStationHeader();
  resetHero();
  resetCharts();
  renderAll();          // önceki istasyonun verisi ekranda kalmasın

  await withBusy(async () => {
    await Promise.allSettled([loadStationLive(code), loadElab(code)]);
    if (state.code !== code) return;
    clampCustomToCoverage();
    renderAll();
  });

  scheduleNext();
}

async function manualRefresh() {
  if (state.busy > 0) return;
  const code = state.code;

  await withBusy(async () => {
    if (state.view === 'compare') {
      await loadCompareData({ force: true });
      if (state.view === 'compare') renderAll();
      return;
    }

    await Promise.allSettled([
      loadStationLive(code, { force: true }),
      loadElab(code, { force: true }),
      loadEntsoe({ force: true })
    ]);
    if (state.code === code) {
      clampCustomToCoverage();
      renderAll();
    }
  });

  scheduleNext();
}

/** 5 dakikada bir yalnızca canlı veriyi tazeler (yükleme örtüsü göstermeden). */
async function autoRefresh() {
  if (state.busy > 0) {
    scheduleNext();
    return;
  }

  if (state.view === 'compare') {
    await loadCompareData();
    if (state.view === 'compare') renderAll();
    scheduleNext();
    return;
  }

  const code = state.code;
  await loadStationLive(code, { force: true });
  await loadElab(code);          // TTL dolmadıysa önbellekten döner
  await loadEntsoe();            // backend önbelleği 15 dk tutar

  if (state.code === code) {
    clampCustomToCoverage();
    renderAll();
  }

  scheduleNext();
}

function scheduleNext() {
  nextRefreshAt = Date.now() + REFRESH_MS;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(autoRefresh, REFRESH_MS);
}

function tickCountdown() {
  if (!nextRefreshAt) {
    ui.countdown.textContent = '—';
    return;
  }
  const left = Math.max(0, nextRefreshAt - Date.now());
  const mm = String(Math.floor(left / 60000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  ui.countdown.textContent = left > 0 ? mm + ':' + ss : '…';
}

/* ------------------------------------------------------------------
   Başlangıç
   ------------------------------------------------------------------ */
async function init() {
  ui.tzLabel.textContent = tzName + ' (' + tzOffset + ')';
  ui.tzLabel.title = 'Tüm tarih ve saatler bu saat dilimine çevrilir';

  if (typeof Chart === 'undefined') {
    ui.banner.hidden = false;
    ui.bannerTitle.textContent = 'Grafik kütüphanesi yüklenemedi';
    ui.bannerMsg.textContent = 'Chart.js CDN üzerinden yüklenemedi. İnternet bağlantınızı kontrol edip sayfayı yenileyin.';
    ui.statusDot.className = 'pulse down';
    return;
  }

  Chart.defaults.font.family = '"Segoe UI", system-ui, -apple-system, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#8ea3c0';
  Chart.register(thresholdPlugin);
  Chart.register(zeroLinePlugin);

  setInterval(tickCountdown, 1000);

  Array.prototype.forEach.call(
    ui.rangeGroup.querySelectorAll('[data-range]'),
    (btn) => btn.addEventListener('click', () => setRange(btn.dataset.range))
  );
  Array.prototype.forEach.call(
    ui.viewGroup.querySelectorAll('[data-view]'),
    (btn) => btn.addEventListener('click', () => setView(btn.dataset.view))
  );
  ui.applyRange.addEventListener('click', applyCustomRange);

  // datetime-local alanlarında 'change' her parça girişinde tetikleniyor ve
  // değeri yeniden yazdığı için yazmayı bozuyordu. Bunun yerine Enter ile uygula.
  [ui.fromInput, ui.toInput].forEach((input) => {
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        applyCustomRange();
      }
    });
  });
  ui.refreshBtn.addEventListener('click', manualRefresh);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && nextRefreshAt && Date.now() > nextRefreshAt + 30000) {
      autoRefresh();
    }
  });

  if (CONFIG.rolling.windowDays > LIVE_WINDOW_DAYS) {
    console.warn('[Yapılandırma] Hareketli ortalama penceresi canlı veri penceresinden büyük; ' +
      'ortalama için yeterli geçmiş olmayabilir.');
  }

  state.code = readSavedStation() || DEFAULT_STATION;
  state.range = DEFAULT_RANGE;

  // Santral bölümleri backend yapılandırmasından üretilir; nehir paneli
  // Chooz bölümüne taşındıktan sonra grafikler kurulur.
  await loadPlants();
  initCharts();
  initPlantCharts();

  updateRangeButtons();
  updateViewButtons();
  applyViewVisibility();
  resetHero();
  updateRangeTags();

  await withBusy(async () => {
    await loadStations();
    await Promise.allSettled([
      loadStationLive(state.code, { force: true }),
      loadElab(state.code, { force: true }),
      loadEntsoe({ force: true })
    ]);
    renderAll();
  });

  scheduleNext();

  // Her istasyon için H/Q kayıt sayılarını konsola yazdır
  setTimeout(logStationCounts, 1500);
}

init();
