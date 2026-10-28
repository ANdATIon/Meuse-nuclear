/* ------------------------------------------------------------------
   js/config.js
   All constants, configuration, thresholds, colors, and shared state
   ------------------------------------------------------------------ */

const API_BASE = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie/';

// İlk değerler yedektir; /api/entsoe/plants yanıtı geldiğinde nehir
// istasyonları backend yapılandırmasından güncellenir.
let STATION_CODES = ['B720000001', 'B720000002'];
const DEFAULT_STATION = STATION_CODES[0];
const DEFAULT_RANGE = '7d';

// Backend'e ulaşılamazsa sayfanın iskeleti yine de çizilebilsin.
const FALLBACK_PLANTS = [
  {
    key: 'chooz', label: 'Chooz', country: 'FR', countryLabel: 'Fransa', order: 1,
    zone: { key: 'FR', eic: '10YFR-RTE------C' },
    units: [
      { key: 'chooz1', label: 'Chooz B1', overviewOrder: 1 },
      { key: 'chooz2', label: 'Chooz B2', overviewOrder: 2 }
    ],
    river: {
      label: 'Meuse – Chooz',
      stations: [
        { code: 'B720000001', name: 'Trou du Diable (DREAL)' },
        { code: 'B720000002', name: 'Île Graviat' }
      ]
    }
  },
  {
    key: 'tihange', label: 'Tihange', country: 'BE', countryLabel: 'Belçika', order: 2,
    zone: { key: 'BE', eic: '10YBE----------2' },
    units: [{ key: 'tihange3', label: 'Tihange 3', overviewOrder: 4 }]
  },
  {
    key: 'doel', label: 'Doel', country: 'BE', countryLabel: 'Belçika', order: 3,
    zone: { key: 'BE', eic: '10YBE----------2' },
    units: [{ key: 'doel4', label: 'Doel 4', overviewOrder: 3 }]
  }
];

const DAY = 86400000;

/* ==================================================================
   YAPILANDIRMA — eşikler, hareketli ortalama, boşluk ve renkler
   Davranışı değiştirmek için yalnızca bu bölümü düzenleyin.
   ================================================================== */
const CONFIG = {
  // Debi eşikleri (m³/s): grafik çizgileri ve durum kartı bu değerleri kullanır.
  thresholds: {
    twoUnits: { value: 22, label: '22 m³/s – 1 ünite durur', color: '#fbbf24', labelOffset: 'above' },
    oneUnit:  { value: 20, label: '20 m³/s – 2 ünite durur', color: '#f87171', labelOffset: 'below' }
  },
  rolling: {
    windowDays: 12,               // hareketli ortalama penceresi (gün)
    resampleMs: 60 * 60 * 1000,   // saatlik yeniden örnekleme adımı
    minCoverage: 0.85,            // pencerede en az bu oranda saatlik veri bulunmalı
    trendLookbackMs: DAY,         // trend karşılaştırması: 24 saat önceki ortalama
    trendEpsilon: 0.25            // bundan küçük fark "sabit" sayılır (m³/s)
  },
  gaps: {
    breakMs: 6 * 60 * 60 * 1000   // bu süreden uzun boşlukta çizgi kesilir
  },
  entsoe: {
    // Backend adresi. Sayfa server.py üzerinden açılıyorsa boş bırakın.
    // Sayfayı file:// ile açarsanız 'http://127.0.0.1:8080' yazın.
    proxyUrl: '',

    generationDays: 30,           // A73 için istenen geriye dönük gün sayısı
    outageBackDays: 30,           // A80/A77 geriye dönük gün
    outageForwardDays: 7,         // planlı dönüşlerin görünmesi için ileri gün
    recentNoticeDays: 7,          // "son 7 gün" bildirim penceresi
    cacheTtlMs: 15 * 60 * 1000,   // tarayıcı tarafı önbellek (backend 15 dk tutar)

    genBreakMs: 2 * 60 * 60 * 1000, // üretim serisinde bu boşlukta çizgi kesilir
    genFreshHours: 6,             // bu saatten eski üretim "bayat" sayılır
    genRequestTimeoutMs: 45000,   // A73 isteği artık beklemiyor; yine de üst sınır
    genPollMs: 30000,             // eksik günler dolarken en fazla 30 sn'de bir
    genPollMaxMs: 30000,          // sabit: geri çekilme yok
    noticeMaxItems: 40,
    productionOverlayDefault: false,

    // Çevresel kısıt ipuçları (comment / reason). A95 "ek bilgi" sayılır.
    envPattern: /environ|environmental|[ée]colog|ecological|çevresel|cevresel|milieu/i,

    // Bitki/ünite listesi backend'den (/api/entsoe/plants) gelir.
    unitColors: ['#38bdf8', '#f472b6', '#a78bfa', '#34d399'],
    plantColors: { chooz: '#38bdf8', tihange: '#a78bfa', doel: '#34d399' },
    neutralColor: '#94a3b8',

    // ENTSO-E ReasonCode (A95/B18/B19/B20) çevirileri; bilinmeyen kod ham gösterilir.
    reasonLabels: {
      A95: 'Ek bilgi',
      B18: 'Arıza',
      B19: 'Planlı bakım',
      B20: 'Kapatma'
    },
    kindLabels: {
      planned: 'Planlı bakım',
      forced: 'Arıza / zorunlu kesinti',
      unknown: 'Kesinti'
    }
  },
  colors: {
    rolling: '#f472b6',           // 12 günlük ortalama çizgisi
    genOverlay: '#34d399',        // üretim grafiğindeki debi ortalaması
    compare: ['#38bdf8', '#34d399', '#a78bfa']
  }
};

const LIVE_WINDOW_DAYS = 30;   // observations_tr yalnızca ~30 gün tutar
// NOT: Hareketli ortalama en az CONFIG.rolling.windowDays gün ister.
// LIVE_WINDOW_DAYS (30) bundan büyük olduğu için ek geçmiş isteği gerekmez.
const ELAB_WINDOW_DAYS = 365;

const REFRESH_MS = 5 * 60 * 1000;   // canlı veri yenileme aralığı
const ELAB_TTL_MS = 60 * 60 * 1000; // günlük veri önbellek ömrü
const REQ_TIMEOUT_MS = 30000;       // yanıtlar büyük (~3 MB)
const REQ_RETRIES = 1;

const LS_STATION = 'hubeau.hydrometrie.station';
const COLORS = { h: '#38bdf8', q: '#34d399', d: '#a78bfa' };

// H ve Q grafikleri için ortak zaman aralıkları
const RANGES = {
  '24h': { label: '24 saat', span: DAY,       tag: 'son 24 saat' },
  '2d':  { label: '2 gün',   span: 2 * DAY,   tag: 'son 2 gün' },
  '7d':  { label: '7 gün',   span: 7 * DAY,   tag: 'son 7 gün' },
  '14d': { label: '2 hafta', span: 14 * DAY,  tag: 'son 2 hafta' },
  '30d': { label: '30 gün',  span: 30 * DAY,  tag: 'son 30 gün' }
};

const TIME_ZONE = 'Europe/Brussels';

const tzName = TIME_ZONE;
const tzOffset = (() => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE, timeZoneName: 'shortOffset'
    }).formatToParts(new Date());
    const part = parts.find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch (err) {
    return '';
  }
})();

/* ------------------------------------------------------------------
   DOM Referansları
   ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const ui = {
  banner: $('banner'), bannerTitle: $('bannerTitle'), bannerMsg: $('bannerMsg'),
  stationTabs: $('stationTabs'), stationTitle: $('stationTitle'), stationCode: $('stationCode'),
  tzLabel: $('tzLabel'), updatedLabel: $('updatedLabel'), countdown: $('countdown'),
  refreshBtn: $('refreshBtn'), statusDot: $('statusDot'),
  hero: $('hero'), viewGroup: $('viewGroup'),
  hValue: $('hValue'), hTime: $('hTime'),
  qValue: $('qValue'), qTime: $('qTime'),
  statusCard: $('statusCard'), statusAvg: $('statusAvg'),
  statusBadge: $('statusBadge'), statusTrend: $('statusTrend'),
  cross22: $('cross22'), cross20: $('cross20'),
  reactorGrid: $('reactorGrid'), reactorMeta: $('reactorMeta'),
  plantSections: $('plantSections'), riverSource: $('riverSource'),
  riverPanel: $('riverPanel'),
  rangeGroup: $('rangeGroup'), customRange: $('customRange'),
  fromInput: $('fromInput'), toInput: $('toInput'), applyRange: $('applyRange'),
  rangeWarn: $('rangeWarn'), rangeWarnText: $('rangeWarnText'),
  hCard: $('hCard'), qCard: $('qCard'), dCard: $('dCard'), cmpCard: $('cmpCard'),
  hErr: $('hErr'), qErr: $('qErr'), dErr: $('dErr'), cmpErr: $('cmpErr'),
  hEmpty: $('hEmpty'), qEmpty: $('qEmpty'), dEmpty: $('dEmpty'), cmpEmpty: $('cmpEmpty'),
  hFoot: $('hFoot'), qFoot: $('qFoot'), dFoot: $('dFoot'), cmpFoot: $('cmpFoot'),
  hTag: $('hTag'), qTag: $('qTag'), cmpTag: $('cmpTag')
};

/* ------------------------------------------------------------------
   Merkezi Durum (State)
   ------------------------------------------------------------------ */
const state = {
  code: DEFAULT_STATION,
  range: DEFAULT_RANGE,
  view: 'single',          // 'single' | 'compare'
  custom: null,            // { from, to } — ms
  stations: [],            // [{ code, name }]
  stationNames: new Map(), // code -> configured name
  live: new Map(),         // code -> { h, q, fetchedAt }
  elab: new Map(),         // code -> { points, count, error, fetchedAt }
  plants: [],              // [{ key, label, country, zone, units, river }]
  overviewOrder: [],
  entsoe: null,            // { gen, out, genError, outError, fetchedAt }
  busy: 0
};

const charts = { h: null, q: null, d: null, cmp: null, gen: new Map() };
const failures = new Map();   // key -> { label, reason }

const UNIT_BY_KEY = new Proxy({
  chooz1: { key: 'chooz1', label: 'Chooz B1' },
  chooz2: { key: 'chooz2', label: 'Chooz B2' },
  doel4: { key: 'doel4', label: 'Doel 4' },
  tihange3: { key: 'tihange3', label: 'Tihange 3' }
}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined;
    if (prop in target) return target[prop];
    for (const p of (state.plants || [])) {
      const u = (p.units || []).find((unit) => unit.key === prop);
      if (u) return u;
    }
    return { key: prop, label: prop };
  }
});
