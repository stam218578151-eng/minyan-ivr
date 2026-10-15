import express from 'express';
import { transcribe } from './stt.js';
import { geocode, normalizeAddress } from './geocode.js';
import { fetchMinyanim, fetchRaw } from './minyanim.js';

const app = express();
// Yemot's API module may send either GET (default) or POST (api_url_post=yes).
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
// Keep request duration/status telemetry so API timeouts can be distinguished
// from a response-format problem. Do not log caller audio paths or phone numbers.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log('http response completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      contentType: res.getHeader('content-type') ?? null,
      contentLength: res.getHeader('content-length') ?? null
    });
  });
  next();
});
const RADIUS_KM = Number(process.env.RADIUS_KM || 2);
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 6);

// ימות: תווים שמפריעים לפרסור הפקודה
const clean = s => String(s ?? '').replace(/[&=,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
const say = t => {
  // Yemot's API parser expects ampersand-delimited fields; terminate the
  // response with '&' as well, including the final hangup command.
  const message = clean(t).slice(0, 850);
  const response = `id_list_message=t-${message}&go_to_folder=hangup&`;
  console.log('ivr response prepared', {
    command: 'id_list_message',
    characters: response.length,
    hasHangup: response.includes('&go_to_folder=hangup&')
  });
  return response;
};

// תיעוד ימות: read=הודעה=שם_פרמטר,,record,תיקייה,שם_קובץ,no,yes,no,מינימום,מקסימום
const safeFilePart = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 70) || String(Date.now());

// Cache the same recording's transcription between the record and confirm callbacks.
// Pre-resolve the address while the caller hears the read-back prompt.
const TRANSCRIPT_CACHE_MS = 5 * 60 * 1000;
const ADDRESS_CACHE_MS = 5 * 60 * 1000;
const transcriptCache = new Map();
const addressLookupCache = new Map();

async function transcriptFor(key, filePath) {
  const existing = transcriptCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const entry = {
    expiresAt: Date.now() + TRANSCRIPT_CACHE_MS,
    promise: (async () => {
      const audio = await download(filePath);
      return String((await transcribe(audio)) ?? '').trim();
    })()
  };
  transcriptCache.set(key, entry);
  entry.promise.catch(() => {
    if (transcriptCache.get(key) === entry) transcriptCache.delete(key);
  });
  return entry.promise;
}

function addressLookupFor(transcript) {
  const key = normalizeAddress(transcript).toLocaleLowerCase('he-IL');
  if (!key) return Promise.resolve({ pos: null });
  const existing = addressLookupCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;

  const entry = {
    expiresAt: Date.now() + ADDRESS_CACHE_MS,
    promise: geocode(transcript).then(
      pos => ({ pos }),
      error => ({ error: String(error?.message ?? error) })
    )
  };
  addressLookupCache.set(key, entry);
  entry.promise.then(result => {
    if (addressLookupCache.get(key) !== entry) return;
    if (result.pos) {
      entry.expiresAt = Date.now() + ADDRESS_CACHE_MS;
    } else {
      addressLookupCache.delete(key);
    }
  });
  return entry.promise;
}

const ask = (prompt, varName, file) =>
  `read=t-${clean(prompt)}=${varName},,record,/1,${safeFilePart(file)},no,yes,no,1,20&`;

// Yemot's documented read schema: variable,yes,maxDigits,minDigits,timeout,Digits,yes&.
// The explicit timeout field is required before Digits; only one digit is accepted.
const askKey = (prompt, varName) =>
  `read=t-${clean(prompt)}=${varName},yes,1,1,20,Digits,yes&`;

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
  res.set('Content-Type', 'text/plain; charset=utf-8');
  // Yemot repeats all previously collected values in each read callback.
  const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const getParam = name => params[name] ?? params[Object.keys(params).find(k => k.toLowerCase() === name.toLowerCase())];
  const hasParam = name => Object.keys(params).some(k => k.toLowerCase() === name.toLowerCase());
  const id = getParam('ApiCallId') ?? Date.now();

  // Keep each new recording under a fresh parameter name; Yemot appends older
  // values to later callbacks, so reusing voiceFile would cause duplicate keys.
  const recordings = Object.entries(params)
    .filter(([name, value]) => /^voiceFile\d*$/i.test(name) && value != null && String(value).trim() !== '')
    .map(([name, value]) => {
      const suffix = name.match(/^voiceFile(\d*)$/i)?.[1] ?? '';
      const attempt = suffix ? Number(suffix) : 1;
      const values = Array.isArray(value) ? value : [value];
      return { attempt, value: values[values.length - 1], name };
    })
    .sort((a, b) => a.attempt - b.attempt);
  const latest = recordings[recordings.length - 1];

  console.log('ivr request received', {
    method: req.method,
    hasCallId: Boolean(getParam('ApiCallId')),
    recordingAttempt: latest?.attempt ?? 0,
    hasConfirmation: latest ? hasParam('confirmAddress' + latest.attempt) : false
  });

  if (!latest) {
    return res.send(ask(
      'אמרו את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית',
      'voiceFile',
      'addr_' + id + '_1'
    ));
  }

  const attempt = latest.attempt;
  const nextVoiceParam = 'voiceFile' + (attempt + 1);
  const nextRecordingName = 'addr_' + id + '_' + (attempt + 1);
  const confirmParam = 'confirmAddress' + attempt;
  const hasConfirmation = hasParam(confirmParam);
  const confirmation = String(getParam(confirmParam) ?? '').trim();

  // Any answer other than 1 means the caller wants to record the address again.
  // A fresh variable name avoids conflicts with parameters retained by Yemot.
  if (hasConfirmation && confirmation !== '1') {
    return res.send(ask(
      'בסדר, נקליט שוב. אמרו את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית',
      nextVoiceParam,
      nextRecordingName
    ));
  }

  try {
    const filePath = recordingPath(latest.value);
    // ApiCallId is stable across callbacks within the same call. Include the
    // recording name so a retry cannot reuse another recording's transcript.
    const transcriptKey = String(id) + ':' + attempt + ':' + String(latest.value);
    const transcript = await transcriptFor(transcriptKey, filePath);
    console.log('speech transcription completed', {
      hasText: Boolean(transcript),
      characterCount: transcript.length,
      wordCount: transcript ? transcript.split(/\s+/).filter(Boolean).length : 0
    });

    if (!transcript) {
      return res.send(ask(
        'לא הצלחתי להבין את ההקלטה. הקליטו שוב את שם העיר ואחריו שם הרחוב, וסיימו בסולמית',
        nextVoiceParam,
        nextRecordingName
      ));
    }

    // On the first pass, read back the transcription and wait for an explicit
    // keypad confirmation. When the caller presses 1, transcribe the same
    // stored audio again, then proceed with address lookup.
    if (!hasConfirmation) {
      const heard = clean(transcript).slice(0, 180);
      // Start geocoding now without delaying the spoken confirmation prompt.
      // The result is awaited only if the caller confirms the address.
      void addressLookupFor(transcript);
      return res.send(askKey(
        'שמעתי ' + heard + '. אם הכתובת נכונה הקישו 1. להקלטה מחדש הקישו 2',
        confirmParam
      ));
    }

    const lookup = await addressLookupFor(transcript);
    if (lookup.error) throw new Error(lookup.error);
    const pos = lookup.pos;
    if (!pos) {
      return res.send(ask(
        'לא הצלחתי לאתר את הכתובת שאישרתם. אנא הקליטו שוב את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית',
        nextVoiceParam,
        nextRecordingName
      ));
    }

    const list = await fetchMinyanim(pos.lat, pos.lng, RADIUS_KM);
    if (!list.length) {
      return res.send(say('לא נמצאו מניינים באזור הכתובת שאישרתם ' + transcript));
    }

    const body = list.slice(0, MAX_RESULTS)
      .map(m => {
        const when = m.time
          ? (m.nextDay ? ' מחר בשעה ' : ' היום בשעה ') + m.time
          : ' בשעה לא ידועה';
        return (m.type || 'מניין') + when + (m.place ? ' ב' + m.place : '');
      })
      .join('. ');
    res.send(say('נמצאו ' + list.length + ' מניינים באזור. ' + body));
  } catch (e) {
    console.error(e);
    if (String(e?.message ?? e).includes('Geocoding providers unavailable')) {
      res.send(say('שירות איתור הכתובות אינו זמין כרגע. נסו שוב בעוד דקה'));
    } else {
      res.send(say('אירעה שגיאה, נסו שוב מאוחר יותר'));
    }
  }
};

// Support both Yemot API settings, including a legacy api_url_post=yes.
app.get('/ivr', ivrHandler);
app.post('/ivr', ivrHandler);

app.listen(process.env.PORT || 3000);
