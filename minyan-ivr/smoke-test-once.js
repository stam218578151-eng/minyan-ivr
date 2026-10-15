import { geocode } from './geocode.js';
import { fetchMinyanim } from './minyanim.js';

const cases = [
  { id: 'bnei-brak-street', address: 'בני ברק רבי עקיבא' },
  { id: 'jerusalem-street', address: 'ירושלים בר אילן' },
  { id: 'haifa-street', address: 'חיפה הרצל' }
];

let firstPoint = null;
for (const sample of cases) {
  try {
    const point = await geocode(sample.address);
    const ok = Boolean(point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
    console.log('CALLER_SMOKE_GEOCODE=' + JSON.stringify({
      case: sample.id,
      ok,
      coordinatesInsideIsrael: ok && point.lat >= 29.2 && point.lat <= 33.5 && point.lng >= 34.1 && point.lng <= 35.9
    }));
    if (ok && !firstPoint) firstPoint = point;
  } catch (error) {
    console.log('CALLER_SMOKE_GEOCODE=' + JSON.stringify({ case: sample.id, ok: false, error: String(error).slice(0, 120) }));
  }
}

if (firstPoint) {
  try {
    const minyanim = await fetchMinyanim(firstPoint.lat, firstPoint.lng, 2);
    console.log('CALLER_SMOKE_MINYANIM=' + JSON.stringify({
      ok: Array.isArray(minyanim),
      count: Array.isArray(minyanim) ? minyanim.length : 0,
      hasSpeakableFields: Array.isArray(minyanim) && minyanim.every(x =>
        typeof x === 'object' && typeof x.place === 'string' && typeof x.time === 'string')
    }));
  } catch (error) {
    console.log('CALLER_SMOKE_MINYANIM=' + JSON.stringify({ ok: false, error: String(error).slice(0, 160) }));
  }
} else {
  console.log('CALLER_SMOKE_MINYANIM=' + JSON.stringify({ ok: false, reason: 'No test address geocoded' }));
}

console.log('CALLER_SMOKE_CREDENTIALS=' + JSON.stringify({
  groqKeyConfigured: Boolean(process.env.GROQ_API_KEY),
  yemotTokenConfigured: Boolean(process.env.YM_TOKEN)
}));
