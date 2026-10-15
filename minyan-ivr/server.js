import express from 'express';
import { transcribe } from './stt.js';
import { geocode } from './geocode.js';
import { fetchMinyanim, fetchRaw } from './minyanim.js';

const app = express();
const RADIUS_KM = Number(process.env.RADIUS_KM || 2);
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 6);

// ימות: תווים שמפריעים לפרסור הפקודה
const clean = s => String(s ?? '').replace(/[&=,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
const say = t => `id_list_message=t-${clean(t)}&go_to_folder=hangup`;

// TODO: לאמת מול תיעוד ימות את סדר הפרמטרים של read במצב record
const ask = (prompt, varName, file) =>
  `read=t-${clean(prompt)}=${varName},no,record,/ApiRecords,${file},no,yes,no,1,8`;

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

app.get('/ivr', async (req, res) => {
  res.type('text/plain; charset=utf-8');
  console.log('ivr query:', req.query); // לבדיקה: שם המשתנה והנתיב שימות שולחים
  const { ApiCallId: id = Date.now(), voiceFile } = req.query;

  if (!voiceFile) {
    return res.send(ask('אמרו את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית', 'voiceFile', `addr_${id}`));
  }

  try {
    const text = await transcribe(await download(voiceFile));
    console.log('transcript:', text);
    if (!text) return res.send(say('לא הצלחנו להבין, נסו שוב'));

    const pos = await geocode(text);
    if (!pos) return res.send(say('לא מצאנו את הכתובת, נסו שוב'));

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
});

app.listen(process.env.PORT || 3000);
