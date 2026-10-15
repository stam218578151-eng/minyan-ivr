// One-time, read-only diagnostic of the active Yemot IVR configuration.
// Deliberately logs only routing/protocol settings; never logs tokens or api_add values.
const base = 'https://www.call2all.co.il/ym/api/';
async function getTextFile(what) {
  const url = new URL('GetTextFile', base);
  url.searchParams.set('token', process.env.YM_TOKEN || '');
  url.searchParams.set('what', what);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return { status: 'HTTP_' + response.status };
  let data;
  try { data = await response.json(); } catch { return { status: 'NON_JSON' }; }
  if (data.responseStatus !== 'OK') return { status: String(data.responseStatus || 'UNKNOWN') };
  const raw = {};
  for (const line of String(data.contents || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const out = { status: 'OK' };
  for (const key of ['type','api_url_post','api_wait','api_wait_play','api_timeout','api_end_goto',
    'api_wait_answer_music_on_hold','api_wait_answer_music_on_hold_continue_all_sends',
    'api_wait_answer_music_on_hold_different','rate','tts_rate']) {
    if (raw[key] !== undefined) out[key] = raw[key].slice(0, 150);
  }
  if (raw.api_link) {
    try {
      const u = new URL(raw.api_link);
      out.api_link = u.origin + u.pathname;
    } catch { out.api_link = '[configured but not a valid URL]'; }
  } else {
    out.api_link = '[missing]';
  }
  out.api_add_0_present = raw.api_add_0 !== undefined;
  out.api_add_keys = Object.keys(raw).filter(k => /^api_add_\d+$/.test(k));
  return out;
}
try {
  const [root, ext1] = await Promise.all([
    getTextFile('ivr2:/ext.ini'),
    getTextFile('ivr2:/1/ext.ini')
  ]);
  console.log('YEMOT_SAFE_CONFIG_DIAGNOSTIC=' + JSON.stringify({ root, ext1 }));
} catch (e) {
  console.log('YEMOT_SAFE_CONFIG_DIAGNOSTIC=' + JSON.stringify({ error: e?.name || 'Error' }));
}
