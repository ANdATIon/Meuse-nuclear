/* ------------------------------------------------------------------
   js/weather.js
   Open-Meteo weather data for the Chooz area.
   Fetched directly from the browser — no backend proxy and no API key.
   ------------------------------------------------------------------ */

const WEATHER_CONFIG = {
  latitude: 50.09,
  longitude: 4.79,
  cacheTtlMs: 30 * 60 * 1000,   // 30 min cache
  timezone: 'Europe/Brussels'
};

const WEATHER_LABELS = {
  0: 'Açık', 1: 'Az bulutlu', 2: 'Parçalı bulutlu', 3: 'Bulutlu',
  45: 'Sisli', 48: 'Kırağılı sis',
  51: 'Hafif çisenti', 53: 'Çisenti', 55: 'Yoğun çisenti',
  61: 'Hafif yağmur', 63: 'Yağmur', 65: 'Şiddetli yağmur',
  71: 'Hafif kar', 73: 'Kar', 75: 'Yoğun kar',
  80: 'Hafif sağanak', 81: 'Sağanak', 82: 'Şiddetli sağanak',
  95: 'Gök gürültülü fırtına', 96: 'Dolu ile fırtına', 99: 'Şiddetli dolu'
};

const WEATHER_ICONS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '🌨️',
  80: '🌧️', 81: '🌧️', 82: '🌧️',
  95: '⛈️', 96: '⛈️', 99: '⛈️'
};

const fmtWeatherDay = new Intl.DateTimeFormat('tr-TR', {
  timeZone: WEATHER_CONFIG.timezone,
  weekday: 'short'
});

function weatherCode(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function weatherLabel(value) {
  return WEATHER_LABELS[weatherCode(value)] || 'Bilinmeyen';
}

function weatherIcon(value) {
  return WEATHER_ICONS[weatherCode(value)] || '·';
}

/** Open-Meteo zaman damgası yerel Brüksel saatidir; UTC ms'e çevirir. */
function weatherTimeToMs(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return Date.parse(value);

  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // İlk tahmin, sonra DST sınırı için bir düzeltme turu.
  let ms = local - tzOffsetMsAt(local);
  ms = local - tzOffsetMsAt(ms);
  return ms;
}

function tzOffsetMsAt(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: WEATHER_CONFIG.timezone,
      timeZoneName: 'shortOffset'
    }).formatToParts(new Date(ms));
    const name = (parts.find((part) => part.type === 'timeZoneName') || {}).value || '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * ((+m[2]) * 60 + (+(m[3] || 0))) * 60000;
  } catch (err) {
    return 0;
  }
}

function weatherDayLabel(value, index) {
  if (index === 0) return 'Bugün';
  if (index === 1) return 'Yarın';
  const d = new Date(String(value) + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) ? fmtWeatherDay.format(d) : String(value);
}

function weatherUrl(extra) {
  return 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + WEATHER_CONFIG.latitude +
    '&longitude=' + WEATHER_CONFIG.longitude +
    extra +
    '&timezone=' + encodeURIComponent(WEATHER_CONFIG.timezone);
}

/**
 * Güncel + 5 günlük tahmin ve son 30 günün saatlik yağış/steaklık verisi.
 * Hata durumunda bile reddetmez; çağıran taraf her zaman devam edebilir.
 */
async function loadWeather(opts) {
  const force = !!(opts && opts.force);
  const cached = state.weather;

  if (!force && cached && cached.fetchedAt &&
      Date.now() - cached.fetchedAt < WEATHER_CONFIG.cacheTtlMs) {
    return cached;
  }

  const forecastUrl = weatherUrl(
    '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code' +
    '&forecast_days=5'
  );
  const historyUrl = weatherUrl(
    '&hourly=precipitation,temperature_2m' +
    '&past_days=30&forecast_days=1'
  );

  const [forecastResult, historyResult] = await Promise.allSettled([
    fetchJson(forecastUrl),
    fetchJson(historyUrl)
  ]);

  const errors = [];
  let current = null;
  let daily = null;
  let hourly = null;

  if (forecastResult.status === 'fulfilled' && forecastResult.value) {
    current = forecastResult.value.current || null;
    daily = forecastResult.value.daily || null;
  } else {
    errors.push(forecastResult.status === 'rejected' ? forecastResult.reason : new Error('tahmin verisi yok'));
  }

  if (historyResult.status === 'fulfilled' && historyResult.value) {
    hourly = historyResult.value.hourly || null;
  } else {
    errors.push(historyResult.status === 'rejected' ? historyResult.reason : new Error('geçmiş verisi yok'));
  }

  if (!current && !daily && !hourly) {
    if (cached && (cached.current || cached.daily || cached.hourly)) {
      console.warn('[Weather] Güncelleme başarısız; önbellekteki veri kullanılıyor.');
      return cached;
    }
    const message = errors.length ? errors[0].message : 'Hava verisi alınamadı.';
    console.warn('[Weather] ' + message);
    state.weather = {
      current: null,
      daily: null,
      hourly: null,
      fetchedAt: 0,
      error: message
    };
    return state.weather;
  }

  const weather = {
    current,
    daily,
    hourly,
    fetchedAt: Date.now(),
    error: errors.length ? errors[0].message : null
  };
  state.weather = weather;

  if (current) {
    console.log('[Weather] ' + weatherLabel(current.weather_code) + ' · ' +
      nfTick.format(Number(current.temperature_2m)) + '°C · ' +
      ((daily && daily.time) ? daily.time.length : 0) + ' günlük tahmin');
  }
  if (errors.length) {
    console.warn('[Weather] Kısmi veri: ' + errors[0].message);
  }

  return weather;
}
