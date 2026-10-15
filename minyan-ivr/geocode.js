// Israeli street geocoding with a primary Nominatim lookup and Photon fallback.
// Nominatim's public service requires a maximum of one request per second per application.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PHOTON = 'https://photon.komoot.io/api/';
const REQUEST_TIMEOUT_MS = 7000;
const ISRAEL = { minLat: 29.2, maxLat: 33.5, minLng: 34.1, maxLng: 35.9 };

let lastNominatimStartedAt = 0;
let nominatimQueue = Promise.resolve();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeAddress(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[#*]+$/g, ' ')
    .replace(/[!?;:"'״׳]/g, ' ')
    .replace(/[،,]/g, ' ')
    .replace(/\s+/g, ' ')
    // Remove common spoken framing and the caller's spoken end marker, not street/city names.
    .replace(/^\s*(?:הכתובת היא|הכתובת|בכתובת|המיקום שלי|אני נמצא|אני נמצאת|אני גר|אני גרה|המקום הוא|העיר היא)\s+(?:בעיר\s+)?/g, '')
    .replace(/(^|\s)(?:ברחוב|רחוב)\s+/g, '$1')
    .replace(/\s+(?:סיימתי בסולמית|סיימו בסולמית|ואסיים בסולמית|בסולמית|עם סולמית|סולמית|כוכבית|סיימתי|סיימו|זה הכל|זהו|תודה)\s*$/g, '')
    .trim();
}

function isIsraeliPoint(lat, lng, properties = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const cc = String(properties.countrycode ?? properties.country_code ?? '').toLowerCase();
  const country = String(properties.country ?? '').toLowerCase();
  if (cc === 'il' || country === 'israel' || country === 'ישראל') return true;
  return lat >= ISRAEL.minLat && lat <= ISRAEL.maxLat &&
    lng >= ISRAEL.minLng && lng <= ISRAEL.maxLng;
}

function pointFromNominatim(row) {
  const lat = Number(row?.lat);
  const lng = Number(row?.lon);
  if (!isIsraeliPoint(lat, lng, row?.address ?? {})) return null;
  return { lat, lng };
}

function pointFromPhoton(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!isIsraeliPoint(lat, lng, feature?.properties ?? {})) return null;
  return { lat, lng };
}

async function serializedNominatimFetch(url) {
  const run = async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - lastNominatimStartedAt));
    if (waitMs) await sleep(waitMs);
    lastNominatimStartedAt = Date.now();
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'minyan-ivr/1.1 (Israeli minyan phone line; contact via GitHub repository)',
        'Accept-Language': 'he,en'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      const error = new Error('Nominatim HTTP ' + response.status);
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    return response.json();
  };
  const result = nominatimQueue.then(run, run);
  nominatimQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function searchNominatim(query) {
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({
    format: 'jsonv2',
    limit: '3',
    addressdetails: '1',
    countrycodes: 'il',
    'accept-language': 'he,en',
    q: query
  }).toString();
  try {
    const rows = await serializedNominatimFetch(url);
    return { ok: true, point: (Array.isArray(rows) ? rows : []).map(pointFromNominatim).find(Boolean) ?? null };
  } catch (error) {
    const rateLimited = error?.status === 429;
    console.warn('geocode provider unavailable', {
      provider: 'nominatim',
      status: error?.status ?? null,
      rateLimited,
      error: String(error).slice(0, 100)
    });
    return { ok: false, point: null, rateLimited, retryAfter: error?.retryAfter ?? null };
  }
}

async function searchPhoton(query) {
  const url = new URL(PHOTON);
  // Public Photon instances may not have Hebrew enabled as a result language; use the
  // Accept-Language header instead of a lang=he query parameter that can return HTTP 400.
  url.search = new URLSearchParams({ q: query, limit: '5' }).toString();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'minyan-ivr/1.1', Accept: 'application/geo+json, application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error('Photon HTTP ' + response.status);
    const data = await response.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    return { ok: true, point: features.map(pointFromPhoton).find(Boolean) ?? null };
  } catch (error) {
    console.warn('geocode provider unavailable', { provider: 'photon', error: String(error).slice(0, 100) });
    return { ok: false, point: null };
  }
}

// The phone prompt requests city first and street second. Free-form search is attempted first;
// explicit city/street separators are tried only when that doesn't find a point.
function queryCandidates(query) {
  const words = query.split(' ').filter(Boolean);
  const candidates = [query];
  for (let cityWords = 1; cityWords <= Math.min(3, words.length - 1); cityWords++) {
    candidates.push(words.slice(0, cityWords).join(' ') + ', ' + words.slice(cityWords).join(' '));
  }
  if (words.length >= 3) {
    const city = words.slice(0, 2).join(' ');
    const street = words.slice(2).join(' ');
    candidates.push(street + ', ' + city);
  }
  return [...new Set(candidates.map(x => x.trim()).filter(Boolean))];
}

export async function geocode(text) {
  const q = normalizeAddress(text);
  if (!q || q.length < 3) return null;

  const candidates = queryCandidates(q);
  let providersResponded = 0;

  // First pass: use Nominatim's free-form interpretation of the entire spoken address.
  const first = await searchNominatim(candidates[0]);
  if (first.ok) providersResponded++;
  if (first.point) {
    console.log('geocode matched', { provider: 'nominatim', candidate: 1 });
    return first.point;
  }

  // Independent OpenStreetMap-backed provider for Hebrew spelling/ordering differences.
  const photon = await searchPhoton(q);
  if (photon.ok) providersResponded++;
  if (photon.point) {
    console.log('geocode matched', { provider: 'photon', candidate: 1 });
    return photon.point;
  }

  // If Nominatim is rate-limited or unavailable, do not hammer it with alternate queries.
  // A provider failure is not evidence that the caller's address does not exist.
  if (!first.ok) throw new Error('Geocoding providers unavailable');

  // Try city/street boundaries only after a real (HTTP 200) no-match response.
  // Any rate limit/transport failure stops the attempt instead of misreporting "not found".
  for (let i = 1; i < candidates.length; i++) {
    const attempt = await searchNominatim(candidates[i]);
    if (!attempt.ok) throw new Error('Geocoding providers unavailable');
    providersResponded++;
    if (attempt.point) {
      console.log('geocode matched', { provider: 'nominatim', candidate: i + 1 });
      return attempt.point;
    }
  }

  console.log('geocode no match', { wordCount: q.split(/\s+/).length, candidatesTried: candidates.length });
  if (providersResponded === 0) throw new Error('Geocoding providers unavailable');
  return null;
}
