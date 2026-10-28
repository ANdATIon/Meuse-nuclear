/* ------------------------------------------------------------------
   js/river.js
   Meuse / Hub'Eau logic: stations, 12-day average, threshold crossings
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Dönüşümler
   ------------------------------------------------------------------ */
// Canlı veriler: UTC ISO 8601 damgası + mm / l/s
function livePoints(rows, divisor) {
  return rows
    .map((r) => ({
      x: Date.parse(r.date_obs),
      y: r.resultat_obs == null ? NaN : r.resultat_obs / divisor
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
}

function elabPoints(rows) {
  return rows
    .map((r) => ({
      x: parseLocalDay(r.date_obs_elab),
      y: r.resultat_obs_elab == null ? NaN : r.resultat_obs_elab / 1000
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
}

/* ------------------------------------------------------------------
   Hareketli ortalama (12 gün) — saatlik yeniden örnekleme + kayan ortalama
   Ölçümler düzensiz aralıklı olduğu için önce saatlik değerlere
   doğrusal interpolasyonla örneklenir, sonra 12 günlük pencere ortalanır.
   ------------------------------------------------------------------ */
function hourlySeries(points) {
  const step = CONFIG.rolling.resampleMs;
  if (!points || points.length < 2) return [];

  const start = Math.ceil(points[0].x / step) * step;
  const end = Math.floor(points[points.length - 1].x / step) * step;
  const out = [];
  let i = 0;

  for (let t = start; t <= end; t += step) {
    while (i < points.length - 2 && points[i + 1].x < t) i++;
    const a = points[i];
    const b = points[i + 1];

    // Veri aralığı dışında veya büyük boşlukta saat boş bırakılır.
    if (!a || !b || t < a.x || t > b.x) {
      out.push({ x: t, y: null });
      continue;
    }

    const dx = b.x - a.x;
    if (!(dx > 0) || dx > CONFIG.gaps.breakMs) {
      out.push({ x: t, y: null });
      continue;
    }

    out.push({ x: t, y: a.y + ((b.y - a.y) * (t - a.x)) / dx });
  }

  return out;
}

function rollingAverage(hourly, windowDays) {
  if (!hourly || !hourly.length) return [];

  const bins = Math.max(1, Math.round((windowDays * DAY) / CONFIG.rolling.resampleMs));
  const minCount = Math.ceil(bins * CONFIG.rolling.minCoverage);
  const out = [];
  let sum = 0;
  let count = 0;

  for (let j = 0; j < hourly.length; j++) {
    const add = hourly[j].y;
    if (Number.isFinite(add)) {
      sum += add;
      count++;
    }

    // Pencereyi kaydır: soldaki saatlik değeri çıkar.
    if (j >= bins) {
      const rem = hourly[j - bins].y;
      if (Number.isFinite(rem)) {
        sum -= rem;
        count--;
      }
    }

    // En az 12 günlük pencere dolmadan ortalama üretilmez.
    if (j >= bins - 1 && count >= minCount) {
      out.push({ x: hourly[j].x, y: sum / count });
    }
  }

  return out;
}

/** Q serisine hareketli ortalamayı ekler (hata varsa dokunmaz). */
function attachRolling(series) {
  if (!series || series.error) return series;
  series.rolling = rollingAverage(hourlySeries(series.points), CONFIG.rolling.windowDays);
  return series;
}

/** Büyük zaman boşluklarında çizginin kopması için null nokta ekler. */
function withGaps(points, maxGapMs) {
  if (!points || !points.length) return [];
  if (points.length < 2) return points.slice();

  const limit = maxGapMs || CONFIG.gaps.breakMs;
  const out = [];
  let lastX = null;

  for (const p of points) {
    if (lastX !== null && p.x - lastX > limit) {
      out.push({ x: lastX + (p.x - lastX) / 2, y: null });
    }
    out.push(p);
    lastX = p.x;
  }

  return out;
}

/** Hedef zamana en yakın noktayı döner; tolerans dışındaysa null. */
function nearestPoint(points, targetX, maxDistance) {
  if (!points || !points.length) return null;

  let best = null;
  let bestDist = Infinity;

  for (const p of points) {
    const d = Math.abs(p.x - targetX);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }

  return best && bestDist <= maxDistance ? best : null;
}

/* ------------------------------------------------------------------
   localStorage
   ------------------------------------------------------------------ */
function readSavedStation() {
  try {
    const saved = localStorage.getItem(LS_STATION);
    return STATION_CODES.includes(saved) ? saved : null;
  } catch (err) {
    return null;
  }
}

function saveStation(code) {
  try {
    localStorage.setItem(LS_STATION, code);
  } catch (err) {
    /* gizli mod / depolama kapalı — yoksay */
  }
}

/* ------------------------------------------------------------------
   İstasyon listesi (adlar API'den)
   ------------------------------------------------------------------ */
async function loadStations() {
  let rows = [];
  try {
    const json = await fetchJson(stationsUrl());
    rows = Array.isArray(json.data) ? json.data : [];
    clearFail('stations');
  } catch (err) {
    // Adlar alınamazsa uydurma ad yazmayız; kod ile devam ederiz.
    fail('stations', 'İstasyon listesi', err.message);
    console.error('[stations]', err);
  }

  const byCode = new Map(rows.map((s) => [s.code_station, s]));
  state.stations = STATION_CODES.map((code) => {
    const s = byCode.get(code);
    const configured = state.stationNames.get(code);
    return { code, name: (s && s.libelle_station) ? s.libelle_station : (configured || code) };
  });

  console.log('[İstasyonlar] ' + state.stations.map((s) => s.code + ' = ' + s.name).join(' | '));
  renderStationTabs();
  renderStationHeader();
}

/* ------------------------------------------------------------------
   Canlı veri (observations_tr) — 30 gün, istasyon başına önbellek
   ------------------------------------------------------------------ */
async function loadStationLive(code, opts) {
  const force = !!(opts && opts.force);
  const cached = state.live.get(code);
  const now = Date.now();

  // Tazelik seri bazında tutulur: karşılaştırma görünümü yalnızca Q yükler,
  // istasyona geçildiğinde H'nin de indirilmesi gerekir.
  const fresh = (part, at) =>
    !!(part && !part.error && now - (at || 0) < REFRESH_MS);

  const hFresh = !force && cached &&
    fresh(cached.h, cached.hFetchedAt || cached.fetchedAt);
  const qFresh = !force && cached &&
    fresh(cached.q, cached.qFetchedAt || cached.fetchedAt);

  if (hFresh && qFresh) return cached;

  const entry = cached || { h: null, q: null };
  entry.fetchedAt = now;

  const jobs = [];

  if (!hFresh) {
    jobs.push(fetchLiveSeries(code, 'H', 1000)
      .then((value) => { entry.h = value; })
      .catch((err) => { entry.h = { error: err }; })
      .finally(() => { entry.hFetchedAt = Date.now(); }));
  }

  if (!qFresh) {
    jobs.push(fetchLiveSeries(code, 'Q', 1000)
      .then((value) => { entry.q = attachRolling(value); })
      .catch((err) => { entry.q = { error: err }; })
      .finally(() => { entry.qFetchedAt = Date.now(); }));
  }

  await Promise.allSettled(jobs);

  // Hatalı sonuç da önbelleğe alınır ki ekranda hata durumu görünsün.
  state.live.set(code, entry);

  if (code === state.code && !entry.h.error && !entry.q.error) {
    ui.updatedLabel.textContent = fmtClock.format(new Date());
  }

  if (entry.h.error) console.error('[H] ' + code, entry.h.error);
  if (entry.q.error) console.error('[Q] ' + code, entry.q.error);

  return entry;
}

/* ------------------------------------------------------------------
   Karşılaştırma için üç istasyonun Q verisi (yalnızca debi)
   ------------------------------------------------------------------ */
async function loadCompareData(opts) {
  const force = !!(opts && opts.force);

  await Promise.all(STATION_CODES.map(async (code) => {
    const cached = state.live.get(code);
    const ttl = cached && cached.q && cached.q.error ? 30000 : REFRESH_MS;

    if (cached && cached.q && !force && Date.now() - (cached.qFetchedAt || 0) < ttl) return;

    const entry = cached || { h: null, q: null, fetchedAt: Date.now() };
    try {
      entry.q = attachRolling(await fetchLiveSeries(code, 'Q', 1000));
    } catch (err) {
      entry.q = { error: err };
      console.error('[Karşılaştırma Q] ' + code, err);
    }
    entry.qFetchedAt = Date.now();
    state.live.set(code, entry);
  }));

  ui.updatedLabel.textContent = fmtClock.format(new Date());
}

/* ------------------------------------------------------------------
   Geçmiş veri (obs_elab / QmnJ)
   ------------------------------------------------------------------ */
async function loadElab(code, opts) {
  const force = !!(opts && opts.force);
  const cached = state.elab.get(code);
  const ttl = cached && cached.error ? 30000 : ELAB_TTL_MS;
  if (cached && !force && Date.now() - cached.fetchedAt < ttl) return cached;

  const entry = { points: [], count: 0, error: null, fetchedAt: Date.now() };
  try {
    const { rows, count } = await fetchAllPages(elabUrl(code));
    console.log('[QmnJ] ' + code + ' → ' + count + ' kayıt');
    console.log('[obs_elab QmnJ] ' + code + ' ilk 3 değer:', rows.slice(0, 3));
    entry.count = count;
    entry.points = elabPoints(rows);
  } catch (err) {
    entry.error = err;
    console.error('[QmnJ] ' + code, err);
  }

  state.elab.set(code, entry);
  return entry;
}

/* ------------------------------------------------------------------
   İstasyon başına H / Q kayıt sayıları (hafif sayım sorgusu)
   ------------------------------------------------------------------ */
async function logStationCounts() {
  const start = isoZ(new Date(Date.now() - LIVE_WINDOW_DAYS * DAY));
  const lines = [];

  for (const code of STATION_CODES) {
    const [h, q] = await Promise.all([
      fetchJson(countUrl(code, 'H', start)).then((j) => j.count).catch(() => 'hata'),
      fetchJson(countUrl(code, 'Q', start)).then((j) => j.count).catch(() => 'hata')
    ]);
    lines.push('  ' + code + ' → H: ' + h + ', Q: ' + q);
  }

  console.log('[H/Q veri sayıları — istasyon başına, son ' + LIVE_WINDOW_DAYS + ' gün]\n' + lines.join('\n'));
}

/* ------------------------------------------------------------------
   Zaman aralığı sınırları ve filtreleme
   ------------------------------------------------------------------ */
function stationCoverage() {
  const live = state.live.get(state.code);
  const olds = [live && live.h && live.h.oldest, live && live.q && live.q.oldest]
    .filter((v) => Number.isFinite(v));
  const news = [live && live.h && live.h.newest, live && live.q && live.q.newest]
    .filter((v) => Number.isFinite(v));
  return {
    oldest: olds.length ? Math.min.apply(null, olds) : null,
    newest: news.length ? Math.max.apply(null, news) : null
  };
}

function currentBounds() {
  if (state.range === 'custom') {
    const c = state.custom;
    if (!c || !Number.isFinite(c.from) || !Number.isFinite(c.to)) return null;
    return { from: c.from, to: c.to };
  }
  const cfg = RANGES[state.range];
  if (!cfg) return null;
  const { newest } = stationCoverage();
  const to = newest || Date.now();
  return { from: to - cfg.span, to };
}

function filterPoints(points, bounds) {
  if (!bounds) return points;
  return points.filter((p) => p.x >= bounds.from && p.x <= bounds.to);
}

function syncCustomBounds() {
  const { oldest, newest } = stationCoverage();
  const fromMs = state.custom ? state.custom.from : oldest;
  const toMs = state.custom ? state.custom.to : newest;

  if (oldest) ui.fromInput.min = toInputValue(oldest);
  if (newest) ui.toInput.max = toInputValue(newest);
  if (oldest && fromMs) ui.toInput.min = toInputValue(Math.max(oldest, fromMs));
  if (toMs) ui.fromInput.max = toInputValue(toMs);

  if (!state.custom) return;

  // Kullanıcı bir alanda yazarken değeri geri yazma: aksi hâlde imleç
  // başka bir parçaya atlar ve "13" yazarken "01"/"03" gibi değerler oluşur.
  const active = document.activeElement;
  const fromValue = toInputValue(state.custom.from);
  const toValue = toInputValue(state.custom.to);

  if (active !== ui.fromInput && ui.fromInput.value !== fromValue) {
    ui.fromInput.value = fromValue;
  }
  if (active !== ui.toInput && ui.toInput.value !== toValue) {
    ui.toInput.value = toValue;
  }
}

/** İstasyon değişince özel aralığı yeni kapsama sıkıştır (sessizce). */
function clampCustomToCoverage() {
  if (!state.custom) return;
  const { oldest, newest } = stationCoverage();
  let { from, to } = state.custom;

  if (oldest && from < oldest) from = oldest;
  if (newest && to > newest) to = newest;

  if (!(to > from)) {
    from = oldest || (to - DAY);
    to = newest || (from + DAY);
  }

  state.custom = { from, to };
  if (state.range === 'custom') syncCustomBounds();
}

/* ------------------------------------------------------------------
   Eşik geçişleri: 12 günlük ortalama serisindeki son geçişler
   ------------------------------------------------------------------ */
function lastThresholdCrossing(series, value, cutoff) {
  let hit = null;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (!Number.isFinite(prev.y) || !Number.isFinite(cur.y)) continue;
    if (cur.x < cutoff) continue;

    if (prev.y < value && cur.y >= value) {
      hit = { x: cur.x, dir: 'up' };
    } else if (prev.y >= value && cur.y < value) {
      hit = { x: cur.x, dir: 'down' };
    }
  }
  return hit;
}
