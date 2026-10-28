/* ------------------------------------------------------------------
   js/api.js
   All fetch calls to the backend (/api/entsoe/...) and Hub'Eau
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Ağ katmanı (yeniden deneme + zaman aşımı)
   ------------------------------------------------------------------ */
async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    // Hub'Eau kısmi sonuç sayfasında 206 döner — bu da başarıdır.
    if (!res.ok && res.status !== 206) {
      const e = new Error('Hub\'Eau API yanıtı: HTTP ' + res.status + ' ' + (res.statusText || ''));
      e.retryable = res.status >= 500 || res.status === 429;
      throw e;
    }
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('Zaman aşımı: istek ' + (REQ_TIMEOUT_MS / 1000) + ' saniye içinde yanıtlanmadı.');
      e.retryable = true;
      throw e;
    }
    if (err instanceof TypeError) {
      const e = new Error('Ağ hatası: sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
      e.retryable = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt <= REQ_RETRIES; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === REQ_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

/** "next" null olana kadar sayfaları takip eder; toplam kayıt sayısını da döner. */
async function fetchAllPages(url) {
  const rows = [];
  let next = url;
  let page = 0;
  let count = null;

  while (next) {
    if (++page > 500) throw new Error('Sayfalama güvenlik sınırı aşıldı.');
    const json = await fetchJson(next);
    if (count === null && typeof json.count === 'number') count = json.count;
    if (Array.isArray(json.data)) rows.push(...json.data);
    next = json.next || null;
  }

  return { rows, count: count === null ? rows.length : count };
}

/* ------------------------------------------------------------------
   ENTSO-E proxy (token yalnızca backend'de)
   ------------------------------------------------------------------ */
function entsoeBase() {
  const configured = (CONFIG.entsoe.proxyUrl || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  // file:// ile açılan sayfa yerel backend'e gider.
  if (location.protocol === 'file:') return 'http://127.0.0.1:8080';
  return '';
}

function entsoeDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function entsoeWindow() {
  const now = Date.now();
  const cfg = CONFIG.entsoe;
  return {
    gen: {
      from: entsoeDate(now - cfg.generationDays * DAY),
      to: entsoeDate(now + DAY)
    },
    out: {
      from: entsoeDate(now - cfg.outageBackDays * DAY),
      to: entsoeDate(now + (cfg.outageForwardDays + 1) * DAY)
    }
  };
}

async function fetchEntsoe(path, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(entsoeBase() + path, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    let json = null;
    try {
      json = await res.json();
    } catch (err) {
      json = null;
    }

    if (!json) {
      const e = new Error('Backend geçersiz yanıt döndü (HTTP ' + res.status + ').');
      e.code = 'bad_response';
      throw e;
    }

    if (!res.ok || json.ok === false) {
      const detail = json.error || {};
      const e = new Error(detail.message || ('HTTP ' + res.status));
      e.code = detail.code || 'upstream_error';
      e.status = res.status;
      throw e;
    }

    return json;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('İstek ' + Math.round(timeoutMs / 1000) + ' saniye içinde yanıtlanmadı.');
      e.code = 'timeout';
      throw e;
    }
    if (err instanceof TypeError) {
      const e = new Error('Backend\'e ulaşılamadı: ' + (entsoeBase() || location.origin));
      e.code = 'network';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function entsoeErrorMessage(err) {
  if (!err) return 'Bilinmeyen hata.';
  switch (err.code) {
    case 'missing_token':
      return 'Sunucuda ENTSOE_TOKEN tanımlı değil. Backend\'i token ile başlatın.';
    case 'upstream_auth':
      return 'ENTSO-E kimlik doğrulaması başarısız. Token geçersiz veya süresi dolmuş.';
    case 'rate_limited':
      return 'ENTSO-E istek sınırı aşıldı. Birkaç dakika sonra tekrar deneyin.';
    case 'network':
      return 'Backend\'e ulaşılamadı (' + (entsoeBase() || location.origin) + '). server.py çalışıyor mu?';
    case 'timeout':
      return 'ENTSO-E yanıtı 60 saniye içinde gelmedi.';
    case 'missing_token_local':
      return 'Token tanımlı değil.';
    default:
      return err.message || 'ENTSO-E verisi alınamadı.';
  }
}

/* ------------------------------------------------------------------
   Hub'Eau sorgu adresleri
   ------------------------------------------------------------------ */
// observations_tr: code_entite + grandeur_hydro + date_debut_obs
function liveUrl(code, grandeur) {
  const start = new Date(Date.now() - LIVE_WINDOW_DAYS * DAY);
  const params = new URLSearchParams({
    code_entite: code,
    grandeur_hydro: grandeur,
    size: '20000',
    date_debut_obs: isoZ(start)
  });
  return API_BASE + 'observations_tr?' + params.toString();
}

// obs_elab: tarih parametreleri date_debut_obs_elab / date_fin_obs_elab
function elabUrl(code) {
  const start = new Date(Date.now() - ELAB_WINDOW_DAYS * DAY);
  const params = new URLSearchParams({
    code_entite: code,
    grandeur_hydro_elab: 'QmnJ',
    size: '20000',
    date_debut_obs_elab: ymdLocal(start),
    date_fin_obs_elab: ymdLocal(new Date())
  });
  return API_BASE + 'obs_elab?' + params.toString();
}

// referentiel/stations: virgülle ayrılmış code_station listesi
function stationsUrl() {
  const params = new URLSearchParams({
    code_station: STATION_CODES.join(','),
    size: '20'
  });
  return API_BASE + 'referentiel/stations?' + params.toString();
}

// Yalnızca kayıt sayısını almak için hafif sorgu
function countUrl(code, grandeur, startIso) {
  const params = new URLSearchParams({
    code_entite: code,
    grandeur_hydro: grandeur,
    size: '1',
    fields: 'code_station',
    date_debut_obs: startIso
  });
  return API_BASE + 'observations_tr?' + params.toString();
}

/* ------------------------------------------------------------------
   Canlı veri (observations_tr) — 30 gün, istasyon başına önbellek
   ------------------------------------------------------------------ */
async function fetchLiveSeries(code, grandeur, divisor) {
  const { rows, count } = await fetchAllPages(liveUrl(code, grandeur));

  console.log('[Canlı ' + grandeur + '] ' + code + ' → ' + count + ' kayıt' +
    (rows.length !== count ? ' (' + rows.length + ' satır)' : ''));

  // Grafik çizmeden önce ilk 3 değer
  console.log('[Canlı ' + grandeur + '] ' + code + ' ilk 3 değer:', rows.slice(0, 3));

  if (count === 0) return { count, points: [], oldest: null, newest: null };

  const points = livePoints(rows, divisor);
  return {
    count,
    points,
    oldest: points.length ? points[0].x : null,
    newest: points.length ? points[points.length - 1].x : null
  };
}
