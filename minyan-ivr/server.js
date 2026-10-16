import express from 'express';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { transcribe } from './stt.js';
import { geocode, normalizeAddress } from './geocode.js';
import { fetchMinyanim, fetchRaw } from './minyanim.js';

const app = express();

function shortHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12);
}

function emit(req, event, details = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    app: 'minyan-ivr',
    event,
    requestId: req?.requestId ?? null,
    callKey: req?.callKey ?? null,
    stage: req?.ivrStage ?? null,
    ...details
  }));
}

function errorInfo(error) {
  const rawMessage = String(error?.message ?? error ?? 'unknown error');
  const message = rawMessage
    .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|authorization)\s*[:=]\s*[^,\s]+/gi, '$1=[REDACTED]')
    .slice(0, 700);
  return {
    name: String(error?.name ?? 'Error'),
    message,
    stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : null
  };
}

function summarizeResponse(body) {
  const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
  const parts = text.split('&');
  const commands = parts.filter(Boolean).map(part => part.split('=')[0] || '[EMPTY]');
  let preview = '[non-text response]';
  const readMatch = text.match(/^read=t-.*?=([a-z0-9_]+)/i);
  if (readMatch) {
    preview = 'read=t-[PROMPT_REDACTED]=' + readMatch[1] + text.slice(readMatch[0].length);
  } else if (/^id_list_message=t-/i.test(text)) {
    preview = 'id_list_message=t-[SPEECH_TEXT_REDACTED]' + (text.endsWith('&') ? '&' : '');
  } else if (text.length <= 120) {
    preview = text;
  }
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    commandNames: commands,
    commandCount: commands.length,
    startsWithKnownCommand: /^(read|id_list_message)=/i.test(text),
    endsWithAmpersand: text.endsWith('&'),
    emptySegments: parts.filter(part => part === '').length,
    equalsCount: (text.match(/=/g) || []).length,
    redactedShape: preview,
    sha256: shortHash(text)
  };
}

// Assign IDs before body parsing, so malformed incoming requests are diagnosable.
app.use((req, res, next) => {
  req.requestId = randomUUID();
  req.startedAt = Date.now();
  req.ivrStage = 'http_received';
  emit(req, 'http.request.received', {
    method: req.method,
    path: req.path,
    contentType: req.get('content-type') ?? null,
    contentLengthHeader: req.get('content-length') ?? null,
    queryKeys: Object.keys(req.query ?? {})
  });

  const originalSend = res.send.bind(res);
  res.send = body => {
    if ((req.path === '/ivr' || req.path === '/') && req.method !== 'HEAD') {
      emit(req, 'ivr.response.about_to_send', {
        statusCode: res.statusCode,
        contentType: res.getHeader('content-type') ?? null,
        response: summarizeResponse(body)
      });
    }
    return originalSend(body);
  };

  res.on('finish', () => {
    emit(req, 'http.response.finished', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - req.startedAt,
      contentType: res.getHeader('content-type') ?? null,
      contentLength: res.getHeader('content-length') ?? null,
      headersSent: res.headersSent
    });
  });
  next();
});

// Yemot supports GET by default and optionally POST.
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));

// Log parameter inventory without exposing phone numbers, audio paths or address text.
app.use((req, res, next) => {
  if (req.path === '/ivr' || req.path === '/') {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const params = { ...query, ...body };
    const callIdKey = Object.keys(params).find(key => key.toLowerCase() === 'apicallid');
    const callId = callIdKey ? params[callIdKey] : null;
    if (callId != null && String(callId).trim()) req.callKey = shortHash(callId);

    emit(req, 'http.request.parameters_parsed', {
      queryKeys: Object.keys(query),
      bodyKeys: Object.keys(body),
      allKeys: Object.keys(params),
      parameterCount: Object.keys(params).length,
      parameters: Object.entries(params).map(([key, value]) => {
        const values = Array.isArray(value) ? value : [value];
        const scalar = values[values.length - 1];
        const summary = {
          key,
          valueType: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
          itemCount: values.length,
          valueLength: scalar == null ? 0 : String(scalar).length
        };
        if (/^apicallid$/i.test(key)) {
          summary.valueRedacted = true;
          summary.valueHash = shortHash(scalar);
        } else if (/^confirmAddress\d*$/i.test(key)) {
          summary.confirmationDigit = /^[1-9]$/.test(String(scalar ?? '')) ? String(scalar) : '[not-a-single-digit]';
        } else if (/^voiceFile\d*$/i.test(key)) {
          const path = String(scalar ?? '');
          summary.recordingPathRedacted = true;
          summary.hasSlash = /[\\/]/.test(path);
          summary.hasIvr2Prefix = /^ivr2:/i.test(path);
          summary.extension = path.match(/\.(wav|ogg|mp3)(?:[?#].*)?$/i)?.[1]?.toLowerCase() ?? null;
        }
        return summary;
      })
    });
  }
  next();
});
const RADIUS_KM = Number(process.env.RADIUS_KM || 2);
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 3);

// ימות: תווים שמפריעים לפרסור הפקודה
const clean = s => String(s ?? '').replace(/[&=,.\-]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanSpeechText = value => String(value ?? '')
  .normalize('NFKC')
  // Yemot's Text (t-) syntax uses dot and hyphen as control separators.
  // Allow only letters, numbers, combining marks, spaces and the colon in HH:MM.
  .replace(/[^\p{L}\p{N}\p{M}\s:]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const say = t => {
  // Keep the API reply to one plain-text command, using conservative, parser-safe
  // speech text and a short utterance so a long place name cannot invalidate it.
  const cleaned = cleanSpeechText(t);
  const maxSpeechCharacters = 200;
  const clipped = cleaned.length <= maxSpeechCharacters
    ? cleaned
    : cleaned.slice(0, maxSpeechCharacters).replace(/\s+\S*$/, '').trim();
  const response = `id_list_message=t-${clipped}&`;
  console.log('ivr response prepared', {
    command: 'id_list_message',
    characters: response.length,
    speechCharacters: clipped.length,
    bytes: Buffer.byteLength(response, 'utf8'),
    terminated: response.endsWith('&'),
    forbiddenTtsDelimiters: ['.', '-', '&', '=', ','].some(ch => clipped.includes(ch)),
    chainedActions: false
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


async function transcriptFor(key, filePath, req) {
  const existing = transcriptCache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    emit(req, 'stt.cache.hit', { cache: 'transcript' });
    return existing.promise;
  }
  emit(req, 'stt.cache.miss', { cache: 'transcript' });
  const entry = {
    expiresAt: Date.now() + TRANSCRIPT_CACHE_MS,
    promise: (async () => {
      req.ivrStage = 'recording_download';
      const downloadStarted = Date.now();
      emit(req, 'recording.download.started', {
        fileExtension: String(filePath).match(/\.(wav|ogg|mp3)$/i)?.[1]?.toLowerCase() ?? null,
        pathRedacted: true
      });
      const audio = await download(filePath, req);
      emit(req, 'recording.download.completed', {
        durationMs: Date.now() - downloadStarted,
        bytes: audio.length
      });

      req.ivrStage = 'speech_transcription';
      const sttStarted = Date.now();
      emit(req, 'stt.started', { provider: 'groq_whisper', language: 'he', audioBytes: audio.length });
      try {
        const transcript = String((await transcribe(audio)) ?? '').trim();
        emit(req, 'stt.completed', {
          provider: 'groq_whisper',
          durationMs: Date.now() - sttStarted,
          hasText: Boolean(transcript),
          characterCount: transcript.length,
          wordCount: transcript ? transcript.split(/\s+/).filter(Boolean).length : 0
        });
        return transcript;
      } catch (error) {
        emit(req, 'stt.failed', {
          provider: 'groq_whisper',
          durationMs: Date.now() - sttStarted,
          error: errorInfo(error)
        });
        throw error;
      }
    })()
  };
  transcriptCache.set(key, entry);
  entry.promise.catch(() => {
    if (transcriptCache.get(key) === entry) transcriptCache.delete(key);
  });
  return entry.promise;
}

function addressLookupFor(transcript, req) {
  const normalized = normalizeAddress(transcript);
  const key = normalized.toLocaleLowerCase('he-IL');
  if (!key) {
    emit(req, 'geocode.skipped', { reason: 'empty_normalized_address' });
    return Promise.resolve({ pos: null });
  }
  const existing = addressLookupCache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    emit(req, 'geocode.cache.hit', {
      cache: 'address',
      normalizedCharacterCount: normalized.length,
      wordCount: normalized.split(/\s+/).filter(Boolean).length
    });
    return existing.promise;
  }

  emit(req, 'geocode.started', {
    normalizedCharacterCount: normalized.length,
    wordCount: normalized.split(/\s+/).filter(Boolean).length
  });
  const started = Date.now();
  const entry = {
    expiresAt: Date.now() + ADDRESS_CACHE_MS,
    promise: geocode(transcript).then(
      pos => {
        emit(req, 'geocode.completed', {
          durationMs: Date.now() - started,
          matched: Boolean(pos),
          approximatePoint: pos ? { lat: Number(pos.lat.toFixed(2)), lng: Number(pos.lng.toFixed(2)) } : null
        });
        return { pos };
      },
      error => {
        emit(req, 'geocode.failed', {
          durationMs: Date.now() - started,
          error: errorInfo(error)
        });
        return { error: String(error?.message ?? error) };
      }
    )
  };
  addressLookupCache.set(key, entry);
  entry.promise.then(result => {
    if (addressLookupCache.get(key) !== entry) return;
    if (result.pos) entry.expiresAt = Date.now() + ADDRESS_CACHE_MS;
    else addressLookupCache.delete(key);
  });
  return entry.promise;
}

const ask = (prompt, varName, file) =>
  `read=t-${clean(prompt)}=${varName},,record,/1,${safeFilePart(file)},no,yes,no,1,20&`;

// Yemot's documented read schema: variable,yes,maxDigits,minDigits,timeout,Digits,yes&.
// The explicit timeout field is required before Digits; only one digit is accepted.
const askKey = (prompt, varName) =>
  `read=t-${cleanSpeechText(prompt)}=${varName},yes,1,1,20,Digits,yes&`;

const MINYAN_PAGE_SIZE = 3;

function sortMinyanim(items, mode) {
  const rows = [...items];
  if (mode === '2') {
    rows.sort((a, b) =>
      (a.place || 'בית כנסת לא ידוע').localeCompare(b.place || 'בית כנסת לא ידוע', 'he') ||
      (a.mins ?? 9999) - (b.mins ?? 9999)
    );
  } else {
    rows.sort((a, b) =>
      (a.minutesUntilNext ?? 9999) - (b.minutesUntilNext ?? 9999) ||
      (a.distance ?? 0) - (b.distance ?? 0)
    );
  }
  return rows;
}

function describeMinyan(m, index, mode, previousPlace = '') {
  const place = m.place || 'בית כנסת לא ידוע';
  const when = m.time
    ? (m.nextDay ? ' מחר בשעה ' : ' היום בשעה ') + m.time
    : ' בשעה לא ידועה';
  if (mode === '2') {
    const prefix = place === previousPlace ? '' : 'בית הכנסת ' + place + '. ';
    return prefix + 'מניין ' + (index + 1) + when + (m.type ? ' תפילת ' + m.type : '');
  }
  return 'מניין ' + (index + 1) + when + ' בבית הכנסת ' + place + (m.type ? ', תפילת ' + m.type : '');
}

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


async function download(path, req) {
  if (!process.env.YM_TOKEN) {
    emit(req, 'recording.download.failed', { reason: 'YM_TOKEN_missing' });
    throw new Error('YM_TOKEN is missing');
  }
  const url = 'https://www.call2all.co.il/ym/api/DownloadFile?token=' +
    process.env.YM_TOKEN + '&path=' + encodeURIComponent('ivr2:' + path);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    emit(req, 'recording.download.failed', {
      durationMs: Date.now() - started,
      reason: 'network_or_timeout',
      error: errorInfo(error)
    });
    throw error;
  }
  if (!response.ok) {
    emit(req, 'recording.download.failed', {
      durationMs: Date.now() - started,
      statusCode: response.status,
      statusText: response.statusText,
      reason: 'provider_http_error'
    });
    throw new Error('download ' + response.status);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  emit(req, 'recording.download.http_ok', {
    durationMs: Date.now() - started,
    statusCode: response.status,
    contentType: response.headers.get('content-type'),
    bytes: bytes.length
  });
  return bytes;
}

// Accept the IVR flow both on the documented /ivr path and on the service root.
// Render health probes use HEAD /; keep those probes lightweight and unchanged.
app.get('/', (req, res) => {
  if (req.method === 'HEAD') return res.status(200).type('text/plain').send('ok');
  return ivrHandler(req, res);
});

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
  req.ivrStage = 'ivr_handler_started';
  // Yemot repeats all previously collected values in each read callback.
  const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const getParam = name => params[name] ?? params[Object.keys(params).find(k => k.toLowerCase() === name.toLowerCase())];
  const hasParam = name => Object.keys(params).some(k => k.toLowerCase() === name.toLowerCase());
  const id = getParam('ApiCallId') ?? Date.now();
  if (getParam('ApiCallId') != null) req.callKey = shortHash(getParam('ApiCallId'));
  emit(req, 'ivr.callback.started', {
    method: req.method, path: req.path,
    hasCallId: Boolean(getParam('ApiCallId')),
    queryKeyCount: Object.keys(req.query ?? {}).length,
    bodyKeyCount: Object.keys(req.body ?? {}).length
  });

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

  emit(req, 'ivr.callback.classified', {
    recordingParameterNames: recordings.map(item => item.name),
    recordingCount: recordings.length,
    selectedAttempt: latest?.attempt ?? null,
    selectedParameter: latest?.name ?? null,
    confirmationParameterExpected: latest ? 'confirmAddress' + latest.attempt : null,
    hasConfirmation: latest ? hasParam('confirmAddress' + latest.attempt) : false,
    parameterKeys: Object.keys(params)
  });

  if (!latest) {
    req.ivrStage = 'awaiting_initial_recording';
    emit(req, 'ivr.decision', { decision: 'ask_for_city_and_street_recording' });
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
    req.ivrStage = 'confirmation_declined';
    emit(req, 'ivr.decision', {
      decision: 'record_address_again',
      confirmationValue: /^[1-9]$/.test(confirmation) ? confirmation : '[not-a-single-digit]',
      nextAttempt: attempt + 1
    });
    return res.send(ask(
      'בסדר, נקליט שוב. אמרו את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית',
      nextVoiceParam,
      nextRecordingName
    ));
  }

  let activeStage = 'recording_path_validation';
  try {
    req.ivrStage = activeStage;
    const filePath = recordingPath(latest.value);
    emit(req, 'recording.path.validated', {
      attempt, parameterName: latest.name,
      pathRedacted: true,
      hasSlash: /[\\/]/.test(String(latest.value)),
      extension: filePath.match(/\.(wav|ogg|mp3)$/i)?.[1]?.toLowerCase() ?? null
    });
    // ApiCallId is stable across callbacks within the same call. Include the
    // recording name so a retry cannot reuse another recording's transcript.
    const transcriptKey = String(id) + ':' + attempt + ':' + String(latest.value);
    const transcript = await transcriptFor(transcriptKey, filePath, req);
    emit(req, 'ivr.transcript.ready', {
      hasText: Boolean(transcript),
      characterCount: transcript.length,
      wordCount: transcript ? transcript.split(/\s+/).filter(Boolean).length : 0,
      spokenAddressOmittedFromLogs: true
    });

    if (!transcript) {
      req.ivrStage = 'empty_transcription';
      emit(req, 'ivr.decision', { decision: 'ask_to_rerecord', reason: 'speech_transcription_empty' });
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
      req.ivrStage = 'awaiting_address_confirmation';
      const heard = clean(transcript).slice(0, 180);
      emit(req, 'ivr.decision', {
        decision: 'read_back_transcription_and_wait_for_keypress',
        confirmationParameter: confirmParam,
        transcriptCharacterCount: transcript.length,
        spokenAddressOmittedFromLogs: true
      });
      // Start geocoding now without delaying the spoken confirmation prompt.
      // The result is awaited only if the caller confirms the address.
      void addressLookupFor(transcript, req);
      return res.send(askKey(
        'שמעתי ' + heard + '. אם הכתובת נכונה הקישו 1. להקלטה מחדש הקישו 2',
        confirmParam
      ));
    }

    req.ivrStage = 'awaiting_geocode_result';
    const lookup = await addressLookupFor(transcript, req);
    if (lookup.error) throw new Error(lookup.error);
    const pos = lookup.pos;
    if (!pos) {
      req.ivrStage = 'geocode_no_match';
      emit(req, 'ivr.decision', { decision: 'ask_to_rerecord', reason: 'geocoder_returned_no_match' });
      return res.send(ask(
        'לא הצלחתי לאתר את הכתובת שאישרתם. אנא הקליטו שוב את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית',
        nextVoiceParam,
        nextRecordingName
      ));
    }

    req.ivrStage = 'minyan_search';
    const minyanStarted = Date.now();
    emit(req, 'minyan.search.started', {
      approximatePoint: { lat: Number(pos.lat.toFixed(2)), lng: Number(pos.lng.toFixed(2)) },
      radiusKmConfigured: RADIUS_KM,
      maxResultsToSpeak: MAX_RESULTS
    });
    const list = await fetchMinyanim(pos.lat, pos.lng, RADIUS_KM);
    emit(req, 'minyan.search.completed', {
      durationMs: Date.now() - minyanStarted,
      returnedRows: list.length,
      numberOfResultsToSpeak: Math.min(list.length, MAX_RESULTS)
    });
    if (!list.length) {
      req.ivrStage = 'minyan_search_empty';
      emit(req, 'ivr.decision', { decision: 'speak_no_minyanim_found' });
      return res.send(say('לא נמצאו מניינים באזור הכתובת שאישרתם ' + transcript));
    }

    const sortParamNames = Object.keys(params).filter(name => /^sortMode$/i.test(name));
    const sortMode = sortParamNames.length ? String(getParam('sortMode') ?? '').trim() : '';
    if (sortMode !== '1' && sortMode !== '2') {
      req.ivrStage = 'awaiting_minyan_sort_choice';
      emit(req, 'ivr.decision', {
        decision: 'ask_minyan_sort_choice',
        resultsFound: list.length
      });
      return res.send(askKey(
        'נמצאו ' + list.length + ' מניינים באזור. להקראה לפי שעה הקישו 1. להקראה לפי בית כנסת הקישו 2',
        'sortMode'
      ));
    }

    const sorted = sortMinyanim(list, sortMode);
    const actionNames = Object.keys(params)
      .filter(name => /^pageAction\d+$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));
    const lastActionName = actionNames[actionNames.length - 1];
    const lastAction = lastActionName ? String(getParam(lastActionName) ?? '').trim() : '';
    if (lastAction === '2') {
      req.ivrStage = 'minyan_list_finished';
      emit(req, 'ivr.decision', { decision: 'finish_minyan_list', sortMode });
      return res.send(say('סיימנו את רשימת המניינים. תודה ולהתראות'));
    }

    const pageIndex = actionNames.filter(name => String(getParam(name) ?? '').trim() === '1').length;
    const start = pageIndex * MINYAN_PAGE_SIZE;
    const page = sorted.slice(start, start + MINYAN_PAGE_SIZE);
    if (!page.length) {
      req.ivrStage = 'minyan_list_finished';
      emit(req, 'ivr.decision', { decision: 'minyan_list_exhausted', sortMode, pageIndex });
      return res.send(say('אין מניינים נוספים ברשימה'));
    }

    let previousPlace = '';
    const spoken = page.map((m, offset) => {
      const text = describeMinyan(m, start + offset, sortMode, previousPlace);
      previousPlace = m.place || 'בית כנסת לא ידוע';
      return text;
    }).join('. ');
    const hasMore = start + page.length < sorted.length;
    emit(req, 'ivr.decision', {
      decision: 'speak_minyan_page',
      sortMode,
      pageIndex,
      pageSize: page.length,
      totalResults: sorted.length,
      hasMore
    });
    if (hasMore) {
      return res.send(askKey(
        spoken + '. להמשך הרשימה הקישו 1. לסיום הקישו 2',
        'pageAction' + (pageIndex + 1)
      ));
    }
    return res.send(say(spoken + '. אלה כל המניינים שנמצאו'));
  } catch (e) {
    const geocodingUnavailable = String(e?.message ?? e).includes('Geocoding providers unavailable');
    emit(req, 'ivr.failure', {
      stage: req.ivrStage ?? activeStage,
      category: geocodingUnavailable ? 'geocoding_provider_unavailable' : 'unexpected_flow_error',
      error: errorInfo(e)
    });
    if (geocodingUnavailable) {
      req.ivrStage = 'speaking_geocoding_provider_error';
      res.send(say('שירות איתור הכתובות אינו זמין כרגע. נסו שוב בעוד דקה'));
    } else {
      req.ivrStage = 'speaking_generic_error';
      res.send(say('אירעה שגיאה, נסו שוב מאוחר יותר'));
    }
  }
};

// Support both Yemot API settings, including a legacy api_url_post=yes.
app.get('/ivr', ivrHandler);
app.post('/ivr', ivrHandler);

// שלוחה 2: חיפוש וניהול של עד שני אזורים שמורים לכל מתקשר.
function normalizeCallerPhone(value) {
  let phone = String(value ?? '').trim();
  if (!phone || /private|anonymous|unknown|חסוי/i.test(phone)) return '';
  phone = phone.replace(/[^\d+]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  if (phone.startsWith('0') && !phone.startsWith('00')) phone = '+972' + phone.slice(1);
  phone = phone.replace(/^\+/, '');
  return /^\d{8,15}$/.test(phone) ? phone : '';
}

function callerParameter(params) {
  const keys = Object.keys(params);
  // ApiPhone is the documented Yemot caller-number field; accept common aliases too.
  const preferred = ['ApiPhone', 'callerIdNum', 'ApiCallerId', 'callerPhone', 'CallerPhone', 'phone'];
  for (const name of preferred) {
    const key = keys.find(k => k.toLowerCase() === name.toLowerCase());
    if (key) {
      const value = params[key];
      const list = Array.isArray(value) ? value : [value];
      const normalized = normalizeCallerPhone(list[list.length - 1]);
      if (normalized) return normalized;
    }
  }
  return '';
}

async function savedAreasRpc(action, callerKey, slot = null, areaName = null, areaAddress = null) {
  const endpoint = process.env.SAVED_AREAS_API_URL;
  const apiKey = process.env.SAVED_AREAS_API_KEY;
  const secret = process.env.SAVED_AREAS_API_SECRET;
  if (!endpoint || !apiKey || !secret) throw new Error('Saved areas database is not configured');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'x-ivr-secret': secret
    },
    body: JSON.stringify({
      p_action: action,
      p_caller_key: callerKey,
      p_slot: slot,
      p_area_name: areaName,
      p_area_address: areaAddress
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error('Saved areas database HTTP ' + response.status + ': ' + body);
  }
  return response.json();
}

function callerKeyForPhone(phone) {
  // Store a keyed digest, not a raw phone number or an easily enumerable plain hash.
  const secret = process.env.SAVED_AREAS_API_SECRET;
  if (!secret) throw new Error('Saved areas secret is not configured');
  return createHmac('sha256', secret).update('minyan-ivr-saved-area-v1:' + phone).digest('hex');
}

const savedHandler = async (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const getParam = name => params[name] ?? params[Object.keys(params).find(k => k.toLowerCase() === name.toLowerCase())];
  const hasParam = name => Object.keys(params).some(k => k.toLowerCase() === name.toLowerCase());
  const rawPhone = callerParameter(params);
  if (!rawPhone) {
    emit(req, 'saved_area.caller_phone_missing', {
      keysPresent: Object.keys(params).filter(k => /phone|caller|api/i.test(k)),
      apiPhoneFieldPresent: hasParam('ApiPhone')
    });
    return res.send(say('לא זיהיתי את מספר הטלפון שממנו התקשרתם. יש להגדיר בשלוחת ימות המשיח העברת מספר מתקשר בפרמטר ApiPhone'));
  }
  const callerKey = callerKeyForPhone(rawPhone);
  let areas;
  try {
    areas = await savedAreasRpc('list', callerKey);
    if (!Array.isArray(areas)) areas = [];
  } catch (error) {
    emit(req, 'saved_area.database_read_failed', { error: errorInfo(error) });
    return res.send(say('שירות האזורים השמורים אינו זמין כרגע. נסו שוב מאוחר יותר'));
  }

  const choice = String(getParam('savedAreaChoice') ?? '').trim();
  const slotToConfigure = choice === '3' ? 1 : choice === '4' ? 2 : null;

  // Configure or replace a saved slot by recording its city and street over the phone.
  if (slotToConfigure) {
    const recordings = Object.entries(params)
      .filter(([name, value]) => /^savedVoiceFile\d*$/i.test(name) && value != null && String(value).trim() !== '')
      .map(([name, value]) => {
        const suffix = name.match(/^savedVoiceFile(\d*)$/i)?.[1] ?? '';
        const attempt = suffix ? Number(suffix) : 1;
        const values = Array.isArray(value) ? value : [value];
        return { attempt, value: values[values.length - 1], name };
      })
      .sort((a, b) => a.attempt - b.attempt);
    const latest = recordings[recordings.length - 1];

    if (!latest) {
      return res.send(ask(
        'הקליטו את שם העיר ואחריו את שם הרחוב לשמירה באזור ' + slotToConfigure + ', וסיימו בסולמית',
        'savedVoiceFile',
        'saved_area_' + slotToConfigure + '_' + (getParam('ApiCallId') ?? Date.now()) + '_1'
      ));
    }

    const confirmationName = 'savedConfirmAddress' + latest.attempt;
    const hasConfirmation = hasParam(confirmationName);
    const confirmation = String(getParam(confirmationName) ?? '').trim();
    const nextParam = 'savedVoiceFile' + (latest.attempt + 1);
    const nextFile = 'saved_area_' + slotToConfigure + '_' + (getParam('ApiCallId') ?? Date.now()) + '_' + (latest.attempt + 1);

    try {
      const filePath = recordingPath(latest.value);
      const transcript = await transcriptFor(
        'saved-area:' + String(getParam('ApiCallId') ?? 'call') + ':' + slotToConfigure + ':' + latest.attempt + ':' + String(latest.value),
        filePath,
        req
      );
      if (!transcript) {
        return res.send(ask(
          'לא הצלחתי להבין את הכתובת. הקליטו שוב את שם העיר והרחוב, וסיימו בסולמית',
          nextParam,
          nextFile
        ));
      }

      if (!hasConfirmation) {
        void addressLookupFor(transcript, req);
        return res.send(askKey(
          'שמעתי ' + clean(transcript).slice(0, 150) + '. אם הכתובת נכונה הקישו 1. להקלטה מחדש הקישו 2',
          confirmationName
        ));
      }

      if (confirmation !== '1') {
        return res.send(ask(
          'נקליט מחדש. אמרו את שם העיר ואחריו את שם הרחוב, וסיימו בסולמית',
          nextParam,
          nextFile
        ));
      }

      const lookup = await addressLookupFor(transcript, req);
      if (lookup.error) throw new Error(lookup.error);
      if (!lookup.pos) {
        return res.send(ask(
          'לא הצלחתי לאתר את הכתובת. הקליטו שוב את שם העיר ואחריו את שם הרחוב',
          nextParam,
          nextFile
        ));
      }

      await savedAreasRpc('upsert', callerKey, slotToConfigure, transcript.slice(0, 40), transcript);
      emit(req, 'saved_area.saved', { slot: slotToConfigure, callerKeyHash: callerKey.slice(0, 12) });
      return res.send(say('האזור ' + slotToConfigure + ' נשמר בהצלחה. בשיחה הבאה תוכלו לבחור אותו משלוחה 2'));
    } catch (error) {
      emit(req, 'saved_area.configure_failed', { slot: slotToConfigure, error: errorInfo(error) });
      return res.send(say('לא הצלחתי לשמור את האזור כרגע. נסו שוב מאוחר יותר'));
    }
  }

  // Initial menu: configured slots are searchable; slots can always be replaced.
  if (choice !== '1' && choice !== '2') {
    const configuredSlots = new Set(areas.map(area => Number(area.slot)));
    const options = [];
    if (configuredSlots.has(1)) options.push('לחיפוש באזור ' + (areas.find(a => Number(a.slot) === 1)?.name || 'הראשון') + ' הקישו 1');
    if (configuredSlots.has(2)) options.push('לחיפוש באזור ' + (areas.find(a => Number(a.slot) === 2)?.name || 'השני') + ' הקישו 2');
    options.push('להגדרת אזור ראשון או להחלפתו הקישו 3');
    options.push('להגדרת אזור שני או להחלפתו הקישו 4');
    return res.send(askKey(options.join('. '), 'savedAreaChoice'));
  }

  const area = areas.find(item => String(item.slot) === choice);
  if (!area || !area.name || !area.address) {
    return res.send(say('האזור שבחרתם עדיין לא הוגדר. הקישו 3 להגדרת אזור ראשון או 4 להגדרת אזור שני'));
  }

  try {
    emit(req, 'saved_area.selected', { slot: choice, configured: true, callerKeyHash: callerKey.slice(0, 12) });
    const lookup = await addressLookupFor(area.address, req);
    if (lookup.error) throw new Error(lookup.error);
    const pos = lookup.pos;
    if (!pos) return res.send(say('לא הצלחתי לאתר את הכתובת השמורה של אזור ' + choice + '. הגדירו אותו מחדש'));

    const list = await fetchMinyanim(pos.lat, pos.lng, RADIUS_KM);
    if (!list.length) return res.send(say('לא נמצאו מניינים באזור השמור ' + area.name));

    const sortMode = String(getParam('savedSortMode') ?? '').trim();
    if (sortMode !== '1' && sortMode !== '2') {
      return res.send(askKey(
        'באזור ' + area.name + ' נמצאו ' + list.length + ' מניינים. להקראה לפי שעה הקישו 1. להקראה לפי בית כנסת הקישו 2',
        'savedSortMode'
      ));
    }

    const sorted = sortMinyanim(list, sortMode);
    const actionNames = Object.keys(params)
      .filter(name => /^savedPageAction\d+$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));
    const lastActionName = actionNames[actionNames.length - 1];
    if (lastActionName && String(getParam(lastActionName) ?? '').trim() === '2') {
      return res.send(say('סיימנו את רשימת המניינים באזור ' + area.name + '. תודה ולהתראות'));
    }

    const pageIndex = actionNames.filter(name => String(getParam(name) ?? '').trim() === '1').length;
    const start = pageIndex * MINYAN_PAGE_SIZE;
    const page = sorted.slice(start, start + MINYAN_PAGE_SIZE);
    if (!page.length) return res.send(say('אין מניינים נוספים באזור ' + area.name));

    let previousPlace = '';
    const spoken = page.map((m, offset) => {
      const text = describeMinyan(m, start + offset, sortMode, previousPlace);
      previousPlace = m.place || 'בית כנסת לא ידוע';
      return text;
    }).join('. ');
    if (start + page.length < sorted.length) {
      return res.send(askKey(
        'באזור ' + area.name + '. ' + spoken + '. להמשך הרשימה הקישו 1. לסיום הקישו 2',
        'savedPageAction' + (pageIndex + 1)
      ));
    }
    return res.send(say('באזור ' + area.name + '. ' + spoken + '. אלה כל המניינים שנמצאו'));
  } catch (error) {
    emit(req, 'saved_area.failure', { slot: choice, error: errorInfo(error) });
    return res.send(say('אירעה שגיאה בחיפוש המניינים באזור השמור. נסו שוב מאוחר יותר'));
  }
};

app.get('/saved', savedHandler);
app.post('/saved', savedHandler);


app.use((error, req, res, next) => {
  emit(req, 'http.middleware.failure', {
    stage: req.ivrStage ?? 'before_route_handler',
    error: errorInfo(error),
    responseAlreadyStarted: res.headersSent
  });
  if (res.headersSent) return next(error);
  if (req.path === '/ivr' || req.path === '/') {
    res.status(200).type('text/plain; charset=utf-8')
      .send('id_list_message=t-אירעה תקלה בקבלת נתוני השיחה. נסו שוב מאוחר יותר&');
    return;
  }
  res.status(400).type('text/plain; charset=utf-8').send('Bad request');
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    app: 'minyan-ivr',
    event: 'server.started',
    port,
    envPresence: {
      YM_TOKEN: Boolean(process.env.YM_TOKEN),
      GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
      DEBUG_KEY: Boolean(process.env.DEBUG_KEY)
    },
    config: { radiusKm: RADIUS_KM, maxResults: MAX_RESULTS }
  }));
});
