// שליפת מניינים מנדרים פלוס (פרויקט זמני תפילות הארצי).
// GetNearestMinyan accepts discrete radius values in kilometers (0, 0.5, or 1).
// Map this app's configurable kilometer radius to the largest supported value not
// exceeding the requested search size; larger values caused "Wrong radius".
const BASE = 'https://www.matara.pro/nedarimplus/Zmanim/Manage.aspx';
const ONLY_UPCOMING = process.env.ONLY_UPCOMING !== 'false';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

// הבקשה הגולמית - משמשת גם את /debug כדי לראות מה נדרים מחזירים
export async function fetchRaw(lat, lng, radiusKm) {
  const requestedKm = Math.max(0, Number(radiusKm) || 0);
  const supportedRadiusKm = requestedKm === 0 ? 0 : (requestedKm <= 0.5 ? 0.5 : 1);
  const url = `${BASE}?Action=GetNearestMinyan&lat=${lat}&lng=${lng}&radius=${supportedRadiusKm}&_=${Date.now()}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 minyan-ivr', Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`nedarim ${r.status}`);
  return r.text();
}

const norm = k => String(k).toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]/g, '');

// ערך של שדה לפי רשימת שמות אפשריים (לא רגיש לאותיות גדולות/קטנות)
function pick(o, names) {
  const m = new Map(Object.keys(o).map(k => [norm(k), o[k]]));
  for (const n of names) {
    const v = m.get(norm(n));
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

// מוצא את מערך האובייקטים הראשון בתשובה, בלי קשר לעטיפה
function findArray(x, depth = 0) {
  if (Array.isArray(x)) return x.length && typeof x[0] === 'object' ? x : x.length ? null : x;
  if (x && typeof x === 'object' && depth < 4) {
    for (const v of Object.values(x)) {
      const a = findArray(v, depth + 1);
      if (a) return a;
    }
  }
  return null;
}

const hhmm = v => {
  const m = String(v ?? '').match(/(\d{1,2}):(\d{2})/);
  return m ? { h: +m[1], m: +m[2] } : null;
};

function nowIsrael() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value;
}

function normalize(row) {
  // Nedarim Plus currently returns compact keys: T=prayer, L=location/name,
  // H=hour, D=distance, A=street address, W=coordinates.
  const t = hhmm(pick(row, ['H', 'Time', 'MinyanTime', 'StartTime', 'Hour', 'Zman', 'שעה', 'זמן']));
  const typeRaw = pick(row, ['T', 'Tfila', 'TfilaName', 'Prayer', 'PrayerName', 'MinyanType', 'Type', 'Kind', 'תפילה', 'סוג']);
  return {
    type: typeof typeRaw === 'string' && /[\u0590-\u05ff]/.test(typeRaw) ? typeRaw.trim() : '',
    time: t ? `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}` : '',
    mins: t ? t.h * 60 + t.m : null,
    place: String(pick(row, ['L', 'SynagogueName', 'Synagogue', 'BeitKnesset', 'PlaceName', 'Place', 'Name', 'Title', 'Shul', 'A', 'בית כנסת', 'שם']) ?? '').trim(),
    distance: (() => {
      const value = pick(row, ['D', 'Distance', 'Dist', 'Meters', 'מרחק']);
      const match = String(value ?? '').match(/[0-9]+(?:[.,][0-9]+)?/);
      return match ? Number(match[0].replace(',', '.')) : 0;
    })()
  };
}

// The API returns recurring clock times (HH:MM) without a calendar date.
// Treat a time that has passed today as the next occurrence tomorrow, rather
// than dropping it and incorrectly saying there are no nearby minyanim.
function orderForNextOccurrence(items) {
  const now = nowIsrael();
  return items.map(m => {
    if (m.mins === null) {
      return { ...m, nextDay: false, minutesUntilNext: null };
    }
    const difference = m.mins - now;
    const nextDay = difference < -5;
    const minutesUntilNext = nextDay ? difference + 1440 : Math.max(0, difference);
    return { ...m, nextDay, minutesUntilNext };
  }).sort((a, b) =>
    (a.minutesUntilNext ?? 9999) - (b.minutesUntilNext ?? 9999) ||
    a.distance - b.distance
  );
}

export async function fetchMinyanim(lat, lng, radiusKm) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusKm}`;
  const hit = cache.get(key);
  let usable;
  if (hit && Date.now() - hit.t < CACHE_MS) {
    usable = hit.v;
  } else {
    const text = await fetchRaw(lat, lng, radiusKm);
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error('nedarim: not JSON: ' + text.slice(0, 200)); }

    const rows = findArray(json);
    if (!rows) throw new Error('nedarim: no array in response: ' + text.slice(0, 300));
    if (rows.length && !hhmm(JSON.stringify(rows[0]))) {
      console.warn('nedarim: no time field recognised, sample keys:', Object.keys(rows[0]).join(','));
    }

    usable = rows.map(normalize).filter(m => m.place || m.time);
    console.log('minyan search response', {
      rawRows: rows.length,
      usableRows: usable.length,
      radiusKm: Math.max(0, Number(radiusKm) || 0) <= 0 ? 0 :
        (Number(radiusKm) <= 0.5 ? 0.5 : 1),
      usingRecurringTimes: ONLY_UPCOMING
    });
    cache.set(key, { t: Date.now(), v: usable });
  }

  const list = ONLY_UPCOMING
    ? orderForNextOccurrence(usable)
    : [...usable].sort((a, b) => (a.mins ?? 9999) - (b.mins ?? 9999) || a.distance - b.distance);

  console.log('minyan search results', {
    returnedRows: list.length,
    nextDayRows: list.filter(m => m.nextDay).length
  });
  return list;
}
