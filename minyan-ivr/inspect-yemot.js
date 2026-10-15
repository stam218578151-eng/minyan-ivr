const base = 'https://www.call2all.co.il/ym/api/';
async function yemotRead(command, params = {}) {
  const url = new URL(command, base);
  url.searchParams.set('token', process.env.YM_TOKEN || '');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  try { return JSON.parse(body); }
  catch { return { responseStatus: 'NON_JSON', message: body.slice(0, 250) }; }
}
function nameOf(item) {
  if (typeof item === 'string') return item;
  return item?.name || item?.path || item?.what || '';
}
const [session, root] = await Promise.all([
  yemotRead('GetSession'),
  yemotRead('GetIVR2Dir', { path: '/' })
]);
const extIni = root.extIni && typeof root.extIni === 'object' ? root.extIni : {};
const settings = {};
for (const key of ['type', 'title', 'api_link', 'api_url_post', 'api_000', 'api_add_0', 'api_end_goto', 'api_phone_send', 'go_to_folder', 'enter_id']) {
  if (extIni[key] !== undefined) settings[key] = extIni[key];
}
console.log('YEMOT_READONLY_DIAGNOSTIC=' + JSON.stringify({
  session: {
    responseStatus: session.responseStatus,
    message: session.message,
    username: session.username,
    name: session.name
  },
  root: {
    responseStatus: root.responseStatus,
    message: root.message,
    thisPath: root.thisPath,
    settings,
    dirs: Array.isArray(root.dirs) ? root.dirs.map(nameOf) : [],
    files: Array.isArray(root.files) ? root.files.map(nameOf) : [],
    ini: Array.isArray(root.ini) ? root.ini.map(nameOf) : []
  }
}));
