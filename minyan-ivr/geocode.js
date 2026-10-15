// טקסט חופשי ("הרצל חיפה") -> קואורדינטות (OpenStreetMap Nominatim, עד בקשה אחת בשנייה)
export async function geocode(text) {
  const q = String(text).replace(/[.,!?;:"']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1' +
    '&countrycodes=il&accept-language=he&q=' + encodeURIComponent(`${q}, ישראל`);
  const r = await fetch(url, {
    headers: { 'User-Agent': 'minyan-ivr/1.0 (personal IVR project)' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  const j = await r.json();
  return j.length ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}
