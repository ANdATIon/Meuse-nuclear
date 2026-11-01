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
    beNuclearSeries: []
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

    // Active, not cancelled, not superseded A77/A80 outage notices
    const notices = (out && out.notices) || [];
    const beNotices = notices.filter(n =>
      n.zoneKey === "BE" &&
      (n.unitKey === "doel4" || n.unitKey === "tihange3") &&
      n.status === "active" && !noticeIsInfo(n) &&
      Number.isFinite(n.start) && Number.isFinite(n.end)
    );

    // Latest notice per unit (not superseded)
    const latestNoticePerUnit = {};
    for (const n of beNotices) {
      const existing = latestNoticePerUnit[n.unitKey];
      if (!existing || (n.created || 0) > (existing.created || 0)) {
        latestNoticePerUnit[n.unitKey] = n;
      }
    }

    const d4Notice = latestNoticePerUnit['doel4'];
    const t3Notice = latestNoticePerUnit['tihange3'];

    const attribution = {};
    let reasoning = [];
    let uncertain = false;

    // Helper: is active outage notice with available 0 covering current time?
    const isActiveZeroOutage = (n) =>
      n && n.start <= now && n.end > now && n.availableMW != null && n.availableMW <= 50;

    // Helper: does notice indicate ramp-up / startup / maintenance-return / power-reduction?
    const hasRampOrReductionNotice = (n) => {
      if (!n) return false;
      if (n.availableMW != null && n.availableMW > 50 && n.availableMW < 1000) return true;
      const txt = ((n.reasonText || '') + ' ' + (n.comment || '') + ' ' + (n.reason || '')).toLowerCase();
      return /ramp|start|redémarr|reprise|step|essai|test|kısıt|reduc|réduc|curtail|baisse|maint|bakım/i.test(txt);
    };

    const getPartialNote = (key, partialMW, notice, lastA73, nominalMW) => {
      const txt = ((notice && ((notice.reasonText || '') + ' ' + (notice.comment || '') + ' ' + (notice.reason || ''))) || '').toLowerCase();
      if (/reduc|réduc|kısıt|baisse|curtail|limit/i.test(txt)) {
        return 'güç azaltımında';
      }
      if (/ramp|start|redémarr|reprise|step-up|montee|montée|return|retour/i.test(txt)) {
        return 'güç artırımında';
      }
      if (notice && (notice.availableMW <= 50 || /maint|bakım|entretien/i.test(txt))) {
        return 'güç artırımında';
      }
      if (lastA73) {
        if (lastA73.genMW <= 100 || !lastA73.producing) return 'güç artırımında';
        if (lastA73.genMW >= nominalMW * 0.9) return 'güç azaltımında';
      }
      return 'güç artırımında';
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
    // 2. total <= one unit nominal + tol (single-unit range):
    else if (totalMW <= singleUnitLimit) {
      const d4Zero = isActiveZeroOutage(d4Notice);
      const t3Zero = isActiveZeroOutage(t3Notice);

      let activeUnitKey = null;
      let zeroUnitKey = null;

      // - The unit with an active outage notice (available 0) = 0; other = total.
      if (d4Zero && !t3Zero) {
        zeroUnitKey = 'doel4';
        activeUnitKey = 'tihange3';
      } else if (t3Zero && !d4Zero) {
        zeroUnitKey = 'tihange3';
        activeUnitKey = 'doel4';
      }
      // - If no notice: the unit that was producing in the last A73 data = total, other = 0.
      else if (d4A73 && t3A73 && d4A73.producing && !t3A73.producing) {
        activeUnitKey = 'doel4';
        zeroUnitKey = 'tihange3';
      } else if (d4A73 && t3A73 && t3A73.producing && !d4A73.producing) {
        activeUnitKey = 'tihange3';
        zeroUnitKey = 'doel4';
      } else {
        // Fallback: compare last gen MW
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
    // 3. Between (total > one nominal + tol and < sum - tol) -> both are running, one is ramping/reduced.
    // IMPORTANT: total is the truth; ignore "available 0" on notices here - they may be ending (e.g. return from maintenance).
    else {
      const d4NoticeHit = hasRampOrReductionNotice(d4Notice);
      const t3NoticeHit = hasRampOrReductionNotice(t3Notice);

      let partialKey = null;
      let fullKey = null;

      // - Partial unit = the one with a recent/active ramp-up, startup, maintenance-return or power-reduction notice (not cancelled, not superseded).
      if (d4NoticeHit && !t3NoticeHit) {
        partialKey = 'doel4';
        fullKey = 'tihange3';
      } else if (t3NoticeHit && !d4NoticeHit) {
        partialKey = 'tihange3';
        fullKey = 'doel4';
      }
      // - If both or neither have notices -> partial = the one that was offline/lower in the last A73 data.
      else if (d4A73 && t3A73) {
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

      // If still unclear -> split proportionally, low confidence.
      if (!partialKey || !fullKey) {
        uncertain = true;
        const d4Avail = (d4Notice && Number.isFinite(d4Notice.availableMW) && d4Notice.availableMW > 50)
          ? d4Notice.availableMW : d4Nominal;
        const t3Avail = (t3Notice && Number.isFinite(t3Notice.availableMW) && t3Notice.availableMW > 50)
          ? t3Notice.availableMW : t3Nominal;
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
        const partialA73 = partialKey === 'doel4' ? d4A73 : t3A73;
        const note = getPartialNote(partialKey, partialMW, partialNotice, partialA73, partialNominal);

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
    availableMW: attribution ? attribution.estimatedMW : (availableMW != null ? availableMW : null),
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
