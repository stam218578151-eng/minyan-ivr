// תמלול דרך Groq (Whisper), תואם OpenAI: POST /openai/v1/audio/transcriptions
export async function transcribe(audioBuffer) {
  const form = new FormData();
  form.append('model', 'whisper-large-v3');
  form.append('language', 'he');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // רמז לשפה/סגנון - משפר זיהוי שמות ערים ורחובות
  form.append('prompt', 'עיר ורחוב בישראל. לדוגמה: בני ברק רבי עקיבא, ירושלים בר אילן, חיפה הרצל');
  form.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`STT ${r.status} ${await r.text()}`);
  const j = await r.json();
  return (j.text || '').trim();
}
