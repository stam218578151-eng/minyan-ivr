const token = process.env.YM_TOKEN;
if (!token) throw new Error('YM_TOKEN is not configured; refusing to change Yemot');

const base = 'https://www.call2all.co.il/ym/api/';
async function api(command, fields, method = 'GET') {
  const params = new URLSearchParams({ token, ...fields });
  const url = new URL(command, base);
  const options = { method, signal: AbortSignal.timeout(15000) };
  if (method === 'GET') {
    url.search = params.toString();
  } else {
    options.headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };
    options.body = params;
  }
  const response = await fetch(url, options);
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(command + ' returned non-JSON HTTP ' + response.status); }
  if (!response.ok || data.responseStatus !== 'OK') {
    throw new Error(command + ' failed: ' + JSON.stringify({
      httpStatus: response.status,
      responseStatus: data.responseStatus,
      message: data.message,
      messageCode: data.messageCode
    }));
  }
  return data;
}

const path = 'ivr2:/ext.ini';
console.log('ROOT_MENU_UPDATE_BEGIN');
const current = await api('GetTextFile', { what: path });
console.log('ROOT_MENU_BEFORE=' + JSON.stringify({
  exists: current.file?.exists,
  content: current.contents ?? ''
}));

const desired = [
  'type=menu',
  'title=תפריט ראשי',
  'say_menu_voice=yes',
  'menu_voice=שלום, ברוכים הבאים לקו מניין הקרוב אליכם. לחיפוש הקישו 1, לחיפושים שמורים 2'
].join('\r\n') + '\r\n';

if ((current.contents ?? '').replace(/\r\n/g, '\n').trim() !== desired.replace(/\r\n/g, '\n').trim()) {
  const written = await api('UploadTextFile', { what: path, contents: desired }, 'POST');
  console.log('ROOT_MENU_WRITE_STATUS=' + written.responseStatus);
} else {
  console.log('ROOT_MENU_ALREADY_CORRECT=true');
}

const verified = await api('GetTextFile', { what: path });
if ((verified.contents ?? '').replace(/\r\n/g, '\n').trim() !== desired.replace(/\r\n/g, '\n').trim()) {
  throw new Error('Root menu verification failed; read-back did not match requested configuration');
}
console.log('ROOT_MENU_VERIFIED=' + JSON.stringify({
  type: 'menu',
  say_menu_voice: 'yes',
  menu_voice: verified.contents.split(/\r?\n/).find(line => line.startsWith('menu_voice='))?.slice('menu_voice='.length)
}));
