import express from 'express';
import { transcribe } from './stt.js';
import { geocode } from './geocode.js';
import { fetchMinyanim, fetchRaw } from './minyanim.js';

const app = express();
// Yemot's API module may send either GET (default) or POST (api_url_post=yes).
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
const RADIUS_KM = Number(process.env.RADIUS_KM || 2);
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 6);

// ימות: תווים שמפריעים לפרסור הפקודה
const clean = s => String(s ?? '').replace(/[&=,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
const say = t => `id_list_message=t-${clean(t)}&go_to_folder=hangup`;

// תיעוד ימות: read=הודעה=שם_פרמטר,,record,תיקייה,שם_קובץ,no,yes,no,מינימום,מקסימום
const safeFilePart = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 70) || String(Date.now());
const ask = (prompt, varName, file) =>
  `read=t-${clean(prompt)}=${varName},,record,/1,${safeFilePart(file)},no,yes,no,1,20`;

// ערך ההקלטה מימות עשוי להגיע כנתיב מלא או כשם קובץ בלבד.
// בהקלטה שמורה לשלוחה /1, נתיב יחסי מפורש מתפרש ביחס לשלוחה זו.
function recordingPath(value) {
  let p = String(value ?? '').trim();
  if (!p) throw new Error('Missing voiceFile recording path');
  p = p.replace(/^ivr2:/i, '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  const parts = p.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) {
    throw new Error('Invalid voiceFile recording path');
  }
  if (!p.includes('/')) p = `1/${p}`;
  if (!/\.(wav|ogg|mp3)$/i.test(p)) p += '.wav';
  return `/${p}`;
}

async function download(path) {
  const url = 'https://www.call2all.co.il/ym/api/DownloadFile?token=' +
    process.env.YM_TOKEN + '&path=' + encodeURIComponent('ivr2:' + path);
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

app.get('/', (_, res) => res.send('ok'));

// בדיקה: מה נדרים פלוס מחזירים בפועל. פועל רק אם הוגדר DEBUG_KEY.
// /debug?key=...&lat=32.08&lng=34.78&radius=1
app.get('/debug', async (req, res) => {
  if (!process.env.DEBUG_KEY || req.query.key !== process.env.DEBUG_KEY) return res.sendStatus(404);
  try {
    res.type('application/json; charset=utf-8')
      .send(await fetchRaw(req.query.lat, req.query.lng, req.query.radius || RADIUS_KM));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

const ivrHandler = async (req, res) => {
  res.type('text/plain; charset=utf-8');
  // Accept both GET query parameters and form/JSON POST bodies; never log raw credentials.
  const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const getParam = name => params[name] ?? params[Object.keys(params).find(k => k.toLowerCase() === name.toLowerCase())];
  const id = getParam('ApiCallId') ?? Date.now();
  const voiceFile = getParam('voiceFile');
  console.log('ivr request received', { method: req.method, hasCallId: Boolean(getParam('ApiCallId')), hasVoiceFile: Boolean(voiceFile) });

  if (!voiceFile) {
    return res.send(ask('אמרו את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית', 'voiceFile', `addr_${id}`));
  }

  try {
    const filePath = recordingPath(voiceFile);
    const audio = await download(filePath);
    const text = await transcribe(audio);
    console.log('speech transcription completed', {
      hasText: Boolean(text),
      characterCount: text.length,
      wordCount: text ? text.split(/\\s+/).filter(Boolean).length : 0
    });
    if (!text) return res.send(say('לא הצלחנו להבין את ההקלטה. אמרו שוב את שם העיר ואחריו שם הרחוב, וסיימו בסולמית'));

    const pos = await geocode(text);
    if (!pos) {
      return res.send(say('לא הצלחנו לזהות את העיר והרחוב. אמרו שוב את שם העיר ואחריו שם הרחוב, לדוגמה בני ברק רבי עקיבא, וסיימו בסולמית'));
    }

    const list = await fetchMinyanim(pos.lat, pos.lng, RADIUS_KM);
    if (!list.length) return res.send(say('לא נמצאו מניינים באזור'));

    const body = list.slice(0, MAX_RESULTS)
      .map(m => `${m.type || 'מניין'} בשעה ${m.time || 'לא ידועה'}${m.place ? ' ב' + m.place : ''}`)
      .join('. ');
    res.send(say(`נמצאו ${list.length} מניינים. ${body}`));
  } catch (e) {
    console.error(e);
    res.send(say('אירעה שגיאה, נסו שוב מאוחר יותר'));
  }
};

// Support both Yemot API settings, including a legacy api_url_post=yes.
app.get('/ivr', ivrHandler);
app.post('/ivr', ivrHandler);

app.listen(process.env.PORT || 3000);
