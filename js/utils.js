/* ------------------------------------------------------------------
   js/utils.js
   Time/date formatting (Europe/Brussels), number formatting, helpers
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   Biçimlendiriciler (tr-TR)
   ------------------------------------------------------------------ */
const nfH    = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const nfQ    = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfMW   = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nfTick = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });

const fmtHM        = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const fmtDDMM      = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit' });
const fmtDDMMTime  = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtMonthYear = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, month: 'short', year: '2-digit' });
const fmtFull      = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDayOnly   = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, day: '2-digit', month: 'long', year: 'numeric' });
const fmtClock     = new Intl.DateTimeFormat('tr-TR', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------------
   Yardımcı Fonksiyonlar
   ------------------------------------------------------------------ */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function isoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ymdLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
}

/** ms -> datetime-local değeri (yerel saat) */
function toInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// "YYYY-MM-DD" -> yerel gün başlangıcı (takvim günü kaymasın)
function parseLocalDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return Date.parse(value);
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;

  if (days) return days + ' gün' + (hours ? ' ' + hours + ' sa' : '');
  if (hours) return hours + ' sa' + (mins ? ' ' + mins + ' dk' : '');
  return mins + ' dk';
}

/** Aralık uzunluğuna göre x ekseni etiketi: saat:dakika / gün.ay */
function tickFormatterForSpan(spanMs) {
  if (spanMs <= 36 * 3600 * 1000) return (v) => fmtHM.format(new Date(v));
  if (spanMs <= 3 * DAY) return (v) => fmtDDMMTime.format(new Date(v));
  return (v) => fmtDDMM.format(new Date(v));
}
