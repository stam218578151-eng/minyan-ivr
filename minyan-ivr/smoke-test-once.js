import { geocode } from './geocode.js';
import { fetchMinyanim, fetchRaw } from './minyanim.js';

function inspectArrays(value, depth = 0) {
  if (Array.isArray(value)) {
    if (!value.length || typeof value[0] === 'object') return value;
    return null;
  }
  if (value && typeof value === 'object' && depth < 5) {
    for (const child of Object.values(value)) {
      const found = inspectArrays(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

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
    const raw = await fetchRaw(firstPoint.lat, firstPoint.lng, 2);
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    const rows = inspectArrays(json);
    console.log('CALLER_SMOKE_RAW_MINYANIM=' + JSON.stringify({
      validJson: Boolean(json),
      rootType: Array.isArray(json) ? 'array' : typeof json,
      rootKeys: json && !Array.isArray(json) && typeof json === 'object' ? Object.keys(json).slice(0, 12) : [],
      discoveredArrayCount: Array.isArray(rows) ? rows.length : null,
      firstRowKeys: rows?.[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 25) : [],
      rawPreview: raw.slice(0, 350)
    }));
  } catch (error) {
    console.log('CALLER_SMOKE_RAW_MINYANIM=' + JSON.stringify({ ok: false, error: String(error).slice(0, 160) }));
  }
  try {
    const minyanim = await fetchMinyanim(firstPoint.lat, firstPoint.lng, 2);
    console.log('CALLER_SMOKE_MINYANIM=' + JSON.stringify({
      ok: Array.isArray(minyanim),
      count: Array.isArray(minyanim) ? minyanim.length : 0,
      usableCount: Array.isArray(minyanim) ? minyanim.filter(x => x.place?.trim() && x.time?.trim()).length : 0,
      sample: Array.isArray(minyanim) ? minyanim.slice(0, 3).map(x => ({
        type: x.type || 'מניין',
        time: x.time || 'לא ידועה',
        hasPlace: Boolean(x.place?.trim())
      })) : []
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
