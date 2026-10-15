const base = 'https://www.call2all.co.il/ym/api/';
async function read(command, params = {}) {
  const url = new URL(command, base);
  url.searchParams.set('token', process.env.YM_TOKEN || '');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  try { return JSON.parse(body); } catch { return { responseStatus: 'NON_JSON', message: body.slice(0, 200) }; }
}
function selected(contents, root = false) {
  const out = {};
  for (const line of String(contents || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const keep = root ? /^(type|title|[0-9])$/i.test(key)
      : /^(type|title|api_link|api_url_post|api_000|api_add_\d+|api_end_goto|api_phone_send|api_answer_.+|go_to_folder|enter_id)$/i.test(key);
    if (keep) out[key] = line.slice(i + 1).trim().slice(0, 300);
  }
  return out;
}
async function settings(path, isRoot = false) {
  const what = isRoot ? 'ivr2:/ext.ini' : 'ivr2:/' + path + '/ext.ini';
  const r = await read('GetTextFile', { what });
  return { status: r.responseStatus, message: r.message, settings: selected(r.contents, isRoot) };
}
const [session, root] = await Promise.all([read('GetSession'), read('GetIVR2Dir', { path: '/' })]);
const extensions = {};
for (let i = 0; i <= 9; i++) extensions[String(i)] = await settings(String(i));
console.log('YEMOT_EXTENSIONS_DIAGNOSTIC=' + JSON.stringify({
  account: { status: session.responseStatus, message: session.message, username: session.username },
  root: {
    status: root.responseStatus, message: root.message,
    dirs: Array.isArray(root.dirs) ? root.dirs.map(x => typeof x === 'string' ? x : (x?.name || x?.path || '')) : [],
    settings: await settings('', true)
  },
  extensions
}));
