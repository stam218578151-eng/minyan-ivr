import assert from 'node:assert/strict';
import { normalizeAddress, geocode } from './geocode.js';

const canonical = 'בני ברק רבי עקיבא';
const variants = [
  { name: 'plain spoken address', input: 'בני ברק רבי עקיבא' },
  { name: 'street prefix', input: 'בני ברק רחוב רבי עקיבא' },
  { name: 'spoken framing and end marker', input: 'אני נמצא בעיר בני ברק ברחוב רבי עקיבא סיימתי בסולמית' },
  { name: 'Yemot end marker', input: 'בני ברק רבי עקיבא#' }
];
let normalizationPassed = true;
for (const item of variants) {
  const normalized = normalizeAddress(item.input);
  const ok = normalized === canonical;
  console.log('VERIFY_NORMALIZATION=' + JSON.stringify({case: item.name, ok}));
  if (!ok) normalizationPassed = false;
}

let geocodePassed = false;
let point = null;
try {
  point = await geocode(canonical);
  geocodePassed = Boolean(point &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
    point.lat >= 29.2 && point.lat <= 33.5 &&
    point.lng >= 34.1 && point.lng <= 35.9);
  console.log('VERIFY_GEOCODE=' + JSON.stringify({
    ok: geocodePassed,
    countryBounds: geocodePassed ? 'Israel' : null
  }));
} catch (error) {
  console.log('VERIFY_GEOCODE=' + JSON.stringify({
    ok: false,
    providerUnavailable: String(error?.message ?? error).includes('providers unavailable'),
    error: String(error?.message ?? error).slice(0, 100)
  }));
}

let minyanApiPassed = false;
let parsedCount = 0;
let usableCount = 0;
if (point) {
  try {
    // Raw query validates that the external API is returning a real JSON list,
    // independently of time-of-day filtering for "upcoming only".
    const { fetchRaw } = await import('./minyanim.js');
    const raw = await fetchRaw(point.lat, point.lng, 2);
    const json = JSON.parse(raw);
    const rows = Array.isArray(json?.data) ? json.data : [];
    parsedCount = rows.length;
    const { fetchMinyanim } = await import('./minyanim.js');
    const normalized = await fetchMinyanim(point.lat, point.lng, 2);
    usableCount = normalized.filter(m => m.place && /^\d{2}:\d{2}$/.test(m.time)).length;
    minyanApiPassed = rows.length > 0 && usableCount > 0;
    console.log('VERIFY_MINYAN_API=' + JSON.stringify({
      ok: minyanApiPassed,
      rawRows: parsedCount,
      normalizedUsableRows: usableCount,
      currentTimeFilterMayReduceResults: true
    }));
  } catch (error) {
    console.log('VERIFY_MINYAN_API=' + JSON.stringify({
      ok: false,
      parsedRows: parsedCount,
      error: String(error?.message ?? error).slice(0, 140)
    }));
  }
} else {
  console.log('VERIFY_MINYAN_API=' + JSON.stringify({ok: false, reason: 'No verified point'}));
}

console.log('VERIFY_SUMMARY=' + JSON.stringify({
  normalizationPassed, geocodePassed, minyanApiPassed,
  groqConfigured: Boolean(process.env.GROQ_API_KEY),
  yemotConfigured: Boolean(process.env.YM_TOKEN)
}));
