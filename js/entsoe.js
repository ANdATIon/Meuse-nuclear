/* ------------------------------------------------------------------
   js/entsoe.js
   Generation, net generation, outages, unit status and stale-data logic
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Santral yapılandırması (backend /api/entsoe/plants)
   ------------------------------------------------------------------ */
function orderedPlants() {
  return (state.plants || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

function orderedUnits(plant) {
  return (plant.units || []).slice().sort(
    (a, b) => (a.overviewOrder || 0) - (b.overviewOrder || 0)
  );
}

function allOverviewUnits() {
  const units = [];
  orderedPlants().forEach((plant) => {
    orderedUnits(plant).forEach((unit) => units.push(Object.assign({}, unit, { plant })));
  });
  return units.sort((a, b) => (a.overviewOrder || 0) - (b.overviewOrder || 0));
}

function unitColor(plant, index) {
  const unit = (plant.units || [])[index] || {};
  const known = {
    chooz1: '#38bdf8',
    chooz2: '#f472b6',
    doel4: '#34d399',
    tihange3: '#a78bfa'
  };
  if (known[unit.key]) return known[unit.key];
  return CONFIG.entsoe.unitColors[index % CONFIG.entsoe.unitColors.length];
}

async function loadPlants() {
  let plants = null;
  try {
    const json = await fetchEntsoe('/api/entsoe/plants', { timeoutMs: 20000 });
    plants = Array.isArray(json.plants) && json.plants.length ? json.plants : null;
    state.overviewOrder = Array.isArray(json.overviewOrder) ? json.overviewOrder : [];
    clearFail('plants');
  } catch (err) {
    console.error('[santral yapılandırması]', err);
    fail('plants', 'Santral yapılandırması', entsoeErrorMessage(err));
  }

  state.plants = plants || FALLBACK_PLANTS;
  if (!state.overviewOrder.length) {
    state.overviewOrder = allOverviewUnits().map((unit) => unit.key);
  }

  const riverPlant = state.plants.find(
    (plant) => plant.river && Array.isArray(plant.river.stations) && plant.river.stations.length
  );
  if (riverPlant) {
    STATION_CODES = riverPlant.river.stations.map((station) => station.code);
    state.stationNames = new Map(
      riverPlant.river.stations.map((station) => [station.code, station.name || station.code])
    );
  }
  if (!STATION_CODES.includes(state.code)) {
    state.code = STATION_CODES[0] || DEFAULT_STATION;
  }

  buildPlantSections();
}

/* ------------------------------------------------------------------
   ENTSO-E verisi: üretim (A73) + kesinti bildirimleri (A80/A77)
   A73 günleri backend'de arka planda dolar; istemci pending boşalana
   kadar yoklar ve grafiği her turda günceller.
   ------------------------------------------------------------------ */
let entsoePollSeq = 0;
let entsoePolling = false;

function genPending(gen) {
  return !!(gen && Array.isArray(gen.pending) && gen.pending.length);
}

function generationUrl(win, force) {
  return '/api/entsoe/generation?from=' + win.gen.from + '&to=' + win.gen.to +
    (force ? '&force=1' : '');
}

function fetchGeneration(win, force) {
  return fetchEntsoe(generationUrl(win, force), {
    timeoutMs: CONFIG.entsoe.genRequestTimeoutMs
  });
}

function generationSignature(gen) {
  const days = (gen && gen.days) || {};
  const pending = (gen && gen.pending) || [];
  const missing = (gen && gen.missing) || [];
  return [days.loaded || 0, pending.length, missing.length].join('/');
}

function logGeneration(gen) {
  const units = (gen && gen.units) || [];
  const days = (gen && gen.days) || {};
  console.log('[ENTSO-E üretim] ' + units.map(
    (u) => u.name + ': ' + u.count + ' nokta'
  ).join(' | ') + ' · gün ' + (days.loaded || 0) + '/' + (days.total || 0));

  if (gen && gen.missing && gen.missing.length) {
    console.warn('[ENTSO-E üretim] eksik günler:', gen.missing);
  }
  if (gen && gen.warnings && gen.warnings.length) {
    console.warn('[ENTSO-E üretim uyarıları]', gen.warnings);
  }
}

async function pollGeneration(win, entry, token) {
  const delay = CONFIG.entsoe.genPollMs;
  const deadline = Date.now() + 30 * 60 * 1000;

  while (token === entsoePollSeq && state.entsoe === entry &&
         genPending(entry.gen) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (token !== entsoePollSeq || state.entsoe !== entry) return;

    try {
      const before = generationSignature(entry.gen);
      const next = await fetchGeneration(win, false);
      if (token !== entsoePollSeq || state.entsoe !== entry) return;
      entry.gen = next;
      entry.genError = null;
      logGeneration(next);
      if (generationSignature(next) !== before) renderAll();
    } catch (err) {
      // Arka plan yoklaması kartı düşürmesin; sonraki turda yeniden denenir.
      console.warn('[ENTSO-E üretim] arka plan yoklaması başarısız', err);
    }
  }

  if (token === entsoePollSeq) entsoePolling = false;
}

async function loadEntsoe(opts) {
  const force = !!(opts && opts.force);
  const cached = state.entsoe;

  if (!force && cached && cached.fetchedAt && !genPending(cached.gen) &&
      Date.now() - cached.fetchedAt < CONFIG.entsoe.cacheTtlMs) {
    return cached;
  }
  if (!force && entsoePolling && cached) return cached;

  const win = entsoeWindow();
  const token = ++entsoePollSeq;
  entsoePolling = false;

  const entry = {
    gen: null,
    out: null,
    genError: null,
    outError: null,
    fetchedAt: Date.now(),
    beNuclearTotal: null,
    beAttribution: null
  };

  const [genResult, outResult] = await Promise.allSettled([
    fetchGeneration(win, force),
    fetchEntsoe('/api/entsoe/outages?from=' + win.out.from + '&to=' + win.out.to)
    // A75 / Belçika toplamı daha sonraki bir görevde etkinleştirilecek:
    // fetchEntsoe('/api/entsoe/aggregated-generation?zone=BE')
  ]);

  if (genResult.status === 'fulfilled') {
    entry.gen = genResult.value;
    logGeneration(entry.gen);
  } else {
    entry.genError = genResult.reason;
    console.error('[ENTSO-E üretim]', genResult.reason);
  }

  if (outResult.status === 'fulfilled') {
    entry.out = outResult.value;
    console.log('[ENTSO-E bildirim] ' + entry.out.counts.matched + ' reaktör bildirimi');
    if (entry.out.warnings && entry.out.warnings.length) {
      console.warn('[ENTSO-E bildirim uyarıları]', entry.out.warnings);
    }
  } else {
    entry.outError = outResult.reason;
    console.error('[ENTSO-E bildirim]', outResult.reason);
  }

  // A75 Belçika toplamı ve atribyüsiyon şimdilik devre dışı:
  entry.beNuclearTotal = null;
  entry.beAttribution = null;

  state.entsoe = entry;

  if (genPending(entry.gen)) {
    entsoePolling = true;
    pollGeneration(win, entry, token);
  }

  return entry;
}

/* ------------------------------------------------------------------
   Belçika atribyüsiyon mantığı: A75 canlı toplam + gecikmeli A73 + bildirimler
   ------------------------------------------------------------------ */
function computeBelgiumAttribution(gen, beTotal, out) {
  // Belçika nükleer santralleri ve kapasiteleri (net MW)
  const beUnits = [
    { key: "doel4", label: "Doel 4", capacityMW: 1033 },
    { key: "tihange3", label: "Tihange 3", capacityMW: 1038 }
  ];

  // Adım 1: Mevcut canlı toplam (A75)
  const now = Date.now();
  const totalMW = beTotal.value_mw;
  const totalTs = beTotal.timestamp_ms;

  // Toplamı ünite sayısına çevir (tolerans: ~0.5 GW = 1 ünite)
  const runningNow = Math.round(totalMW / 1000); // 0, 1, veya 2

  // Adım 2: Son bilinen ünite verisi (T_unit)
  // Belgium A73 için en son veri noktasının zamanını bul
  let tUnit = 0;
  let unitsAtTUnit = {};
  for (const unitDef of beUnits) {
    const unit = (gen.units || []).find(u => u.key === unitDef.key);
    if (unit && unit.points && unit.points.length) {
      const latest = unit.points[unit.points.length - 1];
      if (latest && Number.isFinite(latest[2])) { // genMW
        if (latest[0] > tUnit) tUnit = latest[0];
        unitsAtTUnit[unitDef.key] = latest[2] > 50; // üretim > 50 MW = çalışıyor
      }
    }
  }

  if (tUnit === 0) {
    return {
      error: "Belçika ünite verisi bulunamadı",
      totalMW,
      totalTs,
      runningNow,
      units: {}
    };
  }

  const runningAtTUnit = Object.values(unitsAtTUnit).filter(v => v).length;

  // Adım 3: Karşılaştır
  const delta = runningNow - runningAtTUnit;

  // Adım 4: Bildirimlerle değişimi açıkla (T_unit, now] penceresi
  const notices = (out && out.notices) || [];
  const beNotices = notices.filter(n => n.zoneKey === "BE" &&
    n.unitKey && (n.unitKey === "doel4" || n.unitKey === "tihange3") &&
    n.status === "active" && !noticeIsInfo(n) &&
    Number.isFinite(n.created) && n.created > tUnit && n.created <= now);

  // Her ünite için en yeni bildirimi bul (publication time = created)
  const latestNoticePerUnit = {};
  for (const n of beNotices) {
    const existing = latestNoticePerUnit[n.unitKey];
    if (!existing || (n.created || 0) > (existing.created || 0)) {
      latestNoticePerUnit[n.unitKey] = n;
    }
  }

  // Değişimi atfet
  let attribution = {};
  let reasoning = [];
  let uncertain = false;

  if (delta === 0) {
    // Aynı sayıda ünite - T_unit'daki durum devam ediyor, ama bildirimler varsa onları da kontrol et
    for (const unitDef of beUnits) {
      const wasRunning = unitsAtTUnit[unitDef.key] || false;
      const notice = latestNoticePerUnit[unitDef.key];
      if (notice && notice.availableMW != null && notice.availableMW <= 0.5 && notice.end && notice.end > now) {
        // Bu ünite için kapanma bildirimi var
        attribution[unitDef.key] = { running: false, reason: "notice", notice, confidence: "yüksek" };
        reasoning.push(`${unitDef.label}: ${fmtDDMMTime.format(new Date(notice.created))} bildirimi ile kapanış (kullanılabilir ${notice.availableMW} MW)`);
      } else if (notice && notice.availableMW != null && notice.availableMW > 0.5 && notice.start && notice.start <= now && notice.end && notice.end > now) {
        // Bu ünite için yeniden başlatma/ramp-up bildirimi var
        attribution[unitDef.key] = { running: true, reason: "notice", notice, confidence: "yüksek" };
        reasoning.push(`${unitDef.label}: ${fmtDDMMTime.format(new Date(notice.created))} bildirimi ile yeniden başlatma`);
      } else {
        attribution[unitDef.key] = { running: wasRunning, reason: "t_unit", confidence: "orta" };
      }
    }
  } else if (delta < 0) {
    // Daha az ünite çalışıyor - hangisi durdu?
    const stoppedCandidates = [];
    for (const unitDef of beUnits) {
      const wasRunning = unitsAtTUnit[unitDef.key] || false;
      const notice = latestNoticePerUnit[unitDef.key];
      if (wasRunning && notice && notice.availableMW != null && notice.availableMW <= 0.5 && notice.end && notice.end > now) {
        stoppedCandidates.push({ unit: unitDef.key, notice, reason: "shutdown_notice" });
      } else if (wasRunning && notice && notice.kind === "planned" && notice.end && notice.end > now) {
        stoppedCandidates.push({ unit: unitDef.key, notice, reason: "planned_outage" });
      }
    }
    if (stoppedCandidates.length === 1) {
      const c = stoppedCandidates[0];
      attribution[c.unit] = { running: false, reason: c.reason, notice: c.notice, confidence: "yüksek olasılık" };
      reasoning.push(`${UNIT_BY_KEY[c.unit]?.label || c.unit}: ${fmtDDMMTime.format(new Date(c.notice.created))} bildirimi ile kapanış`);
      for (const unitDef of beUnits) {
        if (unitDef.key !== c.unit) {
          attribution[unitDef.key] = { running: unitsAtTUnit[unitDef.key] || false, reason: "t_unit", confidence: "orta" };
        }
      }
    } else {
      uncertain = true;
      reasoning.push(`${Math.abs(delta)} ünite durdu ama hangisi belirsiz (${stoppedCandidates.length} aday)`);
      for (const unitDef of beUnits) {
        attribution[unitDef.key] = { running: unitsAtTUnit[unitDef.key] || false, reason: "t_unit", confidence: "belirsiz" };
      }
    }
  } else { // delta > 0
    // Daha fazla ünite çalışıyor - hangisi başladı?
    const startedCandidates = [];
    for (const unitDef of beUnits) {
      const wasRunning = unitsAtTUnit[unitDef.key] || false;
      const notice = latestNoticePerUnit[unitDef.key];
      if (!wasRunning && notice && (notice.kind === "planned" || notice.reasonCode === "A95") &&
          notice.availableMW != null && notice.availableMW > 0.5 && notice.start && notice.start <= now && notice.end && notice.end > now) {
        startedCandidates.push({ unit: unitDef.key, notice, reason: "ramp_up" });
      }
    }
    if (startedCandidates.length === 1) {
      const c = startedCandidates[0];
      attribution[c.unit] = { running: true, reason: c.reason, notice: c.notice, confidence: "yüksek olasılık" };
      reasoning.push(`${UNIT_BY_KEY[c.unit]?.label || c.unit}: ${fmtDDMMTime.format(new Date(c.notice.created))} bildirimi ile yeniden başlatma`);
      for (const unitDef of beUnits) {
        if (unitDef.key !== c.unit) {
          attribution[unitDef.key] = { running: unitsAtTUnit[unitDef.key] || false, reason: "t_unit", confidence: "orta" };
        }
      }
    } else {
      uncertain = true;
      reasoning.push(`${delta} ünite başladı ama hangisi belirsiz (${startedCandidates.length} aday)`);
      for (const unitDef of beUnits) {
        attribution[unitDef.key] = { running: unitsAtTUnit[unitDef.key] || false, reason: "t_unit", confidence: "belirsiz" };
      }
    }
  }

  // Tahmini üretilen MW hesapla
  for (const unitDef of beUnits) {
    const attr = attribution[unitDef.key];
    attr.estimatedMW = attr.running ? unitDef.capacityMW : 0;
    attr.unitLabel = unitDef.label;
  }

  return {
    tUnit,
    tUnitStr: fmtDDMMTime.format(new Date(tUnit)),
    totalMW,
    totalTs,
    totalTsStr: fmtDDMMTime.format(new Date(totalTs)),
    runningNow,
    runningAtTUnit,
    delta,
    unitsAtTUnit,
    latestNoticePerUnit,
    attribution,
    reasoning,
    uncertain
  };
}

/* ------------------------------------------------------------------
   Bildirim etiketleri: A95 bilgi notu; çevresel kısıtlar bakım değildir
   ------------------------------------------------------------------ */
function noticeIsInfo(notice) {
  // A95 is complementary information unless its text explicitly cites an
  // environmental constraint; those are real planned environmental outages.
  if (String((notice && notice.reasonCode) || '').toUpperCase() !== 'A95') {
    return false;
  }
  if (noticeIsEnvironmental(notice)) return false;
  // Belgian A80/A77 documents use A95 for "planned maintenance/test" and
  // carry a real availability value. Treat those as outages, not info notes.
  if (notice.zoneKey === 'BE' && Number.isFinite(notice.availableMW)) return false;
  return true;
}

function noticeIsEnvironmental(notice) {
  if (!notice) return false;
  const hay = [notice.comment, notice.reasonText, notice.reason]
    .filter(Boolean).join(' ');
  return !!hay && CONFIG.entsoe.envPattern.test(hay);
}

function noticeKindText(notice) {
  if (noticeIsInfo(notice)) return 'Ek bilgi';
  if (noticeIsEnvironmental(notice)) {
    if (notice.kind === 'planned') return 'Planlı – çevresel kısıt';
    if (notice.kind === 'forced') return 'Zorunlu – çevresel kısıt';
    return 'Çevresel kısıt';
  }
  return CONFIG.entsoe.kindLabels[notice.kind] || 'Kesinti';
}

function noticeReasonText(notice) {
  if (noticeIsInfo(notice)) return 'Ek bilgi';
  if (noticeIsEnvironmental(notice)) {
    if (notice.kind === 'planned') return 'Planlı – çevresel kısıt';
    if (notice.kind === 'forced') return 'Zorunlu – çevresel kısıt';
    return 'Çevresel kısıt';
  }
  if (String(notice.reasonCode || '').toUpperCase() === 'A95') {
    // Belçika A95 kayıtlarında asıl bilgi TSO'nun reasonText alanındadır.
    return notice.reasonText || noticeKindText(notice);
  }
  return CONFIG.entsoe.reasonLabels[notice.reasonCode] ||
    notice.reason || notice.reasonCode;
}

function unitSnapshot(key, unit, notices, now, beAttribution) {
  const latest = unit && unit.points && unit.points.length
    ? unit.points[unit.points.length - 1]
    : null;
  const freshMs = 3 * 60 * 60 * 1000; // 3 saat - veri gecikme eşiği
  const stale = !!latest && now - latest[0] > freshMs;
  const ref = latest && !stale ? latest[0] : now;

  // Belçika üniteleri için atribyüsiyon kontrolü
  const isBelgianUnit = (key === "doel4" || key === "tihange3");
  let attribution = null;
  if (isBelgianUnit && beAttribution && beAttribution.attribution) {
    attribution = beAttribution.attribution[key];
  }

  // Veri öncelik sırası:
  // 1. Taze A73 üretim verisi (>50 MW) = çalışıyor
  // 2. Belçika için atribyüsiyon sonucu
  // 3. Bildirimler (en yeni publication time kazanıyor)
  // 4. Eski veri / veri yok

  const netMW = latest && Number.isFinite(latest[1]) ? latest[1] : null;
  const genMW = latest && Number.isFinite(latest[2]) ? latest[2] : null;
  const consMW = latest && Number.isFinite(latest[3]) ? latest[3] : null;
  const nominal = unit && Number.isFinite(unit.nominalMW) ? unit.nominalMW : null;

  // Bildirimleri incele (tüm üniteler için geçerli)
  const validNotices = (notices || []).filter((n) =>
    n.status === "active" && !noticeIsInfo(n) &&
    Number.isFinite(n.start) && Number.isFinite(n.end) &&
    (n.unitKey === key || n.unitKey == null)
  );

  // En yeni bildirimi bul (created zamanına göre)
  let latestNotice = null;
  for (const n of validNotices) {
    if (n.created != null) {
      if (!latestNotice || n.created > latestNotice.created) {
        latestNotice = n;
      }
    }
  }

  // Aşılmış bildirimleri tespit et: aynı ünite için daha yeni bildirim varsa
  const superseded = validNotices.filter((n) =>
    latestNotice && n !== latestNotice &&
    Number.isFinite(n.created) && n.created < latestNotice.created &&
    ((n.start <= ref && n.end > ref) || (latestNotice.start <= ref && latestNotice.end > ref))
  );
  const supersededNotices = superseded.map(n => n.id);

  const covering = latestNotice && latestNotice.start <= ref && latestNotice.end > ref ? [latestNotice] : [];

  const availability = covering
    .map((n) => n.availableMW)
    .filter((v) => Number.isFinite(v));
  const availableMW = availability.length ? Math.min.apply(null, availability) : null;
  const installedList = covering
    .map((n) => n.installedMW)
    .filter((v) => Number.isFinite(v));
  const installedMW = installedList.length ? Math.max.apply(null, installedList) : null;

  let returnAt = null;
  if (covering.length) {
    returnAt = Math.max.apply(null, covering.map((n) => n.end).filter((v) => Number.isFinite(v)));
  }

  const forced = covering.some((n) => n.kind === "forced");
  const environmental = covering.some((n) => noticeIsEnvironmental(n));

  let tone = "ok";
  let label = "çalışıyor";
  let source = "A73 üretim";
  let sourceDetail = "";

  // 1. Taze A73 verisi varsa ve üretim > 50 MW -> çalışıyor
  if (!stale && genMW != null && genMW > 50) {
    tone = "ok";
    label = "çalışıyor";
    source = "A73 üretim";
    sourceDetail = "gerçek zamanlı veri";
  }
  // 2. Belçika atribyüsiyonu varsa
  else if (isBelgianUnit && attribution) {
    if (attribution.running) {
      tone = "ok";
      label = "çalışıyor (tahmini)";
      source = "A75 toplam + atribyüsiyon";
      sourceDetail = "son ünite verisi " + (beAttribution.tUnitStr || "") + " + bildirimler";
    } else {
      tone = "stop";
      label = "kapalı (tahmini)";
      source = "A75 toplam + atribyüsiyon";
      sourceDetail = "son ünite verisi " + (beAttribution.tUnitStr || "") + " + bildirimler";
    }
  }
  // 3. Eski A73 verisi ama üretim > 50 MW
  else if (stale && genMW != null && genMW > 50) {
    tone = "ok";
    label = "çalışıyor (gecikmeli)";
    source = "A73 üretim (eski)";
    sourceDetail = "son veri " + fmtDDMMTime.format(new Date(latest[0]));
  }
  // 4. Bildirimlere dayalı durum (en yeni publication time kazanıyor)
  else if (availableMW != null && availableMW <= 0.5) {
    tone = "stop";
    label = "kapalı";
    source = "ENTSO-E bildirim";
    sourceDetail = latestNotice ? "en yeni bildirim (created: " + fmtDDMMTime.format(new Date(latestNotice.created)) + ")" : "";
  } else if (genMW != null && genMW <= 0.5) {
    tone = "stop";
    label = "kapalı";
    source = "A73 üretim";
    sourceDetail = "üretim 0";
  } else if (covering.length) {
    tone = "warn";
    label = "kısıtlı";
    source = "ENTSO-E bildirim";
    sourceDetail = latestNotice ? "en yeni bildirim" : "";
  } else if (genMW != null && nominal && genMW < nominal * 0.95) {
    tone = "warn";
    label = "kısıtlı";
    source = "A73 üretim";
    sourceDetail = "nominalin altinda";
  } else {
    tone = "ok";
    label = "çalışıyor";
    source = "varsayılan";
    sourceDetail = "bildirim yok";
  }

  const bits = [];
  if (tone === "stop" && label.includes("tahmini")) {
    bits.push('<span class="stop">Tahmini kapalı</span>');
    if (attribution && attribution.notice) {
      bits.push("bildirim: " + fmtDDMMTime.format(new Date(attribution.notice.created)) + " (" + (attribution.confidence || "") + ")");
    }
    if (beAttribution && beAttribution.reasoning) {
      bits.push("<small>" + esc(beAttribution.reasoning.join("; ")) + "</small>");
    }
  } else if (tone === "ok" && label.includes("tahmini")) {
    bits.push('<span class="ok">Tahmini çalışıyor</span>');
    if (attribution && attribution.notice) {
      bits.push("bildirim: " + fmtDDMMTime.format(new Date(attribution.notice.created)) + " (" + (attribution.confidence || "") + ")");
    }
    if (beAttribution && beAttribution.reasoning) {
      bits.push("<small>" + esc(beAttribution.reasoning.join("; ")) + "</small>");
    }
  } else if (covering && covering.length) {
    const kind = forced ? "arıza"
      : covering.some((n) => n.kind === "planned")
        ? (environmental ? "planlı çevresel kısıt" : "planlı bakım")
        : "kesinti";
    bits.push('<span class="' + (tone === "stop" ? "stop" : "warn") + '">Aktif ' + kind + '</span>');
    if (returnAt != null) {
      bits.push("dönüş <b>" + fmtDDMMTime.format(new Date(returnAt)) + "</b>");
    }
    if (availableMW != null) {
      bits.push("kullanılabilir <b>" + nfMW.format(availableMW) + " MW</b>");
    }
  } else {
    const upcoming = (notices || [])
      .filter((n) => n.status === "active" && !noticeIsInfo(n) &&
        Number.isFinite(n.start) && n.start > ref &&
        (n.unitKey === key || n.unitKey == null))
      .sort((a, b) => a.start - b.start)[0] || null;
    if (upcoming && upcoming.start - now <= CONFIG.entsoe.outageForwardDays * DAY) {
      bits.push("Planlanan: <b>" + fmtDDMMTime.format(new Date(upcoming.start)) + "</b>");
    } else {
      bits.push("Aktif kesinti bildirimi yok");
    }
  }

  if (netMW != null && netMW < -0.5) {
    bits.push("şebekeden çekiyor" +
      (consMW != null ? " (iç tüketim " + nfMW.format(consMW) + " MW)" : ""));
  }
  if (stale && latest) {
    bits.push("son üretim " + fmtDDMMTime.format(new Date(latest[0])) + " (gecikmeli)");
  } else if (!latest) {
    bits.push("üretim verisi yok");
  }

  // Kaynak bilgisini ekle
  const sourceInfo = "Kaynak: " + source + (sourceDetail ? " (" + sourceDetail + ")" : "");

  return {
    netMW,
    genMW,
    consMW,
    availableMW: attribution ? (attribution.running ? attribution.estimatedMW : 0) : (availableMW != null ? availableMW : null),
    installedMW,
    tone,
    label,
    extra: bits.join(" · "),
    sourceInfo,
    supersededNotices,
    attribution,
    stale
  };
}

/* ------------------------------------------------------------------
   Santral üretim grafiği yardımcıları (A73)
   ------------------------------------------------------------------ */
function genDayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return m ? m[3] + '.' + m[2] : (key || '?');
}

function genProgressParts(days) {
  const parts = [];
  if (!days) return parts;

  const total = Number.isFinite(days.total) ? days.total : null;
  const loaded = Number.isFinite(days.loaded) ? days.loaded : null;
  const pending = Array.isArray(days.pending) ? days.pending : [];
  const missing = Array.isArray(days.missing) ? days.missing : [];

  if (total != null && loaded != null) {
    parts.push((pending.length ? 'Yükleniyor: <b>' : 'Yüklenen: <b>') +
      loaded + '/' + total + ' gün</b>');
  }

  if (missing.length) {
    const shown = missing.slice(-6).map(genDayLabel).join(', ');
    const more = missing.length > 6 ? ' …' : '';
    parts.push('<span class="warn" title="' + esc(missing.join(', ')) + '">Eksik ' +
      missing.length + ' gün: ' + esc(shown) + more + '</span>');
  }

  return parts;
}

/* ------------------------------------------------------------------
   Kesinti bildirimleri (A80/A77) — santral bazında
   ------------------------------------------------------------------ */
function noticeRefState(notice, now) {
  if (notice.status === 'active') {
    if (Number.isFinite(notice.start) && notice.start > now) return 'upcoming';
    if (Number.isFinite(notice.end) && notice.end <= now) return 'ended';
    return 'active';
  }
  return 'closed';
}

// Aşılmış (superseded) bildirimi mi? - aynı mRID için daha yeni revision varsa
// veya aynı ünite için aynı zaman aralığını kapsayan daha yeni (created) bildirim varsa
function noticeIsSuperseded(notice, allNotices, now) {
  if (notice.status !== 'active' || noticeIsInfo(notice)) return false;

  // Aynı mRID için daha yeni revision varsa
  const sameMrid = allNotices.filter(n => n.id === notice.id && n !== notice);
  if (sameMrid.some(n => (n.revision || 0) > (notice.revision || 0))) return true;

  // Aynı ünite için aynı ref time'ı kapsayan daha yeni created varsa
  const ref = notice.start <= now && notice.end > now ? now : notice.start;
  const newerCovering = allNotices.filter(n =>
    n.unitKey === notice.unitKey &&
    n !== notice &&
    n.status === 'active' &&
    !noticeIsInfo(n) &&
    Number.isFinite(n.created) && n.created > (notice.created || 0) &&
    Number.isFinite(n.start) && Number.isFinite(n.end) &&
    n.start <= ref && n.end > ref
  );
  return newerCovering.length > 0;
}

function noticeMwText(notice) {
  const available = Number.isFinite(notice.availableMW) ? notice.availableMW : null;
  const installed = Number.isFinite(notice.installedMW) ? notice.installedMW : null;

  if (available != null && installed != null) {
    return nfMW.format(available) + ' / ' + nfMW.format(installed) + ' MW';
  }
  if (available != null) return nfMW.format(available) + ' MW kullanılabilir';
  if (installed != null) return nfMW.format(installed) + ' MW kurulu';
  return '';
}
