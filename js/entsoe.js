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
    chooz1: '#58A6FF',
    chooz2: 'rgba(88, 166, 255, 0.6)',
    doel4: '#3FB950',
    tihange3: 'rgba(63, 185, 80, 0.6)'
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
      if (entry.beNuclearTotal) {
        try {
          entry.beAttribution = computeBelgiumAttribution(entry.gen, entry.beNuclearTotal, entry.out);
        } catch (_) {}
      }
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
    beAttribution: null,
    beNuclearSeries: [],
    mix: null,
    mixError: null,
    frMix: null,
    frMixError: null
  };

  const [genResult, outResult] = await Promise.allSettled([
    fetchGeneration(win, force),
    fetchEntsoe('/api/entsoe/outages?from=' + win.out.from + '&to=' + win.out.to)
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

  // A75 Belçika nükleer serisi (kendi try/catch bloğunda, diğer yüklemeleri asla engellemez):
  try {
    const beNuclearRes = await fetchEntsoe('/api/entsoe/be-nuclear');
    const series = Array.isArray(beNuclearRes)
      ? beNuclearRes
      : ((beNuclearRes && (beNuclearRes.series || beNuclearRes.data)) || []);
    entry.beNuclearSeries = series;
    if (series.length > 0) {
      const last = series[series.length - 1];
      if (last && Number.isFinite(Number(last.mw))) {
        entry.beNuclearTotal = {
          value_mw: Number(last.mw),
          timestamp_ms: typeof last.t === 'number' ? last.t : new Date(last.t).getTime()
        };
      }
    }
  } catch (err) {
    console.warn('[BE nuclear series fetch]', err);
    entry.beNuclearSeries = [];
  }

  // A75 Belçika üretim karması (anlık). Diğer yüklemeleri engellemez.
  try {
    entry.mix = await fetchEntsoe('/api/entsoe/be-generation-mix');
    if (entry.mix && entry.mix.categories) {
      console.log('[BE generation mix] ' + Object.keys(entry.mix.categories).length +
        ' kategori · ' + (entry.mix.updated || 'tarih yok'));
    }
  } catch (err) {
    entry.mixError = err;
    console.warn('[BE generation mix fetch]', err);
  }

  // A75 France generation mix (anlık). Diğer yüklemeleri engellemez.
  try {
    entry.frMix = await fetchEntsoe('/api/entsoe/fr-generation-mix');
    if (entry.frMix && entry.frMix.categories) {
      console.log('[FR generation mix] ' + Object.keys(entry.frMix.categories).length +
        ' kategori · ' + (entry.frMix.updated || 'tarih yok'));
    }
  } catch (err) {
    entry.frMixError = err;
    console.warn('[FR generation mix fetch]', err);
  }

  // Belçika atribyüsiyonunu hesapla (kendi try/catch bloğunda, hiçbir şeyi engellemez):
  try {
    if (entry.beNuclearTotal) {
      entry.beAttribution = computeBelgiumAttribution(entry.gen, entry.beNuclearTotal, entry.out);
    }
  } catch (err) {
    console.warn('[computeBelgiumAttribution çağrı hatası]', err);
    entry.beAttribution = null;
  }

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
/* ------------------------------------------------------------------
   Kesinti ve Rampa Bildirimleri (A77/A80/A95) zaman serisi analizi
   ------------------------------------------------------------------ */
function getNoticeAvailableMW(notice, now) {
  if (!notice) return null;
  const schedule = notice.schedule;
  if (!schedule || !schedule.length) {
    return Number.isFinite(notice.availableMW) ? notice.availableMW : null;
  }
  if (now < schedule[0].t) {
    return schedule[0].mw;
  }
  let currentMW = schedule[0].mw;
  for (let i = 0; i < schedule.length; i++) {
    if (schedule[i].t <= now) {
      currentMW = schedule[i].mw;
    } else {
      break;
    }
  }
  return currentMW;
}

function getNoticeNextStep(notice, now) {
  if (!notice) return null;
  const schedule = notice.schedule;
  if (!schedule || !schedule.length) return null;
  const currentMW = getNoticeAvailableMW(notice, now);
  for (let i = 0; i < schedule.length; i++) {
    const pt = schedule[i];
    if (pt.t > now && Math.abs(pt.mw - (currentMW != null ? currentMW : 0)) >= 0.5) {
      const timeStr = fmtHM.format(new Date(pt.t));
      return "plan: " + timeStr + "'de " + nfMW.format(pt.mw) + " MW";
    }
  }
  return null;
}

function classifyNotice(notice, nominal) {
  if (!notice) return "outage";
  const nom = nominal || notice.installedMW || 1000;
  const schedule = notice.schedule || [];
  const text = ((notice.reasonText || "") + " " + (notice.comment || "") + " " + (notice.reason || "")).toLowerCase();

  if (!schedule.length) {
    const mw = notice.availableMW;
    if (mw == null || mw <= 50) return "outage";
    if (mw < nom * 0.9) return "restriction";
    if (/ramp|start|redémarr|reprise|step-up|montee|montée|power increase|increase/i.test(text)) return "ramp_up";
    if (/reduc|réduc|kısıt|baisse|curtail|power reduction|decrease/i.test(text)) return "ramp_down";
    return "outage";
  }

  const values = schedule.map(p => p.mw);
  const minVal = Math.min.apply(null, values);
  const maxVal = Math.max.apply(null, values);
  const firstVal = values[0];
  const lastVal = values[values.length - 1];

  // outage: flat at ~0
  if (maxVal <= 50) {
    return "outage";
  }

  // restriction: flat at a constant value between 0 and nominal
  if (maxVal - minVal <= 50 && minVal > 50 && maxVal < nom * 0.9) {
    return "restriction";
  }

  // Check monotonicity
  let nonDec = 0;
  let nonInc = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1] - 5) nonDec++;
    if (values[i] <= values[i - 1] + 5) nonInc++;
  }
  const isMostlyNonDecreasing = nonDec >= (values.length - 1) * 0.65;
  const isMostlyNonIncreasing = nonInc >= (values.length - 1) * 0.65;

  const startsLow = firstVal <= nom * 0.5;
  const endsNearNominal = lastVal >= nom * 0.88 || maxVal >= nom * 0.88;
  const endsClearlyLower = lastVal <= firstVal - 100;

  // ramp_up: values mostly non-decreasing, start low, end >= ~90% of nominal
  if (isMostlyNonDecreasing && startsLow && endsNearNominal) {
    return "ramp_up";
  }

  // ramp_down: values mostly non-increasing, end clearly lower than start
  if (isMostlyNonIncreasing && endsClearlyLower) {
    return "ramp_down";
  }

  if (startsLow && endsNearNominal) {
    return "ramp_up";
  }
  if (endsClearlyLower) {
    return "ramp_down";
  }

  // Flat at a constant value between 0 and nominal
  if (maxVal - minVal <= 80 && minVal > 50 && maxVal < nom * 0.9) {
    return "restriction";
  }

  // Tie-breaker: reason/description text
  if (/ramp|start|redémarr|reprise|step-up|montee|montée|power increase|increase/i.test(text)) {
    return "ramp_up";
  }
  if (/reduc|réduc|baisse|curtail|power reduction|decrease/i.test(text)) {
    return "ramp_down";
  }
  if (/kısıt|restriction|limit/i.test(text)) {
    return "restriction";
  }

  if (lastVal > firstVal) return "ramp_up";
  if (lastVal < firstVal) return "ramp_down";

  return "outage";
}

function computeBelgiumAttribution(gen, beTotal, out) {
  try {
    const beUnits = (CONFIG.entsoe && CONFIG.entsoe.belgianUnits) || [
      { key: "doel4", label: "Doel 4", nominalMW: 1033 },
      { key: "tihange3", label: "Tihange 3", nominalMW: 1038 }
    ];

    const now = Date.now();
    const totalMW = Number(beTotal && beTotal.value_mw);
    const totalTs = (beTotal && beTotal.timestamp_ms) || now;

    if (!Number.isFinite(totalMW)) return null;

    const d4Def = beUnits.find(u => u.key === 'doel4') || beUnits[0];
    const t3Def = beUnits.find(u => u.key === 'tihange3') || beUnits[1];
    const d4Nominal = d4Def.nominalMW;
    const t3Nominal = t3Def.nominalMW;
    const sumNominal = d4Nominal + t3Nominal; // 2071 MW
    const tol = (CONFIG.entsoe && CONFIG.entsoe.belgianTolerance) || 50; // 50 MW
    const singleUnitLimit = Math.max(d4Nominal, t3Nominal) + tol; // 1038 + 50 = 1088 MW

    // Last A73 points for both units
    const getUnitLastA73 = (key) => {
      const u = ((gen && gen.units) || []).find(x => x.key === key);
      if (!u || !u.points || !u.points.length) return null;
      const pt = u.points[u.points.length - 1];
      const net = Number.isFinite(pt[1]) ? pt[1] : null;
      const prod = Number.isFinite(pt[2]) ? pt[2] : net;
      return {
        timestamp: pt[0],
        netMW: net,
        genMW: prod,
        producing: prod != null && prod > 50
      };
    };

    const d4A73 = getUnitLastA73('doel4');
    const t3A73 = getUnitLastA73('tihange3');

    // Active, not cancelled, not superseded A77/A80/A95 outage notices
    const notices = (out && out.notices) || [];
    const beNotices = notices.filter(n =>
      n.zoneKey === "BE" &&
      (n.unitKey === "doel4" || n.unitKey === "tihange3") &&
      n.status === "active" && !noticeIsInfo(n) &&
      Number.isFinite(n.start) && Number.isFinite(n.end)
    );

    const isCovering = (n) => n && n.start <= now && n.end > now;

    const getActiveCoveringNotice = (key) => {
      const cov = beNotices.filter(n => n.unitKey === key && isCovering(n));
      cov.sort((a, b) => (b.created || 0) - (a.created || 0) || (b.revision || 0) - (a.revision || 0));
      return cov[0] || null;
    };

    const getLatestNotice = (key) => {
      const all = beNotices.filter(n => n.unitKey === key);
      all.sort((a, b) => (b.created || 0) - (a.created || 0) || (b.revision || 0) - (a.revision || 0));
      return all[0] || null;
    };

    const d4Covering = getActiveCoveringNotice('doel4');
    const t3Covering = getActiveCoveringNotice('tihange3');
    const d4Notice = d4Covering || getLatestNotice('doel4');
    const t3Notice = t3Covering || getLatestNotice('tihange3');

    const d4Class = d4Covering ? classifyNotice(d4Covering, d4Nominal) : (d4Notice ? classifyNotice(d4Notice, d4Nominal) : null);
    const t3Class = t3Covering ? classifyNotice(t3Covering, t3Nominal) : (t3Notice ? classifyNotice(t3Notice, t3Nominal) : null);

    const d4Sched = d4Covering ? getNoticeAvailableMW(d4Covering, now) : (d4Notice ? getNoticeAvailableMW(d4Notice, now) : null);
    const t3Sched = t3Covering ? getNoticeAvailableMW(t3Covering, now) : (t3Notice ? getNoticeAvailableMW(t3Notice, now) : null);

    const isPartialClass = (cls) => cls === "ramp_up" || cls === "ramp_down" || cls === "restriction";
    const classToNote = (cls) => cls === "ramp_up" ? "güç artırımında" : cls === "ramp_down" ? "güç azaltımında" : "kısıtlı";

    const d4IsPartial = d4Covering && isPartialClass(d4Class);
    const t3IsPartial = t3Covering && isPartialClass(t3Class);

    const attribution = {};
    let reasoning = [];
    let uncertain = false;

    const isActiveZeroOutage = (n) => {
      if (!n || n.start > now || n.end <= now) return false;
      const mw = getNoticeAvailableMW(n, now);
      return mw != null && mw <= 50;
    };

    // 1. total >= D4 + T3 - tol -> both = nominal.
    if (totalMW >= sumNominal - tol) {
      attribution['doel4'] = {
        running: true,
        estimatedMW: d4Nominal,
        confidence: 'high',
        reason: 'full_power',
        unitLabel: d4Def.label,
        notice: d4Notice,
        partialNote: null
      };
      attribution['tihange3'] = {
        running: true,
        estimatedMW: t3Nominal,
        confidence: 'high',
        reason: 'full_power',
        unitLabel: t3Def.label,
        notice: t3Notice,
        partialNote: null
      };
      reasoning.push(`Toplam (${nfMW.format(totalMW)} MW) tam kapasiteye yakın; her iki ünite nominal.`);
    }
    // 2. Bir ünitede aktif rampa/kısıt bildirimi varsa -> kısmi ünite o bildirimdeki geçerli değer
    else if (d4IsPartial && !t3IsPartial) {
      const cardNote = classToNote(d4Class);
      let partialMW = d4Sched != null ? d4Sched : Math.max(0, totalMW - t3Nominal);
      partialMW = Math.max(0, Math.min(totalMW, Math.min(d4Nominal, partialMW)));
      let fullMW = Math.max(0, Math.min(t3Nominal, totalMW - partialMW));
      if (partialMW + fullMW < totalMW && fullMW >= t3Nominal) {
        partialMW = Math.min(d4Nominal, Math.max(0, Math.round(totalMW - fullMW)));
      }
      partialMW = Math.round(partialMW);
      fullMW = Math.round(fullMW);

      attribution['doel4'] = {
        running: partialMW > 50,
        estimatedMW: partialMW,
        confidence: 'high',
        reason: 'partial_notice',
        unitLabel: d4Def.label,
        notice: d4Covering,
        partialNote: cardNote
      };
      attribution['tihange3'] = {
        running: true,
        estimatedMW: fullMW,
        confidence: 'high',
        reason: 'nominal',
        unitLabel: t3Def.label,
        notice: t3Notice,
        partialNote: null
      };
      reasoning.push(`${d4Def.label} aktif ${cardNote} (${nfMW.format(partialMW)} MW); ${t3Def.label} nominal (${nfMW.format(fullMW)} MW).`);
    }
    else if (t3IsPartial && !d4IsPartial) {
      const cardNote = classToNote(t3Class);
      let partialMW = t3Sched != null ? t3Sched : Math.max(0, totalMW - d4Nominal);
      partialMW = Math.max(0, Math.min(totalMW, Math.min(t3Nominal, partialMW)));
      let fullMW = Math.max(0, Math.min(d4Nominal, totalMW - partialMW));
      if (partialMW + fullMW < totalMW && fullMW >= d4Nominal) {
        partialMW = Math.min(t3Nominal, Math.max(0, Math.round(totalMW - fullMW)));
      }
      partialMW = Math.round(partialMW);
      fullMW = Math.round(fullMW);

      attribution['tihange3'] = {
        running: partialMW > 50,
        estimatedMW: partialMW,
        confidence: 'high',
        reason: 'partial_notice',
        unitLabel: t3Def.label,
        notice: t3Covering,
        partialNote: cardNote
      };
      attribution['doel4'] = {
        running: true,
        estimatedMW: fullMW,
        confidence: 'high',
        reason: 'nominal',
        unitLabel: d4Def.label,
        notice: d4Notice,
        partialNote: null
      };
      reasoning.push(`${t3Def.label} aktif ${cardNote} (${nfMW.format(partialMW)} MW); ${d4Def.label} nominal (${nfMW.format(fullMW)} MW).`);
    }
    // 3. Tek ünite aralığı (total <= singleUnitLimit)
    else if (totalMW <= singleUnitLimit) {
      const d4Zero = isActiveZeroOutage(d4Notice);
      const t3Zero = isActiveZeroOutage(t3Notice);

      let activeUnitKey = null;
      let zeroUnitKey = null;

      if (d4Zero && !t3Zero) {
        zeroUnitKey = 'doel4';
        activeUnitKey = 'tihange3';
      } else if (t3Zero && !d4Zero) {
        zeroUnitKey = 'tihange3';
        activeUnitKey = 'doel4';
      } else if (d4A73 && t3A73 && d4A73.producing && !t3A73.producing) {
        activeUnitKey = 'doel4';
        zeroUnitKey = 'tihange3';
      } else if (d4A73 && t3A73 && t3A73.producing && !d4A73.producing) {
        activeUnitKey = 'tihange3';
        zeroUnitKey = 'doel4';
      } else {
        const d4Last = d4A73 ? (d4A73.genMW || 0) : 0;
        const t3Last = t3A73 ? (t3A73.genMW || 0) : 0;
        if (d4Last > t3Last) {
          activeUnitKey = 'doel4';
          zeroUnitKey = 'tihange3';
        } else if (t3Last > d4Last) {
          activeUnitKey = 'tihange3';
          zeroUnitKey = 'doel4';
        } else {
          uncertain = true;
          const half = Math.round(totalMW / 2);
          attribution['doel4'] = {
            running: half > 50,
            estimatedMW: half,
            confidence: 'low',
            lowConfidence: true,
            reason: 'unclear_split',
            unitLabel: d4Def.label,
            notice: d4Notice,
            partialNote: null
          };
          attribution['tihange3'] = {
            running: (totalMW - half) > 50,
            estimatedMW: Math.max(0, totalMW - half),
            confidence: 'low',
            lowConfidence: true,
            reason: 'unclear_split',
            unitLabel: t3Def.label,
            notice: t3Notice,
            partialNote: null
          };
          reasoning.push(`Tek ünite aralığı (${nfMW.format(totalMW)} MW) ancak hangi ünite olduğu belirsiz (düşük güven).`);
        }
      }

      if (activeUnitKey && zeroUnitKey) {
        const estTotal = Math.max(0, Math.round(totalMW));
        attribution[zeroUnitKey] = {
          running: false,
          estimatedMW: 0,
          confidence: 'high',
          reason: 'outage_zero',
          unitLabel: zeroUnitKey === 'doel4' ? d4Def.label : t3Def.label,
          notice: zeroUnitKey === 'doel4' ? d4Notice : t3Notice,
          partialNote: null
        };
        attribution[activeUnitKey] = {
          running: estTotal > 50,
          estimatedMW: estTotal,
          confidence: 'high',
          reason: 'single_unit_total',
          unitLabel: activeUnitKey === 'doel4' ? d4Def.label : t3Def.label,
          notice: activeUnitKey === 'doel4' ? d4Notice : t3Notice,
          partialNote: null
        };
        reasoning.push(`${zeroUnitKey === 'doel4' ? d4Def.label : t3Def.label} kapalı (0 MW); ${activeUnitKey === 'doel4' ? d4Def.label : t3Def.label} = ${nfMW.format(estTotal)} MW.`);
      }
    }
    // 4. İki ünite arası durum: A73 veya oransal paylaşım
    else {
      let partialKey = null;
      let fullKey = null;

      if (d4A73 && t3A73) {
        const d4Val = d4A73.genMW != null ? d4A73.genMW : 0;
        const t3Val = t3A73.genMW != null ? t3A73.genMW : 0;
        if (d4Val < t3Val) {
          partialKey = 'doel4';
          fullKey = 'tihange3';
        } else if (t3Val < d4Val) {
          partialKey = 'tihange3';
          fullKey = 'doel4';
        }
      }

      if (!partialKey || !fullKey) {
        uncertain = true;
        const d4Avail = (d4Sched && d4Sched > 50) ? d4Sched : ((d4Notice && Number.isFinite(d4Notice.availableMW) && d4Notice.availableMW > 50) ? d4Notice.availableMW : d4Nominal);
        const t3Avail = (t3Sched && t3Sched > 50) ? t3Sched : ((t3Notice && Number.isFinite(t3Notice.availableMW) && t3Notice.availableMW > 50) ? t3Notice.availableMW : t3Nominal);
        const sumAvail = d4Avail + t3Avail;
        const d4MW = sumAvail > 0 ? Math.round(totalMW * (d4Avail / sumAvail)) : Math.round(totalMW / 2);
        const t3MW = Math.max(0, Math.round(totalMW - d4MW));

        attribution['doel4'] = {
          running: d4MW > 50,
          estimatedMW: d4MW,
          confidence: 'low',
          lowConfidence: true,
          reason: 'proportional_split',
          unitLabel: d4Def.label,
          notice: d4Notice,
          partialNote: d4MW < d4Nominal * 0.9 ? 'güç artırımında' : null
        };
        attribution['tihange3'] = {
          running: t3MW > 50,
          estimatedMW: t3MW,
          confidence: 'low',
          lowConfidence: true,
          reason: 'proportional_split',
          unitLabel: t3Def.label,
          notice: t3Notice,
          partialNote: t3MW < t3Nominal * 0.9 ? 'güç artırımında' : null
        };
        reasoning.push(`Belirgin tekil bildirim yok; kapasiteye göre paylaştırıldı (düşük güven).`);
      } else {
        const fullNominal = fullKey === 'doel4' ? d4Nominal : t3Nominal;
        const partialNominal = partialKey === 'doel4' ? d4Nominal : t3Nominal;
        const partialMW = Math.max(0, Math.round(totalMW - fullNominal));
        const partialNotice = partialKey === 'doel4' ? d4Notice : t3Notice;
        const note = partialMW < partialNominal * 0.9 ? 'güç artırımında' : 'güç azaltımında';

        attribution[fullKey] = {
          running: true,
          estimatedMW: fullNominal,
          confidence: 'high',
          reason: 'nominal',
          unitLabel: fullKey === 'doel4' ? d4Def.label : t3Def.label,
          notice: fullKey === 'doel4' ? d4Notice : t3Notice,
          partialNote: null
        };
        attribution[partialKey] = {
          running: partialMW > 50,
          estimatedMW: partialMW,
          confidence: 'high',
          reason: 'partial_notice',
          unitLabel: partialKey === 'doel4' ? d4Def.label : t3Def.label,
          notice: partialNotice,
          partialNote: note
        };
        reasoning.push(`${fullKey === 'doel4' ? d4Def.label : t3Def.label} nominal (${nfMW.format(fullNominal)} MW); ${partialKey === 'doel4' ? d4Def.label : t3Def.label} kısmi (${nfMW.format(partialMW)} MW, ${note}).`);
      }
    }

    let tUnit = 0;
    for (const unitDef of beUnits) {
      const unit = (gen.units || []).find(u => u.key === unitDef.key);
      if (unit && unit.points && unit.points.length) {
        const latest = unit.points[unit.points.length - 1];
        if (latest && latest[0] > tUnit) tUnit = latest[0];
      }
    }

    return {
      tUnit,
      tUnitStr: tUnit ? fmtDDMMTime.format(new Date(tUnit)) : '',
      totalMW,
      totalTs,
      totalTsStr: fmtDDMMTime.format(new Date(totalTs)),
      attribution,
      reasoning,
      uncertain
    };
  } catch (err) {
    console.warn('[computeBelgiumAttribution hatası]', err);
    return null;
  }
}

/* ------------------------------------------------------------------
   Bildirim etiketleri: A95 bilgi notu; çevresel kısıtlar bakım değildir
   ------------------------------------------------------------------ */
function noticeIsInfo(notice) {
  if (!notice) return true;
  // Schedule veya kullanılabilir MW taşıyan bildirimler asla filtrelenmez
  if ((notice.schedule && notice.schedule.length > 0) || Number.isFinite(notice.availableMW)) {
    return false;
  }
  if (String(notice.reasonCode || '').toUpperCase() !== 'A95') {
    return false;
  }
  if (noticeIsEnvironmental(notice)) return false;
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

  let availableMW = null;
  let nextStepText = null;
  if (covering.length && latestNotice) {
    availableMW = getNoticeAvailableMW(latestNotice, now);
    nextStepText = getNoticeNextStep(latestNotice, now);
  }
  if (availableMW == null && covering.length) {
    const availability = covering
      .map((n) => n.availableMW)
      .filter((v) => Number.isFinite(v));
    availableMW = availability.length ? Math.min.apply(null, availability) : null;
  }
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
      tone = attribution.lowConfidence ? "warn" : "ok";
      label = attribution.partialNote || (attribution.lowConfidence ? "tahmin (düşük güven)" : "tahmin");
      source = "A75 Belçika nükleer toplamı + bildirimler";
      sourceDetail = "";
    } else {
      tone = "stop";
      label = "kapalı";
      source = "A75 Belçika nükleer toplamı + bildirimler";
      sourceDetail = "";
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
      let availStr = "kullanılabilir <b>" + nfMW.format(availableMW) + " MW</b>";
      if (nextStepText) {
        availStr += " (" + nextStepText + ")";
      }
      bits.push(availStr);
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
    availableMW: attribution ? attribution.estimatedMW : (availableMW != null ? availableMW : null),
    scheduledMW: availableMW,
    nextStepText,
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
  const schedule = notice.schedule;
  if (schedule && schedule.length > 1) {
    const now = Date.now();
    const curr = getNoticeAvailableMW(notice, now);
    const nextStep = getNoticeNextStep(notice, now);
    const installed = Number.isFinite(notice.installedMW) ? notice.installedMW : null;
    let s = (curr != null ? nfMW.format(curr) : '0') + (installed != null ? ' / ' + nfMW.format(installed) + ' MW' : ' MW');
    if (nextStep) s += ' (' + nextStep + ')';
    return s;
  }
  const available = Number.isFinite(notice.availableMW) ? notice.availableMW : null;
  const installed = Number.isFinite(notice.installedMW) ? notice.installedMW : null;

  if (available != null && installed != null) {
    return nfMW.format(available) + ' / ' + nfMW.format(installed) + ' MW';
  }
  if (available != null) return nfMW.format(available) + ' MW kullanılabilir';
  if (installed != null) return nfMW.format(installed) + ' MW kurulu';
  return '';
}
